// 劇本型文字轉語音（多人聲音）＝ 把劇本交給「廣播劇團」
//   ScriptParser   劇本文字 → Script（演員表 + 事件：台詞、同時說話、停頓、背景、音樂、音效）
//   NovelConverter 一般小說（「」對話）→ 劇本格式
//   mixScript      混音師：每句台詞放到時間軸、立體聲左右、空間感、背景環境音、背景音樂、音效 → [L, R]
// 移植自 indextts2-taiwan-tts 的 drama.py，背景音另外加上自然環境音（天氣、鳥、蟲、雷、雨…）與音效。

import { VOICE_ALIASES, guessVoice } from "./voices.js";
import { AMB_ALIASES, AMBIENCES, SFX, SFX_ALIASES, SR, makeAmbience, makeSfx } from "./sounds.js";

export const EMO_ALIASES = {
  "生氣": "生氣", "憤怒": "生氣", "怒": "生氣", "大吼": "生氣", "罵": "生氣", "吵": "生氣",
  "開心": "開心", "高興": "開心", "笑": "開心", "興奮": "開心",
  "悲傷": "悲傷", "難過": "悲傷", "哭": "悲傷", "傷心": "悲傷",
  "害怕": "害怕", "恐懼": "害怕", "驚恐": "害怕",
  "厭惡": "厭惡", "嫌棄": "厭惡", "不屑": "厭惡",
  "低落": "低落", "無奈": "低落", "沮喪": "低落", "嘆氣": "低落",
  "驚訝": "驚訝", "驚": "驚訝", "吃驚": "驚訝",
  "平靜": "平靜", "冷靜": "平靜", "溫柔": "平靜", "自然": "自然",
};
const LANG_WORDS = { "台語": "nan", "閩南語": "nan", "臺語": "nan", "國語": "zh", "華語": "zh", "中文": "zh", "英文": "en", "英語": "en", "日文": "ja", "日語": "ja" };

const RE_LINE = /^(?<barge>[>＞])?\s*(?<name>[^：:（(\[【〔\s][^：:（(\[【〔]{0,11}?)\s*(?:[（(](?<emo>[^）)]{1,10})[）)])?\s*[：:]\s*(?<text>.+)$/;
const RE_DIRECTIVE = /^[\[【〔](?<head>[^\]】〕]+)[\]】〕]\s*(?<rest>.*)$/;
const RE_PERCENT = /(\d+(?:\.\d+)?)\s*%/;
const RE_NUMBER = /(\d+(?:\.\d+)?)/;
const pct = (w, lo, hi) => Math.max(lo, Math.min(hi, parseFloat(w.match(RE_PERCENT)[1]) / 100));

export function parseEmotion(raw) {
  raw = (raw || "").trim();
  if (!raw) return ["自然", 0.7];
  let strength = 0.7;
  if (RE_PERCENT.test(raw)) { strength = pct(raw, 0.1, 1); raw = raw.replace(RE_PERCENT, "").trim(); }
  for (const [k, v] of Object.entries(EMO_ALIASES)) if (raw.includes(k)) return [v, strength];
  return ["自然", strength];
}

export class ScriptParser {
  /** voices = [{id, name}]；assets = 專案素材（找背景音樂、音效名稱用） */
  constructor(voices, assets = []) {
    this.voices = voices;
    this.ids = voices.map(v => v.id);
    this.byName = Object.fromEntries(voices.map(v => [v.name, v.id]));
    this.assets = assets;
  }
  voice(w) { w = w.trim(); return this.byName[w] || (this.ids.includes(w) ? w : null) || (VOICE_ALIASES[w] && this.ids.includes(VOICE_ALIASES[w]) ? VOICE_ALIASES[w] : null); }
  asset(name, kinds) { return this.assets.find(a => kinds.includes(a.kind) && (a.name === name || a.name.replace(/\.[^.]+$/, "") === name)); }

  parseCast(body, s) {
    for (const part of body.split(/[,，、;；]/)) {
      if (!/[=＝]/.test(part)) continue;
      const [rawName, spec] = part.split(/[=＝]/, 2);
      const name = rawName.trim();
      if (!name) continue;
      const c = s.cast[name] || newChar(name);
      for (const w of (spec || "").split(/\s+/).filter(Boolean)) {
        const v = this.voice(w);
        if (v) c.voice_id = v;
        else if (["左", "左邊"].includes(w)) { c.pan = -0.6; c.panSet = true; }
        else if (["右", "右邊"].includes(w)) { c.pan = 0.6; c.panSet = true; }
        else if (["中", "中間"].includes(w)) { c.pan = 0; c.panSet = true; }
        else if (LANG_WORDS[w]) c.language = LANG_WORDS[w];
        else if (RE_PERCENT.test(w)) c.volume = pct(w, 0.2, 2);
        else s.warnings.push(`角色「${name}」的設定「${w}」看不懂，已略過`);
      }
      s.cast[name] = c;
    }
  }

  parse(text) {
    const s = { cast: {}, events: [], warnings: [] };
    let together = null;
    (text || "").split(/\r?\n/).forEach((raw, idx) => {
      const no = idx + 1, line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) return;
      let m = line.match(RE_DIRECTIVE);
      if (m) {
        const body = (m.groups.head.trim() + " " + m.groups.rest.trim()).trim();
        const head = body.split(/\s+/)[0] || "";
        const rest = body.slice(head.length).trim();
        const words = rest.split(/\s+/).filter(Boolean);
        const volOf = (d) => { const w = words.find(w => RE_PERCENT.test(w)); return w ? pct(w, 0, 1.5) : d; };
        const nameOf = () => words.filter(w => !RE_PERCENT.test(w) && w !== "等").join(" ");
        if (head.startsWith("角色")) this.parseCast(rest || body.slice(2), s);
        else if (["同時", "一起", "齊聲", "同時開始"].includes(head)) together = { kind: "together", lines: [] };
        else if (["/同時", "／同時", "同時結束", "結束同時", "/一起"].includes(head)) { if (together?.lines.length) s.events.push(together); together = null; }
        else if (head.startsWith("停頓") || head.startsWith("暫停")) { const n = body.match(RE_NUMBER); s.events.push({ kind: "pause", seconds: n ? Math.min(30, +n[1]) : 1 }); }
        else if (/^(背景|場景|環境)/.test(head)) {
          let name = nameOf() || "無";
          const parts = name.split(/[+＋、]/).map(p => AMB_ALIASES[p.trim()] || p.trim());
          const bad = parts.filter(p => p !== "無" && !AMBIENCES[p] && !this.asset(p, ["ambience", "music", "sfx"]));
          if (bad.length) s.warnings.push(`第 ${no} 行：找不到背景音「${bad.join("、")}」`);
          s.events.push({ kind: "ambience", name: parts.join("+"), volume: volOf(0.35) });
        } else if (/^(音樂|配樂|背景音樂|BGM)/i.test(head)) {
          const name = nameOf() || "無";
          if (!["無", "關", "停"].includes(name) && !this.asset(name, ["music", "ambience"])) s.warnings.push(`第 ${no} 行：專案裡找不到背景音樂「${name}」`);
          s.events.push({ kind: "music", name: ["關", "停"].includes(name) ? "無" : name, volume: volOf(0.25) });
        } else if (/^(音效|效果)/.test(head)) {
          const name = SFX_ALIASES[nameOf()] || nameOf();
          if (!SFX[name] && !this.asset(name, ["sfx", "music", "ambience"])) s.warnings.push(`第 ${no} 行：找不到音效「${name}」`);
          s.events.push({ kind: "sfx", name, volume: volOf(0.8), wait: words.includes("等") });
        } else s.warnings.push(`第 ${no} 行：看不懂的指令 ${line}`);
        return;
      }
      m = line.match(RE_LINE);
      let name, txt, emo, barge;
      if (!m) { name = "旁白"; txt = line; emo = ""; barge = false; }
      else { name = m.groups.name.trim(); txt = m.groups.text.trim(); emo = m.groups.emo || ""; barge = !!m.groups.barge; }
      const [emotion, strength] = parseEmotion(emo);
      if (/插話|搶話/.test(emo)) barge = true;
      if (!/[\p{L}\p{N}]/u.test(txt)) return;
      const ln = { kind: "line", speaker: name, text: txt, emotion, strength, barge_in: barge };
      (together ? together.lines : s.events).push(ln);
      if (!s.cast[name]) s.cast[name] = newChar(name);
    });
    if (together?.lines.length) { s.events.push(together); s.warnings.push("【同時】沒有對應的【/同時】，已自動結束"); }
    this.autoCast(s);
    return s;
  }

  /** 沒指定聲音的角色：依名字猜，並自動左右分開 */
  autoCast(s) {
    const used = new Set(Object.values(s.cast).map(c => c.voice_id).filter(Boolean));
    const pans = [-0.5, 0.5, -0.25, 0.25, -0.7, 0.7, 0];
    let k = 0;
    for (const c of Object.values(s.cast)) {
      if (!c.voice_id) c.voice_id = guessVoice(c.name, this.ids, used);
      used.add(c.voice_id);
      if (c.name !== "旁白" && c.pan === 0 && !c.panSet) c.pan = pans[k++ % pans.length];
    }
  }
}

function newChar(name) { return { name, voice_id: "", language: "zh", pan: 0, volume: 1 }; }

export function allLines(s) {
  return s.events.flatMap(e => e.kind === "line" ? [e] : e.kind === "together" ? e.lines : []);
}
export function speakers(s) { return [...new Set(allLines(s).map(l => l.speaker))]; }

// ------------------------------------------------------------
// 小說 → 劇本
// ------------------------------------------------------------
const SPEECH_VERBS = "說道|說|道|問道|問|喊道|喊|叫道|叫|罵道|罵|吼道|吼|答道|答|回答|笑道|笑說|哭道|嘆道|嚷道|嚷|低聲說|大聲說|插嘴|接著說";
const RE_TAG_BEFORE = new RegExp(`([一-鿿]{1,4}?)(?:[一-鿿]{0,4}地)?(?:${SPEECH_VERBS})[：:，,]?\\s*$`);
const RE_TAG_AFTER = new RegExp(`^\\s*([一-鿿]{1,4}?)(?:[一-鿿]{0,4}地)?(?:${SPEECH_VERBS})`);
const NOT_NAMES = new Set(["他", "她", "我", "你", "它", "大家", "有人", "對方", "又", "便", "就", "才", "也", "還", "再", "卻", "然後", "接著"]);
const EMO_HINTS = [["罵", "生氣"], ["吼", "生氣"], ["怒", "生氣"], ["氣", "生氣"], ["嚷", "生氣"], ["笑", "開心"], ["哭", "悲傷"], ["嘆", "低落"], ["驚", "驚訝"], ["怕", "害怕"], ["抖", "害怕"]];
const ADVERBS = ["大聲", "小聲", "輕聲", "低聲", "笑著", "哭著", "冷冷", "急忙", "連忙", "忍不住", "突然", "接著", "然後", "於是", "只好", "終於", "馬上", "立刻", "一邊", "頭也"];

export class NovelConverter {
  detectNames(prose) {
    const cands = {};
    const add = clause => {
      let best = null, bestN = 0;
      for (const L of [2, 3]) {
        if (clause.length < L) continue;
        const w = clause.slice(0, L);
        if (NOT_NAMES.has(w) || ADVERBS.some(a => w.startsWith(a)) || !/^[一-鿿]+$/.test(w)) continue;
        const n = prose.split(w).length - 1;
        if (n > bestN || (n === bestN && best && w.length < best.length)) { best = w; bestN = n; }
      }
      if (best) cands[best] = (cands[best] || 0) + bestN;
    };
    for (const m of prose.matchAll(new RegExp(`([^，,。！？!?；;「」『』\\n]{1,12}?)(?:${SPEECH_VERBS})[：:，,]?\\s*[「『]`, "g"))) add(m[1].trim());
    for (const m of prose.matchAll(new RegExp(`[」』]\\s*([^，,。！？!?；;「」『』\\n]{1,12}?)(?:${SPEECH_VERBS})`, "g"))) add(m[1].trim());
    return Object.entries(cands).sort((a, b) => b[1] - a[1]).map(e => e[0]);
  }

  convert(prose, knownNames, withNarration = true) {
    let known = (knownNames || []).filter(n => n && n !== "旁白");
    if (!known.length) known = this.detectNames(prose || "");
    const out = [], recent = [];
    for (let para of (prose || "").split(/\n/)) {
      para = para.trim();
      if (!para) continue;
      let pos = 0;
      for (const m of para.matchAll(/[「『“"](.+?)[」』”"]/g)) {
        const before = para.slice(pos, m.index), speech = m[1].trim();
        const after = para.slice(m.index + m[0].length, m.index + m[0].length + 16);
        let [speaker, emo, tagStart] = this.findSpeaker(before, after, known);
        const narr = tagStart != null ? before.slice(0, tagStart) : before;
        if (withNarration && meaningful(narr)) out.push(`旁白：${narr.replace(/^[\s，,：:]+|[\s，,：:]+$/g, "")}`);
        if (!speaker) {
          speaker = recent.length >= 2 ? recent[recent.length - 2] : (recent[recent.length - 1] || "？");
          if (!speaker.endsWith("？")) speaker += "？";
        }
        recent.push(speaker.replace(/？$/, ""));
        out.push(`${speaker}${emo ? `（${emo}）` : ""}：${speech}`);
        pos = m.index + m[0].length;
        const am = para.slice(pos).match(RE_TAG_AFTER);
        if (am && !NOT_NAMES.has(am[1])) pos += am[0].length;
      }
      const tail = para.slice(pos);
      if (withNarration && meaningful(tail)) out.push(`旁白：${tail.replace(/^[\s，,。]+|[\s，,。]+$/g, "")}`);
    }
    return out.join("\n");
  }

  findSpeaker(before, after, known) {
    const tag = before.match(new RegExp(`[^，,。！？!?；;」』]{0,10}?(?:${SPEECH_VERBS})[：:，,]?\\s*$`));
    const tagStart = tag ? tag.index : null;
    const parts = before.split(/[。！？!?；;」』]/), last = parts[parts.length - 1];
    const emo = tag ? emoOf(before.slice(tagStart)) : "";
    const hits = known.filter(n => n && last.includes(n)).map(n => [last.indexOf(n), n]).sort((a, b) => a[0] - b[0]);
    if (hits.length) return [hits[0][1], emo, tagStart];
    if (tag) { const mb = before.slice(tagStart).match(RE_TAG_BEFORE); if (mb && !NOT_NAMES.has(mb[1])) return [mb[1], emo, tagStart]; }
    for (const n of [...known].sort((a, b) => b.length - a.length)) if (n && after.startsWith(n)) return [n, emoOf(after), tagStart];
    const ma = after.match(RE_TAG_AFTER);
    if (ma && !NOT_NAMES.has(ma[1])) return [ma[1], emoOf(ma[0]), tagStart];
    return [null, emo, tagStart];
  }
}
const emoOf = s => (EMO_HINTS.find(([k]) => s.includes(k)) || [, ""])[1];
const meaningful = s => (s || "").replace(/[\s，。,.！!？?：:、…]/g, "").length >= 4;

// ------------------------------------------------------------
// 混音
// ------------------------------------------------------------
export const PACE_GAP = { "從容": 0.7, "一般": 0.4, "緊湊": 0.15, "爭吵": -0.15 };
export const ROOMS = { "無": 0, "房間": 0.35, "大廳": 1.1, "戶外": 0.15 };

function seeded(seed) { let a = seed; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }

/**
 * 把劇本排上時間軸。audioOf(line) → { data, sr }（已去頭尾靜音）。
 * 回傳時間軸（秒）：{ placed, ambs, musics, sfxs, total }
 */
export function layout(script, audioOf, pace = "一般") {
  const gap = PACE_GAP[pace] ?? 0.4, rnd = seeded(42), U = (a, b) => a + (b - a) * rnd();
  const placed = [], ambs = [], musics = [], sfxs = [];
  const t0 = 0.3;
  let lastStart = 0, lastEnd = 0;
  const cursor = () => lastEnd > 0 ? lastEnd : 0;
  for (const e of script.events) {
    if (e.kind === "line") {
      const a = audioOf(e), dur = a.data.length / a.sr;
      const start = e.barge_in && lastEnd > 0 ? Math.max(lastStart + 0.3, lastEnd - U(0.4, 0.8)) : (lastEnd > 0 ? Math.max(0, lastEnd + gap) : t0);
      placed.push({ start, a, speaker: e.speaker });
      lastStart = start; lastEnd = start + dur;
    } else if (e.kind === "together") {
      const base = lastEnd > 0 ? lastEnd + Math.max(gap, 0.1) : t0;
      let end = base;
      e.lines.forEach((ln, i) => {
        const a = audioOf(ln), st = base + (i === 0 ? 0 : U(0.1, 0.9));
        placed.push({ start: st, a, speaker: ln.speaker });
        end = Math.max(end, st + a.data.length / a.sr);
      });
      lastStart = base; lastEnd = end;
    } else if (e.kind === "pause") lastEnd = (lastEnd > 0 ? lastEnd : t0) + e.seconds;
    else if (e.kind === "ambience") ambs.push({ start: cursor(), name: e.name, volume: e.volume });
    else if (e.kind === "music") musics.push({ start: cursor(), name: e.name, volume: e.volume });
    else if (e.kind === "sfx") {
      const st = cursor() || t0;
      sfxs.push({ start: st, name: e.name, volume: e.volume, wait: e.wait });
      if (e.wait) lastEnd = st + (e.length || 2.5);
    }
  }
  return { placed, ambs, musics, sfxs, total: (lastEnd > 0 ? lastEnd : 1) + 1.2 };
}

function impulse(ctx, t60) {
  const L = Math.round(t60 * ctx.sampleRate), b = ctx.createBuffer(2, L, ctx.sampleRate), r = seeded(7);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < L; i++) d[i] = (r() * 2 - 1) * Math.exp(-6.9 * i / L); }
  return b;
}

function stereoBuf(ctx, ch) {
  const b = ctx.createBuffer(2, ch[0].length, SR);
  b.getChannelData(0).set(ch[0]); b.getChannelData(1).set(ch[1]);
  return b;
}

/**
 * 混音。o = { script, audioOf, pace, room, ambienceVolume, musicVolume, voiceBuffers, assetAudio(name, kinds) → AudioBuffer|null, onStep }
 * 回傳 [L, R]（44.1 kHz，峰值標準化到 0.9）
 */
export async function mixScript(o) {
  // 等候型音效要先知道長度
  for (const e of o.script.events) if (e.kind === "sfx" && e.wait) {
    const ab = await o.assetAudio(e.name, ["sfx", "music", "ambience"]);
    e.length = ab ? ab.duration : ({ "雷聲": 7, "遠雷": 7, "鐘聲": 6, "電話鈴": 4.2, "掌聲": 4, "腳步聲": 3.6, "風聲": 5 }[e.name] || 2.5);
  }
  const tl = layout(o.script, o.audioOf, o.pace);
  const n = Math.round(tl.total * SR);
  const ctx = new OfflineAudioContext(2, n, SR);
  const master = ctx.createGain(); master.connect(ctx.destination);

  // 空間感：乾聲 + 濕聲（卷積）
  const dry = ctx.createGain(), t60 = ROOMS[o.room] || 0;
  dry.connect(master);
  let voiceBus = dry;
  if (t60) {
    const bus = ctx.createGain(), wet = ctx.createGain(), conv = ctx.createConvolver(), hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
    const amt = o.room === "大廳" ? 0.3 : o.room === "戶外" ? 0.08 : 0.18;
    conv.buffer = impulse(ctx, t60); hp.type = "highpass"; hp.frequency.value = 150; lp.type = "lowpass"; lp.frequency.value = 6000;
    dry.gain.value = 1 - amt; wet.gain.value = amt * 2.5;
    bus.connect(dry); bus.connect(hp); hp.connect(lp); lp.connect(conv); conv.connect(wet); wet.connect(master);
    voiceBus = bus;
  }

  // 1) 台詞：依角色放到左右
  for (const p of tl.placed) {
    const c = o.script.cast[p.speaker] || { pan: 0, volume: 1 };
    const b = ctx.createBuffer(1, p.a.data.length, p.a.sr); b.getChannelData(0).set(p.a.data);
    const s = ctx.createBufferSource(), g = ctx.createGain(), pn = ctx.createStereoPanner();
    s.buffer = b; g.gain.value = (c.volume ?? 1) * 1.2; pn.pan.value = c.pan || 0;
    s.connect(g); g.connect(pn); pn.connect(voiceBus); s.start(p.start);
  }

  // 2) 背景環境音、背景音樂：每段從標記處到下一個標記或結尾，前後淡入淡出
  const bed = async (marks, isMusic, step) => {
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (m.name === "無" || m.volume <= 0) continue;
      const end = i + 1 < marks.length ? marks[i + 1].start : tl.total;
      const dur = Math.max(0.5, end - m.start);
      o.onStep && o.onStep(`${step}：${m.name}`);
      let buf = await o.assetAudio(m.name, isMusic ? ["music", "ambience"] : ["ambience", "music", "sfx"]);
      let loop = !!buf;
      if (!buf && !isMusic) { const ch = await makeAmbience(m.name, dur, o.voiceBuffers, i + 1); if (ch) buf = stereoBuf(ctx, ch); }
      if (!buf) continue;
      const s = ctx.createBufferSource(), g = ctx.createGain();
      s.buffer = buf; s.loop = loop;
      const vol = m.volume * (isMusic ? (o.musicVolume ?? 1) * 1.6 : (o.ambienceVolume ?? 1) * 2.2);
      const fade = Math.min(dur / 3, isMusic ? 2 : 1.2);
      g.gain.setValueAtTime(0, m.start); g.gain.linearRampToValueAtTime(vol, m.start + fade);
      g.gain.setValueAtTime(vol, m.start + dur - fade); g.gain.linearRampToValueAtTime(0, m.start + dur);
      s.connect(g); g.connect(master); s.start(m.start); s.stop(m.start + dur);
    }
  };
  await bed(tl.ambs, false, "產生背景音");
  await bed(tl.musics, true, "加入背景音樂");

  // 3) 音效
  for (const [i, x] of tl.sfxs.entries()) {
    o.onStep && o.onStep(`音效：${x.name}`);
    let buf = await o.assetAudio(x.name, ["sfx", "music", "ambience"]);
    if (!buf) { const ch = await makeSfx(x.name, i + 1); if (ch) buf = stereoBuf(ctx, ch); }
    if (!buf) continue;
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf; g.gain.value = x.volume; s.connect(g); g.connect(master); s.start(x.start);
  }

  o.onStep && o.onStep("混音中…");
  const ab = await ctx.startRendering();
  const L = ab.getChannelData(0), R = ab.getChannelData(1);
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = 0.9 / peak;
  for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
  return [L, R];
}

// ------------------------------------------------------------
// 範本
// ------------------------------------------------------------
export const TEMPLATES = {
  single: { title: "小柯的早安廣播", pace: "從容", room: "無", text:
`[角色] 小柯=年輕女音 中
[背景 鳥叫 30%]
小柯（開心）：大家早安！我是小柯機器人。
小柯：今天天氣晴朗，氣溫二十六度，很適合出門走走。
小柯（平靜）：出門前記得多喝水，也別忘了帶把傘喔。` },
  qa: { title: "市場阿公訪問", pace: "一般", room: "房間", text:
`[角色] 記者=年輕女音 左, 阿公=高齡男音 右
記者：阿公您好，請問您在這裡擺攤多久了？
阿公（開心）：喔，差不多四十年囉！
記者：這四十年來，市場有什麼改變嗎？
阿公：以前人擠人，現在年輕人都去超市了。
記者（驚訝）：那生意還好嗎？
阿公（無奈）：馬馬虎虎啦，老客人還是會來。
記者：最後想對大家說什麼？
阿公（開心）：有空來市場走走，阿公算你便宜！` },
  market: { title: "星期天的菜市場", pace: "緊湊", room: "無", text:
`[角色] 阿嬤=高齡女音 右, 小美=年輕女音 左, 魚販=中年男音, 菜販=中年女音, 小弟=男童音
[背景 菜市場 45%]
旁白：星期天早上，傳統市場裡人聲鼎沸。
【同時】
魚販：來喔！現撈的虱目魚，一尾一百！
菜販：高麗菜一顆五十，買二送蔥喔！
小弟（開心）：阿嬤，我要吃肉圓！
【/同時】
小美：阿嬤，這邊人好多，你慢慢走。
阿嬤：知道啦，你顧好弟弟就好。
魚販（開心）：阿嬤，今天的魚很新鮮，帶一尾回去啦！
阿嬤：一尾一百太貴了，算八十啦。
>魚販（開心）：好啦好啦，阿嬤說了算！` },
  storm: { title: "颱風夜", pace: "一般", room: "房間", text:
`[角色] 媽媽=中年女音 右, 女兒=女童音 左, 爸爸=中年男音
[背景 雷雨 40%]
旁白：颱風夜，窗外風雨交加。
[音效 雷聲 90%]
女兒（害怕）：媽媽，外面好大聲，我好怕！
媽媽（溫柔）：不怕不怕，媽媽在這裡。
[音效 敲門]
爸爸：我回來了！外面雨真的好大。
女兒（開心）：爸爸！
[背景 雨聲 30%]
旁白：雨聲漸漸小了，一家人靠在一起，慢慢睡著。` },
  nature: { title: "山中夏夜", pace: "從容", room: "戶外", text:
`[角色] 阿公=高齡男音 左, 孫子=男童音 右
[背景 溪流+蟬鳴 35%]
旁白：夏天的午後，阿公帶著孫子到山裡的小溪邊。
孫子（開心）：阿公，你聽！好多蟬在叫！
阿公（開心）：對啊，夏天到了，蟬就出來唱歌囉。
[音效 鳥叫 60%]
孫子（驚訝）：還有小鳥！
[停頓 1]
[背景 夜晚 40%]
旁白：太陽下山了，草叢裡傳來蟲鳴和蛙叫。
阿公（平靜）：天暗了，我們慢慢走回家吧。` },
  debate: { title: "小學生該不該用手機", pace: "一般", room: "大廳", text:
`[角色] 主持人=年輕女音 中, 正方=中年男音 左, 反方=中年女音 右
[背景 會議廳 20%]
主持人：今天的辯題是：小學生應不應該使用手機？請正方先發言。
正方：手機是學習工具，可以查資料、聯絡家人，應該讓孩子學會正確使用。
反方（冷靜）：可是研究顯示，太早接觸手機會影響專注力與睡眠。
正方：所以重點是教育，不是禁止！
>反方（生氣）：教育需要時間，傷害卻是立刻發生的！
主持人：請兩位冷靜，我們進入自由辯論。
【同時】
正方（生氣）：你這是因噎廢食！
反方（生氣）：你這是放任不管！
【/同時】
主持人：好，時間到！謝謝兩位精彩的發言。
[音效 掌聲]` },
  fight: { title: "深夜的客廳", pace: "爭吵", room: "房間", text:
`[角色] 老公=中年男音 左, 老婆=中年女音 右, 兒子=男童音
[背景 夜晚 15%]
旁白：晚上十點，客廳的燈還亮著。
老婆（生氣）：你又這麼晚回來，打電話也不接！
老公（無奈）：我在加班啊，手機沒電了嘛。
>老婆（生氣）：每次都這個理由！
>老公（生氣）：不然你要我怎樣？辭職嗎？
【同時】
老婆（生氣）：你根本不在乎這個家！
老公（生氣）：我就是為了這個家才這麼累！
【/同時】
[停頓 1.5]
兒子（害怕）：爸爸、媽媽，你們不要再吵了……
老婆（悲傷）：……對不起，吵到你了。
老公（低落）：是爸爸不好，我們好好說。` },
};
