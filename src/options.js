'use strict';

var saveCount = 0;

function save_options() {
  var token = document.getElementById('token').value;
  chrome.storage.sync.set({
    token: token
  }, () => {
    document.getElementById('status').innerText = 'saved';
    saveCount++;
    setTimeout(((targetSaveCount) => {
      if(saveCount === targetSaveCount)
        document.getElementById('status').innerText = '';
    }).bind(null, saveCount), 1000);
  });
}

function restore_options() {
  chrome.storage.sync.get({
    token: ''
  }, (items) => {
    document.getElementById('token').value = items.token;
  });
}

document.addEventListener('DOMContentLoaded', restore_options);
document.getElementById('save').addEventListener('click', save_options);


const stateLabels = {
  connected: '接続中', connecting: '接続処理中', reconnecting: '再接続待ち', disconnected: '未接続',
  running: '同期中', success: '成功', partial: '一部未取得', error: '失敗', interrupted: '切断により中断'
};
let latestDiagnostics = null;
let diagnosticsRequestRunning = false;
let workspaceRequestId = 0;

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

async function refreshWorkspace() {
  const requestId = ++workspaceRequestId;
  const status = document.getElementById('workspace-status');
  document.getElementById('workspace-info').hidden = true;
  status.textContent = 'ワークスペース情報を取得中…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getWorkspaceInfo' });
    if (requestId !== workspaceRequestId) return;
    if (!response?.workspace) throw new Error(response?.error || 'ワークスペース情報を取得できませんでした。');
    const workspace = response.workspace;
    document.getElementById('workspace-name').textContent = workspace.name || '名称なし';
    document.getElementById('workspace-id').textContent = workspace.id || '—';
    document.getElementById('workspace-domain').textContent = workspace.domain || '—';
    const link = document.getElementById('workspace-url');
    const url = workspace.id ? `https://app.slack.com/client/${encodeURIComponent(workspace.id)}/` : null;
    link.textContent = url || '—';
    if (url) link.href = url;
    else link.removeAttribute('href');
    const icon = document.getElementById('workspace-icon');
    const iconUrl = safeHttpsUrl(workspace.iconUrl);
    icon.src = iconUrl || 'slack.png';
    icon.alt = `${workspace.name || 'Slack'} のアイコン`;
    document.getElementById('workspace-info').hidden = false;
    status.textContent = '';
  } catch (error) {
    if (requestId !== workspaceRequestId) return;
    status.textContent = error.message || 'ワークスペース情報を取得できませんでした。';
  }
}

document.getElementById('workspace-icon').addEventListener('error', event => {
  const icon = event.currentTarget;
  if (icon.getAttribute('src') !== 'slack.png') icon.src = 'slack.png';
});
document.addEventListener('DOMContentLoaded', refreshWorkspace);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.token) refreshWorkspace();
});

function formatTime(value) {
  return value ? new Date(value).toLocaleString('ja-JP', { hour12: false }) : '—';
}

function renderRows(id, rows, columns, emptyText) {
  const body = document.getElementById(id);
  const elements = rows.map(values => {
    const row = document.createElement('tr');
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    return row;
  });
  if (!elements.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns;
    cell.textContent = emptyText;
    row.appendChild(cell);
    elements.push(row);
  }
  body.replaceChildren(...elements);
}

function renderDiagnostics(data) {
  const c = data.connection;
  const sync = data.lastUnreadSync;
  const fields = [
    ['WebSocket', stateLabels[c.state]],
    ['HTTP定期同期間隔', data.syncPolicy ? `${data.syncPolicy.intervalMinutes}分 / ${data.syncPolicy.reason}` : '—'],
    ['接続後のHTTP同期成功', data.syncPolicy ? `${data.syncPolicy.successfulSyncsSinceConnection}回` : '—'],
    ['最終pong受信', formatTime(c.lastPongAt)],
    ['最終接続 / 切断', `${formatTime(c.connectedAt)} / ${formatTime(c.disconnectedAt)}`],
    ['最終受信', `${formatTime(c.lastMessageAt)}${c.lastMessageType ? ` (${c.lastMessageType})` : ''}`],
    ['再接続予定 / 試行回数', `${formatTime(c.nextReconnectAt)} / ${c.reconnectAttempt}`],
    ['接続エラー', c.error || 'なし'],
    ['未読データ同期', sync ? `${stateLabels[sync.status]} / 開始 ${formatTime(sync.startedAt)} / 完了 ${formatTime(sync.finishedAt)}` : '未実行'],
    ['未読取得方法 / 進捗', sync ? `${sync.source || 'users.counts'}${sync.progress ? ` / ${sync.progress}` : ''}` : '—'],
    ['未読取得エラー・注意', sync?.error || sync?.warning || 'なし'],
    ['反映待ちイベント', `${data.pendingEvents}件`],
    ['表示取得時刻', formatTime(data.capturedAt)]
  ];
  const list = document.getElementById('connection-status');
  list.replaceChildren(...fields.flatMap(([label, value]) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    return [dt, dd];
  }));
  renderRows('sync-history', data.syncHistory.map(entry => [
    formatTime(entry.startedAt), formatTime(entry.finishedAt),
    entry.durationMs == null ? '—' : `${entry.durationMs} ms`,
    `${entry.api}${entry.target ? `\n${entry.target}` : ''}`, stateLabels[entry.status], entry.summary || '—'
  ]), 6, '同期履歴はまだありません');
  const hasSuccessfulSync = sync && ['success', 'partial'].includes(sync.status);
  const countLabel = (value, incomplete) => incomplete ? value ? `${value}以上（未取得あり）` : '未取得あり' : value;
  document.getElementById('unread-totals').textContent =
    `未読合計: ${countLabel(data.totals.unreadCount, data.totals.unreadIncomplete || !hasSuccessfulSync)} / メンション・DM合計: ${countLabel(data.totals.mentionCount, data.totals.mentionIncomplete || !hasSuccessfulSync)} / 保持チャンネル: ${data.channels.length}`;
  const unreadOnly = document.getElementById('unread-only').checked;
  const channels = data.channels.filter(c => !unreadOnly || c.unreadCount > 0 || c.mentionCount > 0 || c.unreadCount === null || c.mentionCount === null)
    .sort((a, b) => b.unreadCount + b.mentionCount - a.unreadCount - a.mentionCount || a.id.localeCompare(b.id));
  renderRows('channel-data', channels.map(c => [c.name || c.id, c.id,
    c.unreadCount === null ? '未取得' : `${c.unreadCount}${c.unreadCountExact === false ? '以上' : ''}`,
    c.mentionCount === null ? '未取得' : c.mentionCount, c.muted ? 'はい' : 'いいえ', c.countError || '取得済み']),
    6, !hasSuccessfulSync ? '未読データを取得できていません。同期ステータスの取得状況を確認してください。' :
      sync.status === 'partial' ? '未読データの取得が不完全です。Tokenの種類・権限を確認してください。' :
        unreadOnly ? '未読・メンションのあるチャンネルはありません' : '内部データはありません');
}

async function refreshDiagnostics() {
  if (diagnosticsRequestRunning || document.hidden) return;
  diagnosticsRequestRunning = true;
  try {
    const data = await chrome.runtime.sendMessage({ type: 'getSyncDiagnostics' });
    if (!data) throw new Error('No response');
    latestDiagnostics = data;
    renderDiagnostics(data);
    document.getElementById('diagnostics-error').textContent = '';
  } catch (_) {
    document.getElementById('diagnostics-error').textContent = '同期状態を取得できませんでした。表示済みの情報は前回取得時のものです。拡張機能の再読み込み後に設定画面を開き直してください。';
  } finally {
    diagnosticsRequestRunning = false;
  }
}

document.getElementById('unread-only').addEventListener('change', () => {
  if (latestDiagnostics) renderDiagnostics(latestDiagnostics);
});
document.getElementById('refresh-unreads').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const data = await chrome.runtime.sendMessage({ type: 'refreshUnreadCounts' });
    if (data) {
      latestDiagnostics = data;
      renderDiagnostics(data);
    }
  } catch (_) {
    document.getElementById('diagnostics-error').textContent = '未読データの再取得に失敗しました。拡張機能を再読み込みしてください。';
  } finally {
    button.disabled = false;
  }
});
document.addEventListener('DOMContentLoaded', refreshDiagnostics);
document.addEventListener('visibilitychange', refreshDiagnostics);
setInterval(refreshDiagnostics, 2000);
