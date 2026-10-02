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
      if (method === 'rtm.connect') return { url: 'wss://example.invalid', self: { id: 'U1' } };
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
    this.setExport('default', { addListener() {}, addSyncActivityListener() {}, addSyncPolicyListener(fn) { policyListener = fn; }, getSyncPolicy() { return { intervalMinutes: 5 }; }, initialize() {}, start() {}, restart() {}, refresh() { return Promise.reject(new Error('unexpected sync error')); }, getDiagnostics() { return { refreshing: false }; } });
  }, { context });
  const module = new vm.SourceTextModule(await readFile(new URL('../src/background.js', import.meta.url), 'utf8'), { context });
  await module.link(specifier => specifier === './slack_api.js' ? api : rtm);
  await module.evaluate();
  assert.deepEqual(alarmPeriods, [5]);
  policyListener({ intervalMinutes: 30 });
  policyListener({ intervalMinutes: 5 });
  assert.deepEqual(alarmPeriods, [5, 30, 5]);
  const failedSyncResponse = await new Promise(resolve => {
    assert.equal(messageListener({ type: 'refreshUnreadCounts' }, { id: 'extension-id' }, resolve), true);
  });
  assert.equal(failedSyncResponse.refreshing, false);
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
    if (method === 'rtm.connect') return { url: 'wss://example.invalid', self: { id: 'U1' } };
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
    if (method === 'rtm.connect') return { url: 'wss://example.invalid', self: { id: 'U1' } };
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

test('history sync stops after five pages and distinguishes a lower bound from a complete count', async () => {
  for (const hasMore of [true, false]) {
    const f = await setup();
    let pages = 0;
    f.setApiHandler(async (method, args) => {
      if (method === 'rtm.connect') throw 'Slack API error: not_allowed_token_type';
      if (method === 'users.counts') throw 'Slack API error: not_allowed_token_type';
      if (method === 'users.conversations') return { channels: args.types === 'public_channel' ? [{ id: 'C1' }] : [] };
      if (method === 'conversations.info') return { channel: { id: 'C1', name: 'general', last_read: '100', latest: '1000' } };
      if (method === 'conversations.history') {
        pages += 1;
        const more = pages < 5 || hasMore;
        return { messages: [{ type: 'message', ts: String(1000 - pages) }], has_more: more,
          response_metadata: { next_cursor: more ? 'page-' + pages : '' } };
      }
      throw new Error('unexpected API');
    });
    await f.client.start();
    const data = f.client.getDiagnostics();
    assert.equal(pages, 5);
    assert.equal(data.channels[0].unreadCount, 5);
    assert.equal(data.channels[0].unreadCountExact, !hasMore);
    assert.equal(data.lastUnreadSync.status, hasMore ? 'partial' : 'success');
    assert.equal(data.totals.unreadIncomplete, hasMore);
    if (hasMore) assert.match(data.lastUnreadSync.warning, /履歴取得上限/);
  }
});

test('WebSocket counts direct mentions, rich-text mentions and DMs without counting own or duplicate messages', async () => {
  const f = await setup();
  f.setCounts(async () => ({ channels: [{ id: 'C1', unread_count: 0, mention_count: 0, last_read: '100', latest: '100' }],
    ims: [{ id: 'D1', dm_count: 0, last_read: '100' }],
    mpims: [{ id: 'G1', unread_count: 0, mention_count: 0, last_read: '100', is_mpim: true }] }));
  const socket = await f.open();
  const send = message => socket.onmessage({ data: JSON.stringify({ type: 'message', user: 'U2', ...message }) });
  send({ channel: 'C1', ts: '200.000001', text: '<@U1> <@U1>' });
  send({ channel: 'C1', ts: '200.000001', text: '<@U1>' });
  send({ channel: 'C1', ts: '201', user: 'U1', text: '<@U1>' });
  send({ channel: 'C1', ts: '99', text: '<@U1>' });
  send({ channel: 'C1', ts: '202', text: '<@U2>' });
  send({ channel: 'C1', ts: '203', text: '`<@U1>`' });
  send({ channel: 'C1', ts: '204', blocks: [{ type: 'rich_text', elements: [
    { type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U1' }] }] }] });
  send({ channel: 'D1', ts: '205', text: 'DM' });
  send({ channel: 'D1', ts: '206', user: 'U1', text: 'own DM' });
  send({ channel: 'G1', ts: '207', text: 'group DM' });
  const channels = f.client.getDiagnostics().channels;
  assert.equal(channels.find(c => c.id === 'C1').unreadCount, 4);
  assert.equal(channels.find(c => c.id === 'C1').mentionCount, 2);
  for (const id of ['D1', 'G1']) {
    assert.equal(channels.find(c => c.id === id).unreadCount, 1);
    assert.equal(channels.find(c => c.id === id).mentionCount, 1);
  }
  assert.ok(!JSON.stringify([...f.client.messageLedger.values()]).includes('<@U1>'), 'ledger retains flags, not message content');
});

test('WebSocket deletion and editing adjust unread, mention and DM counts once, respecting read markers', async () => {
  const f = await setup();
  f.setCounts(async () => ({ channels: [{ id: 'C1', unread_count: 0, mention_count: 0, last_read: '100' }],
    ims: [{ id: 'D1', dm_count: 0, last_read: '100' }] }));
  const socket = await f.open();
  const send = value => socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1', user: 'U2', ...value }) });
  send({ ts: '200', text: 'hello' });
  send({ subtype: 'message_changed', ts: '201', message: { ts: '200', user: 'U2', text: '<@U1>' } });
  assert.equal(f.client.getDiagnostics().channels.find(c => c.id === 'C1').mentionCount, 1);
  send({ subtype: 'message_changed', ts: '202', message: { ts: '200', user: 'U2', text: 'hello again' } });
  assert.equal(f.client.getDiagnostics().channels.find(c => c.id === 'C1').mentionCount, 0);
  send({ subtype: 'message_deleted', ts: '203', deleted_ts: '200' });
  send({ subtype: 'message_deleted', ts: '203', deleted_ts: '200' });
  send({ ts: '200', text: 'delayed duplicate' });
  assert.equal(f.client.getDiagnostics().channels.find(c => c.id === 'C1').unreadCount, 0);
  send({ channel: 'D1', ts: '204', text: 'DM' });
  send({ channel: 'D1', subtype: 'message_deleted', ts: '205', deleted_ts: '204' });
  const dm = f.client.getDiagnostics().channels.find(c => c.id === 'D1');
  assert.equal(dm.unreadCount, 0);
  assert.equal(dm.mentionCount, 0);
  send({ ts: '206', text: '<@U1>' });
  send({ type: 'channel_marked', ts: '206', unread_count_display: 0, mention_count_display: 0 });
  send({ ts: '207', text: '<@U1>' });
  send({ subtype: 'message_deleted', ts: '208', deleted_ts: '206' });
  const channel = f.client.getDiagnostics().channels.find(c => c.id === 'C1');
  assert.equal(channel.unreadCount, 1);
  assert.equal(channel.mentionCount, 1);
});

test('snapshot-included messages remain deletable; unknown deletions are marked uncertain', async () => {
  const f = await setup();
  f.setCounts(async () => ({ channels: [{ id: 'C1', unread_count: 0, mention_count: 0, last_read: '100', latest: '100' }] }));
  const socket = await f.open();
  let complete;
  f.setCounts(() => new Promise(resolve => { complete = resolve; }));
  const refresh = f.client.refresh();
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1', ts: '200', user: 'U2', text: '<@U1>' }) });
  complete({ channels: [{ id: 'C1', unread_count: 1, mention_count: 1, last_read: '100', latest: '200' }] });
  await refresh;
  assert.equal(f.client.getDiagnostics().totals.unreadCount, 1);
  socket.onmessage({ data: JSON.stringify({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '200', ts: '201' }) });
  assert.equal(f.client.getDiagnostics().totals.unreadCount, 0);
  assert.equal(f.client.getDiagnostics().totals.mentionCount, 0);
  socket.onmessage({ data: JSON.stringify({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '150', ts: '202' }) });
  const data = f.client.getDiagnostics();
  assert.equal(data.totals.unreadCount, 0);
  assert.equal(data.totals.unreadIncomplete, true);
  assert.equal(data.totals.mentionIncomplete, true);
  assert.match(data.channels[0].countError, /元の未読状態が不明/);
});

test('previous_message enables deletion of an initial unread; group mentions and unknown bases remain incomplete', async () => {
  const f = await setup();
  f.setCounts(async () => ({ channels: [{ id: 'C1', unread_count: 1, mention_count: 1, last_read: '100' },
    { id: 'C2', unread_count: 0 }]}));
  const socket = await f.open();
  socket.onmessage({ data: JSON.stringify({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '150',
    ts: '200', previous_message: { type: 'message', ts: '150', user: 'U2', text: '<@U1>' } }) });
  assert.equal(f.client.getDiagnostics().totals.mentionCount, 0);
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1', ts: '201', user: 'U2', text: '<!subteam^S1> <!here>' }) });
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C2', ts: '202', user: 'U2', text: '<@U1>' }) });
  const data = f.client.getDiagnostics();
  assert.equal(data.channels.find(c => c.id === 'C2').mentionCount, 1);
  assert.equal(data.channels.find(c => c.id === 'C2').mentionCountExact, false);
  assert.equal(data.totals.mentionIncomplete, true);
  assert.match(data.channels.find(c => c.id === 'C1').countError, /ユーザーグループ/);
});

test('deletions coalesce targeted HTTP refreshes and preserve other channels and concurrent messages', async () => {
  const f = await setup();
  f.setCounts(async () => ({ channels: [
    { id: 'C1', unread_count: 5, mention_count: 2, last_read: '100' },
    { id: 'C2', unread_count: 8, mention_count: 3, last_read: '100' }
  ] }));
  const socket = await f.open();
  const targets = [];
  let complete;
  f.setApiHandler(async (method, args) => {
    assert.equal(method, 'conversations.info');
    targets.push(args.channel);
    return new Promise(resolve => { complete = resolve; });
  });
  const remove = ts => socket.onmessage({ data: JSON.stringify({
    type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: ts, ts: '300'
  }) });
  remove('150');
  remove('151');
  await f.flush();
  assert.deepEqual(targets, ['C1']);
  assert.equal(f.client.currentRefreshChannel, 'C1');
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1', ts: '400', user: 'U2', text: '<@U1>' }) });
  complete({ channel: { id: 'C1', unread_count: 3, mention_count: 1, last_read: '100', latest: '350' } });
  await f.flush();
  const data = f.client.getDiagnostics();
  assert.equal(data.channels.find(c => c.id === 'C1').unreadCount, 4);
  assert.equal(data.channels.find(c => c.id === 'C1').mentionCount, 2);
  assert.equal(data.channels.find(c => c.id === 'C2').unreadCount, 8);
  assert.equal(data.lastUnreadSync.targetChannel, 'C1');
  assert.equal(data.lastUnreadSync.reason, 'message_deleted');
  assert.equal(f.client.currentRefreshChannel, null);
  assert.equal(data.lastUnreadSync.status, 'success');
});

test('a deletion during targeted HTTP refresh schedules another fetch; stale token results are discarded', async () => {
  const f = await setup();
  const socket = await f.open();
  const resolves = [];
  f.setApiHandler(async (method, args) => {
    if (method === 'conversations.info') return new Promise(resolve => resolves.push(resolve));
    if (method === 'rtm.connect') return { url: 'wss://example.invalid', self: { id: 'U1' } };
    if (method === 'users.counts') return { channels: [{ id: 'Cnew', unread_count: 9, mention_count: 0 }] };
    if (method === 'users.prefs.get') return { ok: true, prefs: {} };
    throw new Error(method);
  });
  const remove = ts => socket.onmessage({ data: JSON.stringify({ type: 'message', subtype: 'message_deleted',
    channel: 'C1', deleted_ts: ts, ts: '400' }) });
  remove('150');
  await f.flush();
  remove('151');
  resolves[0]({ channel: { id: 'C1', unread_count: 2, mention_count: 0, last_read: '100' } });
  await f.flush();
  assert.equal(resolves.length, 2);
  await f.client.restart();
  resolves[1]({ channel: { id: 'C1', unread_count: 100, mention_count: 100 } });
  await f.flush();
  assert.equal(f.client.getDiagnostics().channels.some(c => c.id === 'C1'), false);
  assert.equal(f.client.getDiagnostics().channels.find(c => c.id === 'Cnew').unreadCount, 9);
});

test('deletion HTTP refresh uses history fallback and reports failures without treating missing counts as zero', async () => {
  const f = await setup();
  const socket = await f.open();
  const methods = [];
  f.setApiHandler(async (method, args) => {
    methods.push(method);
    if (method === 'conversations.info') return { channel: { id: 'C1', last_read: '100', latest: '200' } };
    if (method === 'conversations.history') return { messages: [{ type: 'message', ts: '200' }] };
    throw new Error(method);
  });
  socket.onmessage({ data: JSON.stringify({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '150', ts: '250' }) });
  await f.flush();
  assert.deepEqual(methods, ['conversations.info', 'conversations.history']);
  assert.equal(f.client.getDiagnostics().channels.find(c => c.id === 'C1').unreadCount, 1);
  assert.equal(f.client.getDiagnostics().channels.find(c => c.id === 'C1').mentionCount, null);
  f.setApiHandler(async () => { throw 'Slack API error: missing_scope'; });
  socket.onmessage({ data: JSON.stringify({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '151', ts: '260' }) });
  await f.flush();
  const data = f.client.getDiagnostics();
  assert.equal(data.lastUnreadSync.status, 'error');
  assert.equal(data.channels.find(c => c.id === 'C1').unreadCount, 1);
  assert.match(data.channels.find(c => c.id === 'C1').countError, /HTTP再取得に失敗/);
});

test('queued edits update mention counts even when their event timestamp precedes snapshotLatest', async () => {
  const f = await setup();
  f.setCounts(async () => ({ channels: [{ id: 'C1', unread_count: 0, mention_count: 0, last_read: '100', latest: '100' }] }));
  const socket = await f.open();
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1', user: 'U2', ts: '200', text: 'hello' }) });
  for (const [before, text, expected] of [[0, '<@U1>', 1], [1, 'hello again', 0]]) {
    let finish;
    f.setCounts(() => new Promise(resolve => { finish = resolve; }));
    const refreshing = f.client.refresh();
    const edit = { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '250',
      message: { type: 'message', user: 'U2', ts: '200', text } };
    socket.onmessage({ data: JSON.stringify(edit) });
    socket.onmessage({ data: JSON.stringify(edit) });
    finish({ channels: [{ id: 'C1', unread_count: 1, mention_count: before, last_read: '100', latest: '300' }] });
    await refreshing;
    assert.equal(f.client.getDiagnostics().channels.find(c => c.id === 'C1').mentionCount, expected);
  }
});

test('fallback MPIM type works when the API omits is_mpim and events omit channel_type', async () => {
  const f = await setup();
  f.setApiHandler(async (method, args) => {
    if (method === 'rtm.connect') return { url: 'wss://example.invalid', self: { id: 'U1' } };
    if (method === 'users.counts') throw 'Slack API error: not_allowed_token_type';
    if (method === 'users.conversations') return { channels: args.types === 'mpim' ?
      [{ id: 'G1', name: 'group-dm', unread_count: 0, mention_count: 0 }] : [] };
    throw new Error(method);
  });
  const socket = await f.open();
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'G1', user: 'U2', ts: '200', text: 'hello' }) });
  const dm = f.client.getDiagnostics().channels.find(c => c.id === 'G1');
  assert.equal(dm.unreadCount, 1);
  assert.equal(dm.mentionCount, 1);
});

test('rich-text code-styled users and preformatted users are not mentions', async () => {
  const f = await setup();
  f.setCounts(async () => ({ channels: [{ id: 'C1', unread_count: 0, mention_count: 0 }] }));
  const socket = await f.open();
  socket.onmessage({ data: JSON.stringify({ type: 'message', channel: 'C1', user: 'U2', ts: '200',
    blocks: [{ type: 'rich_text', elements: [
      { type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U1', style: { code: true } }] },
      { type: 'rich_text_preformatted', elements: [{ type: 'user', user_id: 'U1' }] }
    ] }] }) });
  assert.equal(f.client.getDiagnostics().totals.mentionCount, 0);
  assert.equal(f.client.getDiagnostics().totals.unreadCount, 1);
});
