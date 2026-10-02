import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function setup() {
  let now = Date.now();
  const sockets = [];
  const timers = [];
  const calls = [];
  const intervals = [];
  let apiHandler = null;
  let prefs = { muted_channels: 'C1' };
  let counts = () => Promise.resolve({ channels: [{ id: 'C1', name: 'general', unread_count_display: 3, mention_count_display: 1 }], groups: [], ims: [{ id: 'D1', dm_count: 2 }] });
  class WebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const context = vm.createContext({ console, Date: { now: () => now }, WebSocket,
    setInterval(fn, delay) { intervals.push({ fn, delay }); return intervals.length; }, clearInterval() {},
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} });
  const api = new vm.SyntheticModule(['send', 'getSyncHistory'], function() {
    this.setExport('getSyncHistory', () => []);
    this.setExport('send', async (method, args) => {
      calls.push(method);
      if (apiHandler) return apiHandler(method, args);
      if (method === 'rtm.connect') return { url: 'wss://example.invalid' };
      if (method === 'users.counts') return counts();
      if (method === 'users.prefs.get') return { ok: true, prefs };
      return { channel: { user: 'U1' } };
    });
  }, { context });
  const module = new vm.SourceTextModule(await readFile(new URL('../src/slack_rtm.js', import.meta.url), 'utf8'), { context });
  await module.link(() => api);
  await module.evaluate();
  const client = module.namespace.default;
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const open = async () => { client.start(); await flush(); const socket = sockets.at(-1); socket.readyState = 1; socket.onopen(); await flush(); return socket; };
  return { setTime(value) { now = value; }, client, sockets, timers, intervals, calls, flush, open, setCounts(fn) { counts = fn; },
    setApiHandler(fn) { apiHandler = fn; }, setPrefs(value) { prefs = value; } };
}

test('diagnostics reflect counts, muted totals, names, messages and reconnects', async () => {
  const f = await setup();
  assert.equal(f.client.getDiagnostics().connection.state, 'disconnected');
  f.client.initialize();
  const socket = await f.open();
  let data = f.client.getDiagnostics();
  assert.equal(data.connection.state, 'connected');
  assert.equal(data.lastUnreadSync.status, 'success');
  assert.equal(data.channels.find(c => c.id === 'C1').name, 'general');
  assert.equal(data.totals.unreadCount, 2);
  assert.equal(data.totals.mentionCount, 2);
  await f.flush();
  assert.equal(f.client.getDiagnostics().channels.find(c => c.id === 'D1').name, 'DM (U1)');
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C2' }) });
  data = f.client.getDiagnostics();
  assert.equal(data.totals.unreadCount, 3);
  assert.equal(data.connection.lastMessageType, 'message');
  socket.readyState = 3;
  socket.onclose({ code: 1006 });
  data = f.client.getDiagnostics();
  assert.equal(data.connection.state, 'reconnecting');
  assert.equal(data.connection.reconnectAttempt, 1);
  assert.ok(data.connection.nextReconnectAt);
});

test('HTTP sync completes even after WebSocket disconnect and replays queued events', async () => {
  const f = await setup();
  let complete;
  f.setCounts(() => new Promise(resolve => { complete = resolve; }));
  const socket = await f.open();
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1' }) });
  assert.equal(f.client.getDiagnostics().pendingEvents, 1);
  socket.readyState = 3;
  socket.onclose({ code: 1006 });
  complete({ channels: [{ id: 'C1', unread_count_display: 99 }] });
  await f.flush();
  const data = f.client.getDiagnostics();
  assert.equal(data.lastUnreadSync.status, 'success');
  assert.equal(data.refreshing, false);
  assert.equal(data.totals.unreadCount, 100);
});

test('failed refresh preserves existing counts and reports failure', async () => {
  const f = await setup();
  const socket = await f.open();
  socket.readyState = 3;
  socket.onclose({ code: 1006 });
  f.setCounts(() => Promise.reject('test error'));
  f.timers[0]();
  await f.flush();
  f.sockets[1].readyState = 1;
  f.sockets[1].onopen();
  await f.flush();
  const data = f.client.getDiagnostics();
  assert.equal(data.lastUnreadSync.status, 'error');
  assert.equal(data.totals.unreadCount, 5);
});

test('HTTP history includes duration and safe errors without response secrets', async () => {
  let ok = true;
  let token = 'secret-token';
  let storageListener;
  const sentTokens = [];
  const context = vm.createContext({ Date, FormData, console,
    chrome: { storage: { onChanged: { addListener(fn) { storageListener = fn; } }, sync: { get(_, callback) { callback({ token }); } } } },
    fetch: async (_, options) => {
      sentTokens.push(options.body.get('token'));
      return { headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
        json: async () => ok ? { ok: true, channels: [{ id: 'C1' }], token } : { ok: false, error: 'missing_scope' } };
    } });
  const module = new vm.SourceTextModule(await readFile(new URL('../src/slack_api.js', import.meta.url), 'utf8'), { context });
  await module.link(() => {});
  await module.evaluate();
  const api = module.namespace;
  await api.send('users.counts');
  let entry = api.getSyncHistory()[0];
  assert.equal(entry.summary, 'channels: 1件 / 未読: 未取得 / メンション・DM: 未取得');
  assert.equal(entry.status, 'success');
  assert.ok(entry.durationMs >= 0);
  ok = false;
  await assert.rejects(api.send('users.counts'));
  entry = api.getSyncHistory()[0];
  assert.equal(entry.status, 'error');
  assert.equal(entry.summary, 'Slack API error: missing_scope');
  assert.ok(!JSON.stringify(api.getSyncHistory()).includes('secret-token'));
  token = 'replacement-token';
  storageListener({ token: { newValue: token } }, 'sync');
  await api.send('team.info').catch(() => {});
  assert.equal(sentTokens.at(-1), 'replacement-token');
  for (let i = 0; i < 35; i++) await api.send('users.counts').catch(() => {});
  assert.equal(api.getSyncHistory().length, 30);
});

test('workspace details reuse team.info and discard the cache when the token changes', async () => {
  let messageListener;
  let storageListener;
  let policyListener;
  const alarmPeriods = [];
  const requests = [];
  const context = vm.createContext({ console, setInterval() { return 1; }, clearInterval() {},
    chrome: {
      alarms: { onAlarm: { addListener() {} }, create(name, options) { assert.equal(name, 'refresh-unread-counts'); alarmPeriods.push(options.periodInMinutes); } },
      storage: { onChanged: { addListener(fn) { storageListener = fn; } } },
      runtime: { id: 'extension-id', onMessage: { addListener(fn) { messageListener = fn; } } },
      action: { onClicked: { addListener() {} } }
    }
  });
  const api = new vm.SyntheticModule(['send'], function() {
    this.setExport('send', method => {
      assert.equal(method, 'team.info');
      return new Promise(resolve => requests.push(resolve));
    });
  }, { context });
  const rtm = new vm.SyntheticModule(['default'], function() {
    this.setExport('default', { addListener() {}, addSyncPolicyListener(fn) { policyListener = fn; }, getSyncPolicy() { return { intervalMinutes: 5 }; }, initialize() {}, start() {}, restart() {} });
  }, { context });
  const module = new vm.SourceTextModule(await readFile(new URL('../src/background.js', import.meta.url), 'utf8'), { context });
  await module.link(specifier => specifier === './slack_api.js' ? api : rtm);
  await module.evaluate();
  assert.deepEqual(alarmPeriods, [5]);
  policyListener({ intervalMinutes: 30 });
  policyListener({ intervalMinutes: 5 });
  assert.deepEqual(alarmPeriods, [5, 30, 5]);
  const requestInfo = () => new Promise(resolve => {
    assert.equal(messageListener({ type: 'getWorkspaceInfo' }, { id: 'extension-id' }, resolve), true);
  });
  const first = requestInfo();
  const concurrent = requestInfo();
  assert.equal(requests.length, 1);
  storageListener({ token: { newValue: 'new-token' } }, 'sync');
  const current = requestInfo();
  assert.equal(requests.length, 2);
  requests[1]({ team: { id: 'T2', name: 'Current', domain: 'current', icon: { image_132: 'https://example.invalid/icon.png' }, secret: 'hidden' } });
  assert.equal((await current).workspace.id, 'T2');
  requests[0]({ team: { id: 'T1', name: 'Previous', domain: 'previous' } });
  await Promise.all([first, concurrent]);
  const cached = await requestInfo();
  assert.equal(cached.workspace.id, 'T2');
  assert.equal(cached.workspace.iconUrl, 'https://example.invalid/icon.png');
  assert.ok(!JSON.stringify(cached).includes('hidden'));
  assert.equal(requests.length, 2);
  storageListener({ token: { newValue: '' } }, 'sync');
  const noIcon = requestInfo();
  requests[2]({ team: { id: 'T3', name: 'No icon' } });
  assert.equal((await noIcon).workspace.iconUrl, null);
});

test('unsupported users.counts falls back to all pages of member conversations', async () => {
  const f = await setup();
  const pages = [];
  f.setApiHandler(async (method, args) => {
    if (method === 'rtm.connect') throw 'Slack API error: not_allowed_token_type';
    if (method === 'users.counts') throw 'Slack API error: not_allowed_token_type';
    if (method === 'users.conversations') {
      pages.push({ ...args });
      if (args.types !== 'public_channel') return { channels: [] };
      if (!args.cursor) return { channels: [], response_metadata: { next_cursor: 'page2' } };
      return { channels: Array.from({ length: 12 }, (_, i) => ({ id: `C${i}`, name: `channel-${i}` })) };
    }
    if (method === 'conversations.info') return { channel: { id: args.channel, unread_count: 3, mention_count: 0 } };
    throw new Error(`Unexpected API: ${method}`);
  });
  f.client.start();
  await f.flush();
  const data = f.client.getDiagnostics();
  assert.equal(data.connection.state, 'disconnected');
  assert.equal(data.lastUnreadSync.source, 'conversations');
  assert.equal(data.lastUnreadSync.status, 'success');
  assert.equal(data.channels.filter(c => c.unreadCount > 0).length, 12);
  assert.equal(data.totals.unreadCount, 36);
  assert.equal(pages[1].cursor, 'page2');
  await f.client.refresh();
  assert.equal(f.calls.filter(method => method === 'users.counts').length, 1);
});

test('missing counts remain unknown, while unread_count and DM counts are accepted', async () => {
  const f = await setup();
  f.setCounts(async () => ({
    channels: [{ id: 'C1', unread_count: '4', mention_count: '2' }, { id: 'C2' }, { id: 'C3', has_unreads: true, mention_count: 0 }],
    ims: [{ id: 'D1', dm_count: 5 }]
  }));
  await f.open();
  const data = f.client.getDiagnostics();
  assert.equal(data.channels.find(c => c.id === 'C1').unreadCount, 4);
  assert.equal(data.channels.find(c => c.id === 'C2').unreadCount, null);
  assert.equal(data.channels.find(c => c.id === 'C3').unreadCountExact, false);
  assert.equal(data.channels.find(c => c.id === 'D1').unreadCount, 5);
  assert.equal(data.lastUnreadSync.status, 'partial');
  assert.equal(data.totals.unreadCount, 10);
  assert.equal(data.totals.unreadIncomplete, true);
});

test('public API fallback reports missing read state rather than zero unread', async () => {
  const f = await setup();
  f.setApiHandler(async (method, args) => {
    if (method === 'users.counts') throw 'Slack API error: not_allowed_token_type';
    if (method === 'rtm.connect') return { url: 'wss://example.invalid' };
    if (method === 'users.conversations') {
      if (args.types === 'private_channel') throw 'Slack API error: missing_scope';
      return { channels: args.types === 'public_channel' ? [{ id: 'C1', name: 'unknown' }] : [] };
    }
    if (method === 'conversations.info') return { channel: { id: 'C1', name: 'unknown' } };
    throw new Error(`Unexpected API: ${method}`);
  });
  await f.open();
  const data = f.client.getDiagnostics();
  assert.equal(data.lastUnreadSync.status, 'partial');
  assert.match(data.lastUnreadSync.warning, /取得権限不足/);
  assert.equal(data.channels[0].unreadCount, null);
  assert.match(data.channels[0].countError, /未読数/);
});

test('fallback counts history after last_read, paginates, and excludes membership events', async () => {
  const f = await setup();
  const historyArgs = [];
  f.setApiHandler(async (method, args) => {
    if (method === 'users.counts') throw 'Slack API error: not_allowed_token_type';
    if (method === 'rtm.connect') return { url: 'wss://example.invalid' };
    if (method === 'users.conversations') return { channels: args.types === 'public_channel' ? [{ id: 'C1', name: 'history' }] : [] };
    if (method === 'conversations.info') return { channel: { id: 'C1', last_read: '100.000001', latest: { ts: '200.000001' } } };
    if (method === 'conversations.history') {
      historyArgs.push({ ...args });
      return !args.cursor ? {
        messages: [{ type: 'message', ts: '200.000001' }, { type: 'message', subtype: 'channel_join', ts: '150.000001' }],
        has_more: true, response_metadata: { next_cursor: 'next' }
      } : { messages: [{ type: 'message', ts: '120.000001' }], has_more: false };
    }
    throw new Error(`Unexpected API: ${method}`);
  });
  await f.open();
  const data = f.client.getDiagnostics();
  assert.equal(data.channels[0].unreadCount, 2);
  assert.equal(data.channels[0].mentionCount, null);
  assert.equal(historyArgs[0].oldest, '100.000001');
  assert.equal(historyArgs[0].inclusive, false);
  assert.equal(historyArgs[1].cursor, 'next');
});

test('missing and differently shaped mute preferences never throw and unmuting updates totals', async () => {
  const f = await setup();
  await f.open();
  for (const prefs of [undefined, {}, { muted_channels: undefined }, { muted_channels: 123, all_notifications_prefs: 'invalid-json' },
    { muted_channels: [], all_notifications_prefs: { channels: { C1: null } } }]) {
    f.setPrefs(prefs);
    f.client.initialize();
    await f.flush();
    assert.equal(f.client.getDiagnostics().channels.find(c => c.id === 'C1').muted, false);
  }
  f.setPrefs({ muted_channels: ['C1'], all_notifications_prefs: { channels: { D1: { muted: true } } } });
  f.client.initialize();
  await f.flush();
  assert.equal(f.client.getDiagnostics().totals.unreadCount, 0);
  let lastTotal;
  f.client.addListener(unreads => { lastTotal = unreads; });
  assert.doesNotThrow(() => f.sockets[0].onmessage({ data: JSON.stringify({ type: 'pref_change', name: 'all_notifications_prefs', value: '{bad' }) }));
  f.sockets[0].onmessage({ data: JSON.stringify({ type: 'pref_change', name: 'all_notifications_prefs', value: JSON.stringify({ muted_channels: '' }) }) });
  assert.equal(lastTotal, 5);
});

test('a previous token response cannot overwrite counts after restart', async () => {
  const f = await setup();
  let resolveOld;
  f.setCounts(() => new Promise(resolve => { resolveOld = resolve; }));
  await f.open();
  f.setCounts(async () => ({ channels: [{ id: 'Cnew', unread_count_display: 7, mention_count_display: 0 }] }));
  f.client.restart();
  await f.flush();
  resolveOld({ channels: [{ id: 'Cold', unread_count_display: 99 }] });
  await f.flush();
  const data = f.client.getDiagnostics();
  assert.equal(data.channels.some(c => c.id === 'Cold'), false);
  assert.equal(data.channels.find(c => c.id === 'Cnew').unreadCount, 7);
});

test('queued messages already included in a snapshot are not counted twice', async () => {
  const f = await setup();
  let complete;
  f.setCounts(() => new Promise(resolve => { complete = resolve; }));
  const socket = await f.open();
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1', ts: '150.000001' }) });
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1', ts: '250.000001' }) });
  complete({ channels: [{ id: 'C1', unread_count_display: 3, mention_count_display: 0, latest: { ts: '200.000001' } }] });
  await f.flush();
  assert.equal(f.client.getDiagnostics().totals.unreadCount, 4);
  for (const message of [
    { subtype: 'message_changed' }, { subtype: 'message_deleted' }, { subtype: 'channel_join' },
    { ts: '300.000001', thread_ts: '200.000001' }
  ]) socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1', ...message }) });
  assert.equal(f.client.getDiagnostics().totals.unreadCount, 4);
});

test('HTTP rate limits respect Retry-After and JSON without a charset is accepted', async () => {
  let time = 1000;
  const waits = [];
  let requests = 0;
  const context = vm.createContext({ Date: { now: () => time }, FormData, console,
    setTimeout(callback, delay) { waits.push(delay); time += delay; callback(); },
    chrome: { storage: { onChanged: { addListener() {} }, sync: { get(_, callback) { callback({ token: 'token' }); } } } },
    fetch: async () => ++requests === 1 ? { status: 429, headers: new Headers({ 'retry-after': '2' }) } :
      { status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ ok: true, channel: { id: 'C1' } }) }
  });
  const module = new vm.SourceTextModule(await readFile(new URL('../src/slack_api.js', import.meta.url), 'utf8'), { context });
  await module.link(() => {});
  await module.evaluate();
  await assert.rejects(module.namespace.send('conversations.info'), error => error === 'Slack API error: ratelimited');
  await module.namespace.send('conversations.info');
  assert.equal(waits[0], 2000);
  assert.equal(module.namespace.getSyncHistory()[0].status, 'success');
});

test('HTTP summaries show response counts and resolve history targets without storing secrets', async () => {
  let time = 1000;
  let response;
  const context = vm.createContext({ Date: { now: () => time }, FormData, console,
    setTimeout(callback, delay) { time += delay; callback(); },
    chrome: { storage: { onChanged: { addListener() {} }, sync: { get(_, callback) { callback({ token: 'secret-token' }); } } } },
    fetch: async () => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => response })
  });
  const module = new vm.SourceTextModule(await readFile(new URL('../src/slack_api.js', import.meta.url), 'utf8'), { context });
  await module.link(() => {});
  await module.evaluate();
  const api = module.namespace;
  response = { ok: true, messages: [{ type: 'message', text: 'private message body' }], has_more: true };
  await api.send('conversations.history', { channel: 'C1', oldest: '123.000001' });
  assert.equal(api.getSyncHistory()[0].target, 'チャンネル C1');
  assert.equal(api.getSyncHistory()[0].summary, '履歴: 1件 / 次ページあり / 最終既読以降: 123.000001');
  response = { ok: true, channels: [{ id: 'C1', name: 'general' }], response_metadata: { next_cursor: 'private-cursor' } };
  await api.send('users.conversations', { types: 'public_channel' });
  assert.equal(api.getSyncHistory()[0].target, '公開チャンネル');
  assert.equal(api.getSyncHistory()[1].target, '#general (C1)');
  assert.match(api.getSyncHistory()[0].summary, /未読: 未取得/);
  response = { ok: true, channel: { id: 'C1', name: 'general', unread_count_display: 0, mention_count: 2, last_read: '123.000001', is_muted: false } };
  await api.send('conversations.info', { channel: 'C1' });
  assert.equal(api.getSyncHistory()[0].target, '#general (C1)');
  assert.match(api.getSyncHistory()[0].summary, /未読: 0 \/ メンション・DM: 2/);
  assert.match(api.getSyncHistory()[0].summary, /最終既読: 123.000001 \/ ミュート: なし/);
  response = { ok: true, channels: [{ id: 'C1', unread_count: '3', mention_count: 1 }, { id: 'C2' }], ims: [{ id: 'D1', dm_count: 4 }] };
  await api.send('users.counts');
  assert.equal(api.getSyncHistory()[0].target, '全チャンネル・DM');
  assert.match(api.getSyncHistory()[0].summary, /未読: 7以上（1件未取得）/);
  assert.match(api.getSyncHistory()[0].summary, /メンション・DM: 5以上（1件未取得）/);
  response = { ok: true, channel: { id: 'C2', has_unreads: true, mention_count: 0 } };
  await api.send('conversations.info', { channel: 'C2' });
  assert.match(api.getSyncHistory()[0].summary, /未読: 1以上/);
  response = { ok: true, prefs: { muted_channels: 'C1', all_notifications_prefs: JSON.stringify({ channels: { C1: { muted: true }, C2: { muted: true } } }) } };
  await api.send('users.prefs.get');
  assert.equal(api.getSyncHistory()[0].summary, 'ミュート: 2チャンネル（C1, C2）');
  response = { ok: true, team: { id: 'T1', name: 'Workspace', domain: 'workspace' } };
  await api.send('team.info');
  assert.equal(api.getSyncHistory()[0].target, 'Workspace (T1)');
  assert.match(api.getSyncHistory()[0].summary, /名前: Workspace \/ ID: T1 \/ ドメイン: workspace/);
  response = { ok: true, team: { id: 'T1', name: 'Workspace' }, self: { id: 'U1' }, url: 'wss://private-url' };
  await api.send('rtm.connect');
  assert.match(api.getSyncHistory()[0].summary, /ワークスペース: T1 \/ ユーザー: U1/);
  const history = JSON.stringify(api.getSyncHistory());
  for (const secret of ['secret-token', 'private message body', 'private-cursor', 'private-url']) assert.ok(!history.includes(secret));
});

test('HTTP interval requires 11 minutes, two post-connection successes and a recent pong', async () => {
  const f = await setup();
  f.setTime(1000000);
  const changes = [];
  f.client.addSyncPolicyListener(policy => changes.push(policy.intervalMinutes));
  const socket = await f.open();
  const started = f.client.getDiagnostics().connection.connectedAt;
  assert.equal(f.client.getSyncPolicy().successfulSyncsSinceConnection, 1);
  const pong = () => socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
  await f.client.refresh();
  f.setTime(started + 11 * 60000 - 1);
  pong();
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 5);
  f.setTime(started + 11 * 60000);
  pong();
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 30);
  assert.deepEqual(changes, [30]);
  pong();
  assert.deepEqual(changes, [30], 'unchanged policy must not postpone the alarm');
  const requests = f.calls.filter(method => method === 'users.counts').length;
  f.setTime(started + 12 * 60000);
  f.intervals.find(interval => interval.delay === 20000).fn();
  await f.flush();
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 5);
  assert.equal(f.client.getSyncPolicy().successfulSyncsSinceConnection, 0);
  assert.deepEqual(changes, [30, 5]);
  assert.equal(f.calls.filter(method => method === 'users.counts').length, requests + 1);
  f.timers.at(-1)();
  await f.flush();
  const reconnected = f.sockets.at(-1);
  reconnected.readyState = 1;
  reconnected.onopen();
  await f.flush();
  assert.equal(f.client.getSyncPolicy().successfulSyncsSinceConnection, 1);
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 5);
});

test('failed, partial and approximate syncs prevent reduced HTTP polling; token changes reset it', async () => {
  const f = await setup();
  f.setTime(1000000);
  const socket = await f.open();
  const started = f.client.getDiagnostics().connection.connectedAt;
  await f.client.refresh();
  f.setTime(started + 11 * 60000);
  socket.onmessage({ data: '{"type":"pong"}' });
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 30);
  f.setCounts(async () => { throw 'temporary failure'; });
  await f.client.refresh();
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 5);
  assert.equal(f.client.getSyncPolicy().successfulSyncsSinceConnection, 0);
  for (const channel of [{ id: 'C1' }, { id: 'C1', has_unreads: true }]) {
    f.setCounts(async () => ({ channels: [channel] }));
    await f.client.refresh();
    await f.client.refresh();
    assert.equal(f.client.getSyncPolicy().intervalMinutes, 5);
    assert.equal(f.client.getSyncPolicy().successfulSyncsSinceConnection, 0);
  }
  f.setCounts(async () => ({ channels: [{ id: 'C1', unread_count: 3 }] }));
  await f.client.refresh();
  await f.client.refresh();
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 30);
  await f.client.restart();
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 5);
  assert.equal(f.client.getSyncPolicy().successfulSyncsSinceConnection, 0);
});

test('an HTTP sync begun before connection is excluded and followed by a fresh sync', async () => {
  const f = await setup();
  let finish;
  let countCalls = 0;
  f.setCounts(() => ++countCalls === 1 ? new Promise(resolve => { finish = resolve; }) :
    Promise.resolve({ channels: [] }));
  const socket = await f.open();
  assert.equal(f.client.getSyncPolicy().successfulSyncsSinceConnection, 0);
  finish({ channels: [] });
  await f.flush();
  assert.equal(countCalls, 2);
  assert.equal(f.client.getSyncPolicy().successfulSyncsSinceConnection, 1);
  await f.client.refresh();
  f.setTime(f.client.getDiagnostics().connection.connectedAt + 11 * 60000);
  // An ordinary message must not substitute for a heartbeat.
  socket.onmessage({ data: '{"type":"hello"}' });
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 5);
  socket.onmessage({ data: '{"type":"pong"}' });
  assert.equal(f.client.getSyncPolicy().intervalMinutes, 30);
});
