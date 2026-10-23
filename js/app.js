// 小柯機器人台灣語音 MP3 工具：網頁介面（單一語音、劇本語音、聲音範本、專案素材、產生紀錄、設定）

import { APP_VERSION } from "./version.js";
import { audioCtx, decodeMono, trimSilence, resample, concat, normalize, encodeMp3 } from "./audio.js";
import { db, prefs, sha1 } from "./store.js";
import { EMOTIONS, LANG_NAMES, CLOUD_SPACES, splitText, makeEngine } from "./engines.js";
import { listVoices, sampleBlob, saveSample, addCustom, removeVoice, invalidate as invalidateVoices } from "./voices.js";
import { ScriptParser, NovelConverter, allLines, speakers, mixScript, TEMPLATES } from "./drama.js";
import { AMBIENCES, AMB_ALIASES, SFX, makeAmbience, makeSfx } from "./sounds.js";
import * as P from "./project.js";
import { tagMp3, coverJpeg } from "./id3.js";
import { Desktop, whenAppReady, appSave, openExternal, cmpVersion, readClipboard } from "./desktop.js";
import { showTokenQR, scanTokenQR } from "./qrtoken.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtT = s => { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`; };
const safeName = s => (s || "語音").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 40);
let toastTimer;
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hide"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hide"), ms); }
function showErr(el, msg) {
  el.textContent = msg || ""; el.classList.toggle("hide", !msg);
  if (msg && /權杖/.test(msg)) {
    const b = document.createElement("button");
    b.className = "primary errbtn"; b.textContent = "🔑 去設定權杖";
    b.onclick = () => goToken();
    el.appendChild(b);
  }
}
/** 跳到設定的權杖欄位 */
function goToken() {
  showTab("settings");
  const box = $("#sCloud");
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  box.classList.remove("need"); void box.offsetWidth; box.classList.add("need");
}

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isTouch = matchMedia("(pointer: coarse)").matches;
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let S = P.settings();
let engine = makeEngine(engineOpts());
let voices = [];
let assets = [];

function engineOpts() { return { engine: S.engine === "cloud2" ? "cloud2" : S.engine, localUrl: S.localUrl, localKey: S.localKey || "", hfToken: S.hfToken || "" }; }
async function save(patch) { S = await P.setSettings(patch); }

// ------------------------------------------------------------
// 分頁
// ------------------------------------------------------------
function showTab(name) {
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tab").forEach(t => t.classList.toggle("on", t.id === "tab-" + name));
  prefs.set("tab", name);
  if (name === "history") renderHistory();
  if (name === "settings") renderStorage();
}
$$("#tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
$("#engineChip").onclick = () => showTab("settings");

// ------------------------------------------------------------
// 播放（同時間只播一個）
// ------------------------------------------------------------
const player = new Audio();
player.setAttribute("playsinline", "");
let srcNode = null;

// iPhone／iPad：聲音一定要在「手指點下去」的當下先啟動一次，之後非同步產生的聲音才放得出來
function unlockAudio() {
  const ctx = audioCtx();
  ctx.resume().catch(() => { });
  const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
  s.buffer = b; s.connect(ctx.destination); s.start();
  player.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=";
  player.play().then(() => player.pause()).catch(() => { });
  ["touchend", "click", "keydown"].forEach(ev => document.removeEventListener(ev, unlockAudio, true));
}
["touchend", "click", "keydown"].forEach(ev => document.addEventListener(ev, unlockAudio, true));

// 產生語音時讓手機螢幕保持亮著（螢幕關掉，瀏覽器會把網頁暫停）
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => wakeLock = null); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && busy()) keepAwake(true); });
function stopAll() { player.pause(); if (srcNode) { try { srcNode.stop(); } catch { } srcNode = null; } $$(".playing").forEach(b => b.classList.remove("playing")); }
async function playBlob(blob) { stopAll(); if (player.src.startsWith("blob:")) URL.revokeObjectURL(player.src); player.src = URL.createObjectURL(blob); await player.play(); }
function playChannels(ch, sr, btn) {
  stopAll();
  const ctx = audioCtx(); ctx.resume();
  const b = ctx.createBuffer(ch.length, ch[0].length, sr);
  ch.forEach((c, i) => b.getChannelData(i).set(c));
  srcNode = ctx.createBufferSource(); srcNode.buffer = b; srcNode.connect(ctx.destination); srcNode.start();
  if (btn) { btn.classList.add("playing"); srcNode.onended = () => btn.classList.remove("playing"); }
}

// ------------------------------------------------------------
// 引擎狀態
// ------------------------------------------------------------
const engineLabel = e => e.id === "local" ? "自架伺服器" : e.id === "cloud2" ? "雲端 IndexTTS-2" : "雲端 IndexTTS-2.5";

/** 一打開就自動連線；雲端主引擎連不到就自動改用備用，不用使用者處理 */
async function checkEngine(showMsg) {
  const chip = $("#engineChip");
  chip.className = "chip"; chip.textContent = "⏳ 啟動" + engineLabel(engine);
  const tryOne = async e => { const r = await e.status(); return r; };
  try {
    const r = await tryOne(engine);
    chip.className = "chip " + (r.ok ? "ok" : "bad"); chip.textContent = (r.ok ? "🟢 " : "🟠 ") + engineLabel(engine);
    if (showMsg) $("#sTestMsg").textContent = r.message;
    warmUp();
  } catch (e) {
    const alt = fallbackEngine();
    if (alt) {
      try {
        await tryOne(alt);
        engine = alt;
        chip.className = "chip ok"; chip.textContent = "🟢 " + engineLabel(engine);
        toast(`主引擎暫時連不到，已自動改用${engineLabel(engine)}`);
        if (showMsg) $("#sTestMsg").textContent = `已自動改用${engineLabel(engine)}`;
        renderLang(); ttsCount();
        warmUp();
        return;
      } catch { }
    }
    chip.className = "chip bad"; chip.textContent = "🔴 " + engineLabel(engine);
    if (showMsg) $("#sTestMsg").textContent = "連線失敗：" + (e.message === "Failed to fetch" ? "連不到（網路中斷、伺服器沒開，或沒有允許跨網域）" : e.message);
  }
}

/** 雲端兩個引擎互為備用；自架伺服器連不到時改用雲端 */
function fallbackEngine() {
  const cur = engine.id;
  const next = cur === "cloud2.5" ? "cloud2" : cur === "cloud2" ? "cloud25" : "cloud25";
  return makeEngine({ ...engineOpts(), engine: next });
}

/** 連上後先把目前選的聲音樣本送到引擎，第一次產生就比較快 */
function warmUp() {
  const v = voices.find(x => x.id === tts.voice);
  if (v && engine.upload) engine.upload(v.id, v.version || 0).catch(() => { });
}

function langOptions() {
  const langs = engine.id === "local" ? ["zh", "nan"] : Object.keys(CLOUD_SPACES[engine.id === "cloud2" ? "2" : "2.5"].langs);
  return langs;
}

// ------------------------------------------------------------
// 語音合成（含快取：同一句、同聲音、同情緒做過就不重做）
// ------------------------------------------------------------
async function synthCached(o) {
  const v = voices.find(x => x.id === o.voiceId);
  if (!v) throw new Error("找不到聲音：" + o.voiceId);
  const key = await sha1(JSON.stringify([engine.id, o.text, o.emotion, Math.round((o.strength ?? 0.7) * 100), o.voiceId, v.version || 0, o.lang, Math.round((o.speed || 1) * 100)]));
  const hit = await db.get("lines", key).catch(() => null);
  if (hit) { const d = new Float32Array(hit.pcm.length); for (let i = 0; i < d.length; i++) d[i] = hit.pcm[i] / 32767; return { data: d, sr: hit.sr, cached: true }; }
  let r;
  try { r = await engine.synth({ ...o, voiceVersion: v.version || 0 }); }
  catch (e) {
    if (e.name === "AbortError" || /額度|權杖|不支援|自訂聲音/.test(e.message)) throw e;
    const alt = fallbackEngine();
    try { r = await alt.synth({ ...o, voiceVersion: v.version || 0 }); }
    catch { throw e; }
    engine = alt; toast(`已自動改用${engineLabel(engine)}`); checkEngine(false);
  }
  const data = trimSilence(r.data, r.sr);
  const pcm = new Int16Array(data.length); for (let i = 0; i < data.length; i++) pcm[i] = Math.max(-1, Math.min(1, data[i])) * 32767;
  db.put("lines", { id: key, pcm, sr: r.sr, created: Date.now() }).catch(() => { });
  return { data, sr: r.sr };
}

/** 素材音檔 → AudioBuffer（劇本的背景音樂、音效、自訂背景） */
const assetCache = new Map();
async function assetAudio(name, kinds) {
  const a = assets.find(a => kinds.includes(a.kind) && a.name === name);
  if (!a) return null;
  if (!assetCache.has(a.id)) assetCache.set(a.id, P.assetBlob(a).then(b => b.arrayBuffer()).then(buf => audioCtx().decodeAudioData(buf)));
  return assetCache.get(a.id);
}

const BABBLE = ["菜市場", "人群嘈雜", "會議廳", "咖啡廳"];
/** 只有菜市場、人群這類背景才需要聲音樣本（手機省記憶體） */
async function babbleVoices(names) {
  const need = names.filter(Boolean).flatMap(n => n.split(/[+＋、]/)).some(n => BABBLE.includes(AMB_ALIASES[n.trim()] || n.trim()));
  return need ? voiceBuffers() : [];
}
let _voiceBufs = null;
async function voiceBuffers() {         // 做「人群聲」用：內建聲音樣本
  if (!_voiceBufs) _voiceBufs = Promise.all(voices.filter(v => v.builtin).slice(0, isTouch ? 6 : 11).map(v => sampleBlob(v.id).then(b => b.arrayBuffer()).then(b => audioCtx().decodeAudioData(b)).catch(() => null))).then(a => a.filter(Boolean));
  return _voiceBufs;
}

async function coverBytes(id) {
  if (!id) return null;
  const a = assets.find(a => a.id === id);
  if (!a) return null;
  try { return await coverJpeg(await P.assetBlob(a)); } catch { return null; }
}

async function finishMp3({ channels, sr, kbps, title, kind, text, voiceName, cover, resultEl, progress }) {
  progress && progress(0.97, "轉成 MP3…");
  let mp3 = await encodeMp3(channels, sr, kbps);
  mp3 = tagMp3(await mp3.arrayBuffer(), { title, artist: S.artist || "小柯機器人", album: S.name, coverJpeg: await coverBytes(cover) });
  const seconds = Math.round(channels[0].length / sr * 10) / 10;
  const filename = `${safeName(title)}${voiceName ? "_" + safeName(voiceName) : ""}.mp3`;
  const rec = { id: Date.now().toString(36), title, kind, text: (text || "").slice(0, 300), voice: voiceName || "", engine: engine.id, seconds, created: Date.now(), blob: mp3, filename, size: mp3.size };
  await db.put("history", rec).catch(() => toast("瀏覽器儲存空間不足，紀錄沒有存下來"));
  let saved = false, appPath = "";
  if (S.saveToFolder && P.folderLinked()) saved = await P.saveOutput(mp3, filename).catch(() => false);
  // 電腦版、Android 版：自動存到「音樂／小柯語音」（iPhone 版由使用者按「分享／儲存」）
  if (Desktop.available && !Desktop.ios) appPath = await appSave(filename, mp3).catch(e => { toast("存檔失敗：" + e.message); return ""; }) || "";
  const url = URL.createObjectURL(mp3);
  const shareFile = new File([mp3], filename, { type: "audio/mpeg" });
  const canShareFile = !!(navigator.canShare && navigator.canShare({ files: [shareFile] }));
  const buttons = Desktop.available ? appButtons(appPath) : `${canShareFile ? `<button class="${isTouch ? "primary" : "ghost"} share">📤 ${isIOS ? "分享／儲存到檔案" : "分享"}</button>` : ""}
    <a class="btnlink" href="${url}" download="${esc(filename)}"><button class="${canShareFile && isTouch ? "ghost" : "primary"}">⬇ 下載 MP3</button></a>`;
  resultEl.innerHTML = `<b>✅ 完成：${esc(title)}</b>（${fmtT(seconds)}，${(mp3.size / 1024 / 1024).toFixed(2)} MB）
    <audio controls src="${url}"></audio>
    ${appPath ? `<p class="hint">💾 已存到：${esc(appPath)}</p>` : ""}
    <div class="row">${buttons}
    ${saved ? `<span class="hint">已存到專案資料夾「輸出」</span>` : ""}</div>`;
  resultEl.classList.remove("hide");
  bindAppButtons(resultEl, mp3, filename, title, appPath);
  const sh = resultEl.querySelector(".share");
  if (sh) sh.onclick = () => navigator.share({ files: [shareFile], title }).catch(() => { });
  resultEl.querySelector("audio").play().catch(() => { });
  return rec;
}

/** App 版的結果按鈕：開啟資料夾、另存新檔（電腦）；分享／儲存（iPhone）；再存一次（Android） */
function appButtons(path) {
  if (Desktop.ios) return `<button class="primary appshare">📤 分享／儲存到檔案</button>`;
  if (Desktop.android) return `<button class="ghost appagain">💾 再存一份到「音樂」</button>`;
  return `${path ? `<button class="primary appopen">📂 開啟資料夾</button>` : ""}<button class="ghost appsaveas">另存新檔…</button>`;
}
function bindAppButtons(el, blob, filename, title, path) {
  const on = (sel, fn) => { const b = el.querySelector(sel); if (b) b.onclick = async () => { try { await fn(); } catch (e) { toast(e.message); } }; };
  on(".appopen", () => Desktop.api.open_folder(path));
  on(".appsaveas", async () => { const p = await appSave(filename, blob, true); if (p) toast("已存到 " + p, 4000); });
  on(".appshare", () => appSave(filename, blob));
  on(".appagain", async () => { const p = await appSave(filename, blob); if (p) toast("已存到 " + p, 4000); });
}

function progressUI(box) {
  const bar = box.querySelector("i"), p = box.querySelector("p");
  return (frac, text) => { box.classList.remove("hide"); bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%"; if (text != null) p.textContent = text; };
}

// ------------------------------------------------------------
// 單一語音
// ------------------------------------------------------------
const tts = { voice: S.voice, emotion: S.emotion, abort: null };

function renderVoiceChips() {
  const ready = voices.filter(v => v.ready);
  if (!ready.some(v => v.id === tts.voice)) tts.voice = ready[0]?.id;
  $("#ttsVoices").innerHTML = ready.map(v => `<div class="vchip ${v.id === tts.voice ? "on" : ""}" data-id="${esc(v.id)}" title="${esc(v.name)}${v.ageLabel ? `（${v.ageLabel}・${v.genderLabel}）` : ""}">
    <span>${v.asset ? "📁 " : v.custom ? "⭐ " : ""}${esc(v.name)}${v.ageLabel ? `<small class="vtag">${v.ageLabel}・${v.genderLabel}</small>` : ""}</span><button class="play" title="試聽樣本">▶</button></div>`).join("");
  $$("#ttsVoices .vchip").forEach(el => {
    el.onclick = () => { tts.voice = el.dataset.id; save({ voice: tts.voice }); renderVoiceChips(); };
    el.querySelector(".play").onclick = async e => { e.stopPropagation(); try { await playBlob(await sampleBlob(el.dataset.id)); } catch (er) { toast(er.message); } };
  });
}

function renderLang() {
  const langs = langOptions();
  if (!langs.includes(S.lang)) S.lang = "zh";
  $("#ttsLang").innerHTML = langs.map(l => `<option value="${l}" ${l === S.lang ? "selected" : ""}>${LANG_NAMES[l]}</option>`).join("");
}
$("#ttsLang").onchange = e => save({ lang: e.target.value });

$("#ttsEmo").innerHTML = ["自然", ...EMOTIONS].map(e => `<button data-v="${e}">${e}</button>`).join("");
function syncEmo() { $$("#ttsEmo button").forEach(b => b.classList.toggle("on", b.dataset.v === tts.emotion)); $("#ttsStrength").disabled = tts.emotion === "自然"; }
$$("#ttsEmo button").forEach(b => b.onclick = () => { tts.emotion = b.dataset.v; save({ emotion: tts.emotion }); syncEmo(); });

function bindRange(id, key, fmt) {
  const el = $(id), out = $(id + "V");
  el.value = S[key];
  const show = () => out.textContent = fmt(+el.value);
  show();
  el.oninput = show;
  el.onchange = () => save({ [key]: +el.value });
}
bindRange("#ttsStrength", "strength", v => Math.round(v * 100) + "%");
bindRange("#ttsSpeed", "speed", v => v.toFixed(2) + "×");
bindRange("#ttsMusicVol", "musicVolume", v => Math.round(v * 100) + "%");
bindRange("#ttsAmbVol", "ambienceVolume", v => Math.round(v * 100) + "%");
bindRange("#dAmbVol", "dramaAmbienceVolume", v => Math.round(v * 100) + "%");
bindRange("#dMusicVol", "dramaMusicVolume", v => Math.round(v * 100) + "%");
$("#ttsBitrate").value = S.bitrate; $("#dBitrate").value = S.bitrate;
$("#ttsBitrate").onchange = e => { save({ bitrate: +e.target.value }); $("#dBitrate").value = e.target.value; };
$("#dBitrate").onchange = e => { save({ bitrate: +e.target.value }); $("#ttsBitrate").value = e.target.value; };
$("#ttsArtist").value = S.artist; $("#ttsArtist").onchange = e => save({ artist: e.target.value });
["#ttsMusic", "#ttsAmb", "#ttsCover"].forEach((id, i) => $(id).onchange = e => save({ [["music", "ambience", "cover"][i]]: e.target.value }));
$("#dCover").onchange = e => save({ cover: e.target.value });

const ttsText = $("#ttsText");
ttsText.value = prefs.get("ttsText", "大家好，我是小柯機器人。今天天氣真好，我們下午去夜市吃蚵仔煎，再買一杯珍珠奶茶吧！");
function ttsCount() {
  const n = ttsText.value.trim().length, segs = splitText(ttsText.value).length;
  $("#ttsCount").textContent = n ? `${n} 字，分 ${segs} 段，預估約 ${fmtT(engine.estimate(n))}` : "0 字";
}
ttsText.oninput = () => { prefs.set("ttsText", ttsText.value); ttsCount(); };

$("#ttsTextAsset").onchange = async e => {
  const a = assets.find(a => a.id === e.target.value); e.target.value = "";
  if (!a) return;
  if (ttsText.value.trim() && !confirm("要用這份文案取代目前的文字嗎？")) return;
  ttsText.value = await P.assetText(a); ttsText.oninput();
};
$("#ttsSaveText").onclick = async () => {
  if (!ttsText.value.trim()) return toast("沒有文字可以存");
  const name = prompt("文案名稱", ttsText.value.trim().slice(0, 12));
  if (!name) return;
  await P.saveText(name, ttsText.value); await refreshAssets(); toast("已存成專案文案");
};

$("#ttsPreviewBg").onclick = async e => {
  const btn = e.target;
  const ch = [new Float32Array(8 * 44100), new Float32Array(8 * 44100)];
  let any = false;
  if (S.ambience) { const a = await makeAmbience(S.ambience, 8, await babbleVoices([S.ambience]), 1); if (a) { any = true; a.forEach((c, i) => { for (let k = 0; k < ch[i].length; k++) ch[i][k] += c[k] * S.ambienceVolume * 2.2; }); } }
  if (S.music) { const m = await assetAudio(S.music, ["music"]); if (m) { any = true; for (let i = 0; i < 2; i++) { const d = m.getChannelData(Math.min(i, m.numberOfChannels - 1)); for (let k = 0; k < ch[i].length && k < d.length * 44100 / m.sampleRate; k++) ch[i][k] += d[Math.floor(k * m.sampleRate / 44100)] * S.musicVolume * 1.6; } } }
  if (!any) return toast("還沒選背景音樂或環境音");
  playChannels(ch, 44100, btn);
};

$("#ttsGo").onclick = async () => {
  const text = ttsText.value.trim();
  if (!text) return toast("請先輸入文字");
  const v = voices.find(v => v.id === tts.voice);
  if (!v) return toast("請先選一個聲音");
  const segs = splitText(text);
  const prog = progressUI($("#ttsProg"));
  showErr($("#ttsErr"), ""); $("#ttsResult").classList.add("hide");
  tts.abort = new AbortController();
  $("#ttsGo").disabled = true; $("#ttsStop").classList.remove("hide"); keepAwake(true);
  const t0 = Date.now();
  try {
    const parts = [];
    let sr = 0;
    for (let i = 0; i < segs.length; i++) {
      const el = (Date.now() - t0) / 1000;
      const eta = i ? ` · 預估還要 ${fmtT(el / i * (segs.length - i))}` : "";
      prog(i / segs.length * 0.92, `產生第 ${i + 1} / ${segs.length} 段：${segs[i].slice(0, 20)}…（已 ${fmtT(el)}${eta}）`);
      const r = await synthCached({ text: segs[i], voiceId: v.id, lang: S.lang, emotion: tts.emotion, strength: S.strength, speed: S.speed, signal: tts.abort.signal });
      if (!sr) sr = r.sr;
      parts.push(r.sr === sr ? r.data : await resample(r.data, r.sr, sr));
      if (tts.abort.signal.aborted) throw new DOMException("", "AbortError");
    }
    const speech = concat(parts, sr, 0.3);
    let channels, outSr;
    if (S.music || S.ambience) {
      prog(0.94, "加入背景…");
      const script = { cast: { 旁白: { pan: 0, volume: 1 } }, events: [] };
      if (S.ambience) script.events.push({ kind: "ambience", name: S.ambience, volume: S.ambienceVolume });
      if (S.music) script.events.push({ kind: "music", name: S.music, volume: S.musicVolume });
      script.events.push({ kind: "pause", seconds: 0.8 }, { kind: "line", speaker: "旁白", text });
      const sp = { data: speech, sr };
      channels = await mixScript({ script, audioOf: () => sp, pace: "一般", room: "無", ambienceVolume: 1, musicVolume: 1, voiceBuffers: await babbleVoices([S.ambience]), assetAudio });
      outSr = 44100;
    } else { channels = normalize([speech]); outSr = sr; }
    await finishMp3({ channels, sr: outSr, kbps: S.bitrate, title: text.replace(/\s+/g, " ").slice(0, 16), kind: "tts", text, voiceName: v.name, cover: S.cover, resultEl: $("#ttsResult"), progress: prog });
    prog(1, `完成，共花 ${fmtT((Date.now() - t0) / 1000)}`);
  } catch (e) {
    if (e.name === "AbortError") { prog(0, "已取消"); }
    else { showErr($("#ttsErr"), e.message); $("#ttsProg").classList.add("hide"); }
  } finally { $("#ttsGo").disabled = false; $("#ttsStop").classList.add("hide"); keepAwake(false); }
};
$("#ttsStop").onclick = () => tts.abort && tts.abort.abort();

// ------------------------------------------------------------
// 劇本語音
// ------------------------------------------------------------
const dstate = { cast: prefs.get("dCast", {}), pace: prefs.get("dPace", "一般"), room: prefs.get("dRoom", "無"), parsed: null, abort: null };
const dScript = $("#dScript"), dTitle = $("#dTitle");
dScript.value = prefs.get("dScript", "");
dTitle.value = prefs.get("dTitle", "");

function segPick(sel, key) {
  $$(sel + " button").forEach(b => b.onclick = () => { dstate[key] = b.dataset.v; prefs.set("d" + key[0].toUpperCase() + key.slice(1), b.dataset.v); segSync(sel, key); });
  segSync(sel, key);
}
function segSync(sel, key) { $$(sel + " button").forEach(b => b.classList.toggle("on", b.dataset.v === dstate[key])); }
segPick("#paceSeg", "pace"); segPick("#roomSeg", "room");

$$("[data-tpl]").forEach(b => b.onclick = () => {
  const t = TEMPLATES[b.dataset.tpl];
  if (dScript.value.trim() && dScript.value !== t.text && !confirm("要用範本取代目前的劇本嗎？")) return;
  dScript.value = t.text; dTitle.value = t.title;
  dstate.pace = t.pace; dstate.room = t.room; segSync("#paceSeg", "pace"); segSync("#roomSeg", "room");
  dstate.cast = {}; saveDrama(); dramaParse();
});

function saveDrama() { prefs.set("dScript", dScript.value); prefs.set("dTitle", dTitle.value); prefs.set("dCast", dstate.cast); prefs.set("dPace", dstate.pace); prefs.set("dRoom", dstate.room); }
let parseTimer;
dScript.oninput = () => { clearTimeout(parseTimer); parseTimer = setTimeout(dramaParse, 500); saveDrama(); };
dTitle.oninput = saveDrama;

function insertLine(str) {
  const v = dScript.value, pos = dScript.selectionStart ?? v.length;
  const lineStart = v.lastIndexOf("\n", pos - 1) + 1;
  const ins = str + "\n";
  dScript.value = v.slice(0, lineStart) + ins + v.slice(lineStart);
  dScript.focus(); dScript.selectionStart = dScript.selectionEnd = lineStart + ins.length;
  dScript.oninput();
}
$("#dInsAmb").onchange = e => { if (e.target.value) insertLine(`[背景 ${e.target.value} ${e.target.value === "無" ? "" : "35%"}]`.replace(" ]", "]")); e.target.value = ""; };
$("#dInsSfx").onchange = e => { if (e.target.value) insertLine(`[音效 ${e.target.value} 80%]`); e.target.value = ""; };
$("#dInsMusic").onchange = e => { if (e.target.value) insertLine(`[音樂 ${e.target.value} ${e.target.value === "無" ? "" : "25%"}]`.replace(" ]", "]")); e.target.value = ""; };
$$("[data-ins]").forEach(b => b.onclick = () => {
  const names = dstate.parsed ? speakers(dstate.parsed).filter(n => n !== "旁白") : [];
  const a = names[0] || "甲", c = names[1] || "乙";
  if (b.dataset.ins === "together") insertLine(`【同時】\n${a}：（一起說的台詞）\n${c}：（一起說的台詞）\n【/同時】`);
  if (b.dataset.ins === "barge") insertLine(`>${c}：（搶話的台詞）`);
  if (b.dataset.ins === "pause") insertLine(`[停頓 1.5]`);
});
$("#dTextAsset").onchange = async e => {
  const a = assets.find(a => a.id === e.target.value); e.target.value = "";
  if (!a) return;
  const txt = await P.assetText(a);
  const looksScript = /^[^\n：:]{1,12}[：:]/m.test(txt) || /^\[/m.test(txt);
  if (dScript.value.trim() && !confirm("要用這份文案取代目前的劇本嗎？")) return;
  dScript.value = looksScript ? txt : new NovelConverter().convert(txt, [], true) || `旁白：${txt}`;
  if (!dTitle.value) dTitle.value = a.name;
  dstate.cast = {}; saveDrama(); dramaParse();
};

$("#novelGo").onclick = () => {
  const nc = new NovelConverter(), prose = $("#novelText").value;
  if (!prose.trim()) return toast("請先貼上小說內文");
  let names = $("#novelNames").value.split(/[,，、\s]+/).filter(Boolean);
  if (!names.length) { names = nc.detectNames(prose); $("#novelNames").value = names.join("、"); }
  const out = nc.convert(prose, names, $("#novelNarr").checked);
  if (dScript.value.trim() && !confirm("要用轉換結果取代目前的劇本嗎？")) return;
  dScript.value = out; dstate.cast = {}; saveDrama(); dramaParse();
};

function dramaParse() {
  const text = dScript.value;
  if (!text.trim()) { dstate.parsed = null; $("#castTable").classList.add("hide"); $("#dEmpty").classList.remove("hide"); $("#dStat").textContent = ""; showErr($("#dWarn"), ""); return; }
  const ready = voices.filter(v => v.ready);
  const s = new ScriptParser(ready, assets).parse(text);
  for (const [n, o] of Object.entries(dstate.cast)) if (s.cast[n]) Object.assign(s.cast[n], o);
  dstate.parsed = s;
  const names = speakers(s);
  $("#dEmpty").classList.toggle("hide", names.length > 0);
  $("#castTable").classList.toggle("hide", !names.length);
  const langs = langOptions();
  $("#castTable tbody").innerHTML = names.map(n => {
    const c = s.cast[n];
    return `<tr data-n="${esc(n)}"><td><b>${esc(n)}</b></td>
      <td><select data-k="voice_id">${ready.map(v => `<option value="${esc(v.id)}" ${v.id === c.voice_id ? "selected" : ""}>${esc(v.name)}${v.ageLabel ? `（${v.ageLabel}${v.genderLabel}）` : ""}</option>`).join("")}</select></td>
      <td><select data-k="language">${langs.map(l => `<option value="${l}" ${l === c.language ? "selected" : ""}>${LANG_NAMES[l].replace("（實驗性）", "")}</option>`).join("")}${langs.includes(c.language) ? "" : `<option value="${c.language}" selected>${LANG_NAMES[c.language]}（目前引擎不支援）</option>`}</select></td>
      <td data-l="左 ↔ 右"><input type="range" data-k="pan" min="-1" max="1" step="0.1" value="${c.pan}"></td>
      <td data-l="音量"><input type="range" data-k="volume" min="0.3" max="1.6" step="0.1" value="${c.volume}"></td></tr>`;
  }).join("");
  $$("#castTable [data-k]").forEach(el => el.onchange = () => {
    const n = el.closest("tr").dataset.n;
    dstate.cast[n] = { ...(dstate.cast[n] || {}), [el.dataset.k]: el.type === "range" ? +el.value : el.value };
    saveDrama(); dramaParse();
  });
  const lines = allLines(s), chars = lines.reduce((a, l) => a + l.text.length, 0);
  $("#dStat").textContent = names.length ? `${names.length} 個角色、${lines.length} 句、${chars} 字，預估約 ${fmtT(engine.estimate(chars) + lines.length * 3)}（做過的句子不用重做）` : "";
  showErr($("#dWarn"), s.warnings.slice(0, 8).join("\n"));
}

$("#dGo").onclick = async () => {
  dramaParse();
  const s = dstate.parsed;
  if (!s || !allLines(s).length) return toast("劇本裡還沒有台詞");
  const title = dTitle.value.trim() || "劇本語音";
  const lines = allLines(s);
  const prog = progressUI($("#dProg"));
  showErr($("#dErr"), ""); $("#dResult").classList.add("hide");
  dstate.abort = new AbortController();
  $("#dGo").disabled = true; $("#dStop").classList.remove("hide"); keepAwake(true);
  const t0 = Date.now();
  try {
    // 同一個聲音的句子排在一起做
    const order = lines.map((l, i) => i).sort((a, b) => (s.cast[lines[a].speaker]?.voice_id || "").localeCompare(s.cast[lines[b].speaker]?.voice_id || "") || a - b);
    const audio = new Map();
    let made = 0;
    for (let k = 0; k < order.length; k++) {
      const ln = lines[order[k]], c = s.cast[ln.speaker];
      const el = (Date.now() - t0) / 1000;
      const eta = made ? ` · 預估還要 ${fmtT(el / made * (order.length - k))}` : "";
      prog(k / order.length * 0.85, `第 ${k + 1} / ${order.length} 句：${ln.speaker}：${ln.text.slice(0, 18)}（已 ${fmtT(el)}${eta}）`);
      // 一句太長也切段
      const segs = splitText(ln.text);
      const parts = [];
      let sr = 0, cached = true;
      for (const seg of segs) {
        const r = await synthCached({ text: seg, voiceId: c.voice_id, lang: c.language, emotion: ln.emotion, strength: ln.strength, speed: 1, signal: dstate.abort.signal });
        cached = cached && r.cached;
        if (!sr) sr = r.sr;
        parts.push(r.sr === sr ? r.data : await resample(r.data, r.sr, sr));
      }
      if (!cached) made++;
      audio.set(ln, { data: concat(parts, sr, 0.2), sr });
      if (dstate.abort.signal.aborted) throw new DOMException("", "AbortError");
    }
    const channels = await mixScript({
      script: s, audioOf: ln => audio.get(ln), pace: dstate.pace, room: dstate.room,
      ambienceVolume: S.dramaAmbienceVolume, musicVolume: S.dramaMusicVolume,
      voiceBuffers: await babbleVoices(s.events.filter(e => e.kind === "ambience").map(e => e.name)), assetAudio, onStep: t => prog(0.9, t),
    });
    await finishMp3({ channels, sr: 44100, kbps: S.bitrate, title, kind: "drama", text: dScript.value, voiceName: "", cover: S.cover, resultEl: $("#dResult"), progress: prog });
    prog(1, `完成，共 ${lines.length} 句，花 ${fmtT((Date.now() - t0) / 1000)}`);
  } catch (e) {
    if (e.name === "AbortError") prog(0, "已取消（做好的句子已記住，下次不用重做）");
    else { showErr($("#dErr"), e.message + "\n（已完成的句子都記住了，再按一次會從沒做完的地方繼續）"); $("#dProg").classList.add("hide"); }
  } finally { $("#dGo").disabled = false; $("#dStop").classList.add("hide"); keepAwake(false); }
};
$("#dStop").onclick = () => dstate.abort && dstate.abort.abort();

$("#dSoundList").innerHTML = `<b>內建環境音：</b>${Object.keys(AMBIENCES).join("、")}<br><b>內建音效：</b>${Object.keys(SFX).join("、")}<br>專案裡的背景音樂、音效也可以直接寫檔名。`;

// ------------------------------------------------------------
// 聲音範本
// ------------------------------------------------------------
function renderVoiceCards() {
  $("#vList").innerHTML = voices.map(v => `<div class="vcard" data-id="${esc(v.id)}">
    <div class="name">${esc(v.name)}${v.builtin ? `<span class="tag ${v.replaced ? "g" : ""}">${v.replaced ? "已換成我的樣本" : "內建"}</span>` : ""}${v.ageLabel ? `<span class="tag">${v.ageLabel}・${v.genderLabel}</span>` : ""}${v.builtin ? "" : v.asset ? `<span class="tag g">專案</span>` : `<span class="tag g">自訂</span>`}</div>
    ${v.ready ? "" : `<div class="hint">還沒有樣本，請錄音或上傳</div>`}
    <div class="row">${v.ready ? `<button class="small" data-a="play">▶ 試聽</button>` : ""}
      ${v.asset ? "" : `<button class="small" data-a="rec">🎤 錄音</button><button class="small" data-a="up">📁 上傳</button>`}
      ${v.builtin && v.replaced ? `<button class="small ghost" data-a="reset">↺ 還原</button>` : ""}
      ${v.custom ? `<button class="small ghost" data-a="del">🗑</button>` : ""}</div></div>`).join("");
  $$("#vList [data-a]").forEach(b => b.onclick = async () => {
    const id = b.closest(".vcard").dataset.id, v = voices.find(x => x.id === id);
    try {
      if (b.dataset.a === "play") await playBlob(await sampleBlob(id));
      if (b.dataset.a === "rec") { const blob = await recordDialog(v.name); if (blob) { await saveSample(id, v.name, blob); await refreshVoices(); toast(`已更新「${v.name}」`); } }
      if (b.dataset.a === "up") pickFile("audio/*,.mp3,.wav,.m4a", async f => { await saveSample(id, v.name, f[0]); await refreshVoices(); toast(`已更新「${v.name}」`); });
      if (b.dataset.a === "reset" && confirm(`把「${v.name}」還原成內建樣本？`)) { await removeVoice(id); await refreshVoices(); }
      if (b.dataset.a === "del" && confirm(`刪除自訂聲音「${v.name}」？`)) { await removeVoice(id); await refreshVoices(); }
    } catch (e) { toast(e.message); }
  });
}
$("#vAdd").onclick = async () => {
  const name = prompt("新聲音的名稱（例如：阿嬤（台南）、我的聲音）");
  if (!name) return;
  await addCustom(name.trim()); await refreshVoices();
  toast("已新增，請按「錄音」或「上傳」設定樣本");
};

function pickFile(accept, cb, multiple = false) {
  const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.multiple = multiple;
  i.onchange = () => i.files.length && cb([...i.files]); i.click();
}

let micStream = null;
/** 錄音對話框：最多 15 秒，回傳 Blob 或 null */
function recordDialog(name) {
  return new Promise(resolve => {
    const dlg = $("#recDlg"); $("#recTitle").textContent = `錄音：${name}`; $("#recTime").textContent = "0.0 秒";
    $("#recStart").classList.remove("hide"); $("#recStopBtn").classList.add("hide"); dlg.classList.remove("hide");
    let rec, stream, timer, raf, chunks = [], t0;
    const close = (blob) => { clearInterval(timer); cancelAnimationFrame(raf); stream && stream.getTracks().forEach(t => t.stop()); micStream = null; dlg.classList.add("hide"); resolve(blob); };
    $("#recCancel").onclick = () => { if (rec && rec.state === "recording") { rec.onstop = null; rec.stop(); } close(null); };
    $("#recStart").onclick = async () => {
      if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
        close(null);
        toast("這個瀏覽器不能直接錄音，請改用「上傳」（手機可以選錄音檔或直接錄）", 4000);
        return;
      }
      try { stream = micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch { toast("無法使用麥克風，請允許瀏覽器使用麥克風"); return close(null); }
      const ctx = audioCtx(); ctx.resume();
      const an = ctx.createAnalyser(); ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const meter = () => { an.getByteTimeDomainData(buf); let m = 0; for (const x of buf) m = Math.max(m, Math.abs(x - 128)); $("#recLevel").style.width = Math.min(100, m / 1.28) + "%"; raf = requestAnimationFrame(meter); };
      meter();
      rec = new MediaRecorder(stream); chunks = [];
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      rec.onstop = () => close(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
      rec.start(); t0 = Date.now();
      $("#recStart").classList.add("hide"); $("#recStopBtn").classList.remove("hide");
      timer = setInterval(() => { const s = (Date.now() - t0) / 1000; $("#recTime").textContent = s.toFixed(1) + " 秒"; if (s >= 15) rec.stop(); }, 100);
    };
    $("#recStopBtn").onclick = () => { if ((Date.now() - t0) < 3000) return toast("至少錄 3 秒，最好 8~15 秒"); rec.stop(); };
  });
}

// ------------------------------------------------------------
// 專案素材
// ------------------------------------------------------------
$("#pName").value = S.name;
$("#pName").onchange = e => save({ name: e.target.value.trim() || "我的專案" });

async function renderFolder() {
  const box = $("#pFolder");
  if (!P.canLinkFolder()) {
    box.innerHTML = `這個瀏覽器不能直接連結資料夾（手機、Safari、Firefox）。素材會存在瀏覽器裡；設定可以匯出／匯入。
      <div class="row wrap" style="margin-top:8px"><button id="pExport" class="small">⬇ 匯出專案設定</button><button id="pImport" class="small">⬆ 匯入專案設定</button></div>`;
  } else if (P.folderLinked()) {
    box.innerHTML = `📂 已連結專案資料夾：<code>${esc(P.folderName())}</code>（素材子資料夾：聲音、文案、圖形、背景音樂、音效；產生的 MP3 存到「輸出」）
      <div class="row wrap" style="margin-top:8px"><button id="pRescan" class="small">🔄 重新讀取</button><button id="pLink" class="small">換一個資料夾</button><button id="pUnlink" class="small ghost">取消連結</button>
      <label class="check"><input type="checkbox" id="pSaveOut" ${S.saveToFolder ? "checked" : ""}> 產生的 MP3 自動存到「輸出」</label></div>`;
  } else {
    const saved = await P.savedFolder();
    box.innerHTML = `把電腦上的資料夾當成專案：裡面的「聲音、文案、圖形、背景音樂、音效」會自動變成素材，設定存成「專案設定.json」，產生的 MP3 存到「輸出」。
      <div class="row wrap" style="margin-top:8px">${saved ? `<button id="pRelink" class="primary small">🔓 重新連結「${esc(saved.name)}」</button>` : ""}<button id="pLink" class="${saved ? "" : "primary "}small">📂 選擇專案資料夾</button>
      <button id="pExport" class="small ghost">⬇ 匯出設定</button><button id="pImport" class="small ghost">⬆ 匯入設定</button></div>`;
  }
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = async () => { try { await fn(); } catch (e) { if (e.name !== "AbortError") toast(e.message); } }; };
  on("#pLink", async () => { const n = await P.linkFolder(false); afterFolder(n); });
  on("#pRelink", async () => { const n = await P.linkFolder(true); afterFolder(n); });
  on("#pRescan", async () => { await P.scanFolder(); await refreshAssets(); toast("已重新讀取"); });
  on("#pUnlink", async () => { if (confirm("取消連結專案資料夾？（資料夾裡的檔案不會被刪除）")) { await P.unlinkFolder(); await refreshAssets(); renderFolder(); } });
  on("#pExport", () => { const a = document.createElement("a"); a.href = URL.createObjectURL(P.exportSettings()); a.download = "專案設定.json"; a.click(); });
  on("#pImport", () => pickFile(".json,application/json", async f => { S = await P.importSettings(f[0]); toast("已匯入設定"); location.reload(); }));
  const so = $("#pSaveOut"); if (so) so.onchange = () => save({ saveToFolder: so.checked });
}
async function afterFolder(name) { S = P.settings(); $("#pName").value = S.name; await refreshAssets(); renderFolder(); toast(`已連結「${name}」`); }

async function renderKinds() {
  const html = [];
  for (const [kind, k] of Object.entries(P.KINDS)) {
    const list = assets.filter(a => a.kind === kind);
    html.push(`<div class="card" data-kind="${kind}"><div class="row between"><h2>${k.icon} ${k.label} <small class="muted">${list.length}</small></h2>
      <button class="small" data-imp="${kind}">＋ 匯入</button></div>
      <p class="hint">${{ voice: "聲音樣本：會出現在聲音範本，可以用這個聲音說話。", text: "稿子或劇本（txt）：在單一語音／劇本語音「載入專案文案」。", image: "MP3 封面：手機音樂 App 會顯示。", music: "墊在語音下面的音樂；劇本用 [音樂 檔名 20%]。", sfx: "自己的音效；劇本用 [音效 檔名]。" }[kind]}</p>
      ${kind === "text" ? `<details class="newtext"><summary class="hint">✏️ 新增文案</summary><input id="ntName" placeholder="文案名稱"><textarea id="ntBody" rows="4" placeholder="內容"></textarea><button id="ntSave" class="small">儲存</button></details>` : ""}
      <ul class="alist">${list.map(a => `<li data-id="${esc(a.id)}">${kind === "image" ? `<img data-thumb="${esc(a.id)}" alt="">` : ""}<span class="n" title="${esc(a.file || a.name)}">${esc(a.name)}</span>
        ${kind === "text" ? `<button data-x="tts">單一</button><button data-x="drama">劇本</button>` : kind === "image" ? `<button data-x="cover">${S.cover === a.id ? "✓ 封面" : "設為封面"}</button>` : `<button data-x="play">▶</button>`}
        ${kind === "music" ? `<button data-x="bgm">${S.music === a.name ? "✓ 背景" : "用作背景"}</button>` : ""}
        <button data-x="del" class="ghost">🗑</button></li>`).join("") || `<li class="muted">還沒有${k.label}</li>`}</ul></div>`);
  }
  $("#pKinds").innerHTML = html.join("");
  $$("[data-imp]").forEach(b => b.onclick = () => pickFile(P.KINDS[b.dataset.imp].accept, async files => {
    try { await P.importFiles(files, b.dataset.imp); await refreshAssets(); toast(`已匯入 ${files.length} 個檔案`); } catch (e) { toast(e.message); }
  }, true));
  for (const img of $$("[data-thumb]")) P.assetBlob(img.dataset.thumb).then(b => img.src = URL.createObjectURL(b)).catch(() => { });
  const nt = $("#ntSave");
  if (nt) nt.onclick = async () => { const n = $("#ntName").value.trim(), t = $("#ntBody").value; if (!n || !t.trim()) return toast("請輸入名稱和內容"); await P.saveText(n, t); await refreshAssets(); toast("已儲存文案"); };
  $$(".alist [data-x]").forEach(b => b.onclick = async () => {
    const a = assets.find(x => x.id === b.closest("li").dataset.id);
    try {
      switch (b.dataset.x) {
        case "play": await playBlob(await P.assetBlob(a)); break;
        case "tts": ttsText.value = await P.assetText(a); ttsText.oninput(); showTab("tts"); break;
        case "drama": $("#dTextAsset").value = a.id; showTab("drama"); $("#dTextAsset").onchange({ target: $("#dTextAsset") }); break;
        case "cover": await save({ cover: S.cover === a.id ? "" : a.id }); refreshSelects(); renderKinds(); break;
        case "bgm": await save({ music: S.music === a.name ? "" : a.name }); refreshSelects(); renderKinds(); break;
        case "del": if (confirm(`刪除「${a.name}」？${a.source === "folder" ? "（會從專案資料夾刪除檔案）" : ""}`)) { await P.removeAsset(a); await refreshAssets(); } break;
      }
    } catch (e) { toast(e.message); }
  });
}

function renderSoundLib() {
  const mk = (el, names, isAmb) => {
    el.innerHTML = Object.entries(names).map(([n, d]) => `<button title="${esc(d)}" data-n="${esc(n)}">▶ ${esc(n)}</button>`).join("");
    el.querySelectorAll("button").forEach(b => b.onclick = async () => {
      if (b.classList.contains("playing")) return stopAll();
      b.textContent = "⏳ " + b.dataset.n;
      const ch = isAmb ? await makeAmbience(b.dataset.n, 8, await babbleVoices([b.dataset.n]), 1) : await makeSfx(b.dataset.n, 1);
      b.textContent = "▶ " + b.dataset.n;
      if (isAmb) ch.forEach(c => { for (let i = 0; i < c.length; i++) c[i] *= 2.2 * 0.5; });
      playChannels(ch, 44100, b);
    });
  };
  mk($("#pAmb"), AMBIENCES, true); mk($("#pSfx"), SFX, false);
}

function refreshSelects() {
  const by = k => assets.filter(a => a.kind === k);
  const opt = (v, t, sel) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(t)}</option>`;
  const texts = by("text").map(a => opt(a.id, a.name)).join("");
  $("#ttsTextAsset").innerHTML = `<option value="">📝 載入專案文案…</option>` + texts;
  $("#dTextAsset").innerHTML = `<option value="">📝 載入專案文案…</option>` + texts;
  $("#ttsMusic").innerHTML = opt("", "（不加）", S.music) + by("music").map(a => opt(a.name, a.name, S.music)).join("");
  if (S.music && !by("music").some(a => a.name === S.music)) $("#ttsMusic").innerHTML += opt(S.music, S.music + "（找不到）", S.music);
  $("#ttsAmb").innerHTML = opt("", "（不加）", S.ambience) + Object.keys(AMBIENCES).map(n => opt(n, n, S.ambience)).join("");
  const covers = opt("", "（不加封面）", S.cover) + by("image").map(a => opt(a.id, a.name, S.cover)).join("");
  $("#ttsCover").innerHTML = covers; $("#dCover").innerHTML = covers;
  $("#dInsAmb").innerHTML = `<option value="">🌦️ 插入背景音…</option>` + Object.keys(AMBIENCES).map(n => opt(n, `${n}（${AMBIENCES[n]}）`)).join("") + opt("無", "關掉背景音");
  $("#dInsSfx").innerHTML = `<option value="">💥 插入音效…</option>` + Object.keys(SFX).map(n => opt(n, `${n}（${SFX[n]}）`)).join("") + by("sfx").map(a => opt(a.name, "📁 " + a.name)).join("");
  $("#dInsMusic").innerHTML = `<option value="">🎵 插入背景音樂…</option>` + (by("music").map(a => opt(a.name, a.name)).join("") || `<option disabled>（先到「專案素材」匯入背景音樂）</option>`) + opt("無", "關掉背景音樂");
}

async function refreshAssets() {
  assets = await P.listAssets();
  assetCache.clear();
  invalidateVoices();
  await refreshVoices();
  refreshSelects();
  renderKinds();
}
async function refreshVoices() {
  voices = await listVoices(true);
  _voiceBufs = null;
  renderVoiceChips(); renderVoiceCards(); dramaParse();
}

// ------------------------------------------------------------
// 產生紀錄
// ------------------------------------------------------------
let histUrls = [];
async function renderHistory() {
  histUrls.forEach(u => URL.revokeObjectURL(u)); histUrls = [];
  const list = (await db.all("history")).sort((a, b) => b.created - a.created);
  $("#hList").innerHTML = list.length ? list.map(h => {
    const u = URL.createObjectURL(h.blob); histUrls.push(u);
    return `<div class="hitem" data-id="${h.id}"><div class="t">${h.kind === "drama" ? "🎭" : "🗣️"} ${esc(h.title)}</div>
      <div class="meta">${new Date(h.created).toLocaleString("zh-TW")} · ${fmtT(h.seconds)} · ${esc(h.voice || "多人")} · ${(h.size / 1024 / 1024).toFixed(2)} MB</div>
      <audio controls preload="none" src="${u}"></audio>
      <div class="row">${Desktop.available ? `<button class="small" data-save>${Desktop.ios ? "📤 分享／儲存" : "💾 存檔"}</button>` : `<a href="${u}" download="${esc(h.filename)}"><button class="small">⬇ 下載</button></a>`}<button class="small ghost" data-del>🗑 刪除</button></div></div>`;
  }).join("") : `<p class="muted">還沒有產生過語音。</p>`;
  $$("#hList [data-del]").forEach(b => b.onclick = async () => { await db.del("history", b.closest(".hitem").dataset.id); renderHistory(); });
  $$("#hList [data-save]").forEach(b => b.onclick = async () => {
    const h = list.find(x => x.id === b.closest(".hitem").dataset.id);
    try { const p = await appSave(h.filename, h.blob, Desktop.desktop); if (p && !Desktop.ios) toast("已存到 " + p, 4000); } catch (e) { toast(e.message); }
  });
}
$("#hClear").onclick = async () => { if (confirm("清除全部產生紀錄？")) { await db.clear("history"); renderHistory(); } };
// 範例檔用英文檔名（Android 打包工具不支援中文檔名）
$("#hSamples").innerHTML = [["market", "星期天的菜市場", "多人同時說話＋菜市場背景"], ["night-fight", "深夜的客廳", "夫妻吵架、搶話"], ["debate", "小學生該不該用手機", "辯論、大廳回音"], ["sick", "破病有夠艱苦", "中年女音朗讀"]]
  .map(([f, t, d]) => `<div><b>${t}</b><br><small>${d}</small><audio controls preload="none" src="samples/${f}.mp3"></audio></div>`).join("");

// ------------------------------------------------------------
// 設定
// ------------------------------------------------------------
function renderSettings() {
  $$("input[name=engine]").forEach(r => r.checked = r.value === S.engine);
  $("#sCloud").classList.toggle("hide", S.engine === "local");
  $("#sLocal").classList.toggle("hide", S.engine !== "local");
  if (S.engine === "local") $("#advEngine").open = true;
  $("#sToken").value = S.hfToken || ""; verifyToken(); $("#sUrl").value = S.localUrl; $("#sKey").value = S.localKey || "";
  $("#sVer").textContent = APP_VERSION;
}
async function engineChanged() {
  engine = makeEngine(engineOpts());
  renderSettings(); renderLang(); ttsCount(); dramaParse(); checkEngine(false);
}
$$("input[name=engine]").forEach(r => r.onchange = async () => { await save({ engine: r.value }); engineChanged(); });
async function setToken(v) {
  // 複製時常帶到空白、換行或前後的文字：只取出 hf_ 開頭那一串
  v = (v || "").trim().replace(/^Bearer\s+/i, "");
  const m = v.match(/hf_[A-Za-z0-9]{20,}/);
  if (m) v = m[0];
  $("#sToken").value = v;
  await save({ hfToken: v });
  engine = makeEngine(engineOpts()); renderLang();
  verifyToken();
}
/** 向 Hugging Face 確認權杖有效，顯示帳號名稱 */
async function verifyToken() {
  const msg = $("#sTokenMsg"), t = S.hfToken || "";
  if (!t) { msg.textContent = "尚未設定權杖（沒登入只能產生幾次）。"; return; }
  if (!/^hf_[A-Za-z0-9]{20,}$/.test(t)) { msg.textContent = "⚠️ 這看起來不是權杖，應該是 hf_ 開頭的一串英數字。"; return; }
  msg.textContent = "確認中…";
  try {
    const r = await fetch("https://huggingface.co/api/whoami-v2", { headers: { Authorization: "Bearer " + t } });
    if (r.status === 401) { msg.textContent = "❌ 權杖無效或已刪除，請重新建立一個。"; return; }
    const j = await r.json();
    msg.textContent = `✅ 權杖可以用（帳號：${j.name || "?"}）。之後產生語音會用你帳號的每日額度。${j.emailVerified === false ? "\n⚠️ 你的 Email 還沒驗證，請先到信箱點驗證信。" : ""}`;
  } catch { msg.textContent = "已儲存（暫時無法向 Hugging Face 確認，網路可能不穩）。"; }
}
$("#sToken").onchange = e => setToken(e.target.value);
// 長按「貼上」後馬上檢查，不用再按其他地方
$("#sToken").oninput = e => { if (/hf_[A-Za-z0-9]{20,}/.test(e.target.value)) setToken(e.target.value); };
$("#sTokenQR").onclick = () => S.hfToken ? showTokenQR(S.hfToken).catch(e => toast(e.message)) : toast("這台裝置還沒有權杖：先貼上權杖，才能傳到手機");
$("#sTokenScan").onclick = async () => {
  try { const t = await scanTokenQR(); if (t) { await setToken(t); toast("已從 QR Code 帶入權杖"); } }
  catch (e) { toast(e.message, 4000); }
};
$("#sTokenEye").onclick = () => { const i = $("#sToken"); i.type = i.type === "password" ? "text" : "password"; };
$("#sTokenClear").onclick = () => { if (confirm("清除權杖？")) setToken(""); };
$("#sTokenPaste").onclick = async () => {
  try {
    const t = await readClipboard();
    if (!t.trim()) return toast("剪貼簿是空的，請先到 Hugging Face 複製權杖");
    await setToken(t);
  } catch {
    $("#sToken").type = "text"; $("#sToken").focus();
    toast("這個瀏覽器不讓網頁讀剪貼簿，請長按輸入框選「貼上」", 4000);
  }
};
$("#sUrl").onchange = async e => { await save({ localUrl: e.target.value.trim() || "http://127.0.0.1:7861" }); engineChanged(); };
$("#sKey").onchange = async e => { await save({ localKey: e.target.value }); engineChanged(); };
$("#sTest").onclick = () => { $("#sTestMsg").textContent = "測試中…"; checkEngine(true); };
$("#sClearCache").onclick = async () => { await db.clear("lines"); toast("已清除台詞快取"); renderStorage(); };
async function renderStorage() {
  try { const e = await navigator.storage.estimate(); $("#sStorage").textContent = `這個網站已使用 ${(e.usage / 1024 / 1024).toFixed(1)} MB（產生紀錄、台詞快取、自訂聲音、匯入的素材）。`; } catch { }
}

$("#sInstallHint").textContent = isStandalone ? "✅ 已經安裝在這台裝置，正從主畫面開啟。"
  : isIOS ? "這台是 iPhone／iPad：請用 Safari 開啟本網頁，按下方的「分享」→「加入主畫面」。" : "";
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#sInstall").classList.remove("hide"); });
$("#sInstall").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("#sInstall").classList.add("hide"); };

// ------------------------------------------------------------
// 啟動
// ------------------------------------------------------------
(async function init() {
  renderSettings(); renderLang(); syncEmo(); renderSoundLib();
  const saved = await P.savedFolder().catch(() => null);
  if (saved && (await saved.queryPermission?.({ mode: "readwrite" })) === "granted") { try { await P.linkFolder(true); S = P.settings(); } catch { } }
  else if (saved) {
    // 瀏覽器安全規定：重新開啟資料夾必須點一下（Chrome 選「每次造訪都允許」之後就會自動開）
    const bar = $("#folderBar");
    bar.innerHTML = `📂 專案資料夾「${esc(saved.name)}」<button class="primary small">按一下開啟</button><button class="ghost small" data-x>先不用</button>`;
    bar.classList.remove("hide");
    bar.querySelector(".primary").onclick = async () => { try { await afterFolder(await P.linkFolder(true)); bar.classList.add("hide"); } catch (e) { toast(e.message); } };
    bar.querySelector("[data-x]").onclick = () => bar.classList.add("hide");
  }
  await refreshAssets();
  renderFolder();
  ttsCount();
  const q = new URLSearchParams(location.search);
  if (q.get("tpl") && TEMPLATES[q.get("tpl")]) { dScript.value = ""; $(`[data-tpl=${q.get("tpl")}]`).click(); }
  showTab(q.get("tab") || prefs.get("tab", "tts"));
  checkEngine(false);
  const inApp = await whenAppReady(location.hostname === "127.0.0.1" ? 2500 : 300);
  if (!inApp && "serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => { });
  if (inApp) setupApp();
})();

// ------------------------------------------------------------
// App 版（Windows／Mac／Android／iPhone）：版本更新、外部連結
// ------------------------------------------------------------
async function setupApp() {
  document.body.classList.add("inapp");
  $("#sInstallBox").classList.add("hide");
  // 外部連結（申請權杖、GitHub）用系統瀏覽器開
  document.addEventListener("click", e => {
    const a = e.target.closest("a[target=_blank]");
    if (a) { e.preventDefault(); openExternal(a.href); }
  }, true);
  const info = await Desktop.api.app_info().catch(() => null);
  if (info?.version) $("#sVer").textContent = `${APP_VERSION}（${Desktop.ios ? "iPhone" : Desktop.android ? "Android" : info.platform === "darwin" ? "Mac" : "Windows"} App ${info.version}）`;
  $("#sUpdate").classList.remove("hide");
  $("#sCheckUpdate").onclick = () => checkAppUpdate(true);
  if (!Desktop.ios) setTimeout(() => checkAppUpdate(false), 4000);
}

async function checkAppUpdate(manual) {
  const msg = $("#sUpdateMsg");
  if (manual) msg.textContent = "檢查中…";
  const r = await Desktop.api.check_update().catch(e => ({ status: "error", message: e.message }));
  if (r.status !== "ok") { if (manual) msg.textContent = "無法檢查更新：" + (r.message || ""); return; }
  if (!r.latest || cmpVersion(r.latest, r.current) <= 0 || !r.url) { if (manual) msg.textContent = `✅ 已是最新版（${r.current}）`; return; }
  msg.textContent = `有新版本 ${r.latest}（目前 ${r.current}）`;
  const bar = $("#updateBar");
  bar.innerHTML = `🎉 小柯語音有新版本 ${esc(r.latest)}<button class="primary small">立即更新</button><button class="ghost small" data-x>稍後</button>`;
  bar.classList.remove("hide");
  bar.querySelector("[data-x]").onclick = () => bar.classList.add("hide");
  bar.querySelector(".primary").onclick = async () => {
    await Desktop.api.install_update(r.url, r.latest);
    const poll = setInterval(async () => {
      const st = await Desktop.api.update_status();
      if (st.state === "downloading") bar.firstChild.textContent = `下載新版中… ${st.pct}% `;
      else if (st.state === "permission") { clearInterval(poll); bar.firstChild.textContent = "請在設定畫面允許「安裝不明的應用程式」，再按一次立即更新 "; }
      else if (st.state === "manual") { clearInterval(poll); bar.firstChild.textContent = "已打開新版安裝映像：把 App 拖進「應用程式」取代即可 "; }
      else if (st.state === "error") { clearInterval(poll); bar.firstChild.textContent = "更新失敗：" + (st.message || "") + " "; }
      else if (st.state === "launching") bar.firstChild.textContent = "安裝中，完成後會自動重新開啟… ";
    }, 700);
  };
}

// ------------------------------------------------------------
// 離開／關閉：停止所有執行中的工作（產生語音、播放、錄音）
// ------------------------------------------------------------
const busy = () => $("#ttsGo").disabled || $("#dGo").disabled;
window.addEventListener("beforeunload", e => { if (busy()) { e.preventDefault(); e.returnValue = ""; } });
window.addEventListener("pagehide", () => {
  tts.abort && tts.abort.abort();
  dstate.abort && dstate.abort.abort();
  stopAll();
  keepAwake(false);
  micStream && micStream.getTracks().forEach(t => t.stop());
  try { audioCtx().close(); } catch { }
});
