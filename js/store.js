// 瀏覽器內的資料庫（IndexedDB）：
//   voices  聲音範本（自訂或覆蓋內建）  history 產生紀錄  lines 劇本台詞快取
//   assets  專案素材（聲音 mp3、文案、圖形、背景音樂、音效）  kv 其他（專案資料夾連結等）
// 所有資料只存在這台裝置，不會上傳到任何地方（產生語音時才把聲音樣本送給選用的語音引擎）。

const DB_NAME = "xiaoke-tts";
const STORES = ["voices", "history", "lines", "assets", "kv"];
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => STORES.forEach(s => r.result.objectStoreNames.contains(s) || r.result.createObjectStore(s, { keyPath: "id" }));
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && "result" in out ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("儲存空間不足或被瀏覽器拒絕"));
  });
}

export const db = {
  get: (store, id) => tx(store, "readonly", s => s.get(id)),
  all: (store) => tx(store, "readonly", s => s.getAll()),
  put: (store, obj) => tx(store, "readwrite", s => s.put(obj)),
  del: (store, id) => tx(store, "readwrite", s => s.delete(id)),
  clear: (store) => tx(store, "readwrite", s => s.clear()),
};

/** 設定（小東西放 localStorage；被封鎖時用預設值） */
export const prefs = {
  get(k, d) { try { const v = localStorage.getItem("xkt_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("xkt_" + k, JSON.stringify(v)); } catch { } },
};

export async function sha1(text) {
  if (crypto.subtle) {
    const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 5381; for (let i = 0; i < text.length; i++) h = (h * 33 ^ text.charCodeAt(i)) >>> 0;
  return "h" + h.toString(16) + text.length;
}
