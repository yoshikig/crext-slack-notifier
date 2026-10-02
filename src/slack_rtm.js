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
    }

    addListener(listener) {
        this.listeners.push(listener);
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
          mentionIncomplete: sum.mentionIncomplete || c.mentionCount === null
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

    #handleMessage(json, updateListeners = true) {
      if (this.#isCountEvent(json) && typeof json.channel !== 'string') return;
      if (this.isRefreshingUnreadCounts && this.#isCountEvent(json)) {
        this.pendingCountEvents.push(json);
        return;
      }

      let countChanged = false;
      if (json.type === 'channel_marked' || json.type === 'group_marked') {
        console.log(json);
        this.unreadCounts[json.channel] = numericCount(json.unread_count_display, json.unread_count);
        this.mentionCounts[json.channel] = numericCount(json.mention_count_display, json.mention_count);
        this.countDetails[json.channel] = { unreadCountExact: true };
        countChanged = true;
      } else if (json.type === 'im_marked') {
        console.log(json);
        this.unreadCounts[json.channel] = numericCount(json.unread_count_display, json.unread_count, json.dm_count);
        this.mentionCounts[json.channel] = numericCount(json.dm_count, json.mention_count_display, json.mention_count);
        this.countDetails[json.channel] = { unreadCountExact: true };
        countChanged = true;
      } else if (json.type === 'message') {
        if (!isUnreadMessage(json)) return;
        console.log(json);
        if (typeof this.unreadCounts[json.channel] === 'number') {
          // If the channel already exists, increment the count
          this.unreadCounts[json.channel] += 1;
        } else {
          // If the channel doesn't exist, create it
          this.unreadCounts[json.channel] = 1;
          this.countDetails[json.channel] = { unreadCountExact: false };
        }
        countChanged = true;
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

    #refreshUnreadCounts() {
      if (this.unreadRefreshPromise) return this.unreadRefreshPromise;
      const promise = this.#performUnreadRefresh().finally(() => {
        if (this.unreadRefreshPromise === promise) this.unreadRefreshPromise = null;
      });
      this.unreadRefreshPromise = promise;
      return promise;
    }

    async #performUnreadRefresh() {
      const refreshId = ++this.unreadRefreshId;
      const connectionGeneration = this.socket?.readyState === WebSocket.OPEN ? this.connectionGeneration : null;
      this.isRefreshingUnreadCounts = true;
      this.pendingCountEvents = [];
      this.lastUnreadSync = { startedAt: Date.now(), finishedAt: null, status: 'running', source: this.countsMethod, error: '', warning: '' };

      try {
        let json;
        if (this.countsMethod === 'users.counts') {
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
        const unreadCounts = {};
        const mentionCounts = {};
        const countDetails = {};
        const entries = [...(json.channels || []), ...(json.groups || []), ...(json.mpims || []),
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
            snapshotLatest: channel.snapshotLatest || latest || null };
          if (unread === null) countDetails[channel.id].error ||= 'このTokenでは未読数・最終既読時刻が取得できません';
        }

        if (refreshId === this.unreadRefreshId) {
          this.unreadCounts = unreadCounts;
          this.mentionCounts = mentionCounts;
          this.countDetails = countDetails;
          for (const channel of entries) {
            if (channel.name) this.channelNames[channel.id] = channel.name;
          }
          this.lastUnreadSync.source = this.countsMethod;
          const unknown = Object.values(unreadCounts).filter(value => value === null).length;
          this.lastUnreadSync.status = unknown || json.warning ? 'partial' : 'success';
          this.lastUnreadSync.warning = [json.warning, unknown ? `${unknown}チャンネルの未読数が未取得です。Tokenの種類・権限を確認してください。` : ''].filter(Boolean).join(' / ');
        }
      } catch (e) {
        if (refreshId === this.unreadRefreshId) {
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
          if (event.type === 'message' && !markedChannels.has(event.channel) && snapshotLatest &&
              event.ts && Number(event.ts) <= Number(snapshotLatest)) continue;
          this.#handleMessage(event, false);
        }
        if (connectionGeneration !== null && connectionGeneration === this.connectionGeneration &&
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
              if (channel.id && !channel.is_archived) channels.set(channel.id, { ...channel, is_im: type === 'im' || channel.is_im });
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
          if (numericCount(info.unread_count_display, info.unread_count, info.is_im ? info.dm_count : null) === null &&
              typeof info.has_unreads !== 'boolean' && /^\d+(\.\d+)?$/.test(String(info.last_read ?? ''))) {
            const latest = typeof info.latest === 'object' ? info.latest?.ts : info.latest;
            if (latest != null && Number(latest) <= Number(info.last_read)) info.unread_count = 0;
            else {
              const history = await this.#countHistorySinceRead(id, info.last_read, refreshId, latest);
              if (history) {
                info.unread_count = history.count;
                info.snapshotLatest = history.snapshotLatest;
                info.unreadCountExact = history.exact;
                if (!history.exact) {
                  info.countError = '履歴取得上限（5ページ）に達したため、未読数は下限値です';
                  warnings.push(`${id}: 履歴取得上限に到達（未読${history.count}件以上）`);
                }
              }
            }
          }
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
