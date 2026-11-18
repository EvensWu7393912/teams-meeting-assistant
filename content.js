// 内容脚本：盯着 Teams 网页版的「实时字幕」区域，把每条字幕（说话人 + 文字）发给侧栏。
// Teams 改版时最容易坏的就是这里的选择器，坏了先看这几行。
(() => {
  // 已经有一份活着的脚本就不重复装；插件更新后旧脚本会失效，这时让新的接手
  try {
    if (window.__teamsAssistantAlive?.()) return;
  } catch {}
  window.__teamsAssistantAlive = () => {
    try {
      return alive && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  const TEXT_SEL = '[data-tid="closed-caption-text"]';
  const ITEM_SEL = '[data-tid="closed-caption-message"], .fui-ChatMessageCompact, [data-tid="closed-caption-v2-item"]';
  const AUTHOR_SEL = '[data-tid="author"], [data-tid="closed-caption-author"]';
  // 会议里才有的「离开」按钮：从有到无 = 会议结束
  const HANGUP_SEL =
    '[data-tid="hangup-main-btn"], [data-tid="call-hangup"], #hangup-button, button[aria-label^="Leave"], button[aria-label^="离开"]';
  let inCall = false;

  const ids = new WeakMap();
  const lastText = new Map();
  let counter = 0;
  let alive = true;
  let lastStatus = null;

  function send(msg) {
    if (!alive) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      alive = false; // 插件被重新加载过，旧脚本停掉
      observer.disconnect();
    }
  }

  function scan() {
    const texts = document.querySelectorAll(TEXT_SEL);
    for (const t of texts) {
      const item = t.closest(ITEM_SEL) || t.parentElement;
      let id = ids.get(item);
      if (!id) {
        id = `c${Date.now().toString(36)}${(counter++).toString(36)}`;
        ids.set(item, id);
      }
      const text = (t.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || lastText.get(id) === text) continue;
      lastText.set(id, text);
      const speaker = (item.querySelector(AUTHOR_SEL)?.textContent || '').trim();
      send({ type: 'caption', id, speaker, text, ts: Date.now() });
    }
    const callNow =
      !!document.querySelector(HANGUP_SEL) ||
      [...document.querySelectorAll('button')].some((b) =>
        /^(离开|挂断|Leave|Hang up)/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())
      );
    if (callNow !== inCall) {
      inCall = callNow;
      send({ type: 'call-state', inCall, title: document.title });
    }
    const status = texts.length > 0;
    if (status !== lastStatus) {
      lastStatus = status;
      send({ type: 'caption-status', captionsVisible: status });
    }
  }

  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan();
    }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // 侧栏刚打开时会问一下现在有没有字幕
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ping-captions') {
      lastStatus = null;
      if (inCall) send({ type: 'call-state', inCall, title: document.title });
      scan();
    }
  });

  scan();
})();
