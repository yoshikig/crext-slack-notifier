import { send } from "./slack_api.js";

let theInstance = null;

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
      this.pendingCountEvents = [];
      this.unreadRefreshId = 0;
    }

    addListener(listener) {
        this.listeners.push(listener);
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
      this.#updateConfigs();
    }

    start() {
      this.#startWebSocket();
    }

    forceUpdate() {
      this.#updateUnreadCount();
    }

    #startKeepAlive() {
      if (this.keepAliveIntervalId) {
        clearInterval(this.keepAliveIntervalId);
      }
      this.keepAliveIntervalId = setInterval(() => {
        this.sendPing();
      }, 20 * 1000);
    }

    #updateUnreadCount() {
      var unreadCount = 0;
      var mentionCount = 0;
      for (var k in this.unreadCounts) {
        if (!this.mutedChannels.includes(k)) {
          unreadCount += this.unreadCounts[k];
        }
      }
      for (var k in this.mentionCounts) {
        if (!this.mutedChannels.includes(k)) {
          mentionCount += this.mentionCounts[k];
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
      if (this.isRefreshingUnreadCounts && this.#isCountEvent(json)) {
        this.pendingCountEvents.push(json);
        return;
      }

      let countChanged = false;
      if (json.type === 'channel_marked' || json.type === 'group_marked') {
        console.log(json);
        this.unreadCounts[json.channel] = json.unread_count_display;
        this.mentionCounts[json.channel] = json.mention_count_display;
        countChanged = true;
      } else if (json.type === 'im_marked') {
        console.log(json);
        this.mentionCounts[json.channel] = json.dm_count;
        countChanged = true;
      } else if (json.type === 'message') {
        console.log(json);
        if (json.channel in this.unreadCounts) {
          // If the channel already exists, increment the count
          this.unreadCounts[json.channel] += 1;
        } else {
          // If the channel doesn't exist, create it
          this.unreadCounts[json.channel] = 1;
        }
        countChanged = true;
      } else if (json.type === 'pref_change') {
        if (json.name === 'all_notifications_prefs') {
          const json2 = JSON.parse(json.value);
          if (json2.muted_channels) {
            this.#mutedChannelsChanged(json2.muted_channels);
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

    async #refreshUnreadCounts() {
      const refreshId = ++this.unreadRefreshId;
      this.isRefreshingUnreadCounts = true;
      this.pendingCountEvents = [];

      try {
        const json = await send('users.counts');
        const unreadCounts = {};
        const mentionCounts = {};

        for (const channel of json.channels || []) {
          unreadCounts[channel.id] = channel.unread_count_display || 0;
          mentionCounts[channel.id] = channel.mention_count_display || 0;
        }
        for (const group of json.groups || []) {
          unreadCounts[group.id] = group.unread_count_display || 0;
          mentionCounts[group.id] = group.mention_count_display || 0;
        }
        for (const im of json.ims || []) {
          mentionCounts[im.id] = im.dm_count || 0;
        }

        if (refreshId === this.unreadRefreshId) {
          this.unreadCounts = unreadCounts;
          this.mentionCounts = mentionCounts;
        }
      } catch (e) {
        console.error('SlackRtm: failed to refresh unread counts', e);
      } finally {
        if (refreshId !== this.unreadRefreshId) {
          return;
        }

        this.isRefreshingUnreadCounts = false;
        const pendingCountEvents = this.pendingCountEvents;
        this.pendingCountEvents = [];
        for (const event of pendingCountEvents) {
          this.#handleMessage(event, false);
        }
        this.#updateUnreadCount();
      }
    }

    #scheduleReconnect() {
      if (this.reconnectTimerId || this.isConnecting) {
        return;
      }

      const delay = Math.min(1000 * (2 ** this.reconnectAttempt), 30 * 1000);
      this.reconnectAttempt += 1;
      console.info(`SlackRtm: reconnecting in ${delay}ms`);
      this.reconnectTimerId = setTimeout(() => {
        this.reconnectTimerId = null;
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
      let socket;
      try {
        const json = await send('rtm.connect');
        socket = new WebSocket(json.url);
        this.socket = socket;
      } catch (e) {
        this.isConnecting = false;
        console.error('SlackRtm: failed to connect websocket', e);
        this.#scheduleReconnect();
        return;
      }

      socket.onopen = (() => {
        if (this.socket !== socket) {
          return;
        }

        this.isConnecting = false;
        this.reconnectAttempt = 0;
        this.#startKeepAlive();
        this.#refreshUnreadCounts();
      });
      socket.onmessage = ((e) => {
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

        this.#handleMessage(json);
      });
      socket.onerror = ((e) => {
        console.info('websocket error');
      });
      socket.onclose = ((e) => {
        console.info('websocket close');
        if (this.socket !== socket) {
          return;
        }

        this.socket = null;
        this.isConnecting = false;
        this.unreadRefreshId += 1;
        this.isRefreshingUnreadCounts = false;
        this.pendingCountEvents = [];
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
      // https://github.com/ErikKalkoken/slackApiDoc/blob/master/users.prefs.get.md
      const json = await send('users.prefs.get');
      const mutedChannels = [];
      if (json.ok && json.prefs) {
        const allMutedChannelStr = json.prefs.muted_channels || '';
        const allMutedChannels = allMutedChannelStr.split(',').filter(c => c.length > 0);
        mutedChannels.push(...allMutedChannels);

        const allNotificationPrefsJson = json.prefs.all_notifications_prefs;
        if (allNotificationPrefsJson) {
          const allNotificationPrefs = JSON.parse(allNotificationPrefsJson);
          if (allNotificationPrefs.channels) {
            const channels = allNotificationPrefs.channels;
            const allMutedChannels2 = Object.fromEntries(Object.entries(channels).filter(([k,v]) => v.muted));
            mutedChannels.push(...Object.keys(allMutedChannels2));
          }
        }

        this.#mutedChannelsChanged(mutedChannels);

        console.log('muted channels updated:', mutedChannels);
      } else {
        console.error('users.prefs.get failed', json);
      }
    }

    #mutedChannelsChanged(allMutedChannels) {
      this.mutedChannels = allMutedChannels;

      let updated = false;
      for (const channelId of this.mutedChannels) {
        if (this.unreadCounts[channelId] !== undefined) {
          updated = true;
        }
        if (this.mentionCounts[channelId] !== undefined) {
          updated = true;
        }
      }
      if (updated) {
        this.#updateUnreadCount();
      }
    }
}

// Singleton instance
const slackInstance = Object.seal(new SlackRtm());
export default slackInstance;
