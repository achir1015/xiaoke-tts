// 語音引擎（錄音師）：
//   CloudEngine  Hugging Face 上 IndexTeam 官方的 IndexTTS-2.5 / IndexTTS-2 示範空間（免安裝、免費額度）
//   LocalEngine  自己架的 indextts2-taiwan-tts 伺服器（Windows 電腦、可接台語引擎）
// 兩者都回傳 { data: Float32Array 單聲道, sr }。

import { decodeMono } from "./audio.js";
import { sampleBlob } from "./voices.js";

export const EMOTIONS = ["開心", "生氣", "悲傷", "害怕", "厭惡", "低落", "驚訝", "平靜"];

export const CLOUD_SPACES = {
  "2.5": { name: "IndexTTS-2.5（雲端，推薦）", base: "https://indexteam-indextts-2-5-demo.hf.space", page: "https://huggingface.co/spaces/IndexTeam/IndexTTS-2.5-Demo",
    langs: { zh: "ZH", en: "EN", ja: "JA", es: "ES", ar: "AR" }, speed: true },
  "2": { name: "IndexTTS-2（雲端，備用）", base: "https://indexteam-indextts-2-demo.hf.space", page: "https://huggingface.co/spaces/IndexTeam/IndexTTS-2-Demo",
    langs: { zh: "ZH", en: "EN" }, speed: false },
};

export const LANG_NAMES = { zh: "台灣國語", nan: "台語（實驗性）", en: "英文", ja: "日文", es: "西班牙文", ar: "阿拉伯文" };

/** 長文切段：雲端 GPU 每次呼叫有時間上限，一段約 100 字最穩 */
export function splitText(text, max = 100) {
  // 不用 lookbehind 正規式：舊版 iPhone Safari（16.4 以前）看不懂，整個網頁會打不開
  const sents = text.replace(/\r/g, "").replace(/([。！？!?；;\n])/g, "$1\u0000").split("\u0000").map(s => s.trim()).filter(Boolean);
  const out = [];
  let cur = "";
  for (let s of sents) {
    while (s.length > max) {            // 一句太長：再用逗號切
      const cut = Math.max(s.lastIndexOf("，", max), s.lastIndexOf(",", max), s.lastIndexOf("、", max));
      const k = cut > 20 ? cut + 1 : max;
      if (cur) { out.push(cur); cur = ""; }
      out.push(s.slice(0, k)); s = s.slice(k);
    }
    if ((cur + s).length > max && cur) { out.push(cur); cur = ""; }
    cur += s;
  }
  if (cur) out.push(cur);
  return out.filter(s => /[\p{L}\p{N}]/u.test(s));
}

function friendly(msg) {
  const m = String(msg || "");
  if (/quota|GPU duration|exceeded|runs limit/i.test(m))
    return "雲端免費 GPU 額度用完了（Hugging Face 規定：沒登入只能用幾次）。到「設定」貼上免費的 Hugging Face 權杖就能繼續用，或明天再試。";
  if (/queue is full|too many/i.test(m)) return "雲端排隊人數太多，請稍後再試，或在「設定」改用備用引擎。";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "連不到語音引擎，請檢查網路，或到「設定」按「測試連線」。";
  return m || "語音引擎發生錯誤（沒有提供原因），請再試一次。";
}

export class CloudEngine {
  constructor(version = "2.5", token = "") {
    this.v = CLOUD_SPACES[version] ? version : "2.5";
    this.space = CLOUD_SPACES[this.v];
    this.token = token.trim();
    this.uploaded = new Map();          // 聲音 id+版本 → 雲端暫存路徑（同一次使用不用重傳）
  }
  get id() { return "cloud" + this.v; }
  headers(extra = {}) { return this.token ? { ...extra, Authorization: "Bearer " + this.token } : extra; }

  async status() {
    const r = await fetch(this.space.base + "/gradio_api/info", { headers: this.headers() });
    if (!r.ok) throw new Error(`雲端引擎回應 ${r.status}（可能在睡眠或維修中）`);
    return { ok: true, message: this.space.name + " 已連線" };
  }

  async upload(voiceId, version) {
    const key = voiceId + "@" + version;
    if (this.uploaded.has(key)) return this.uploaded.get(key);
    const blob = await sampleBlob(voiceId);
    const fd = new FormData();
    fd.append("files", blob, "voice." + (/wav/.test(blob.type) ? "wav" : /webm/.test(blob.type) ? "webm" : /ogg/.test(blob.type) ? "ogg" : /mp4|m4a|aac/.test(blob.type) ? "m4a" : "mp3"));
    const r = await fetch(this.space.base + "/gradio_api/upload", { method: "POST", body: fd, headers: this.headers() });
    if (!r.ok) throw new Error(friendly(`上傳聲音樣本失敗（${r.status}）`));
    const path = (await r.json())[0];
    this.uploaded.set(key, path);
    return path;
  }

  /** o = {text, voiceId, voiceVersion, lang, emotion, strength, speed, signal} */
  async synth(o) {
    const lang = this.space.langs[o.lang];
    if (!lang) throw new Error(`${this.space.name} 不支援「${LANG_NAMES[o.lang] || o.lang}」${o.lang === "nan" ? "，台語請到「設定」改用自架伺服器" : ""}`);
    let path = await this.upload(o.voiceId, o.voiceVersion);
    try { return await this._call(o, path, lang); }
    catch (e) {
      if (!/找不到|not found|No such file/i.test(e.message)) throw e;
      this.uploaded.delete(o.voiceId + "@" + o.voiceVersion);       // 雲端暫存被清掉 → 重傳一次
      path = await this.upload(o.voiceId, o.voiceVersion);
      return this._call(o, path, lang);
    }
  }

  async _call(o, path, lang) {
    const vec = [0, 0, 0, 0, 0, 0, 0, 0];
    const useVec = o.emotion && o.emotion !== "自然";
    if (useVec) vec[EMOTIONS.indexOf(o.emotion)] = Math.max(0.05, Math.min(1, o.strength ?? 0.7));
    const method = useVec ? "Use emotion vectors" : "Same as the voice reference";
    const file = { path, meta: { _type: "gradio.FileData" } };
    const sampling = [true, 0.8, 30, 0.8, 0, 3, 10, 1500];
    // 語速 → 時長倍率（越快 = 時長越短）
    const dur = Math.max(0.5, Math.min(2, 1 / (o.speed || 1)));
    const data = this.v === "2.5"
      ? [method, file, o.text, lang, null, useVec ? 1 : 0.65, ...vec, "", false, 120, dur, ...sampling]
      : [method, file, o.text, null, useVec ? 1 : 0.8, ...vec, "", false, 120, ...sampling];
    // 用 Gradio 佇列協定（queue/join + queue/data）：出錯時才拿得到真正的原因（例如額度用完）
    const fn = await this.fnIndex();
    const session = Math.random().toString(36).slice(2, 13);
    const r = await fetch(this.space.base + "/gradio_api/queue/join", {
      method: "POST", headers: this.headers({ "Content-Type": "application/json" }), signal: o.signal,
      body: JSON.stringify({ data, fn_index: fn, session_hash: session, event_data: null, trigger_id: null }),
    });
    if (!r.ok) throw new Error(friendly(`雲端引擎回應 ${r.status}`));
    const s = await fetch(`${this.space.base}/gradio_api/queue/data?session_hash=${session}`, { headers: this.headers(), signal: o.signal });
    const reader = s.body.getReader(), dec = new TextDecoder();
    let buf = "", result = null;
    while (!result) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, k); buf = buf.slice(k + 2);
        const line = chunk.split("\n").find(l => l.startsWith("data:"));
        if (!line) continue;
        let msg; try { msg = JSON.parse(line.slice(5)); } catch { continue; }
        if (msg.msg === "estimation" && o.onWait) o.onWait({ rank: msg.rank, eta: msg.rank_eta });
        if (msg.msg === "process_completed") { result = msg; break; }
      }
    }
    reader.cancel().catch(() => { });
    if (!result) throw new Error("雲端引擎中斷連線，請再試一次。");
    if (!result.success) throw new Error(friendly(result.output?.error || result.title || ""));
    const out = result.output.data[0];
    const url = out?.value?.url || out?.url || (out?.value?.path && `${this.space.base}/gradio_api/file=${out.value.path}`);
    if (!url) throw new Error("雲端引擎沒有回傳音檔");
    const a = await fetch(url, { headers: this.headers(), signal: o.signal });
    if (!a.ok) throw new Error(`下載語音失敗（${a.status}）`);
    return decodeMono(await a.blob());
  }

  async fnIndex() {
    if (this._fn == null) {
      const c = await (await fetch(this.space.base + "/config", { headers: this.headers() })).json();
      const d = c.dependencies.find(d => d.api_name === "gen_single");
      if (!d) throw new Error("雲端引擎的介面改版了，請通知開發者更新");
      this._fn = d.id;
    }
    return this._fn;
  }

  estimate(chars) { return Math.round(chars * 0.3 + 5 * Math.ceil(chars / 100)); }
}

export class LocalEngine {
  constructor(base = "http://127.0.0.1:7861", key = "") {
    this.base = base.replace(/\/+$/, "");
    this.key = key;
  }
  get id() { return "local"; }
  headers(extra = {}) { return this.key ? { ...extra, "x-access-key": this.key } : extra; }

  async status() {
    const r = await fetch(this.base + "/api/status", { headers: this.headers() });
    if (!r.ok) throw new Error(`伺服器回應 ${r.status}`);
    const s = await r.json();
    const zh = s.engines?.zh || {}, nan = s.engines?.nan || {};
    this.hasNan = nan.status === "ready";
    return { ok: zh.status === "ready", message: `國語引擎：${zh.message || zh.status}（${zh.device || ""}）；台語引擎：${nan.message || nan.status}` };
  }

  async synth(o) {
    if (!["zh", "nan"].includes(o.lang)) throw new Error("自架伺服器只支援台灣國語和台語");
    if (o.voiceId.startsWith("custom_") || o.voiceId.startsWith("asset:"))
      throw new Error("自架伺服器只能用伺服器上的聲音；自訂聲音請在伺服器網頁的「聲音範本」上傳");
    const r = await fetch(this.base + "/api/tts", {
      method: "POST", headers: this.headers({ "Content-Type": "application/json" }), signal: o.signal,
      body: JSON.stringify({ text: o.text, voice_id: o.voiceId, language: o.lang, emotion: o.emotion || "自然", emotion_strength: o.strength ?? 0.7, speed: o.speed || 1, bitrate: "192k" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `伺服器回應 ${r.status}`);
    let job = j;
    while (job.status !== "done") {
      if (job.status === "error") throw new Error(job.message || "伺服器產生失敗");
      if (o.signal?.aborted) throw new DOMException("已取消", "AbortError");
      await new Promise(res => setTimeout(res, 1500));
      const q = await fetch(`${this.base}/api/tts/jobs/${job.id}`, { headers: this.headers(), signal: o.signal });
      job = await q.json();
      o.onWait && o.onWait(job);
    }
    const a = await fetch(`${this.base}/outputs/${job.result.mp3_file}${this.key ? "?key=" + encodeURIComponent(this.key) : ""}`, { signal: o.signal });
    return decodeMono(await a.blob());
  }

  estimate(chars) { return Math.round(chars * 1.5); }
}

export function makeEngine(p) {
  return p.engine === "local" ? new LocalEngine(p.localUrl, p.localKey) : new CloudEngine(p.engine === "cloud2" ? "2" : "2.5", p.hfToken || "");
}
