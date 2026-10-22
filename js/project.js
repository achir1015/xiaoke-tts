// 專案：設定 + 素材來源（聲音 mp3、文案、圖形、背景音樂、音效），產出的 MP3 也可以存回專案資料夾。
//
// 專案資料夾結構（電腦版 Chrome / Edge 可以直接連結；手機或其他瀏覽器改用「匯入」存在瀏覽器裡）：
//   我的專案/
//     專案設定.json
//     聲音/       聲音樣本 mp3、wav、m4a（會出現在聲音範本，可以拿來說話）
//     文案/       txt、md（單一文字轉語音的稿子，或劇本）
//     圖形/       png、jpg（MP3 封面）
//     背景音樂/   mp3、wav（墊在語音下面的音樂）
//     音效/       mp3、wav（劇本裡用 [音效 名稱] 插入）
//     輸出/       產生的 MP3

import { db, prefs } from "./store.js";

export const KINDS = {
  voice: { dir: "聲音", label: "聲音", icon: "🎙️", accept: "audio/*,.mp3,.wav,.m4a,.ogg,.webm" },
  text: { dir: "文案", label: "文案", icon: "📝", accept: ".txt,.md,text/plain" },
  image: { dir: "圖形", label: "圖形", icon: "🖼️", accept: "image/*" },
  music: { dir: "背景音樂", label: "背景音樂", icon: "🎵", accept: "audio/*,.mp3,.wav,.m4a,.ogg" },
  sfx: { dir: "音效", label: "音效", icon: "💥", accept: "audio/*,.mp3,.wav,.m4a,.ogg" },
};
const OUT_DIR = "輸出";
const SETTINGS_FILE = "專案設定.json";
const EXT = {
  voice: /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i, music: /\.(mp3|wav|m4a|ogg|aac|flac)$/i, sfx: /\.(mp3|wav|m4a|ogg|aac|flac)$/i,
  text: /\.(txt|md)$/i, image: /\.(png|jpe?g|webp|gif)$/i,
};

export const canLinkFolder = () => "showDirectoryPicker" in window;

let root = null;          // FileSystemDirectoryHandle（有權限時）

export async function savedFolder() { return (await db.get("kv", "folder"))?.value || null; }

/** 連結（或重新授權）專案資料夾。需在使用者點擊時呼叫。 */
export async function linkFolder(reuse = false) {
  let h = reuse ? await savedFolder() : null;
  if (h) {
    if ((await h.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("沒有取得資料夾權限");
  } else {
    h = await window.showDirectoryPicker({ id: "xiaoke-tts", mode: "readwrite" });
    await db.put("kv", { id: "folder", value: h });
  }
  root = h;
  for (const k of Object.values(KINDS)) await root.getDirectoryHandle(k.dir, { create: true });
  await root.getDirectoryHandle(OUT_DIR, { create: true });
  await scanFolder();
  return h.name;
}

export async function unlinkFolder() {
  root = null;
  await db.del("kv", "folder");
  for (const a of await db.all("assets")) if (a.source === "folder") await db.del("assets", a.id);
}

export const folderName = () => root?.name || "";
export const folderLinked = () => !!root;

/** 掃描資料夾 → 更新素材清單（資料夾裡的檔案不複製，用到時才讀） */
export async function scanFolder() {
  if (!root) return;
  const seen = new Set();
  for (const [kind, k] of Object.entries(KINDS)) {
    const dir = await root.getDirectoryHandle(k.dir, { create: true });
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== "file" || !EXT[kind].test(name)) continue;
      const f = await h.getFile();
      const id = `folder:${kind}:${name}`;
      seen.add(id);
      await db.put("assets", { id, kind, name: name.replace(/\.[^.]+$/, ""), file: name, source: "folder", size: f.size, type: f.type, created: f.lastModified });
    }
  }
  for (const a of await db.all("assets")) if (a.source === "folder" && !seen.has(a.id)) await db.del("assets", a.id);
  await loadSettingsFile();
}

export async function listAssets(kind) {
  const all = await db.all("assets");
  return all.filter(a => !kind || a.kind === kind).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}

/** 取得素材內容（Blob） */
export async function assetBlob(a) {
  if (typeof a === "string") a = await db.get("assets", a);
  if (!a) throw new Error("找不到素材");
  if (a.blob) return a.blob;
  if (!root) throw new Error("請先在「專案」重新連結專案資料夾");
  const dir = await root.getDirectoryHandle(KINDS[a.kind].dir);
  return (await dir.getFileHandle(a.file)).getFile();
}

export async function assetText(a) { return (await assetBlob(a)).text(); }

/** 匯入檔案：有連結資料夾就寫進資料夾，否則存在瀏覽器 */
export async function importFiles(files, kind) {
  const out = [];
  for (const f of files) {
    if (root) {
      const dir = await root.getDirectoryHandle(KINDS[kind].dir, { create: true });
      const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable();
      await w.write(f); await w.close();
    } else {
      const id = `local:${kind}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await db.put("assets", { id, kind, name: f.name.replace(/\.[^.]+$/, ""), file: f.name, source: "local", blob: f, size: f.size, type: f.type, created: Date.now() });
    }
    out.push(f.name);
  }
  if (root) await scanFolder();
  return out;
}

/** 新增一份文案（文字） */
export async function saveText(name, text) {
  const f = new File([text], name.replace(/[\\/:*?"<>|]/g, "_") + ".txt", { type: "text/plain" });
  return importFiles([f], "text");
}

export async function removeAsset(a) {
  if (a.source === "folder" && root) {
    const dir = await root.getDirectoryHandle(KINDS[a.kind].dir);
    await dir.removeEntry(a.file);
  }
  await db.del("assets", a.id);
}

/** 產生的 MP3 存到專案資料夾的「輸出」 */
export async function saveOutput(blob, filename) {
  if (!root) return false;
  const dir = await root.getDirectoryHandle(OUT_DIR, { create: true });
  const w = await (await dir.getFileHandle(filename, { create: true })).createWritable();
  await w.write(blob); await w.close();
  return true;
}

// ---------- 專案設定 ----------
export const DEFAULT_SETTINGS = {
  name: "我的專案", engine: "cloud25", localUrl: "http://127.0.0.1:7861",
  voice: "young_female", lang: "zh", emotion: "自然", strength: 0.7, speed: 1, bitrate: 192,
  music: "", musicVolume: 0.25, ambience: "", ambienceVolume: 0.3, cover: "", artist: "小柯機器人",
  pace: "一般", room: "無", dramaMusicVolume: 1, dramaAmbienceVolume: 1, saveToFolder: true,
};

export function settings() { return { ...DEFAULT_SETTINGS, ...prefs.get("settings", {}) }; }

export async function setSettings(patch) {
  const s = { ...settings(), ...patch };
  prefs.set("settings", s);
  if (root) {
    try {
      const { hfToken, localKey, ...safe } = s;         // 權杖、密碼不寫進資料夾
      const w = await (await root.getFileHandle(SETTINGS_FILE, { create: true })).createWritable();
      await w.write(JSON.stringify({ app: "小柯機器人台灣語音 MP3 工具", version: 1, settings: safe }, null, 2)); await w.close();
    } catch { }
  }
  return s;
}

async function loadSettingsFile() {
  try {
    const f = await (await root.getFileHandle(SETTINGS_FILE)).getFile();
    const j = JSON.parse(await f.text());
    if (j?.settings) prefs.set("settings", { ...settings(), ...j.settings });
  } catch { await setSettings({}); }
}

/** 匯出／匯入專案設定（沒有資料夾功能的瀏覽器用） */
export function exportSettings() {
  const { hfToken, localKey, ...safe } = settings();
  return new Blob([JSON.stringify({ app: "小柯機器人台灣語音 MP3 工具", version: 1, settings: safe }, null, 2)], { type: "application/json" });
}
export async function importSettings(file) {
  const j = JSON.parse(await file.text());
  if (!j?.settings) throw new Error("這不是專案設定檔");
  return setSettings(j.settings);
}
