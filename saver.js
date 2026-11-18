// 把会议纪要存到用户指定的文件夹。
// 两种方式：
//   folder    —— 任意文件夹（File System Access API，文件夹授权存在 IndexedDB 里）
//   downloads —— 下载目录下的子文件夹（chrome.downloads，不用授权，最稳）
// 指定文件夹的授权过期又没法弹窗时，自动退回下载目录，不丢文件。

const DB = 'teams-assistant';
const STORE = 'handles';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const getFolder = () => idbDo('readonly', (s) => s.get('folder')).catch(() => null);
const setFolder = (h) => idbDo('readwrite', (s) => s.put(h, 'folder'));

// 让用户选文件夹（必须在点击里调用）
export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'teams-minutes', mode: 'readwrite' });
  await setFolder(handle);
  return handle;
}

// 'granted' | 'prompt' | 'denied' | null（没选文件夹）
export async function folderPermission() {
  const h = await getFolder();
  if (!h) return null;
  try {
    return await h.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}

// ---------- 背景资料文件夹（用户自己选，只读） ----------
export const BG_FILE = '会议背景资料.md';
export const getBgFolder = () => idbDo('readonly', (s) => s.get('bgFolder')).catch(() => null);

export async function pickBgFolder() {
  const handle = await window.showDirectoryPicker({ id: 'teams-background', mode: 'read' });
  await idbDo('readwrite', (s) => s.put(handle, 'bgFolder'));
  return handle;
}

export const clearBgFolder = () => idbDo('readwrite', (s) => s.delete('bgFolder'));

async function perm(h, mode) {
  try {
    return await h.queryPermission({ mode });
  } catch {
    return 'prompt';
  }
}

// 递归找 .md / .txt（跳过 . 开头的，比如 .obsidian、.trash）
async function collectFiles(dir, path = '', depth = 0, out = []) {
  if (depth > 4 || out.length > 300) return out;
  for await (const [name, entry] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (entry.kind === 'directory') await collectFiles(entry, `${path}${name}/`, depth + 1, out);
    else if (/\.(md|txt)$/i.test(name)) out.push({ path: path + name, handle: entry });
  }
  return out;
}

const MAX_TOTAL = 80000; // 背景资料总字数上限
const MAX_PER_FILE = 20000;

// 读背景资料。返回 { text, source, files: [{path, chars}], skipped } / { error } / { missing } / null（什么都没配）
// 选了背景文件夹：读整个文件夹里的 .md/.txt。名字带「背景/人员/术语/通讯」的排前面，其余按修改时间从新到旧，
// 超过上限的就不读了。没选：退回读纪要文件夹里的「会议背景资料.md」。
export async function readBackgroundFile() {
  const bg = await getBgFolder();
  if (bg) {
    if ((await perm(bg, 'read')) !== 'granted') return { error: `「${bg.name}」还没授权`, source: bg.name };
    try {
      const files = await collectFiles(bg);
      const metas = await Promise.all(
        files.map(async (f) => {
          const file = await f.handle.getFile();
          return { path: f.path, file, key: /背景|人员|术语|通讯|名单|people|glossary/i.test(f.path) ? 0 : 1 };
        })
      );
      metas.sort((a, b) => a.key - b.key || b.file.lastModified - a.file.lastModified);
      let text = '';
      const used = [];
      let skipped = 0;
      for (const m of metas) {
        if (text.length >= MAX_TOTAL) {
          skipped++;
          continue;
        }
        const body = (await m.file.text()).slice(0, MAX_PER_FILE).trim();
        if (!body) continue;
        const chunk = `### ${m.path}\n${body}\n\n`.slice(0, MAX_TOTAL - text.length);
        text += chunk;
        used.push({ path: m.path, chars: chunk.length });
      }
      return { text, source: bg.name, files: used, skipped };
    } catch (e) {
      return { error: e.message, source: bg.name };
    }
  }

  const h = await getFolder();
  if (!h) return null;
  if ((await perm(h, 'readwrite')) !== 'granted') return { error: `「${h.name}」还没授权`, source: h.name };
  try {
    const f = await (await h.getFileHandle(BG_FILE)).getFile();
    const text = await f.text();
    return { text, source: h.name, files: [{ path: BG_FILE, chars: text.length }], skipped: 0 };
  } catch (e) {
    if (e.name === 'NotFoundError') return { missing: true, source: h.name };
    return { error: e.message, source: h.name };
  }
}

// 有没有哪个文件夹的授权失效了（要用户点一下才能恢复）
export async function foldersNeedingPermission(saveMode) {
  const out = [];
  const h = await getFolder();
  if (h && (saveMode === 'folder' || !(await getBgFolder())) && (await perm(h, 'readwrite')) === 'prompt') out.push(h.name);
  const bg = await getBgFolder();
  if (bg && (await perm(bg, 'read')) === 'prompt') out.push(bg.name);
  return [...new Set(out)];
}

// 点击时调用：把纪要文件夹（写）和背景文件夹（读）的权限一起要回来
export async function ensureFolderPermission() {
  let ok = true;
  for (const [h, mode] of [
    [await getFolder(), 'readwrite'],
    [await getBgFolder(), 'read'],
  ]) {
    if (!h || (await perm(h, mode)) === 'granted') continue;
    try {
      ok = (await h.requestPermission({ mode })) === 'granted' && ok;
    } catch {
      ok = false;
    }
  }
  return ok;
}

export function safeName(s) {
  return (s || '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// data 可以是文字（纪要）或 Blob（录音）
// 返回 { where: 显示给用户看的保存位置, fallback: 是否退回了下载目录 }
export async function saveText(fileName, data, settings) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/markdown;charset=utf-8' });
  if (settings.saveMode === 'folder') {
    const h = await getFolder();
    if (h && (await h.queryPermission({ mode: 'readwrite' })) === 'granted') {
      const fh = await h.getFileHandle(fileName, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return { where: `${h.name}/${fileName}`, fallback: false };
    }
  }
  const sub = safeName(settings.downloadsSubdir) || 'Teams会议纪要';
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: `${sub}/${fileName}`, conflictAction: 'uniquify', saveAs: false });
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return { where: `下载/${sub}/${fileName}`, fallback: settings.saveMode === 'folder' };
}
