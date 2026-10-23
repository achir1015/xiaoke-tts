// App 版提供的功能：MP3 直接存到電腦／手機、開啟資料夾、版本更新、用系統瀏覽器開網址
//  桌面版（Windows／Mac 的 Python 程式）：window.pywebview.api
//  Android 版（WebView）：window.XiaokeAndroid（同步、回傳 JSON 字串）→ 包成和桌面版一樣的非同步介面
//  iPhone／iPad 版（WKWebView）：window.webkit.messageHandlers.xkt.postMessage({ cmd, args }) 回傳 Promise
// 網頁版三個都沒有，這些功能會自動改用瀏覽器的做法（下載、分享）。

const A = () => window.XiaokeAndroid;
const J = s => { try { return JSON.parse(s); } catch { return { status: "error", message: String(s) }; } };
const androidApi = {
  app_info: async () => J(A().appInfo()),
  begin_save: async (name, ask) => J(A().beginSave(name)),
  write_chunk: async (token, b64) => J(A().writeChunk(token, b64)),
  end_save: async token => J(A().endSave(token)),
  check_update: async () => J(A().checkUpdate()),
  install_update: async (url, ver) => J(A().installUpdate(url, ver)),
  update_status: async () => J(A().updateStatus()),
  open_url: async url => A().openUrl(url),
  read_clipboard: async () => J(A().readClipboard()),
};

const I = () => window.XiaokeIOS && window.webkit?.messageHandlers?.xkt;
const iosApi = new Proxy({}, { get: (_, cmd) => (...args) => I().postMessage({ cmd, args }) });

export const Desktop = {
  get available() { return !!(A() || I() || (window.pywebview && window.pywebview.api)); },
  get android() { return !!A(); },
  get ios() { return !!I(); },
  get desktop() { return !!(window.pywebview && window.pywebview.api) && !A() && !I(); },
  get api() { return A() ? androidApi : I() ? iosApi : window.pywebview.api; },
};

/** 桌面版的 pywebview 介面是網頁載入後才注入的：等它一下 */
export function whenAppReady(timeout = 2500) {
  return new Promise(res => {
    if (Desktop.available) return res(true);
    const t = setTimeout(() => res(false), timeout);
    window.addEventListener("pywebviewready", () => { clearTimeout(t); res(true); }, { once: true });
  });
}

/**
 * 把 Blob 分段（每段 4MB，base64）交給 App 寫成檔案。
 * ask=false：桌面版直接存到「音樂\小柯語音」、Android 存到「音樂/小柯語音」、iPhone 打開分享選單。
 * 使用者取消時回傳 null。
 */
export async function appSave(filename, blob, ask = false) {
  const api = Desktop.api;
  const r = await api.begin_save(filename, ask);
  if (r.status === "declined") return null;
  if (r.status !== "ok") throw new Error(r.message || "存檔失敗");
  const CH = 4 * 1024 * 1024;
  for (let off = 0; off < blob.size; off += CH) {
    const buf = new Uint8Array(await blob.slice(off, off + CH).arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const w = await api.write_chunk(r.token, btoa(bin));
    if (w.status !== "ok") throw new Error(w.message);
  }
  const e = await api.end_save(r.token);
  if (e.status === "declined") return null;
  if (e.status !== "ok") throw new Error(e.message);
  return e.path;
}
export const desktopSave = appSave;   // 自我測試用的舊名稱

/** 讀剪貼簿：App 版由 App 讀（Android WebView、iPhone 的網頁讀不到），網頁版用瀏覽器的 API */
export async function readClipboard() {
  if (Desktop.android || Desktop.ios) {
    const r = await Desktop.api.read_clipboard();
    if (r?.status === "ok") return r.text || "";
  }
  return navigator.clipboard.readText();
}

export function openExternal(url) {
  if (Desktop.available) return Desktop.api.open_url(url);
  window.open(url, "_blank", "noopener");
  return true;
}

export function cmpVersion(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
