import { callLLM, PROVIDERS, providerOf, needsKey, listModels } from './llm.js';
import {
  getFolder,
  pickFolder,
  ensureFolderPermission,
  foldersNeedingPermission,
  saveText,
  safeName,
  readBackgroundFile,
  getBgFolder,
  pickBgFolder,
  clearBgFolder,
  BG_FILE,
} from './saver.js';

const $ = (id) => document.getElementById(id);

// ---------- 设置 ----------
const DEFAULTS = {
  provider: 'anthropic',
  // 当前服务商的地址 / Key / 模型
  baseUrl: PROVIDERS.anthropic.baseUrl,
  apiKey: '',
  model: 'claude-opus-5-5',
  // 每个服务商各记一份，切来切去不用重填
  perProvider: {},
  targetLang: '简体中文',
  profile: '',
  translateOn: true,
  micOn: false,
  autoExport: true,
  saveMode: 'downloads', // 'downloads' | 'folder'
  downloadsSubdir: 'Teams会议纪要',
};
let settings = { ...DEFAULTS };

async function loadSettings() {
  const s = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...(s.settings || {}) };
  if (!PROVIDERS[settings.provider]) settings.provider = 'anthropic';
}

// ---------- 服务商设置 ----------
for (const [id, p] of Object.entries(PROVIDERS)) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = p.name;
  $('provider').appendChild(o);
}

// 对话框里临时的各服务商配置（点保存才写回 settings）
let draft = {};

function fillProviderFields(id) {
  const p = PROVIDERS[id];
  const saved = draft[id] || {};
  $('baseUrl').value = saved.baseUrl ?? p.baseUrl;
  $('apiKey').value = saved.apiKey ?? '';
  $('model').value = saved.model ?? p.model;
  $('apiKey').placeholder = p.noKey ? '可留空' : '';
  $('keyHint').textContent = p.keyHint || '';
  $('baseUrl').readOnly = false;
  $('apiTestOut').textContent = '';
  const dl = $('modelList');
  dl.innerHTML = '';
  for (const m of saved.modelList || p.models || []) {
    const o = document.createElement('option');
    o.value = m;
    dl.appendChild(o);
  }
}

function stashProviderFields() {
  const id = $('provider').dataset.current;
  if (!id) return;
  draft[id] = {
    ...(draft[id] || {}),
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
  };
}

$('provider').addEventListener('change', () => {
  stashProviderFields();
  $('provider').dataset.current = $('provider').value;
  fillProviderFields($('provider').value);
});

function draftSettings() {
  stashProviderFields();
  const id = $('provider').value;
  return { ...settings, provider: id, ...draft[id] };
}

$('fetchModels').addEventListener('click', async () => {
  const out = $('apiTestOut');
  out.textContent = '获取中…';
  try {
    const s = draftSettings();
    await ensureHostPermission(s);
    const models = await listModels(s);
    draft[s.provider].modelList = models;
    fillProviderFields(s.provider);
    out.textContent = models.length ? `拿到 ${models.length} 个模型，点模型框可以选` : '服务商没有返回模型列表，请手动填';
  } catch (e) {
    out.textContent = '获取失败：' + e.message;
  }
});

$('testApi').addEventListener('click', async () => {
  const out = $('apiTestOut');
  out.textContent = '测试中…';
  try {
    const s = draftSettings();
    await ensureHostPermission(s);
    const t0 = Date.now();
    const { text } = await callLLM(s, {
      system: '你是连接测试。',
      prompt: '只回复两个字：成功',
      maxTokens: 50,
      effort: 'low',
    });
    out.textContent = `连接正常（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${text.trim().slice(0, 20)}`;
  } catch (e) {
    out.textContent = '连接失败：' + e.message;
  }
});

// 预设服务商的域名已经在 manifest 里授权；自定义地址要用户点一下同意访问那个域名
async function ensureHostPermission(s) {
  const url = s.baseUrl || providerOf(s).baseUrl;
  if (!url) return;
  let origin;
  try {
    origin = new URL(url).origin + '/*';
  } catch {
    throw new Error('接口地址格式不对');
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return;
  const ok = await chrome.permissions.request({ origins: [origin] });
  if (!ok) throw new Error(`没有允许访问 ${new URL(url).host}`);
}

function openSettings() {
  draft = JSON.parse(JSON.stringify(settings.perProvider || {}));
  draft[settings.provider] = {
    ...(draft[settings.provider] || {}),
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
  };
  $('provider').value = settings.provider;
  $('provider').dataset.current = settings.provider;
  fillProviderFields(settings.provider);
  $('targetLang').value = settings.targetLang;
  $('profile').value = settings.profile;
  $('translateOn').checked = settings.translateOn;
  $('micOn').checked = settings.micOn;
  $('autoExport').checked = settings.autoExport;
  $('downloadsSubdir').value = settings.downloadsSubdir;
  document.querySelector(`input[name=saveMode][value=${settings.saveMode}]`).checked = true;
  showFolderName();
  $('settings').showModal();
}

async function showFolderName() {
  const h = await getFolder();
  $('folderName').textContent = h ? h.name : '还没选';
}

$('pickFolder').addEventListener('click', async () => {
  try {
    await pickFolder();
    document.querySelector('input[name=saveMode][value=folder]').checked = true;
    showFolderName();
  } catch (e) {
    if (e.name !== 'AbortError') alert('选文件夹失败：' + e.message);
  }
});

$('settings').addEventListener('close', async () => {
  if ($('settings').returnValue !== 'save') return;
  settings = {
    ...pickProvider(),
    targetLang: $('targetLang').value.trim() || DEFAULTS.targetLang,
    profile: $('profile').value.trim(),
    translateOn: $('translateOn').checked,
    micOn: $('micOn').checked,
    autoExport: $('autoExport').checked,
    saveMode: document.querySelector('input[name=saveMode]:checked')?.value || 'downloads',
    downloadsSubdir: safeName($('downloadsSubdir').value) || DEFAULTS.downloadsSubdir,
  };
  if (settings.saveMode === 'folder' && !(await getFolder())) {
    settings.saveMode = 'downloads';
    setStatus('没选文件夹，先存到下载目录', true);
  }
  await chrome.storage.local.set({ settings });
  refreshFolderBanner();
  loadBgFile();
  if ($('status').classList.contains('err')) return;
  setStatus('设置已保存');
});
$('settingsBtn').addEventListener('click', openSettings);

function pickProvider() {
  const s = draftSettings();
  const perProvider = {};
  for (const [id, v] of Object.entries(draft)) perProvider[id] = { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model };
  return { provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, perProvider };
}

// 点保存那一下顺便申请访问自定义接口域名（必须在点击里申请）
$('saveSettings').addEventListener('click', () => {
  ensureHostPermission(draftSettings()).catch((e) => setStatus(e.message, true));
});

// ---------- 背景资料（人名、岗位、术语） ----------
let bgLocal = ''; // 侧栏里写的，存在本机
let bgFile = ''; // Obsidian 文件夹里「会议背景资料.md」的内容

function backgroundText() {
  return [bgFile.trim(), bgLocal.trim()].filter(Boolean).join('\n\n').slice(0, 90000);
}

async function loadBgFile() {
  const r = await readBackgroundFile();
  const bgFolder = await getBgFolder();
  $('bgFolderName').textContent = bgFolder ? bgFolder.name : `没选（用纪要文件夹里的 ${BG_FILE}）`;
  $('clearBgFolder').hidden = !bgFolder;
  const info = $('bgFileInfo');
  const list = $('bgFileList');
  list.innerHTML = '';
  if (r?.text != null) {
    bgFile = r.text;
    info.textContent =
      `已读取「${r.source}」里 ${r.files.length} 个文件，共 ${r.text.length} 字` +
      (r.skipped ? `；超出上限没读的 ${r.skipped} 个` : '');
    info.className = 'small';
    for (const f of r.files) {
      const li = document.createElement('li');
      li.textContent = `${f.path}（${f.chars} 字）`;
      list.appendChild(li);
    }
  } else {
    bgFile = '';
    info.className = 'small muted';
    if (!r) info.textContent = '还没选背景资料文件夹，只用下面框里的内容。';
    else if (r.missing) info.textContent = `「${r.source}」里没有 ${BG_FILE}，只用下面框里的内容。`;
    else info.textContent = `读不到背景资料：${r.error}。在侧栏点一下授权后会自动重读。`;
  }
}

$('pickBgFolder').addEventListener('click', async () => {
  try {
    await pickBgFolder();
    await loadBgFile();
    refreshFolderBanner();
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('选文件夹失败：' + e.message, true);
  }
});
$('reloadBg').addEventListener('click', () => loadBgFile());
$('clearBgFolder').addEventListener('click', async () => {
  await clearBgFolder();
  loadBgFile();
  refreshFolderBanner();
});

let bgSaveTimer = null;
$('bgText').addEventListener('input', () => {
  bgLocal = $('bgText').value;
  clearTimeout(bgSaveTimer);
  bgSaveTimer = setTimeout(() => chrome.storage.local.set({ bgLocal }), 500);
});

function appendBg(text) {
  const cur = $('bgText').value.trimEnd();
  $('bgText').value = (cur ? cur + '\n\n' : '') + text.trim() + '\n';
  $('bgText').dispatchEvent(new Event('input'));
}

$('bgImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  appendBg(await f.text());
  e.target.value = '';
  setStatus(`已导入 ${f.name}`);
});

$('bgSpeakers').addEventListener('click', () => {
  const known = backgroundText();
  const names = [...new Set(lines.map((l) => l.speaker).filter(Boolean))].filter((n) => !known.includes(n));
  if (!names.length) return setStatus(lines.length ? '本场发言人都已经在背景资料里了' : '还没有字幕');
  appendBg('# 人员（待补岗位）\n' + names.map((n) => `${n} — `).join('\n'));
  setStatus(`加了 ${names.length} 个发言人，在每行「—」后面补上岗位`);
});

function aiReady() {
  return !!settings.model && (!!settings.apiKey || !needsKey(settings));
}

function claude(opts) {
  const bg = backgroundText();
  const system = bg
    ? `${opts.system}\n\n以下是用户提供的背景资料，可能包括人名岗位、术语，以及会前准备的事实、数据、进度、口径和立场。` +
      '字幕是语音识别的，人名和术语常被听错，据此纠正拼写、统一译名；提到人时可注明岗位。' +
      '给用户建议回答时，优先用资料里的具体事实和数据作答，口径和立场与资料保持一致；资料和字幕里都没有的不要编，留占位符让用户填。' +
      `\n<背景资料>\n${bg}\n</背景资料>`
    : opts.system;
  return callLLM(settings, { ...opts, system });
}

// ---------- 状态栏 ----------
let captionsVisible = null;
function setStatus(text, isErr = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}
function captionHint() {
  if (captionsVisible === false) setStatus('没看到实时字幕：在 Teams 会议里「更多 → 语言和语音 → 打开实时字幕」');
  else if (captionsVisible === true) setStatus('正在读取实时字幕');
}

// ---------- Tab 切换 ----------
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    b.classList.remove('ping');
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  })
);

// ---------- 字幕 ----------
// line: { id, speaker, text, ts, updatedAt, firstAt, tr, trFor }
let lines = [];
const byId = new Map();

function upsertCaption(m) {
  let l = byId.get(m.id);
  const now = Date.now();
  if (!l) {
    l = { id: m.id, speaker: m.speaker, text: m.text, ts: m.ts, firstAt: now, updatedAt: now, tr: '', trFor: '' };
    lines.push(l);
    byId.set(l.id, l);
  } else {
    l.text = m.text;
    if (m.speaker) l.speaker = m.speaker;
    l.updatedAt = now;
  }
  renderLine(l);
  saveSoon();
}

const linesEl = $('lines');
function renderLine(l) {
  const nearBottom = linesEl.parentElement.scrollHeight - linesEl.parentElement.scrollTop - linesEl.parentElement.clientHeight < 80;
  let el = document.getElementById('L' + l.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'line';
    el.id = 'L' + l.id;
    el.innerHTML = '<div class="who"></div><div class="orig"></div><div class="tr"></div>';
    linesEl.appendChild(el);
  }
  const time = new Date(l.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  el.querySelector('.who').textContent = `${l.speaker || '某人'} · ${time}`;
  el.querySelector('.orig').textContent = l.text;
  const tr = el.querySelector('.tr');
  const stale = settings.translateOn && l.trFor !== l.text;
  tr.textContent = l.tr || (stale ? '…' : '');
  tr.classList.toggle('pending', stale);
  $('empty').style.display = lines.length ? 'none' : '';
  if (nearBottom) linesEl.parentElement.scrollTop = linesEl.parentElement.scrollHeight;
}

function renderAll() {
  linesEl.innerHTML = '';
  lines.forEach((l) => {
    renderLine(l);
    if (l.suggest) renderSuggest(l);
  });
  $('empty').style.display = lines.length ? 'none' : '';
}

// 存到本机，侧栏关掉再开不丢
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ transcript: lines.slice(-3000) }), 1000);
}

// ---------- 实时翻译 ----------
// 字幕会一个词一个词地涨，等它停 1.2 秒再翻；一直在涨超过 6 秒也先翻一版。
let translating = false;
async function translateTick() {
  if (translating || !settings.translateOn || !aiReady()) return;
  const now = Date.now();
  const due = lines.filter(
    (l) => l.trFor !== l.text && (now - l.updatedAt > 1200 || now - l.firstAt > 6000)
  );
  if (!due.length) return;
  const batch = due.slice(0, 10);
  const firstIdx = lines.indexOf(batch[0]);
  const context = lines.slice(Math.max(0, firstIdx - 6), firstIdx);

  translating = true;
  const snapshot = batch.map((l) => l.text);
  try {
    const prompt = [
      context.length ? '前文（仅供理解，不要翻译）：\n' + context.map((l) => `${l.speaker || '某人'}: ${l.text}`).join('\n') + '\n' : '',
      '需要翻译的字幕：',
      ...batch.map((l, i) => `[${i + 1}] ${l.speaker || '某人'}: ${l.text}`),
    ].join('\n');
    const { text } = await claude({
      system:
        `你是会议同传。把 Teams 实时字幕翻译成${settings.targetLang}。字幕是语音识别自动生成的，可能有错词，按说话人的本意翻得自然口语化。` +
        `已经是${settings.targetLang}的就原样输出。每条输入输出一行，格式严格为「[编号] 译文」，不要带说话人，不要任何别的内容。`,
      prompt,
      maxTokens: 4000,
      effort: 'low',
    });
    const map = new Map();
    for (const row of text.split('\n')) {
      const m = row.match(/^\s*\[(\d+)\]\s*(.*)$/);
      if (m) map.set(Number(m[1]), m[2].trim());
    }
    batch.forEach((l, i) => {
      const t = map.get(i + 1);
      if (t !== undefined) {
        l.tr = t;
        l.trFor = snapshot[i];
      } else {
        l.trFor = snapshot[i]; // 模型漏了这条就别反复重试
      }
      renderLine(l);
    });
    saveSoon();
    if (captionsVisible) captionHint();
  } catch (e) {
    setStatus('翻译失败：' + e.message, true);
    await new Promise((r) => setTimeout(r, 5000));
  } finally {
    translating = false;
  }
}
setInterval(translateTick, 800);

function transcriptText(list = lines) {
  return list
    .map((l) => {
      const t = new Date(l.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `[${t}] ${l.speaker || '某人'}: ${l.text}`;
    })
    .join('\n');
}

// ---------- 简单 Markdown 渲染 ----------
function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
function md(src) {
  const out = [];
  let inList = false;
  for (const raw of src.split('\n')) {
    let line = esc(raw).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) {
      if (!inList) out.push('<ul>');
      inList = true;
      out.push(`<li>${li[1]}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (h) out.push(`<h3>${h[2]}</h3>`);
    else if (line.trim()) out.push(`<p>${line}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

async function streamInto(el, btn, opts) {
  btn && (btn.disabled = true);
  el.classList.remove('muted');
  el.innerHTML = '<p class="muted">思考中…</p>';
  try {
    const { text } = await claude({ ...opts, onText: (t) => (el.innerHTML = md(t)) });
    el.innerHTML = md(text);
    return text;
  } catch (e) {
    el.innerHTML = `<p class="muted">出错了：${esc(e.message)}</p>`;
  } finally {
    btn && (btn.disabled = false);
  }
}

// ---------- 总结 ----------
let lastSummary = '';
async function summarize() {
  if (!lines.length) return setStatus('还没有字幕可以总结', true);
  const text = await streamInto($('summaryOut'), $('summaryBtn'), {
    system:
      `你是会议记录员。根据会议实时字幕（语音识别生成，可能有错词）用${settings.targetLang}写总结。` +
      '按这几个小标题输出，没有内容的小标题省略：## 主题、## 要点、## 已做的决定、## 待办（谁做什么、何时）、## 还没定的问题。' +
      '只写字幕里有依据的内容，不要编。简洁，每条一行。',
    prompt: `会议字幕：\n${transcriptText()}`,
    maxTokens: 8000,
    effort: 'medium',
  });
  if (text) lastSummary = text;
}
$('summaryBtn').addEventListener('click', summarize);

let autoTimer = null;
$('autoSummary').addEventListener('change', (e) => {
  clearInterval(autoTimer);
  if (e.target.checked) {
    summarize();
    autoTimer = setInterval(summarize, 5 * 60 * 1000);
  }
});

// ---------- 建议回答 ----------
// 我是谁、我的立场、要不要自动：存在本机
let me = { myNames: '', stance: '', autoReply: false };
const myAliases = () =>
  me.myNames
    .split(/[,，、;；]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
const isMe = (speaker) => !!speaker && myAliases().some((a) => speaker.toLowerCase().includes(a.toLowerCase()));
const mentionsMe = (text) => myAliases().some((a) => text.toLowerCase().includes(a.toLowerCase()));
// 粗筛：像不像在提问 / 请人回应。真正要不要回答由模型判断。
const ASK_RE =
  /[?？]|\b(can|could|would|will|do|did|are|have) you\b|\bplease\b|\bwhat do you\b|\bany (updates?|comments?|questions?|feedback)\b|\byour (view|thoughts|opinion|side|team)\b|\bhow about\b|你们?|您|请|能不能|可不可以|怎么看|有没有/i;

function saveMe() {
  chrome.storage.local.set({ me });
}
$('myNames').addEventListener('input', () => {
  me.myNames = $('myNames').value;
  saveMe();
});
$('myStance').addEventListener('input', () => {
  me.stance = $('myStance').value;
  saveMe();
});
$('autoReply').addEventListener('change', () => {
  me.autoReply = $('autoReply').checked;
  if (me.autoReply && !myAliases().length) setStatus('先填「我在 Teams 里的名字」，才能分清谁在问你', true);
  // 打开时之前的字幕不再回头处理，只看之后的
  lines.forEach((l) => (l.askChecked = true));
  saveMe();
});
$('pickSpeaker').addEventListener('focus', () => {
  const sel = $('pickSpeaker');
  const names = [...new Set(lines.map((l) => l.speaker).filter(Boolean))];
  sel.innerHTML = '<option value="">从发言人选…</option>' + names.map((n) => `<option>${esc(n)}</option>`).join('');
});
$('pickSpeaker').addEventListener('change', () => {
  const n = $('pickSpeaker').value;
  if (!n) return;
  const cur = myAliases();
  if (!cur.includes(n)) $('myNames').value = [...cur, n].join(', ');
  $('myNames').dispatchEvent(new Event('input'));
  $('pickSpeaker').value = '';
});

function replySystem(auto) {
  const who = myAliases().length ? `用户在会议里的名字是：${myAliases().join(' / ')}。` : '';
  const common =
    '回答用会议正在使用的语言写，口语化、能直接念出来，每个不超过 3 句；' +
    `每个回答下面用${settings.targetLang}附一行意思说明。回答要符合用户的立场，守住立场里的底线，但语气专业得体。` +
    '不知道的事实不要编，用占位符如 [日期] [数量] 让用户自己填。';
  if (auto) {
    return (
      `你在会议中实时帮用户应对提问。${who}` +
      '看「最新这句话」：如果它不是在问用户、请用户回应，或者用户不需要接话（比如在问别人、只是陈述、用户刚已经回答过），' +
      '只输出 NO_REPLY_NEEDED，别的什么都不要写。' +
      `否则先用一行 **${settings.targetLang}** 写「谁 · 在问什么」，然后给 3 个不同取向的回答，标号 1-3，` +
      '取向写在【】里（比如【直接回答】【先确认再答复】【委婉推回】，按场合选）。' +
      common
    );
  }
  return (
    `你在会议中帮用户想下一句怎么说。${who}先用一句话判断：刚才有没有人在问用户问题、在问什么。` +
    '然后给 3 个不同取向的建议回答（比如：直接回答 / 争取时间或追问 / 委婉推回），取向写在【】里。' +
    common
  );
}

function replyPrompt(recent, extra) {
  return (
    (settings.profile ? `我的身份背景：${settings.profile}\n\n` : '') +
    (me.stance.trim() ? `我在这场会上的立场 / 目标：${me.stance.trim()}\n\n` : '') +
    (lastSummary ? `会议目前的总结：\n${lastSummary}\n\n` : '') +
    `最近的对话：\n${transcriptText(recent)}` +
    (extra ? `\n\n${extra}` : '')
  );
}

$('replyBtn').addEventListener('click', () => {
  if (!lines.length) return setStatus('还没有字幕', true);
  const hint = $('replyHint').value.trim();
  streamInto($('replyOut'), $('replyBtn'), {
    system: replySystem(false),
    prompt: replyPrompt(lines.slice(-40), hint ? `我的想法：${hint}` : ''),
    maxTokens: 6000,
    effort: 'medium',
  });
});

// ---------- 有人问我时自动生成 ----------
let autoBusy = false;
async function autoReplyTick() {
  if (autoBusy || !me.autoReply || !myAliases().length || !aiReady()) return;
  const now = Date.now();
  // 只看最近几句、已经说完（停了 1.5 秒）、还没判断过的
  const recentIdx = Math.max(0, lines.length - 4);
  let target = null;
  for (let i = recentIdx; i < lines.length; i++) {
    const l = lines[i];
    if (l.askChecked === true || now - l.updatedAt < 1500) continue;
    l.askChecked = true;
    if (isMe(l.speaker)) continue;
    if (mentionsMe(l.text) || ASK_RE.test(l.text)) target = l;
  }
  for (let i = 0; i < recentIdx; i++) lines[i].askChecked = true;
  if (!target) return;

  autoBusy = true;
  const upto = lines.indexOf(target) + 1;
  let shown = false;
  try {
    const { text } = await claude({
      system: replySystem(true),
      prompt: replyPrompt(
        lines.slice(Math.max(0, upto - 30), upto),
        `最新这句话（${target.speaker || '某人'}说的）：${target.text}`
      ),
      maxTokens: 3000,
      effort: 'low',
      onText: (t) => {
        const s = t.trimStart();
        if (s.length < 16 || s.startsWith('NO_REPLY')) return; // 先等开头，判断是不是「不需要回答」
        shown = true;
        target.suggest = t;
        renderSuggest(target);
      },
    });
    const s = text.trim();
    if (!s || s.startsWith('NO_REPLY')) {
      target.suggest = '';
      renderSuggest(target);
      return;
    }
    target.suggest = s;
    renderSuggest(target);
    $('replyOut').classList.remove('muted');
    $('replyOut').innerHTML = md(s);
    const replyTab = document.querySelector('nav button[data-tab=reply]');
    if (!replyTab.classList.contains('active')) replyTab.classList.add('ping');
    saveSoon();
  } catch (e) {
    if (shown) target.suggest += `\n\n（生成中断：${e.message}）`;
    renderSuggest(target);
    setStatus('自动建议回复失败：' + e.message, true);
  } finally {
    autoBusy = false;
  }
}
setInterval(autoReplyTick, 700);

// 在「实时翻译」里那句话下面显示建议回复
function renderSuggest(l) {
  const el = document.getElementById('L' + l.id);
  if (!el) return;
  let card = el.querySelector('.suggest');
  if (!l.suggest) return card?.remove();
  if (!card) {
    card = document.createElement('div');
    card.className = 'suggest';
    card.innerHTML = '<div class="head">建议回复<span class="spacer"></span><button class="ghost">收起</button></div><div class="md"></div>';
    card.querySelector('button').addEventListener('click', (e) => {
      card.classList.toggle('collapsed');
      e.target.textContent = card.classList.contains('collapsed') ? '展开' : '收起';
    });
    el.appendChild(card);
    linesEl.parentElement.scrollTop = linesEl.parentElement.scrollHeight;
  }
  card.querySelector('.md').innerHTML = md(l.suggest);
}

// ---------- 帮我说 ----------
$('sayInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  const want = $('sayInput').value.trim();
  if (!want) return;
  streamInto($('sayOut'), null, {
    system:
      '把用户用中文写的意思，改成适合在这场会议里直接说出口的话。用会议正在使用的语言（看不出来就用英文）。' +
      '给 2 个版本：一个简短直接，一个更礼貌正式。每个版本单独一行，前面标「简短：」「正式：」，不要别的解释。',
    prompt:
      (lines.length ? `最近的对话（帮你判断语言和语气）：\n${transcriptText(lines.slice(-15))}\n\n` : '') +
      `我想表达：${want}`,
    maxTokens: 2000,
    effort: 'low',
  });
});

// ---------- 录音 ----------
let recording = false;
let recStartedAt = 0;
function setRec(on, startedAt) {
  recording = on;
  recStartedAt = startedAt || 0;
  $('recBtn').classList.toggle('on', on);
  $('recLabel').textContent = on ? '停止录音' : '录音';
  if (!on) $('recTime').textContent = '';
}
setInterval(() => {
  if (!recording) return;
  const s = Math.floor((Date.now() - recStartedAt) / 1000);
  $('recTime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}, 500);

const TEAMS_RE = /^https:\/\/(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\//;

$('recBtn').addEventListener('click', async () => {
  $('recBtn').disabled = true;
  try {
    if (recording) {
      await chrome.runtime.sendMessage({ type: 'rec-stop' });
      setRec(false);
      setStatus('正在保存录音…');
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !TEAMS_RE.test(tab.url || '')) {
      setStatus('请先切到 Teams 会议的标签页再点录音', true);
      return;
    }
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (e) {
      setStatus('拿不到标签页声音：先点一下浏览器工具栏里的插件图标，再点录音。（' + e.message + '）', true);
      return;
    }
    const r = await chrome.runtime.sendMessage({ type: 'rec-start', streamId, mic: settings.micOn });
    if (!r?.ok) throw new Error(r?.error || '未知错误');
    setRec(true, r.startedAt);
    setStatus(r.note || '正在录音。请记得告知参会者。', !!r.note);
  } catch (e) {
    setStatus('录音失败：' + e.message, true);
  } finally {
    $('recBtn').disabled = false;
  }
});

// ---------- 会议纪要导出 ----------
let meetingTitle = '';
let teamsTabId = null;
let inCall = false;
let exporting = false;

function cleanTitle(t) {
  // Teams 标签页标题形如「会议名 | Microsoft Teams」
  return safeName((t || '').replace(/\s*[|｜]\s*Microsoft Teams.*$/i, '').replace(/^\(\d+\)\s*/, ''));
}

async function buildMinutes() {
  await loadBgFile();
  const start = new Date(lines[0].ts);
  const end = new Date(lines[lines.length - 1].ts);
  const mins = Math.max(1, Math.round((end - start) / 60000));
  const speakers = [...new Set(lines.map((l) => l.speaker).filter(Boolean))];
  if (!meetingTitle && teamsTabId != null) {
    meetingTitle = cleanTitle((await chrome.tabs.get(teamsTabId).catch(() => null))?.title);
  }
  const title = meetingTitle || 'Teams 会议';

  let minutes = '';
  if (aiReady()) {
    try {
      const r = await claude({
        system:
          `你是会议记录员，根据 Teams 会议实时字幕（语音识别生成，可能有错词）用${settings.targetLang}写正式会议纪要。` +
          '按这几个二级标题输出，没有内容的省略：## 摘要（3-5 句）、## 讨论要点、## 决定、## 待办（谁 / 做什么 / 何时）、## 未决问题。' +
          '只写字幕里有依据的内容，不要编，人名保留原文。不要输出一级标题和会议基本信息。' +
          '最后加一节 ## 新出现的人员：列出背景资料里没有的发言人或被提到的人，每行「名字 — 从会上能看出的岗位或职责（看不出就写「待确认」）」，方便用户补进背景资料；都已经有就省略这一节。',
        prompt: `会议：${title}\n参会发言人：${speakers.join('、') || '未知'}\n\n会议字幕：\n${transcriptText()}`,
        maxTokens: 16000,
        effort: 'medium',
      });
      minutes = r.text.trim();
      lastSummary = minutes;
    } catch (e) {
      minutes = `（AI 纪要生成失败：${e.message}。下面的字幕原文已完整保存。）`;
    }
  } else {
    minutes = '（没配置 AI 服务，只保存了字幕原文。）';
  }

  const fmt = (d) => d.toLocaleString('zh-CN', { hour12: false });
  const body =
    `# ${title}\n\n` +
    `- 时间：${fmt(start)} – ${end.toLocaleTimeString('zh-CN', { hour12: false })}（约 ${mins} 分钟）\n` +
    `- 发言人：${speakers.join('、') || '未知'}\n\n` +
    `${minutes}\n\n---\n\n## 字幕原文与翻译\n\n` +
    lines
      .map((l) => {
        const t = new Date(l.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        return `**${l.speaker || '某人'}** ${t}\n${l.text}\n${l.tr && l.tr !== l.text ? '> ' + l.tr + '\n' : ''}`;
      })
      .join('\n');

  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}_${pad(start.getHours())}${pad(start.getMinutes())}`;
  return { body, fileName: `${stamp}_${safeName(title) || '会议纪要'}.md` };
}

async function exportMinutes({ auto }) {
  if (exporting) return;
  if (!lines.length) return auto || setStatus('没有内容可导出', true);
  exporting = true;
  $('exportBtn').disabled = true;
  try {
    setStatus(auto ? '会议结束了，正在生成会议纪要…' : '正在生成会议纪要…');
    const { body, fileName } = await buildMinutes();
    const r = await saveText(fileName, body, settings);
    $('summaryOut').innerHTML = md(lastSummary || '');
    refreshFolderBanner();
    setStatus(
      r.fallback
        ? `文件夹授权过期，这次存到了 ${r.where}`
        : `会议纪要已保存：${r.where}`,
      r.fallback
    );
    if (auto) {
      // 已经存好，清空给下一场会用
      lines = [];
      byId.clear();
      lastSummary = '';
      await chrome.storage.local.remove('transcript');
      renderAll();
    }
  } catch (e) {
    setStatus('保存会议纪要失败：' + e.message + '（字幕还在，可以点「导出」再试）', true);
  } finally {
    exporting = false;
    $('exportBtn').disabled = false;
  }
}

$('exportBtn').addEventListener('click', async () => {
  // 在点击里先把文件夹权限要好，生成完纪要后就能直接写
  if (settings.saveMode === 'folder') await ensureFolderPermission();
  exportMinutes({ auto: false });
});

// 指定文件夹的写权限：浏览器重启或插件更新后会失效，必须用户点一下才能重新拿到。
// 所以侧栏里任何一次点击都顺手要一下；还没拿到时显示一个提示条。
async function refreshFolderBanner() {
  const names = await foldersNeedingPermission(settings.saveMode);
  $('folderBanner').hidden = !names.length;
  if (names.length) $('folderBanner').textContent = `点这里授权文件夹「${names.join('」「')}」（存纪要 / 读背景资料要用）`;
}
document.addEventListener(
  'click',
  async (e) => {
    if (e.target.closest('#pickBgFolder, #pickFolder')) return; // 选文件夹本身会授权
    if (!(await foldersNeedingPermission(settings.saveMode)).length) return;
    await ensureFolderPermission();
    refreshFolderBanner();
    loadBgFile();
  },
  true
);

function onMeetingEnded() {
  if (!inCall) return;
  inCall = false;
  // 会开完了录音也停掉，存到纪要旁边
  if (recording) {
    chrome.runtime.sendMessage({ type: 'rec-stop' }).catch(() => {});
    setRec(false);
  }
  if (settings.autoExport && lines.length >= 3) exportMinutes({ auto: true });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === teamsTabId) onMeetingEnded();
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('清空本场的字幕、翻译和总结？（录音文件不受影响）')) return;
  lines = [];
  byId.clear();
  lastSummary = '';
  await chrome.storage.local.remove('transcript');
  renderAll();
  $('summaryOut').innerHTML = '';
  $('replyOut').innerHTML = '';
});

// ---------- 消息 ----------
// 录音和纪要存在同一个地方，文件名用同样的「日期_时间_会议名」开头
async function saveRecording({ url, startedAt }) {
  const blob = await (await fetch(url)).blob();
  if (!meetingTitle && teamsTabId != null) {
    meetingTitle = cleanTitle((await chrome.tabs.get(teamsTabId).catch(() => null))?.title);
  }
  const d = new Date(startedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const r = await saveText(`${stamp}_${safeName(meetingTitle) || 'Teams会议'}_录音.webm`, blob, settings);
  refreshFolderBanner();
  setStatus(r.fallback ? `文件夹授权过期，录音存到了 ${r.where}` : `录音已保存：${r.where}`, r.fallback);
  return r.where;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'rec-save') {
    saveRecording(msg).then(
      (where) => sendResponse({ saved: true, where }),
      (e) => {
        setStatus('录音存到指定位置失败，改存下载目录：' + e.message, true);
        sendResponse({ saved: false });
      }
    );
    return true;
  }
  if (sender?.tab?.id != null && (msg.type === 'caption' || msg.type === 'call-state')) teamsTabId = sender.tab.id;
  if (msg.type === 'call-state') {
    if (msg.inCall) {
      inCall = true;
      if (msg.title) meetingTitle = cleanTitle(msg.title);
      loadBgFile(); // 每场会开始时重读，Obsidian 里刚改的也能用上
    } else {
      onMeetingEnded();
    }
    return;
  }
  if (msg.type === 'caption') {
    if (!inCall) inCall = true; // 有字幕就说明在会上（防止漏掉「入会」信号）
    if (captionsVisible !== true) {
      captionsVisible = true;
      captionHint();
    }
    upsertCaption(msg);
  } else if (msg.type === 'caption-status') {
    captionsVisible = msg.captionsVisible;
    captionHint();
  } else if (msg.type === 'rec-state') {
    setRec(msg.recording, msg.startedAt);
  }
});

// ---------- 启动 ----------
(async () => {
  await loadSettings();
  const { transcript } = await chrome.storage.local.get('transcript');
  if (Array.isArray(transcript)) {
    lines = transcript;
    lines.forEach((l) => byId.set(l.id, l));
  }
  renderAll();
  refreshFolderBanner();
  const { me: savedMe } = await chrome.storage.local.get('me');
  me = { ...me, ...(savedMe || {}) };
  $('myNames').value = me.myNames;
  $('myStance').value = me.stance;
  $('autoReply').checked = me.autoReply;
  lines.forEach((l) => (l.askChecked = true)); // 恢复出来的旧字幕不再触发
  const { bgLocal: saved } = await chrome.storage.local.get('bgLocal');
  bgLocal = saved || '';
  $('bgText').value = bgLocal;
  loadBgFile();

  const r = await chrome.runtime.sendMessage({ type: 'rec-status' }).catch(() => null);
  if (r?.recording) setRec(true, r.startedAt);

  if (!aiReady()) {
    setStatus('先点右上角「设置」选 AI 服务商、填 API Key');
    openSettings();
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && TEAMS_RE.test(tab.url || '')) {
    chrome.tabs.sendMessage(tab.id, { type: 'ping-captions' }).catch(() => {
      setStatus('这个 Teams 页面是插件装好之前打开的，刷新一下页面', true);
    });
  } else if (aiReady()) {
    setStatus('打开 Teams 网页版会议后，这里会自动出现字幕');
  }
})();
