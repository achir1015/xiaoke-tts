// 環境音與音效：全部用數學即時合成（不用下載任何音效檔）。
//   背景（持續）：菜市場、人群、雨、雷雨、風、海浪、溪流、鳥叫、蟲鳴、蟬鳴、夜晚、森林…
//   音效（單次）：雷聲、鳥叫、門鈴、敲門、電話鈴、掌聲、腳步聲、鐘聲、水滴…
// 每種聲音都在 OfflineAudioContext 裡用雜訊 + 濾波器 + 音量包絡做出來，回傳立體聲 [L, R]。

export const SR = 44100;

// ---------- 名稱與別名 ----------
export const AMBIENCES = {
  "菜市場": "人聲鼎沸、叫賣、碗盤", "人群嘈雜": "遠處很多人在講話", "會議廳": "零星交談與空調聲", "咖啡廳": "小聲交談、杯盤聲",
  "雨聲": "一般的雨", "大雨": "滂沱大雨", "雷雨": "大雨加上遠近雷聲", "風聲": "一陣一陣的風",
  "海浪": "浪潮拍岸", "溪流": "潺潺流水", "鳥叫": "清晨的鳥鳴", "森林": "鳥叫加上微風",
  "蟲鳴": "草叢裡的蟋蟀", "蟬鳴": "夏天的蟬", "夜晚": "蟲鳴、蛙叫、微風", "營火": "柴火劈啪",
};
export const SFX = {
  "雷聲": "近處一聲雷", "遠雷": "遠處悶雷", "鳥叫": "一段鳥鳴", "蟲鳴": "幾聲蟋蟀", "蛙叫": "幾聲青蛙",
  "門鈴": "叮咚", "敲門": "叩叩叩", "電話鈴": "家用電話", "掌聲": "一陣掌聲", "腳步聲": "走幾步路",
  "鐘聲": "廟裡的鐘", "水滴": "滴答", "風聲": "一陣風",
};
export const AMB_ALIASES = {
  "市場": "菜市場", "夜市": "菜市場", "人群": "人群嘈雜", "餐廳": "人群嘈雜", "辯論": "會議廳", "辯論會": "會議廳", "教室": "會議廳",
  "雨": "雨聲", "下雨": "雨聲", "小雨": "雨聲", "暴雨": "大雨", "豪雨": "大雨", "打雷": "雷雨", "雷": "雷雨", "颱風": "雷雨",
  "風": "風聲", "海": "海浪", "海邊": "海浪", "河": "溪流", "小溪": "溪流", "流水": "溪流", "鳥": "鳥叫", "鳥鳴": "鳥叫", "清晨": "鳥叫",
  "蟲": "蟲鳴", "蟋蟀": "蟲鳴", "蟬": "蟬鳴", "夏天": "蟬鳴", "晚上": "夜晚", "夜": "夜晚", "山上": "森林", "樹林": "森林", "火": "營火",
  "咖啡": "咖啡廳", "無": "無", "關": "無", "停": "無", "安靜": "無",
};
export const SFX_ALIASES = { "雷": "雷聲", "打雷": "雷聲", "鳥": "鳥叫", "蟲": "蟲鳴", "青蛙": "蛙叫", "叮咚": "門鈴", "電話": "電話鈴", "鼓掌": "掌聲", "腳步": "腳步聲", "鐘": "鐘聲", "風": "風聲" };

// ---------- 小工具 ----------
function rng(seed) {                 // 可重現的亂數（同一劇本每次混出來一樣）
  let a = seed >>> 0 || 1;
  const f = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  f.uni = (lo, hi) => lo + (hi - lo) * f();
  f.int = n => Math.floor(f() * n);
  return f;
}

function noiseBuf(ctx, sec, kind, r) {
  const n = Math.max(1, Math.round(sec * ctx.sampleRate));
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  if (kind === "white") for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
  else if (kind === "pink") {         // Paul Kellet 粉紅雜訊
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
  } else {                            // brown 棕色雜訊：低沉
    let last = 0;
    for (let i = 0; i < n; i++) { last = (last + 0.02 * (r() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
  }
  return b;
}

function src(ctx, buf, t = 0, loop = false) {
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = loop; s.start(t); return s;
}
function filt(ctx, type, freq, Q = 0.7) { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q; return f; }
function gain(ctx, v) { const g = ctx.createGain(); g.gain.value = v; return g; }
function pan(ctx, p) { const s = ctx.createStereoPanner(); s.pan.value = p; return s; }
function chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }

// ---------- 各種聲音的「配方」：在 ctx 上把聲音接到 out ----------
function rain(ctx, out, dur, r, heavy = 1) {
  const n = noiseBuf(ctx, Math.min(dur, 12), "white", r);
  chain(src(ctx, n, 0, true), filt(ctx, "highpass", 500), filt(ctx, "lowpass", 8000), gain(ctx, 0.35 * heavy), out);
  chain(src(ctx, noiseBuf(ctx, Math.min(dur, 12), "brown", r), 0, true), filt(ctx, "lowpass", 600), gain(ctx, 0.25 * heavy), out);
  // 雨滴：短促的高頻點擊，左右散開
  const drop = noiseBuf(ctx, 0.02, "white", r);
  const count = Math.round(dur * 25 * heavy);
  for (let i = 0; i < count; i++) {
    const t = r() * dur;
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(r.uni(0.05, 0.25), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    chain(src(ctx, drop, t), filt(ctx, "bandpass", r.uni(2000, 6000), 2), g, pan(ctx, r.uni(-0.9, 0.9)), out);
  }
}

function thunder(ctx, out, t, r, near = true) {
  const len = r.uni(5, 8);
  const rum = gain(ctx, 0);
  const g = rum.gain;
  g.setValueAtTime(0, t); g.linearRampToValueAtTime(near ? 1 : 0.5, t + (near ? 0.05 : 0.6));
  let k = t + 0.3;
  while (k < t + len - 0.5) { g.linearRampToValueAtTime(r.uni(0.25, 0.9) * (1 - (k - t) / len) * (near ? 1 : 0.5), k); k += r.uni(0.2, 0.7); }
  g.linearRampToValueAtTime(0, t + len);
  chain(src(ctx, noiseBuf(ctx, len, "brown", r), t), filt(ctx, "lowpass", near ? 260 : 140), rum, pan(ctx, r.uni(-0.5, 0.5)), out);
  if (near) {                         // 霹靂一聲
    const c = gain(ctx, 0);
    c.gain.setValueAtTime(0.9, t); c.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    chain(src(ctx, noiseBuf(ctx, 0.7, "white", r), t), filt(ctx, "bandpass", 1200, 0.6), c, out);
  }
}

function wind(ctx, out, dur, r, level = 1) {
  const f = filt(ctx, "bandpass", 500, 0.9);
  const g = gain(ctx, 0.4 * level);
  for (let t = 0; t < dur; t += r.uni(1.5, 4)) {
    f.frequency.linearRampToValueAtTime(r.uni(250, 1100), t);
    g.gain.linearRampToValueAtTime(r.uni(0.15, 0.6) * level, t);
  }
  chain(src(ctx, noiseBuf(ctx, Math.min(dur, 15), "pink", r), 0, true), f, g, out);
}

function waves(ctx, out, dur, r) {
  const f = filt(ctx, "lowpass", 500);
  const g = gain(ctx, 0.1);
  for (let t = 0; t < dur; t += r.uni(6, 10)) {
    f.frequency.setTargetAtTime(400, t, 0.5); g.gain.setTargetAtTime(0.1, t, 0.5);
    f.frequency.setTargetAtTime(r.uni(1500, 2600), t + 2, 0.8); g.gain.setTargetAtTime(r.uni(0.6, 0.9), t + 2, 0.7);
    f.frequency.setTargetAtTime(600, t + 4, 1.2); g.gain.setTargetAtTime(0.2, t + 4, 1.4);
  }
  chain(src(ctx, noiseBuf(ctx, Math.min(dur, 15), "pink", r), 0, true), f, g, out);
  chain(src(ctx, noiseBuf(ctx, Math.min(dur, 15), "brown", r), 0, true), filt(ctx, "lowpass", 300), gain(ctx, 0.3), out);
}

function stream(ctx, out, dur, r) {
  chain(src(ctx, noiseBuf(ctx, Math.min(dur, 12), "white", r), 0, true), filt(ctx, "bandpass", 2200, 0.5), gain(ctx, 0.18), out);
  chain(src(ctx, noiseBuf(ctx, Math.min(dur, 12), "brown", r), 0, true), filt(ctx, "lowpass", 700), gain(ctx, 0.3), out);
  // 水泡聲：短促、音高往上滑的小正弦波
  for (let i = 0, n = Math.round(dur * 12); i < n; i++) {
    const t = r() * dur, f0 = r.uni(400, 1300), o = ctx.createOscillator(), g = gain(ctx, 0);
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * r.uni(1.5, 2.5), t + 0.05);
    g.gain.setValueAtTime(r.uni(0.03, 0.09), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    chain(o, g, pan(ctx, r.uni(-0.7, 0.7)), out); o.start(t); o.stop(t + 0.07);
  }
}

/** 一隻鳥叫一段：三種叫法（下滑啾、顫音、兩聲調） */
function birdCall(ctx, out, t, r, level = 1) {
  const kind = r.int(3), base = r.uni(2600, 5200), p = pan(ctx, r.uni(-0.9, 0.9));
  p.connect(out);
  const note = (st, len, f1, f2, amp) => {
    const o = ctx.createOscillator(), g = gain(ctx, 0);
    o.frequency.setValueAtTime(f1, st); o.frequency.exponentialRampToValueAtTime(f2, st + len);
    g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(amp * level, st + len * 0.2); g.gain.linearRampToValueAtTime(0, st + len);
    chain(o, g, p); o.start(st); o.stop(st + len + 0.01);
  };
  let k = t;
  if (kind === 0) for (let i = 0, n = 2 + r.int(4); i < n; i++, k += r.uni(0.12, 0.2)) note(k, 0.09, base * 1.3, base * 0.8, 0.25);
  else if (kind === 1) for (let i = 0, n = 6 + r.int(8); i < n; i++, k += 0.055) note(k, 0.045, base, base * 1.15, 0.18);
  else { note(k, 0.22, base, base * 1.05, 0.22); note(k + 0.3, 0.3, base * 0.75, base * 0.7, 0.22); }
  return k - t + 0.4;
}

function birds(ctx, out, dur, r, density = 1) {
  for (let t = r.uni(0, 1); t < dur - 0.5; t += r.uni(0.6, 2.6) / density) birdCall(ctx, out, t, r, r.uni(0.4, 1));
}

/** 蟋蟀：約 4.5 kHz 的正弦波，以「三連音」開關 */
function crickets(ctx, out, dur, r, count = 4, level = 1) {
  for (let c = 0; c < count; c++) {
    const o = ctx.createOscillator(), g = gain(ctx, 0);
    o.frequency.value = r.uni(4000, 5200);
    chain(o, g, pan(ctx, r.uni(-0.8, 0.8)), out);
    const amp = r.uni(0.05, 0.14) * level, period = r.uni(0.45, 0.9);
    for (let t = r.uni(0, 1); t < dur; t += period * r.uni(0.9, 1.1)) {
      for (let p = 0; p < 3; p++) { const s = t + p * 0.035; g.gain.setValueAtTime(amp, s); g.gain.setValueAtTime(0, s + 0.02); }
    }
    o.start(0); o.stop(dur);
  }
}

function cicadas(ctx, out, dur, r) {
  for (let c = 0; c < 2; c++) {
    const am = ctx.createOscillator(), amG = gain(ctx, 0.5), g = gain(ctx, 0.5), env = gain(ctx, 0);
    am.frequency.value = r.uni(55, 90); am.connect(amG); amG.connect(g.gain);
    for (let t = c * 3; t < dur; t += r.uni(8, 14)) {
      env.gain.setTargetAtTime(r.uni(0.25, 0.45), t, 1.2); env.gain.setTargetAtTime(0.03, t + r.uni(5, 8), 1.5);
    }
    chain(src(ctx, noiseBuf(ctx, Math.min(dur, 10), "white", r), 0, true), filt(ctx, "bandpass", r.uni(4500, 6500), 6), g, env, pan(ctx, c ? 0.5 : -0.5), out);
    am.start(0); am.stop(dur);
  }
}

function frog(ctx, out, t, r, level = 1) {
  const f = r.uni(180, 380), p = pan(ctx, r.uni(-0.8, 0.8)); p.connect(out);
  for (let i = 0, n = 2 + r.int(2); i < n; i++) {
    const st = t + i * 0.13, o = ctx.createOscillator(), g = gain(ctx, 0);
    o.type = "sawtooth"; o.frequency.setValueAtTime(f, st); o.frequency.linearRampToValueAtTime(f * 1.25, st + 0.08);
    g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(0.18 * level, st + 0.015); g.gain.linearRampToValueAtTime(0, st + 0.09);
    chain(o, filt(ctx, "lowpass", 900), g, p); o.start(st); o.stop(st + 0.1);
  }
}

function fire(ctx, out, dur, r) {
  chain(src(ctx, noiseBuf(ctx, Math.min(dur, 12), "brown", r), 0, true), filt(ctx, "lowpass", 400), gain(ctx, 0.4), out);
  const click = noiseBuf(ctx, 0.03, "white", r);
  for (let i = 0, n = Math.round(dur * 6); i < n; i++) {
    const t = r() * dur, g = gain(ctx, 0);
    g.gain.setValueAtTime(r.uni(0.15, 0.6), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    chain(src(ctx, click, t), filt(ctx, "highpass", r.uni(1000, 3000)), g, pan(ctx, r.uni(-0.4, 0.4)), out);
  }
}

function clinks(ctx, out, dur, r, rate = 0.3) {
  for (let t = r.uni(0, 2); t < dur; t += r.uni(1, 4) / rate) {
    const f = r.uni(2500, 5500), g = gain(ctx, 0), p = pan(ctx, r.uni(-0.7, 0.7));
    g.gain.setValueAtTime(r.uni(0.04, 0.12), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    for (const m of [1, 2.76]) { const o = ctx.createOscillator(); o.frequency.value = f * m; chain(o, g); o.start(t); o.stop(t + 0.55); }
    chain(g, p, out);
  }
}

/** 人聲嘈雜：把聲音樣本隨機剪成 0.8~2.5 秒片段、疊很多層（與伺服器版相同做法） */
function babble(ctx, out, dur, r, voices, layers, lo, hi, gainRange = [0.3, 1]) {
  if (!voices.length) return;
  const bus = gain(ctx, 1);
  chain(bus, filt(ctx, "highpass", lo), filt(ctx, "lowpass", hi), out);
  for (let l = 0; l < layers; l++) {
    let t = r.uni(0, 0.8);
    while (t < dur) {
      const v = voices[r.int(voices.length)], L = r.uni(0.8, 2.5), off = r.uni(0, Math.max(0.01, v.duration - L));
      const g = gain(ctx, 0), a = r.uni(...gainRange);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.08);
      g.gain.setValueAtTime(a, t + L - 0.08); g.gain.linearRampToValueAtTime(0, t + L);
      const s = ctx.createBufferSource(); s.buffer = v;
      chain(s, g, pan(ctx, r.uni(-0.8, 0.8)), bus); s.start(t, off, L);
      t += L + r.uni(0.05, 0.6);
    }
  }
}

// ---------- 對外：產生一段背景／一個音效 ----------
async function render(sec, build) {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(sec * SR)), SR);
  const out = gain(ctx, 1); out.connect(ctx.destination);
  build(ctx, out);
  const ab = await ctx.startRendering();
  return [ab.getChannelData(0), ab.getChannelData(1)];
}

function levelTo(ch, db, mode = "rms") {
  let v = 0, n = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) { if (mode === "rms") { v += c[i] * c[i]; n++; } else v = Math.max(v, Math.abs(c[i])); }
  const cur = mode === "rms" ? Math.sqrt(v / Math.max(1, n)) : v;
  const k = cur > 1e-7 ? Math.pow(10, db / 20) / cur : 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= k;
  return ch;
}

/**
 * 背景環境音。name 可以是 "雨聲" 或組合 "森林+溪流"。
 * voices = 已解碼的聲音樣本 AudioBuffer 陣列（做人群聲用）。回傳 [L, R]，約 -24 dBFS。
 */
export async function makeAmbience(name, sec, voices = [], seed = 1) {
  const parts = name.split(/[+＋、]/).map(s => AMB_ALIASES[s.trim()] || s.trim()).filter(s => AMBIENCES[s]);
  if (!parts.length) return null;
  const r = rng(seed * 7919);
  const ch = await render(sec, (ctx, out) => {
    for (const p of parts) {
      const o = gain(ctx, 1 / Math.sqrt(parts.length)); o.connect(out);
      switch (p) {
        case "菜市場":
          babble(ctx, o, sec, r, voices, 9, 250, 3800, [0.3, 0.9]); babble(ctx, o, sec, r, voices, 2, 200, 5000, [0.8, 1.3]);
          chain(src(ctx, noiseBuf(ctx, Math.min(sec, 10), "pink", r), 0, true), gain(ctx, 0.05), o); clinks(ctx, o, sec, r, 0.5); break;
        case "人群嘈雜": babble(ctx, o, sec, r, voices, 12, 200, 3000); chain(src(ctx, noiseBuf(ctx, Math.min(sec, 10), "pink", r), 0, true), gain(ctx, 0.04), o); break;
        case "會議廳": babble(ctx, o, sec, r, voices, 3, 200, 2500, [0.15, 0.4]); chain(src(ctx, noiseBuf(ctx, Math.min(sec, 10), "brown", r), 0, true), filt(ctx, "lowpass", 1500), gain(ctx, 0.3), o); break;
        case "咖啡廳": babble(ctx, o, sec, r, voices, 5, 250, 3000, [0.2, 0.6]); clinks(ctx, o, sec, r, 1); break;
        case "雨聲": rain(ctx, o, sec, r, 1); break;
        case "大雨": rain(ctx, o, sec, r, 2.2); break;
        case "雷雨": rain(ctx, o, sec, r, 1.8); for (let t = r.uni(1, 5); t < sec - 3; t += r.uni(9, 20)) thunder(ctx, o, t, r, r() > 0.5); break;
        case "風聲": wind(ctx, o, sec, r, 1); break;
        case "海浪": waves(ctx, o, sec, r); break;
        case "溪流": stream(ctx, o, sec, r); break;
        case "鳥叫": birds(ctx, o, sec, r, 1); wind(ctx, o, sec, r, 0.15); break;
        case "森林": birds(ctx, o, sec, r, 0.6); wind(ctx, o, sec, r, 0.35); break;
        case "蟲鳴": crickets(ctx, o, sec, r, 5); break;
        case "蟬鳴": cicadas(ctx, o, sec, r); break;
        case "夜晚": crickets(ctx, o, sec, r, 4, 0.7); wind(ctx, o, sec, r, 0.15); for (let t = r.uni(0, 3); t < sec - 1; t += r.uni(2, 6)) frog(ctx, o, t, r, r.uni(0.4, 1)); break;
        case "營火": fire(ctx, o, sec, r); crickets(ctx, o, sec, r, 2, 0.4); break;
      }
    }
  });
  return levelTo(ch, -24);
}

/** 單次音效，回傳 [L, R]（峰值約 -6 dBFS） */
export async function makeSfx(name, seed = 1) {
  name = SFX_ALIASES[name] || name;
  if (!SFX[name]) return null;
  const r = rng(seed * 104729);
  const len = { "雷聲": 8, "遠雷": 8, "鳥叫": 2.5, "蟲鳴": 3, "蛙叫": 2.5, "門鈴": 2.5, "敲門": 1.4, "電話鈴": 4.2, "掌聲": 4, "腳步聲": 3.6, "鐘聲": 7, "水滴": 2.5, "風聲": 5 }[name];
  const ch = await render(len, (ctx, o) => {
    switch (name) {
      case "雷聲": thunder(ctx, o, 0, r, true); break;
      case "遠雷": thunder(ctx, o, 0, r, false); break;
      case "鳥叫": for (let t = 0; t < 1.8; t += birdCall(ctx, o, t, r) + 0.15); break;
      case "蟲鳴": crickets(ctx, o, len, r, 2); break;
      case "蛙叫": for (let t = 0; t < 2; t += r.uni(0.4, 0.8)) frog(ctx, o, t, r); break;
      case "門鈴": [[0, 660], [0.55, 523]].forEach(([t, f]) => {
        const g = gain(ctx, 0); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
        for (const [m, a] of [[1, 1], [2, 0.3], [3, 0.12]]) { const os = ctx.createOscillator(), ga = gain(ctx, a); os.frequency.value = f * m; chain(os, ga, g); os.start(t); os.stop(t + 1.9); }
        g.connect(o);
      }); break;
      case "敲門": for (let i = 0; i < 3; i++) {
        const t = 0.1 + i * 0.32, g = gain(ctx, 0), os = ctx.createOscillator();
        g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        os.frequency.setValueAtTime(190, t); os.frequency.exponentialRampToValueAtTime(110, t + 0.12);
        chain(os, g, o); os.start(t); os.stop(t + 0.16);
        const n = gain(ctx, 0); n.gain.setValueAtTime(0.5, t); n.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        chain(src(ctx, noiseBuf(ctx, 0.06, "white", r), t), filt(ctx, "bandpass", 900, 1), n, o);
      } break;
      case "電話鈴": for (const t0 of [0, 2.2]) {
        const g = gain(ctx, 0), am = ctx.createOscillator(), amg = gain(ctx, 0.5);
        am.type = "square"; am.frequency.value = 20; am.connect(amg); amg.connect(g.gain);
        g.gain.setValueAtTime(0.5, t0); g.gain.setValueAtTime(0, t0 + 1.6);
        for (const f of [440, 480]) { const os = ctx.createOscillator(); os.frequency.value = f; chain(os, g); os.start(t0); os.stop(t0 + 1.6); }
        g.connect(o); am.start(t0); am.stop(t0 + 1.6);
      } break;
      case "掌聲": {
        const clap = noiseBuf(ctx, 0.04, "white", r);
        for (let i = 0; i < 260; i++) {
          const t = Math.pow(r(), 0.8) * 3.5, g = gain(ctx, 0), a = r.uni(0.1, 0.4) * (1 - t / 4.2);
          g.gain.setValueAtTime(a, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
          chain(src(ctx, clap, t), filt(ctx, "bandpass", r.uni(900, 2200), 1.2), g, pan(ctx, r.uni(-0.9, 0.9)), o);
        }
      } break;
      case "腳步聲": for (let i = 0; i < 7; i++) {
        const t = 0.1 + i * 0.5 + r.uni(-0.03, 0.03), g = gain(ctx, 0);
        g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        chain(src(ctx, noiseBuf(ctx, 0.15, "brown", r), t), filt(ctx, "lowpass", 500), g, pan(ctx, -0.6 + i * 0.2), o);
      } break;
      case "鐘聲": {
        const g = gain(ctx, 0); g.gain.setValueAtTime(0.5, 0); g.gain.exponentialRampToValueAtTime(0.001, 6.8);
        for (const [m, a] of [[0.5, 0.6], [1, 1], [1.19, 0.5], [1.56, 0.4], [2, 0.35], [2.51, 0.2], [3.01, 0.12]]) {
          const os = ctx.createOscillator(), ga = gain(ctx, a); os.frequency.value = 196 * m; chain(os, ga, g); os.start(0); os.stop(7);
        }
        g.connect(o);
      } break;
      case "水滴": for (let i = 0; i < 4; i++) {
        const t = 0.1 + i * r.uni(0.4, 0.7), f = r.uni(900, 1500), os = ctx.createOscillator(), g = gain(ctx, 0);
        os.frequency.setValueAtTime(f, t); os.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.08);
        g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        chain(os, g, o); os.start(t); os.stop(t + 0.13);
      } break;
      case "風聲": {
        const f = filt(ctx, "bandpass", 300, 1), g = gain(ctx, 0);
        g.gain.linearRampToValueAtTime(0.7, 2); g.gain.linearRampToValueAtTime(0, 5);
        f.frequency.linearRampToValueAtTime(900, 2); f.frequency.linearRampToValueAtTime(300, 5);
        chain(src(ctx, noiseBuf(ctx, 5, "pink", r), 0), f, g, o);
      } break;
    }
  });
  return levelTo(ch, -6, "peak");
}
