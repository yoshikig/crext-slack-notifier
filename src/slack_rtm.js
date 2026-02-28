import { send } from "./slack_api.js";

var kPeriodicalUpdateAlarmName = 'PERIODICAL';
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
      this.updateUnreadCount();
    }

    #startKeepAlive() {
      chrome.alarms.create(kPeriodicalUpdateAlarmName, { periodInMinutes: 0.5 });
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

    async #startWebSocket() {
      const json = await send('rtm.connect');
      this.socket = new WebSocket(json.url);
      this.socket.onopen = ((e) => {
        this.#startKeepAlive();
      });
      this.socket.onmessage = ((e) => {
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

        if (json.type === 'channel_marked' || json.type === 'group_marked') {
          console.log(json);
          this.unreadCounts[json.channel] = json.unread_count_display;
          this.mentionCounts[json.channel] = json.mention_count_display;
          this.#updateUnreadCount();
        } else if (json.type === 'im_marked') {
          console.log(json);
          this.mentionCounts[json.channel] = json.dm_count;
          this.#updateUnreadCount();
        } else if (json.type === 'message') {
          console.log(json);
          if (json.channel in this.unreadCounts) {
            // If the channel already exists, increment the count
            this.unreadCounts[json.channel] += 1;
          } else {
            // If the channel doesn't exist, create it
            this.unreadCounts[json.channel] = 1;
          }
          this.#updateUnreadCount();
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
      });
      this.socket.onerror = ((e) => {
        console.info('websocket error');
      });
      this.socket.onclose = ((e) => {
        console.info('websocket close');
        this.#startWebSocket();
      });
    }

    sendPing() {
      if (this.socket) {
        this.socket.send(JSON.stringify({ id: this.webSocketId++, type: 'ping' }));
      }
    }

    async #updateConfigs() {
      // https://github.com/ErikKalkoken/slackApiDoc/blob/master/users.prefs.get.md
      const json = await send('users.prefs.get');
      if (json.ok && json.prefs) {
        const allMutedChannels = json.prefs.muted_channels;
        this.#mutedChannelsChanged(allMutedChannels);

        console.log('user prefs updated');
      } else {
        console.error('users.prefs.get failed', json);
      }
    }

    #mutedChannelsChanged(allMutedChannels) {
      this.mutedChannels = allMutedChannels.split(',').filter(c => c.length > 0);

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

chrome.alarms.onAlarm.addListener(alarm => {
  switch (alarm.name) {
    case kPeriodicalUpdateAlarmName:
      theInstance.sendPing();
      break;
  }
});

// Singleton instance
const slackInstance = Object.seal(new SlackRtm());
export default slackInstance;
