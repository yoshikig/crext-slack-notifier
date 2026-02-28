'use strict';

const g = {token: ''};
Object.seal(g);

function getToken() {
  return new Promise(function(resolve, reject) {
    chrome.storage.sync.get({token: ''}, (items) => {
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

export function send(api, args) {
  if (!g.token)
    return getToken().then(() => sendInternal(api, args));
  else
    return sendInternal(api, args);
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
    if(res.headers.get('content-type') !== 'application/json; charset=utf-8')
      return Promise.reject('invalid responce');

    return res.json();
  }).then(json => {
    if (!json.ok) {
      console.error(api, formData, json);
      return Promise.reject('Slack API error: ' + json.ok);
    }

    return json;
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName != 'sync')
    return;

  if (changes.token && changes.token.newValue != g.token) {
    clearGlobalValues();
  }
});