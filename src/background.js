'use strict';

import { send } from "./slack_api.js";
import gSlackUnreadClient from "./slack_rtm.js";

var g = {};
clearGlobalValues();
Object.seal(g);

function clearGlobalValues() {
  g.teamInfo = null;
  g.iconImageBitmap = null;
  g.updatedTimestamps = {}
}

async function isUnread() {
  const json = await send('conversations.list');
  console.debug(json);
  for (var channel of json.channels) {
    if (channel.is_archived || !channel.is_member)
      continue;

    if (channel.is_member && 'unread_count_display' in channel) {
      g.unreadCounts[channel.id] = channel.unread_count_display;
      if (channel.is_im || channel.is_mpim) {
        g.mentionCounts[channel.id] = 1;
      } else {
        g.mentionCounts[channel.id] = 0;
      }
      continue;
    }

    const previousUpdatedTimestamp = g.updatedTimestamps[channel.id] || 0;
    if (channel.updated > previousUpdatedTimestamp) {
      g.updatedTimestamps[channel.id] = channel.updated;
      if (channel.is_im || channel.is_mpim) {
        g.unreadCounts[channel.id] = 1; // New message in DM or MPIM
      } else {
        g.unreadCounts[channel.id] = 0; // No mention count for channels
      }
    }
  }
    /*
    g.unreadCounts = {};
    g.mentionCounts = {};
    json.channels.forEach(c => {
      if (!c.is_muted) {
        g.unreadCounts[c.id] = c.unread_count_display;
        g.mentionCounts[c.id] = c.mention_count_display;
      }
    });
    json.groups.forEach(c => {
      g.unreadCounts[c.id] = c.unread_count_display;
      g.mentionCounts[c.id] = c.mention_count_display;
    });
    json.ims.forEach(c => {
      g.mentionCounts[c.id] = c.dm_count;
    });
    */
}

function glayize(data) {
  for (var i = 0; i < data.data.length; i=i+4) {
    var pixel = (data.data[i] + data.data[i+1] + data.data[i+2]) / 3 + 128;
    data.data[i] = data.data[i+1] = data.data[i+2] = pixel;
  }
}

function getTeamInfo() {
  if (g.teamInfo)
    return Promise.resolve(g.teamInfo);

  return send('team.info').then(json => {
    g.teamInfo = json.team;
    return json.team;
  });
}

async function getIconImageBitmap() {
  if (g.iconImageBitmap)
    return g.iconImageBitmap;

  const teamInfo = await getTeamInfo();
  console.log(teamInfo.icon.image_132);
  const imageBlob = await (await fetch(teamInfo.icon.image_132)).blob();
  const bitmap = await self.createImageBitmap(imageBlob);
  g.iconImageBitmap = bitmap;
  return bitmap;
}

async function setIcon(isGray) {
  const image = await getIconImageBitmap();

  var c = new OffscreenCanvas(38, 38);
  var ctx = c.getContext("2d");
  ctx.drawImage(image, 0, 0, 38, 38);
  var imageData = ctx.getImageData(0, 0, 38, 38);

  if (isGray)
    glayize(imageData);

  chrome.action.setIcon({imageData: imageData});
}

function updateUnreadCount(unreadCount, mentionCount) {
  setIcon(unreadCount == 0 && mentionCount == 0);
  if (mentionCount > 0) {
    chrome.action.setBadgeText({text: mentionCount.toString()});
    chrome.action.setBadgeBackgroundColor({color: '#d00'});
  } else if (unreadCount > 0) {
    chrome.action.setBadgeText({text: unreadCount.toString()});
    chrome.action.setBadgeBackgroundColor({color: '#777'});
  } else {
    chrome.action.setBadgeText({text: ''});
  }
}

chrome.action.onClicked.addListener(async () => {
  const teamInfo = await getTeamInfo();

  const url = 'https://' + teamInfo.domain + '.slack.com/';
  {
    var pattern = url + '*';
    const tabs = await chrome.tabs.query({url: pattern});
    for (var tab of tabs) {
      if ((typeof tab.url == 'string') && tab.url.startsWith(url)) {
        chrome.tabs.update(tab.id, {active: true});
        chrome.windows.update(tab.windowId, { focused : true });
        return;
      }
    }
  }

  {
    const url2 = 'https://app.slack.com/client/' + teamInfo.id + '/';
    var pattern = url2 + '*';
    const tabs = await chrome.tabs.query({url: pattern});
    for (var tab of tabs) {
      if ((typeof tab.url == 'string') && tab.url.startsWith(url2)) {
        chrome.tabs.update(tab.id, {active: true});
        chrome.windows.update(tab.windowId, { focused : true });
        return;
      }
    }
  }

  chrome.tabs.create({ url: url }, () => {});
});

self.addEventListener("install", function() {
  console.log('ServiceWorker installed');
  //gSlackUnreadClient.initialize();
  //gSlackUnreadClient.addListener(updateUnreadCount);
  //gSlackUnreadClient.start();
});

self.addEventListener("activate", function() {
  console.log('ServiceWorker activate');
  setIcon(false);
  gSlackUnreadClient.initialize();
  gSlackUnreadClient.addListener(updateUnreadCount);
  gSlackUnreadClient.start();
});

chrome.runtime.onInstalled.addListener(function() {
  console.log('onInstalled');
  //gSlackUnreadClient.initialize();
  //gSlackUnreadClient.addListener(updateUnreadCount);
  //gSlackUnreadClient.start();
});

chrome.runtime.onStartup.addListener(function() {
  console.log('onStartup');
  gSlackUnreadClient.initialize();
  gSlackUnreadClient.addListener(updateUnreadCount);
  gSlackUnreadClient.start();
});

chrome.runtime.onSuspend.addListener(() => {
  console.log('suspend');
  chrome.runtime.getBackgroundPage(() => {});
});

chrome.runtime.onSuspendCanceled.addListener(() => {
  console.log('suspend canceled');
});


console.log('background.js loaded');
