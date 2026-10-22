// 音訊工具：解碼、重新取樣、去頭尾靜音、接句子、WAV/MP3 編碼。全部在瀏覽器裡做，不上傳。

// 舊版 iPhone Safari 只有加 webkit 前綴的版本
if (!window.OfflineAudioContext && window.webkitOfflineAudioContext) window.OfflineAudioContext = window.webkitOfflineAudioContext;

let _ctx = null;
export function audioCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

/** 任何音檔（Blob / ArrayBuffer）→ { data: 單聲道 Float32Array, sr } */
export async function decodeMono(src) {
  const buf = src instanceof ArrayBuffer ? src : await src.arrayBuffer();
  const ab = await audioCtx().decodeAudioData(buf.slice(0));
  return { data: toMono(ab), sr: ab.sampleRate };
}

export function toMono(ab) {
  if (ab.numberOfChannels === 1) return ab.getChannelData(0).slice();
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out;
}

/** 用 OfflineAudioContext 重新取樣（品質比線性內插好） */
export async function resample(data, from, to) {
  if (from === to || !data.length) return data;
  const len = Math.max(1, Math.round(data.length * to / from));
  const off = new OfflineAudioContext(1, len, to);
  const b = off.createBuffer(1, data.length, from);
  b.getChannelData(0).set(data);
  const s = off.createBufferSource();
  s.buffer = b; s.connect(off.destination); s.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

/** 去掉每句前後多餘的靜音，對話節奏才抓得準（與伺服器版 trim_silence 相同做法） */
export function trimSilence(y, sr, threshDb = -42) {
  const win = Math.round(0.02 * sr);
  const frames = Math.floor(y.length / win);
  if (!frames) return y;
  const e = new Float32Array(frames);
  let peak = 1e-9;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * win; i < (f + 1) * win; i++) s += y[i] * y[i];
    e[f] = Math.sqrt(s / win + 1e-12);
    if (e[f] > peak) peak = e[f];
  }
  let first = -1, last = -1;
  for (let f = 0; f < frames; f++) {
    if (20 * Math.log10(e[f] / peak + 1e-12) > threshDb) { if (first < 0) first = f; last = f; }
  }
  if (first < 0) return y;
  const a = Math.max(0, first * win - Math.round(0.03 * sr));
  const b = Math.min(y.length, (last + 1) * win + Math.round(0.08 * sr));
  return y.slice(a, b);
}

/** 把多段語音接起來，中間留 gap 秒 */
export function concat(chunks, sr, gap = 0.25) {
  const g = Math.round(gap * sr);
  const total = chunks.reduce((n, c) => n + c.length, 0) + g * Math.max(0, chunks.length - 1);
  const out = new Float32Array(total);
  let p = 0;
  chunks.forEach((c, i) => { out.set(c, p); p += c.length + (i < chunks.length - 1 ? g : 0); });
  return out;
}

export function normalize(channels, target = 0.9) {
  let peak = 1e-9;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
  const k = target / peak;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= k;
  return channels;
}

export function encodeWav(mono, sr) {
  const buf = new ArrayBuffer(44 + mono.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + mono.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, mono[i])) * 0x7fff, true);
  return new Blob([buf], { type: "audio/wav" });
}

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/**
 * 編碼成 MP3（lamejs）。channels = [L] 或 [L, R]。
 * 每編一段就讓出主執行緒，長音檔也不會讓畫面卡住。
 */
export async function encodeMp3(channels, sr, kbps = 192, onProgress) {
  if (!MP3_RATES.includes(sr)) {
    channels = await Promise.all(channels.map(c => resample(c, sr, 44100)));
    sr = 44100;
  }
  const nch = channels.length;
  const enc = new lamejs.Mp3Encoder(nch, sr, kbps);
  const toI16 = f => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff; return o; };
  const pcm = channels.map(toI16);
  const parts = [];
  const block = 1152 * 40;
  for (let i = 0; i < pcm[0].length; i += block) {
    const l = pcm[0].subarray(i, i + block);
    const r = nch > 1 ? pcm[1].subarray(i, i + block) : undefined;
    const m = nch > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (m.length) parts.push(new Uint8Array(m));
    if ((i / block) % 20 === 0) {
      onProgress && onProgress(i / pcm[0].length);
      await new Promise(r => setTimeout(r));
    }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  onProgress && onProgress(1);
  return new Blob(parts, { type: "audio/mpeg" });
}

/** 一段 Float32 → 可播放的 AudioBuffer 秒數 */
export const seconds = (n, sr) => Math.round(n / sr * 10) / 10;
