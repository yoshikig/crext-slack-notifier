'use strict';

const g = {token: ''};
Object.seal(g);
const syncHistory = [];
const nextRequestAt = new Map();
const retryAfterAt = new Map();
const channelNames = new Map();
const conversationTypes = { public_channel: '公開チャンネル', private_channel: '非公開チャンネル', im: 'DM', mpim: 'グループDM' };
let workspaceName = '';
let tokenVersion = 0;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.token) {
    g.token = '';
    tokenVersion += 1;
    channelNames.clear();
    workspaceName = '';
  }
});

export function getSyncHistory() {
  return syncHistory.map(({ channelId, version, ...entry }) => ({
    ...entry,
    target: channelId && version === tokenVersion ? channelTarget(channelId) : entry.target
  }));
}

function channelTarget(id) {
  return channelNames.has(id) ? `${channelNames.get(id)} (${id})` : `チャンネル ${id}`;
}

function requestTarget(api, args) {
  if (typeof args?.channel === 'string') return channelTarget(args.channel);
  if (typeof args?.types === 'string') {
    return args.types.split(',').map(type => conversationTypes[type] || type).join('・') + (args.cursor ? '（続き）' : '');
  }
  if (typeof args?.user === 'string') return `ユーザー ${args.user}`;
  if (typeof args?.team_id === 'string') return `ワークスペース ${args.team_id}`;
  if (api === 'users.counts') return '全チャンネル・DM';
  if (api === 'users.prefs.get') return 'ユーザーの通知・ミュート設定';
  return workspaceName || '連携先ワークスペース';
}

function countValue(...values) {
  for (const value of values) {
    if ((typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' &&
        Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  }
  return null;
}

function unreadValue(channel) {
  const count = countValue(channel.unread_count_display, channel.unread_count, channel.is_im ? channel.dm_count : null);
  if (count !== null) return { count, exact: true };
  if (typeof channel.has_unreads === 'boolean') return { count: channel.has_unreads ? 1 : 0, exact: !channel.has_unreads };
  return { count: null, exact: false };
}

function mentionValue(channel) {
  return countValue(channel.mention_count_display, channel.mention_count, channel.is_im ? channel.dm_count : null);
}

function countSummary(channels) {
  if (!channels.length) return '未読: 0 / メンション・DM: 0';
  const unreads = channels.map(unreadValue);
  const mentions = channels.map(mentionValue);
  const unreadTotal = unreads.reduce((sum, value) => sum + (value.count || 0), 0);
  const mentionTotal = mentions.reduce((sum, value) => sum + (value || 0), 0);
  const label = (total, unknown, approximate = false) => unknown === channels.length ? '未取得' :
    `${total}${unknown || approximate ? '以上' : ''}${unknown ? `（${unknown}件未取得）` : ''}`;
  return `未読: ${label(unreadTotal, unreads.filter(value => value.count === null).length, unreads.some(value => !value.exact))}` +
    ` / メンション・DM: ${label(mentionTotal, mentions.filter(value => value === null).length)}`;
}

function responseSummary(api, json, args) {
  if (api === 'conversations.info' && json.channel) {
    const channel = json.channel;
    return [countSummary([channel]), channel.last_read != null ? `最終既読: ${channel.last_read}` : '',
      typeof channel.is_muted === 'boolean' ? `ミュート: ${channel.is_muted ? 'あり' : 'なし'}` : ''].filter(Boolean).join(' / ');
  }
  if (api === 'conversations.history') {
    return `履歴: ${json.messages?.length || 0}件${json.has_more || json.response_metadata?.next_cursor ? ' / 次ページあり' : ''}` +
      (args?.oldest ? ` / 最終既読以降: ${args.oldest}` : '');
  }
  const keys = ['channels', 'groups', 'ims', 'mpims'].filter(key => Array.isArray(json[key]));
  if (keys.length) {
    const channels = keys.flatMap(key => json[key].map(channel => key === 'ims' ? { ...channel, is_im: true } : channel));
    return keys.map(key => `${key}: ${json[key].length}件`).join(' / ') +
      ` / ${countSummary(channels)}` +
      (json.response_metadata?.next_cursor ? ' / 次ページあり' : '');
  }
  if (api === 'users.prefs.get') {
    if (!json.prefs || typeof json.prefs !== 'object') return 'ミュート設定: 未取得';
    const prefs = json.prefs || {};
    const ids = value => (typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [])
      .filter(id => typeof id === 'string').map(id => id.trim()).filter(Boolean);
    let notifications = prefs.all_notifications_prefs;
    if (typeof notifications === 'string') {
      try { notifications = JSON.parse(notifications); } catch (_) { notifications = null; }
    }
    const muted = new Set([...ids(prefs.muted_channels), ...ids(notifications?.muted_channels),
      ...Object.entries(notifications?.channels || {}).filter(([, value]) => value?.muted === true).map(([id]) => id)]);
    return `ミュート: ${muted.size}チャンネル${muted.size ? `（${[...muted].slice(0, 3).join(', ')}${muted.size > 3 ? ', …' : ''}）` : ''}`;
  }
  if (api === 'team.info' && json.team) {
    return `名前: ${json.team.name || '未取得'} / ID: ${json.team.id || '未取得'} / ドメイン: ${json.team.domain || '未取得'}`;
  }
  if (api === 'rtm.connect') {
    return `接続先取得 / ワークスペース: ${json.team?.id || '未取得'} / ユーザー: ${json.self?.id || '未取得'}`;
  }
  return '取得完了';
}

function rememberResponse(json) {
  for (const channel of [json.channel, ...['channels', 'groups', 'ims', 'mpims'].flatMap(key => Array.isArray(json[key]) ? json[key] : [])]) {
    if (channel?.id && (channel.name || channel.user)) channelNames.set(channel.id, channel.name ? `#${channel.name}` : `DM ${channel.user}`);
  }
  if (json.team?.id) workspaceName = `${json.team.name || 'ワークスペース'} (${json.team.id})`;
}

function getToken() {
  const version = tokenVersion;
  return new Promise(function(resolve, reject) {
    chrome.storage.sync.get({token: ''}, (items) => {
      if (version !== tokenVersion) {
        resolve(getToken());
        return;
      }
      if (items.token) {
        g.token = items.token;
        resolve(items.token);
      } else {
        g.token = '';
        reject('getToken failed');
      }
    });
  });
}

export async function send(api, args) {
  const entry = { api, target: requestTarget(api, args), channelId: typeof args?.channel === 'string' ? args.channel : null,
    version: tokenVersion, startedAt: Date.now(), finishedAt: null, status: 'running', summary: '' };
  syncHistory.unshift(entry);
  syncHistory.splice(30);
  try {
    // Share pacing between initial sync and background channel-name lookups.
    const spacing = ['users.conversations', 'conversations.info', 'conversations.history'].includes(api) ? 1300 : 0;
    const requestAt = Math.max(Date.now(), nextRequestAt.get(api) || 0);
    nextRequestAt.set(api, requestAt + spacing);
    while (true) {
      const delay = Math.max(requestAt, retryAfterAt.get(api) || 0) - Date.now();
      if (delay <= 0) break;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    if (!g.token) await getToken();
    const json = await sendInternal(api, args);
    entry.status = 'success';
    if (entry.version === tokenVersion) {
      rememberResponse(json);
      entry.target = requestTarget(api, args);
      for (const previous of syncHistory) {
        if (previous.channelId && previous.version === tokenVersion) previous.target = channelTarget(previous.channelId);
      }
    }
    entry.summary = responseSummary(api, json, args);
    return json;
  } catch (error) {
    entry.status = 'error';
    // Store only our own errors; never expose response bodies, URLs or tokens.
    entry.summary = typeof error === 'string' ? error : '通信エラー';
    throw error;
  } finally {
    entry.finishedAt = Date.now();
    entry.durationMs = entry.finishedAt - entry.startedAt;
  }
}

function sendInternal(api, args) {
  if (!g.token)
    return Promise.reject('invalid tokens');

  args = args || {};

  var formData = new FormData;
  formData.append('token', g.token);
  for (var k in args) {
    formData.append(k, args[k]);
  }

  return fetch('https://slack.com/api/' + api, {
    method: 'post',
    body: formData
  }).then(res => {
    if (res.status === 429) {
      const retrySeconds = Number(res.headers.get('retry-after')) || 60;
      retryAfterAt.set(api, Date.now() + retrySeconds * 1000);
      return Promise.reject('Slack API error: ratelimited');
    }
    if (!/^application\/json\b/i.test(res.headers.get('content-type') || ''))
      return Promise.reject('Slack API error: invalid_response');

    return res.json();
  }).then(json => {
    if (!json.ok) {
      return Promise.reject('Slack API error: ' + String(json.error || 'unknown_error').replace(/[^a-z_]/g, ''));
    }

    return json;
  });
}
