// 聲音範本：內建 11 種台灣口音聲音 + 使用者錄音／上傳的自訂聲音 + 專案資料夾裡的聲音 mp3。
// IndexTTS 是「零樣本聲音複製」：聽 5~15 秒的樣本，就用那個人的音色、口音說話。

import { db } from "./store.js";
import { assetBlob } from "./project.js";

export const BUILTIN = [
  { id: "young_female", name: "年輕女音", gender: "female" },
  { id: "young_male", name: "年輕男音", gender: "male" },
  { id: "middle_female", name: "中年女音", gender: "female" },
  { id: "middle_male", name: "中年男音", gender: "male" },
  { id: "elder_female", name: "高齡女音", gender: "female" },
  { id: "elder_male", name: "高齡男音", gender: "male" },
  { id: "girl", name: "女童音", gender: "female" },
  { id: "boy", name: "男童音", gender: "male" },
  { id: "mature_female", name: "成熟女音", gender: "female" },
  { id: "girl2", name: "女童音 2", gender: "female" },
  { id: "boy2", name: "男童音 2", gender: "male" },
];

// 劇本裡可以用的聲音別名
export const VOICE_ALIASES = {
  "年輕女音": "young_female", "年輕男音": "young_male", "女童音": "girl", "男童音": "boy",
  "中年女音": "middle_female", "中年男音": "middle_male", "高齡女音": "elder_female", "高齡男音": "elder_male",
  "成熟女音": "mature_female", "女童": "girl", "男童": "boy", "小女孩": "girl", "小男孩": "boy",
  "阿嬤": "elder_female", "阿公": "elder_male",
};

let _list = null;

/** 所有可用聲音：[{id, name, builtin, custom, version}] */
export async function listVoices(force) {
  if (_list && !force) return _list;
  const saved = await db.all("voices");
  const byId = Object.fromEntries(saved.map(v => [v.id, v]));
  const out = BUILTIN.map(b => ({ ...b, builtin: true, ready: true, replaced: !!byId[b.id], version: byId[b.id]?.updated || 0 }));
  for (const v of saved) if (!BUILTIN.some(b => b.id === v.id)) out.push({ id: v.id, name: v.name, gender: v.gender || "", custom: true, ready: !!v.blob, version: v.updated });
  const assets = await db.all("assets");
  for (const a of assets.filter(a => a.kind === "voice")) out.push({ id: "asset:" + a.id, name: a.name, asset: true, ready: true, version: a.created });
  _list = out;
  return out;
}

export async function voiceById(id) {
  return (await listVoices()).find(v => v.id === id);
}

/** 取得聲音樣本音檔（Blob） */
export async function sampleBlob(id) {
  if (id.startsWith("asset:")) return assetBlob(id.slice(6));
  const saved = await db.get("voices", id);
  if (saved?.blob) return saved.blob;
  if (BUILTIN.some(b => b.id === id)) {
    const r = await fetch(`voices/${id}.mp3`);
    if (!r.ok) throw new Error("讀不到內建聲音樣本");
    return r.blob();
  }
  throw new Error("這個聲音還沒有樣本，請到「聲音範本」錄音或上傳");
}

export async function saveSample(id, name, blob, gender = "") {
  await db.put("voices", { id, name, blob, gender, updated: Date.now() });
  _list = null;
}

/** 新增一個還沒有樣本的自訂聲音，之後再錄音或上傳 */
export async function addCustom(name) {
  const id = "custom_" + Date.now().toString(36);
  await db.put("voices", { id, name, blob: null, updated: Date.now() });
  _list = null;
  return id;
}

export async function removeVoice(id) {
  await db.del("voices", id);
  _list = null;
}

export function invalidate() { _list = null; }

/** 依角色名猜聲音（阿嬤→高齡女音…） */
export function guessVoice(name, ids, used) {
  const guesses = [["嬤", "elder_female"], ["婆", "elder_female"], ["奶奶", "elder_female"],
    ["公", "elder_male"], ["爺", "elder_male"], ["伯", "middle_male"], ["叔", "middle_male"],
    ["姨", "middle_female"], ["嬸", "middle_female"], ["媽", "middle_female"], ["母", "middle_female"],
    ["爸", "middle_male"], ["父", "middle_male"], ["老闆娘", "middle_female"], ["老闆", "middle_male"],
    ["妹", "girl"], ["女孩", "girl"], ["弟", "boy"], ["男孩", "boy"], ["小明", "boy"],
    ["哥", "young_male"], ["姊", "young_female"], ["姐", "young_female"],
    ["旁白", "middle_male"], ["主持", "young_female"]];
  for (const [k, v] of guesses) if (name.includes(k) && ids.includes(v)) return v;
  const female = "美花婷玲芳珍娟雅麗琪萱妤婕怡慧淑秀蓮娘女姐姊妹嫂";
  const pref = ([...name].some(c => female.includes(c))
    ? ["young_female", "middle_female", "mature_female", "girl", "elder_female"]
    : ["young_male", "middle_male", "boy", "elder_male"]).filter(v => ids.includes(v));
  const free = pref.filter(v => !used.has(v));
  return (free[0] || pref[0] || ids[0] || "");
}
