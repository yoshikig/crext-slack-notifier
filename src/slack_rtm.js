import { send, getSyncHistory } from "./slack_api.js";

let theInstance = null;
const stableConnectionMs = 11 * 60 * 1000;
const pongTimeoutMs = 60 * 1000;
const maxHistoryPages = 5;
const ignoredMessageSubtypes = new Set(['message_changed', 'message_deleted', 'message_replied',
  'channel_join', 'channel_leave', 'group_join', 'group_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'group_topic', 'group_purpose', 'group_name']);

function isUnreadMessage(message) {
  return message.type === 'message' && !ignoredMessageSubtypes.has(message.subtype) &&
    (!message.thread_ts || message.thread_ts === message.ts || message.subtype === 'thread_broadcast');
}

function compareTs(a, b) {
  const parse = value => {
    const match = String(value ?? '').match(/^(\d+)(?:\.(\d{1,6}))?$/);
    return match ? BigInt(match[1]) * 1000000n + BigInt((match[2] || '').padEnd(6, '0')) : null;
  };
  const left = parse(a), right = parse(b);
  return left === null || right === null ? null : left < right ? -1 : left > right ? 1 : 0;
}

function timestampAfter(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) return null;
  const microseconds = BigInt(match[1]) * 1000000n + BigInt((match[2] || '').padEnd(6, '0')) + 1n;
  return `${microseconds / 1000000n}.${String(microseconds % 1000000n).padStart(6, '0')}`;
}

function channelIds(value) {
  const values = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return values.filter(id => typeof id === 'string').map(id => id.trim()).filter(Boolean);
}

function notificationPrefs(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numericCount(...values) {
  for (const value of values) {
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

class SlackRtm {
    constructor() {
      if (theInstance) {
        throw new Error("You can only create one instance!");
      }
      theInstance = this;

      this.listeners = [];
      this.selfUserId = null;
      this.messageLedger = new Map();
      this.deletedChannels = new Set();
      this.deletionSyncPromise = null;
      this.currentRefreshChannel = null;
      this.unreadCounts = {};
      this.mentionCounts = {};
      this.mutedChannels = [];
      this.socket = null;
      this.webSocketId = 0;
      this.keepAliveIntervalId = null;
      this.reconnectTimerId = null;
      this.reconnectAttempt = 0;
      this.isConnecting = false;
      this.isRefreshingUnreadCounts = false;
      this.unreadRefreshPromise = null;
      this.pendingCountEvents = [];
      this.unreadRefreshId = 0;
      this.channelNames = {};
      this.nameLookupAttempts = {};
      this.nameLookupRunning = false;
      this.connectedAt = null;
      this.disconnectedAt = null;
      this.lastMessageAt = null;
      this.lastMessageType = null;
      this.nextReconnectAt = null;
      this.connectionError = '';
      this.lastUnreadSync = null;
      this.countsMethod = 'users.counts';
      this.countDetails = {};
      this.sessionId = 0;
      this.connectionGeneration = 0;
      this.lastPongAt = null;
      this.successfulSyncsSinceConnection = 0;
      this.httpSyncIntervalMinutes = 5;
      this.syncPolicyListeners = [];
      this.syncActivityListeners = [];
    }

    addListener(listener) {
        this.listeners.push(listener);
    }

    addSyncActivityListener(listener) {
      this.syncActivityListeners.push(listener);
    }

    addSyncPolicyListener(listener) {
      this.syncPolicyListeners.push(listener);
    }

    getSyncPolicy() {
      const connected = this.socket?.readyState === WebSocket.OPEN;
      const stable = connected && this.connectedAt !== null &&
        Date.now() - this.connectedAt >= stableConnectionMs;
      const healthy = connected && this.lastPongAt !== null && Date.now() - this.lastPongAt < pongTimeoutMs;
      const ready = stable && healthy && this.successfulSyncsSinceConnection >= 2;
      return {
        intervalMinutes: ready ? 30 : 5,
        successfulSyncsSinceConnection: this.successfulSyncsSinceConnection,
        reason: !connected ? 'WebSocket未接続' : !healthy ? 'pong受信待ち' :
          !stable ? '接続継続11分待ち' : this.successfulSyncsSinceConnection < 2 ?
          '接続後のHTTP同期成功2回待ち' : 'WebSocket安定・HTTP同期2回成功'
      };
    }

    #updateSyncPolicy() {
      const policy = this.getSyncPolicy();
      if (policy.intervalMinutes === this.httpSyncIntervalMinutes) return;
      this.httpSyncIntervalMinutes = policy.intervalMinutes;
      for (const listener of this.syncPolicyListeners) {
        try { listener(policy); } catch (error) { console.error('Sync policy listener error', error); }
      }
    }

    removeListener(listener) {
        this.listeners.splice(this.listeners.indexOf(listener), 1);
    }

    callListeners(unreadCount, mentionCount) {
        for (var i = 0; i < this.listeners.length; i++) {
            try {
                this.listeners[i](unreadCount, mentionCount);
            } catch(e) {
                console.error('SlackRtm listener error', e);
            }
        }
    }

    initialize() {
      this.#updateConfigs().catch(e => console.error('SlackRtm: failed to load preferences', e));
    }

    getDiagnostics() {
      const ids = new Set([...Object.keys(this.unreadCounts), ...Object.keys(this.mentionCounts), ...this.mutedChannels]);
      const channels = [...ids].map(id => ({
        id, name: this.channelNames[id] || null,
        unreadCount: this.unreadCounts[id] ?? null,
        mentionCount: this.mentionCounts[id] ?? null,
        unreadCountExact: this.countDetails[id]?.unreadCountExact !== false,
        mentionCountExact: this.countDetails[id]?.mentionCountExact !== false,
        countError: this.countDetails[id]?.error || '',
        muted: this.mutedChannels.includes(id)
      }));
      // Resolve missing names in small batches, only while the settings page is open.
      this.#resolveChannelNames(channels);
      return {
        capturedAt: Date.now(),
        connection: {
          state: this.socket?.readyState === WebSocket.OPEN ? 'connected' :
            this.isConnecting ? 'connecting' : this.reconnectTimerId ? 'reconnecting' : 'disconnected',
          connectedAt: this.connectedAt, disconnectedAt: this.disconnectedAt,
          lastMessageAt: this.lastMessageAt, lastMessageType: this.lastMessageType,
          nextReconnectAt: this.nextReconnectAt, reconnectAttempt: this.reconnectAttempt,
          lastPongAt: this.lastPongAt, error: this.connectionError
        },
        syncPolicy: this.getSyncPolicy(),
        refreshing: this.isRefreshingUnreadCounts,
        pendingEvents: this.pendingCountEvents.length,
        lastUnreadSync: this.lastUnreadSync ? { ...this.lastUnreadSync } : null,
        totals: channels.filter(c => !c.muted).reduce((sum, c) => ({
          unreadCount: sum.unreadCount + (c.unreadCount || 0),
          mentionCount: sum.mentionCount + (c.mentionCount || 0),
          unreadIncomplete: sum.unreadIncomplete || c.unreadCount === null || !c.unreadCountExact,
          mentionIncomplete: sum.mentionIncomplete || c.mentionCount === null || !c.mentionCountExact
        }), { unreadCount: 0, mentionCount: 0, unreadIncomplete: false, mentionIncomplete: false }),
        channels, syncHistory: getSyncHistory()
      };
    }

    async #resolveChannelNames(channels) {
      if (this.nameLookupRunning) return;
      const sessionId = this.sessionId;
      const targets = channels.filter(c => !c.name && (c.unreadCount > 0 || c.mentionCount > 0) &&
        Date.now() - (this.nameLookupAttempts[c.id] || 0) > 60000).slice(0, 5);
      this.nameLookupRunning = true;
      try {
        await Promise.all(targets.map(async c => {
          this.nameLookupAttempts[c.id] = Date.now();
          try {
            const { channel } = await send('conversations.info', { channel: c.id });
            if (sessionId === this.sessionId) this.channelNames[c.id] = channel.name || (channel.user ? `DM (${channel.user})` : c.id);
          } catch (_) {
            // Keep the ID visible when permissions do not allow name lookup.
          }
        }));
      } finally {
        this.nameLookupRunning = false;
      }
    }

    start() {
      // Initial counts must not depend on a successful WebSocket connection.
      const refresh = this.#refreshUnreadCounts();
      this.#startWebSocket();
      return refresh;
    }

    restart() {
      this.selfUserId = null;
      this.messageLedger.clear();
      this.deletedChannels.clear();
      this.deletionSyncPromise = null;
      this.currentRefreshChannel = null;
      this.sessionId += 1;
      this.connectionGeneration += 1;
      this.successfulSyncsSinceConnection = 0;
      this.lastPongAt = null;
      this.unreadRefreshId += 1;
      if (this.reconnectTimerId) clearTimeout(this.reconnectTimerId);
      if (this.keepAliveIntervalId) clearInterval(this.keepAliveIntervalId);
      const socket = this.socket;
      this.socket = null;
      if (socket) socket.close();
      this.#updateSyncPolicy();
      this.reconnectTimerId = this.keepAliveIntervalId = null;
      this.isConnecting = this.isRefreshingUnreadCounts = false;
      this.unreadRefreshPromise = null;
      this.pendingCountEvents = [];
      this.unreadCounts = {};
      this.mentionCounts = {};
      this.countDetails = {};
      this.channelNames = {};
      this.nameLookupAttempts = {};
      this.mutedChannels = [];
      this.lastUnreadSync = null;
      this.countsMethod = 'users.counts';
      this.connectedAt = this.disconnectedAt = this.lastMessageAt = this.nextReconnectAt = null;
      this.lastMessageType = null;
      this.connectionError = '';
      this.reconnectAttempt = 0;
      this.initialize();
      return this.start();
    }

    forceUpdate() {
      this.#updateUnreadCount();
    }

    refresh() {
      return this.#refreshUnreadCounts();
    }

    #startKeepAlive() {
      if (this.keepAliveIntervalId) {
        clearInterval(this.keepAliveIntervalId);
      }
      this.keepAliveIntervalId = setInterval(() => {
        if (Date.now() - (this.lastPongAt ?? this.connectedAt) >= pongTimeoutMs) {
          this.socket?.close();
          return;
        }
        this.sendPing();
        this.#updateSyncPolicy();
      }, 20 * 1000);
    }

    #updateUnreadCount() {
      var unreadCount = 0;
      var mentionCount = 0;
      for (var k in this.unreadCounts) {
        if (!this.mutedChannels.includes(k)) {
          unreadCount += this.unreadCounts[k] || 0;
        }
      }
      for (var k in this.mentionCounts) {
        if (!this.mutedChannels.includes(k)) {
          mentionCount += this.mentionCounts[k] || 0;
        }
      }
      this.callListeners(unreadCount, mentionCount);
    }

    #isCountEvent(json) {
      return json.type === 'channel_marked' ||
        json.type === 'group_marked' ||
        json.type === 'im_marked' ||
        json.type === 'message';
    }

    #markUncertain(channel, reason, unread = true) {
      const detail = this.countDetails[channel] ||= {};
      if (unread) detail.unreadCountExact = false;
      detail.mentionCountExact = false;
      detail.error = reason;
      this.successfulSyncsSinceConnection = 0;
      this.#updateSyncPolicy();
    }

    #contribution(message, channel) {
      const detail = this.countDetails[channel] || {};
      const direct = detail.isDirectMessage || message.channel_type === 'im' ||
        message.channel_type === 'mpim' || channel.startsWith('D');
      if (!isUnreadMessage({ ...message, type: 'message' }) ||
          (this.selfUserId && message.user === this.selfUserId)) return { unread: 0, mention: 0 };
      const text = (typeof message.text === 'string' ? message.text : '').replace(/\`\`\`[\s\S]*?\`\`\`|\`[^\`]*\`/g, '');
      const richMentions = [];
      let richBroadcast = false;
      const visit = node => {
        if (!node || typeof node !== 'object' || node.style?.code) return;
        if (node.type === 'user' && typeof node.user_id === 'string') richMentions.push(node.user_id);
        if (node.type === 'broadcast' || node.type === 'usergroup') richBroadcast = true;
        if (node.type === 'rich_text_preformatted' || node.type === 'rich_text_inline_code') return;
        for (const key of ['elements', 'blocks']) if (Array.isArray(node[key])) node[key].forEach(visit);
      };
      if (Array.isArray(message.blocks)) message.blocks.forEach(visit);
      const mentions = [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)];
      const unresolved = !direct && ((!this.selfUserId && (mentions.length > 0 || richMentions.length > 0)) ||
        /<!subteam\^|<!(?:here|channel|everyone)(?:[>|])/.test(text) || richBroadcast);
      return { unread: 1, mention: direct || mentions.some(match => match[1] === this.selfUserId) || richMentions.includes(this.selfUserId) ? 1 : 0,
        unresolved };
    }

    #rememberMessage(channel, ts, entry) {
      if (compareTs(ts, ts) === null) return;
      this.messageLedger.set(channel + ':' + ts, { channel, ts, ...entry });
      // Bound memory; an eventual deletion of an evicted message is marked uncertain.
      if (this.messageLedger.size > 10000) this.messageLedger.delete(this.messageLedger.keys().next().value);
    }

    #changeCount(channel, field, delta) {
      if (!delta) return;
      const counts = field === 'unread' ? this.unreadCounts : this.mentionCounts;
      if (typeof counts[channel] === 'number') counts[channel] = Math.max(0, counts[channel] + delta);
      else if (delta > 0) {
        counts[channel] = delta;
        const detail = this.countDetails[channel] ||= {};
        detail[field === 'unread' ? 'unreadCountExact' : 'mentionCountExact'] = false;
      }
    }

    #applyMessageEvent(json, includedInSnapshot = false) {
      const channel = json.channel;
      const detail = this.countDetails[channel] ||= {};
      if (json.channel_type === 'im' || json.channel_type === 'mpim') detail.isDirectMessage = true;
      const deletion = json.subtype === 'message_deleted';
      const edit = json.subtype === 'message_changed';
      const message = edit ? json.message : json;
      const ts = deletion ? json.deleted_ts : message?.ts;
      if ((deletion || edit) && compareTs(ts, ts) === null) return false;
      const key = channel + ':' + ts;
      let previous = this.messageLedger.get(key);
      if (previous?.deleted) return false;
      if (deletion || edit) {
        if (!previous && json.previous_message && compareTs(ts, detail.lastRead) !== null) {
          const contribution = this.#contribution(json.previous_message, channel);
          previous = { ...contribution, counted: compareTs(ts, detail.lastRead) > 0 };
        }
        if (!previous || previous.counted === null) {
          // deleted_ts alone cannot tell whether the deleted item was unread or a mention.
          if (compareTs(ts, detail.lastRead) !== null && compareTs(ts, detail.lastRead) <= 0) return false;
          this.#markUncertain(channel, '編集・削除されたメッセージの元の未読状態が不明です');
          if (deletion) this.#rememberMessage(channel, ts, { deleted: true, counted: false });
          return true;
        }
        const next = deletion ? { unread: 0, mention: 0 } : this.#contribution(message, channel);
        if (previous.counted) {
          this.#changeCount(channel, 'unread', next.unread - previous.unread);
          this.#changeCount(channel, 'mention', next.mention - previous.mention);
        }
        if (previous.unresolved || next.unresolved) this.#markUncertain(channel, '通知設定・ユーザーグループのメンション判定が未確定です', false);
        this.#rememberMessage(channel, ts, { ...next, counted: previous.counted, deleted: deletion });
        return true;
      }
      if (!isUnreadMessage(json) || previous) return false;
      const contribution = this.#contribution(json, channel);
      const alreadyRead = compareTs(ts, detail.lastRead) !== null && compareTs(ts, detail.lastRead) <= 0;
      const snapshotIncludes = includedInSnapshot ||
        (compareTs(ts, detail.snapshotLatest) !== null && compareTs(ts, detail.snapshotLatest) <= 0);
      const counted = !alreadyRead && contribution.unread > 0;
      if (counted && !snapshotIncludes) {
        this.#changeCount(channel, 'unread', contribution.unread);
        this.#changeCount(channel, 'mention', contribution.mention);
      }
      this.#rememberMessage(channel, ts, { ...contribution,
        counted: snapshotIncludes && detail.lastRead == null ? null : counted });
      if (contribution.unresolved) this.#markUncertain(channel, '通知設定・ユーザーグループのメンション判定が未確定です', false);
      return counted;
    }

    #scheduleDeletionSync(channel) {
      this.deletedChannels.add(channel);
      if (this.deletionSyncPromise) return;
      const sessionId = this.sessionId;
      const promise = Promise.resolve().then(async () => {
        while (sessionId === this.sessionId && this.deletedChannels.size) {
          while (sessionId === this.sessionId && this.unreadRefreshPromise) await this.unreadRefreshPromise;
          if (sessionId !== this.sessionId) return;
          const channel = this.deletedChannels.values().next().value;
          if (!channel) return;
          this.deletedChannels.delete(channel);
          await this.#refreshUnreadCounts(channel);
        }
      }).catch(error => console.error('Deletion HTTP sync failed', error)).finally(() => {
        if (this.deletionSyncPromise === promise) {
          this.deletionSyncPromise = null;
          const next = this.deletedChannels.values().next().value;
          if (next) this.#scheduleDeletionSync(next);
        }
      });
      this.deletionSyncPromise = promise;
    }

    #handleMessage(json, updateListeners = true, scheduleDeletion = true) {
      if (this.#isCountEvent(json) && typeof json.channel !== 'string') return;
      if (scheduleDeletion && json.type === 'message' && json.subtype === 'message_deleted' &&
          compareTs(json.deleted_ts, json.deleted_ts) !== null) this.#scheduleDeletionSync(json.channel);
      if (this.isRefreshingUnreadCounts && this.#isCountEvent(json)) {
        this.pendingCountEvents.push(json);
        return;
      }

      let countChanged = false;
      if (json.type === 'channel_marked' || json.type === 'group_marked') {
        console.log(json);
        this.unreadCounts[json.channel] = numericCount(json.unread_count_display, json.unread_count);
        this.mentionCounts[json.channel] = numericCount(json.mention_count_display, json.mention_count);
        this.countDetails[json.channel] = { ...this.countDetails[json.channel], unreadCountExact: true,
          mentionCountExact: true, error: '', lastRead: json.ts || this.countDetails[json.channel]?.lastRead };
        for (const entry of this.messageLedger.values()) {
          if (entry.channel === json.channel && compareTs(entry.ts, json.ts) !== null &&
              compareTs(entry.ts, json.ts) <= 0) entry.counted = false;
        }
        countChanged = true;
      } else if (json.type === 'im_marked') {
        console.log(json);
        this.unreadCounts[json.channel] = numericCount(json.unread_count_display, json.unread_count, json.dm_count);
        this.mentionCounts[json.channel] = numericCount(json.dm_count, json.mention_count_display, json.mention_count);
        this.countDetails[json.channel] = { ...this.countDetails[json.channel], unreadCountExact: true,
          mentionCountExact: true, error: '', lastRead: json.ts || this.countDetails[json.channel]?.lastRead };
        for (const entry of this.messageLedger.values()) {
          if (entry.channel === json.channel && compareTs(entry.ts, json.ts) !== null &&
              compareTs(entry.ts, json.ts) <= 0) entry.counted = false;
        }
        countChanged = true;
      } else if (json.type === 'message') {
        countChanged = this.#applyMessageEvent(json);
      } else if (json.type === 'pref_change') {
        if (json.name === 'all_notifications_prefs') {
          const json2 = notificationPrefs(json.value);
          if ('muted_channels' in json2 || json2.channels) {
            this.#mutedChannelsChanged(this.#getMutedChannels(json2));
          }
        }
        console.log(json);
      } else if (json.type === 'pong') {
        // ignore pong messages
      } else {
        console.log(json);
      }

      if (countChanged && updateListeners) {
        this.#updateUnreadCount();
      }
    }

    #refreshUnreadCounts(channel = null) {
      if (this.unreadRefreshPromise) {
        if (channel === null && this.currentRefreshChannel !== null) {
          return this.unreadRefreshPromise.then(() => this.#refreshUnreadCounts());
        }
        return this.unreadRefreshPromise;
      }
      this.currentRefreshChannel = channel;
      const promise = this.#performUnreadRefresh(channel).finally(() => {
        if (this.unreadRefreshPromise === promise) {
          this.unreadRefreshPromise = null;
          this.currentRefreshChannel = null;
        }
      });
      this.unreadRefreshPromise = promise;
      for (const listener of this.syncActivityListeners) {
        try { listener(promise); } catch (error) { console.error('HTTP sync listener failed', error); }
      }
      return promise;
    }

    async #performUnreadRefresh(targetChannel = null) {
      const refreshId = ++this.unreadRefreshId;
      const connectionGeneration = this.socket?.readyState === WebSocket.OPEN ? this.connectionGeneration : null;
      this.isRefreshingUnreadCounts = true;
      this.pendingCountEvents = [];
      this.lastUnreadSync = { startedAt: Date.now(), finishedAt: null, status: 'running', source: targetChannel ? 'conversations.info' : this.countsMethod, targetChannel, reason: targetChannel ? 'message_deleted' : 'periodic/manual', error: '', warning: '' };

      try {
        let json;
        if (targetChannel) {
          const result = await send('conversations.info', { channel: targetChannel, include_num_members: false });
          if (refreshId !== this.unreadRefreshId) return;
          if (!result.channel || result.channel.id !== targetChannel) throw new Error('対象チャンネル情報が応答にありません');
          const info = { ...result.channel,
            is_im: result.channel.is_im || targetChannel.startsWith('D'),
            is_mpim: result.channel.is_mpim || (this.countDetails[targetChannel]?.isDirectMessage && !targetChannel.startsWith('D')) };
          const warning = await this.#completeConversationCount(info, refreshId);
          json = { channels: [info], warning };
        } else if (this.countsMethod === 'users.counts') {
          try {
            json = await send('users.counts');
          } catch (error) {
            if (refreshId !== this.unreadRefreshId) return;
            if (!/not_allowed_token_type|missing_scope|unknown_method|method_deprecated/.test(String(error))) throw error;
            this.countsMethod = 'conversations';
          }
        }
        if (refreshId !== this.unreadRefreshId) return;
        if (!json) json = await this.#fetchConversationCounts(refreshId);
        if (refreshId !== this.unreadRefreshId) return;
        if (!['channels', 'groups', 'ims', 'mpims'].some(key => Array.isArray(json[key]))) {
          throw new Error('未読データが応答に含まれていません');
        }
        const unreadCounts = targetChannel ? { ...this.unreadCounts } : {};
        const mentionCounts = targetChannel ? { ...this.mentionCounts } : {};
        const countDetails = targetChannel ? { ...this.countDetails } : {};
        const entries = [...(json.channels || []), ...(json.groups || []), ...(json.mpims || []).map(im => ({ ...im, is_mpim: true })),
          ...(json.ims || []).map(im => ({ ...im, is_im: true }))];

        for (const channel of entries) {
          if (!channel.id || channel.is_archived) continue;
          let unread = numericCount(channel.unread_count_display, channel.unread_count, channel.is_im ? channel.dm_count : null);
          let exact = channel.unreadCountExact !== false;
          if (unread === null && typeof channel.has_unreads === 'boolean') {
            unread = channel.has_unreads ? 1 : 0;
            exact = !channel.has_unreads;
          }
          unreadCounts[channel.id] = unread;
          mentionCounts[channel.id] = numericCount(channel.mention_count_display, channel.mention_count, channel.is_im ? channel.dm_count : null);
          const latest = typeof channel.latest === 'object' ? channel.latest?.ts : channel.latest;
          countDetails[channel.id] = { unreadCountExact: exact, error: channel.countError || '',
            snapshotLatest: channel.snapshotLatest || latest || null,
            lastRead: compareTs(channel.last_read, channel.last_read) !== null ? channel.last_read : null,
            isDirectMessage: Boolean(channel.is_im || channel.is_mpim) };
          if (unread === null) countDetails[channel.id].error ||= 'このTokenでは未読数・最終既読時刻が取得できません';
        }

        if (refreshId === this.unreadRefreshId) {
          this.unreadCounts = unreadCounts;
          this.mentionCounts = mentionCounts;
          this.countDetails = countDetails;
          for (const entry of this.messageLedger.values()) {
            const detail = countDetails[entry.channel];
            if (!detail || entry.deleted) continue;
            const read = compareTs(entry.ts, detail.lastRead);
            const included = compareTs(entry.ts, detail.snapshotLatest);
            entry.counted = read !== null ? read > 0 && entry.unread > 0 : included !== null && included <= 0 ? null : entry.counted;
          }
          for (const channel of entries) {
            if (channel.name) this.channelNames[channel.id] = channel.name;
          }
          this.lastUnreadSync.source = targetChannel ? 'conversations.info' : this.countsMethod;
          const unknown = Object.values(unreadCounts).filter(value => value === null).length;
          this.lastUnreadSync.status = unknown || json.warning ? 'partial' : 'success';
          this.lastUnreadSync.warning = [json.warning, unknown ? `${unknown}チャンネルの未読数が未取得です。Tokenの種類・権限を確認してください。` : ''].filter(Boolean).join(' / ');
        }
      } catch (e) {
        if (refreshId === this.unreadRefreshId) {
          if (targetChannel) this.#markUncertain(targetChannel, '削除後のHTTP再取得に失敗しました');
          this.lastUnreadSync.status = 'error';
          this.lastUnreadSync.error = typeof e === 'string' ? e : e.message || '通信エラー';
        }
        console.error('SlackRtm: failed to refresh unread counts', e);
      } finally {
        if (refreshId !== this.unreadRefreshId) {
          return;
        }

        this.isRefreshingUnreadCounts = false;
        this.lastUnreadSync.finishedAt = Date.now();
        const pendingCountEvents = this.pendingCountEvents;
        this.pendingCountEvents = [];
        const markedChannels = new Set(pendingCountEvents.filter(event => event.type.endsWith('_marked')).map(event => event.channel));
        for (const event of pendingCountEvents) {
          // A channel snapshot may already include messages received during HTTP sync.
          const snapshotLatest = this.countDetails[event.channel]?.snapshotLatest;
          if (event.type === 'message' && isUnreadMessage(event) && !markedChannels.has(event.channel) && snapshotLatest &&
              compareTs(event.event_ts || event.ts, snapshotLatest) !== null &&
              compareTs(event.event_ts || event.ts, snapshotLatest) <= 0) {
            this.#applyMessageEvent(event, true);
            continue;
          }
          this.#handleMessage(event, false, false);
        }
        if (!targetChannel && connectionGeneration !== null && connectionGeneration === this.connectionGeneration &&
            this.socket?.readyState === WebSocket.OPEN) {
          const complete = this.lastUnreadSync.status === 'success' &&
            Object.values(this.countDetails).every(detail => detail.unreadCountExact && !detail.error);
          this.successfulSyncsSinceConnection = complete ? this.successfulSyncsSinceConnection + 1 : 0;
        }
        this.#updateSyncPolicy();
        this.#updateUnreadCount();
      }
    }

    async #fetchConversationCounts(refreshId) {
      const channels = new Map();
      const warnings = [];
      this.lastUnreadSync.source = 'conversations';
      for (const type of ['public_channel', 'private_channel', 'mpim', 'im']) {
        let cursor = '';
        const seenCursors = new Set();
        try {
          do {
            if (refreshId !== this.unreadRefreshId) return { channels: [] };
            const page = await send('users.conversations', { types: type, exclude_archived: true, limit: 200, cursor });
            if (!Array.isArray(page.channels)) throw new Error('チャンネル一覧が応答にありません');
            for (const channel of page.channels) {
              if (channel.id && !channel.is_archived) channels.set(channel.id, { ...channel, is_im: type === 'im' || channel.is_im, is_mpim: type === 'mpim' || Boolean(channel.is_mpim) });
            }
            cursor = typeof page.response_metadata?.next_cursor === 'string' ? page.response_metadata.next_cursor.trim() : '';
            if (cursor && seenCursors.has(cursor)) throw new Error('チャンネル一覧のページ取得が進みません');
            seenCursors.add(cursor);
          } while (cursor);
        } catch (error) {
          if (!/missing_scope|no_permission|invalid_types/.test(String(error))) throw error;
          warnings.push(`${type}: 取得権限不足`);
        }
      }
      if (warnings.length === 4) throw new Error('チャンネル一覧の取得権限がありません');
      let completed = 0;
      for (const [id, channel] of channels) {
        if (refreshId !== this.unreadRefreshId) return { channels: [] };
        this.lastUnreadSync.progress = `${completed} / ${channels.size}チャンネル`;
        let info = channel;
        try {
          if (numericCount(channel.unread_count_display, channel.unread_count) === null) {
            const json = await send('conversations.info', { channel: id });
            if (!json.channel) throw new Error('チャンネル情報が応答にありません');
            info = { ...channel, ...json.channel };
          }
          const warning = await this.#completeConversationCount(info, refreshId);
          if (warning) warnings.push(warning);
        } catch (error) {
          if (/ratelimited|invalid_auth|token_revoked|token_expired/.test(String(error))) throw error;
          info.countError = typeof error === 'string' ? error : error.message;
        }
        channels.set(id, info);
        completed += 1;
        if (refreshId === this.unreadRefreshId) this.lastUnreadSync.progress = `${completed} / ${channels.size}チャンネル`;
      }
      return { channels: [...channels.values()], warning: warnings.join(' / ') };
    }

    async #completeConversationCount(info, refreshId) {
      if (numericCount(info.unread_count_display, info.unread_count, info.is_im ? info.dm_count : null) !== null ||
          typeof info.has_unreads === 'boolean' || compareTs(info.last_read, info.last_read) === null) return '';
      const latest = typeof info.latest === 'object' ? info.latest?.ts : info.latest;
      if (compareTs(latest, info.last_read) !== null && compareTs(latest, info.last_read) <= 0) info.unread_count = 0;
      else {
        const history = await this.#countHistorySinceRead(info.id, info.last_read, refreshId, latest);
        if (history) {
          info.unread_count = history.count;
          info.snapshotLatest = history.snapshotLatest;
          info.unreadCountExact = history.exact;
          if (!history.exact) {
            info.countError = '履歴取得上限（5ページ）に達したため、未読数は下限値です';
            return `${info.id}: 履歴取得上限に到達（未読${history.count}件以上）`;
          }
        }
      }
      return '';
    }

    async #countHistorySinceRead(channel, lastRead, refreshId, snapshotLatest) {
      let cursor = '';
      snapshotLatest = timestampAfter(snapshotLatest) ? String(snapshotLatest) : String(Date.now() / 1000);
      const upperBound = timestampAfter(snapshotLatest);
      let latest = upperBound;
      let count = 0;
      const seenPages = new Set();
      let pages = 0;
      do {
        if (refreshId !== this.unreadRefreshId) return null;
        const args = { channel, oldest: lastRead, inclusive: false, limit: 200, cursor };
        if (latest) args.latest = latest;
        const page = await send('conversations.history', args);
        if (!Array.isArray(page.messages)) throw new Error('メッセージ履歴が応答にありません');
        count += page.messages.filter(isUnreadMessage).length;
        cursor = typeof page.response_metadata?.next_cursor === 'string' ? page.response_metadata.next_cursor.trim() : '';
        latest = cursor ? upperBound : page.has_more ? page.messages.at(-1)?.ts : undefined;
        const pageKey = cursor || (page.has_more ? latest : undefined);
        if ((page.has_more && !pageKey) || (pageKey && seenPages.has(pageKey))) throw new Error('未読履歴のページ取得が進みません');
        if (pageKey) seenPages.add(pageKey);
        pages += 1;
        if (pages >= maxHistoryPages && (cursor || page.has_more)) {
          return { count, snapshotLatest, exact: false };
        }
      } while (cursor || latest);
      return { count, snapshotLatest, exact: true };
    }

    #scheduleReconnect() {
      if (this.reconnectTimerId || this.isConnecting) {
        return;
      }

      const delay = Math.min(1000 * (2 ** this.reconnectAttempt), 30 * 1000);
      this.reconnectAttempt += 1;
      this.nextReconnectAt = Date.now() + delay;
      console.info(`SlackRtm: reconnecting in ${delay}ms`);
      this.reconnectTimerId = setTimeout(() => {
        this.reconnectTimerId = null;
        this.nextReconnectAt = null;
        this.#startWebSocket();
      }, delay);
    }

    async #startWebSocket() {
      if (this.isConnecting ||
          (this.socket && (this.socket.readyState === WebSocket.OPEN ||
                           this.socket.readyState === WebSocket.CONNECTING))) {
        return;
      }

      this.isConnecting = true;
      const sessionId = this.sessionId;
      let socket;
      try {
        const json = await send('rtm.connect');
        if (sessionId !== this.sessionId) return;
        this.selfUserId = typeof json.self?.id === 'string' ? json.self.id : null;
        socket = new WebSocket(json.url);
        this.socket = socket;
      } catch (e) {
        if (sessionId !== this.sessionId) return;
        this.isConnecting = false;
        this.connectionError = `WebSocket接続先の取得に失敗しました: ${typeof e === 'string' ? e : '通信エラー'}`;
        console.error('SlackRtm: failed to connect websocket', e);
        if (!/not_allowed_token_type|missing_scope|method_deprecated|invalid_auth|token_revoked/.test(String(e))) {
          this.#scheduleReconnect();
        }
        return;
      }

      socket.onopen = (() => {
        if (this.socket !== socket) {
          return;
        }

        this.isConnecting = false;
        this.reconnectAttempt = 0;
        this.connectionGeneration += 1;
        this.successfulSyncsSinceConnection = 0;
        this.lastPongAt = null;
        this.connectedAt = Date.now();
        this.#updateSyncPolicy();
        this.connectionError = '';
        this.#startKeepAlive();
        // A pre-connection request must finish before starting the connection's first sync.
        const pending = this.unreadRefreshPromise;
        Promise.resolve(pending).then(() => {
          if (this.socket === socket && socket.readyState === WebSocket.OPEN) this.#refreshUnreadCounts();
        });
      });
      socket.onmessage = ((e) => {
        if (this.socket !== socket) return;
        var json = null;
        try {
          json = JSON.parse(e.data);
        } catch(e) {
          console.error('SlackRtm: JSON parse error', e);
        }

        if (!json) {
          console.error('SlackRtm: invalid message', e.data);
          return;
        }

        this.lastMessageAt = Date.now();
        this.lastMessageType = json.type || 'unknown';
        if (json.type === 'pong') {
          this.lastPongAt = Date.now();
          this.#updateSyncPolicy();
        }
        this.#handleMessage(json);
      });
      socket.onerror = ((e) => {
        if (this.socket === socket) this.connectionError = 'WebSocket通信エラー';
        console.info('websocket error');
      });
      socket.onclose = ((e) => {
        console.info('websocket close');
        if (this.socket !== socket) {
          return;
        }

        this.socket = null;
        this.connectionGeneration += 1;
        this.successfulSyncsSinceConnection = 0;
        this.lastPongAt = null;
        this.#updateSyncPolicy();
        this.#refreshUnreadCounts();
        this.disconnectedAt = Date.now();
        this.connectionError = `接続終了 (code: ${e.code})`;
        this.isConnecting = false;
        // HTTP sync also works while disconnected; keep any in-flight result.
        if (this.keepAliveIntervalId) {
          clearInterval(this.keepAliveIntervalId);
          this.keepAliveIntervalId = null;
        }
        this.#scheduleReconnect();
      });
    }

    sendPing() {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ id: this.webSocketId++, type: 'ping' }));
      }
    }

    async #updateConfigs() {
      const sessionId = this.sessionId;
      const json = await send('users.prefs.get');
      if (sessionId !== this.sessionId) return;
      if (json.ok && json.prefs) {
        const mutedChannels = [...channelIds(json.prefs.muted_channels),
          ...this.#getMutedChannels(notificationPrefs(json.prefs.all_notifications_prefs))];
        this.#mutedChannelsChanged(mutedChannels);

        console.log('muted channels updated:', mutedChannels);
      } else {
        console.error('users.prefs.get failed', json);
      }
    }

    #getMutedChannels(prefs) {
      return [...channelIds(prefs.muted_channels),
        ...Object.entries(notificationPrefs(prefs.channels)).filter(([, value]) => value?.muted === true).map(([id]) => id)];
    }

    #mutedChannelsChanged(allMutedChannels) {
      this.mutedChannels = [...new Set(channelIds(allMutedChannels))];
      this.#updateUnreadCount();
    }
}

// Singleton instance
const slackInstance = Object.seal(new SlackRtm());
export default slackInstance;
