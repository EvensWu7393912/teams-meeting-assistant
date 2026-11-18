// 后台：点图标开侧栏；管理录音用的 offscreen 文档；把录好的音频存到下载目录。

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// 插件安装或更新后，已经打开的 Teams 页面里旧脚本会失效。
// 这里把读字幕的脚本重新放进去，正在开的会不用刷新、也不会断。
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({
    url: ['https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://teams.cloud.microsoft/*'],
  });
  for (const tab of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
      .catch(() => {});
  }
});

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '录制 Teams 会议标签页的声音',
  });
}

async function hasOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return existing.length > 0;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return; // 发给 offscreen 的，后台不管

  if (msg.type === 'rec-start') {
    (async () => {
      try {
        await ensureOffscreen();
        const r = await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'rec-stop' || msg.type === 'rec-status') {
    (async () => {
      if (!(await hasOffscreen())) return sendResponse({ ok: true, recording: false });
      try {
        sendResponse(await chrome.runtime.sendMessage({ type: msg.type, target: 'offscreen' }));
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'rec-done') {
    // 先交给侧栏：它知道会议名和用户选的文件夹，和纪要存在一起。侧栏没开就存到下载目录。
    (async () => {
      let saved = false;
      try {
        const r = await chrome.runtime.sendMessage({ type: 'rec-save', url: msg.url, startedAt: msg.startedAt });
        saved = !!r?.saved;
      } catch {}
      if (!saved) chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false });
    })();
  }
});
