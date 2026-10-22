// 在 MP3 前面加上 ID3v2.3 標籤：標題、演出者、專輯、封面圖（手機音樂 App 會顯示）。

function textFrame(id, text) {
  const body = new Uint8Array(1 + 2 + text.length * 2);
  body[0] = 1; body[1] = 0xff; body[2] = 0xfe;          // UTF-16 + BOM
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); body[3 + i * 2] = c & 255; body[4 + i * 2] = c >> 8; }
  return frame(id, body);
}

function frame(id, body) {
  const f = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
  new DataView(f.buffer).setUint32(4, body.length);
  f.set(body, 10);
  return f;
}

function apic(mime, bytes) {
  const head = new Uint8Array(1 + mime.length + 1 + 1 + 1);
  head[0] = 0;
  for (let i = 0; i < mime.length; i++) head[1 + i] = mime.charCodeAt(i);
  head[1 + mime.length] = 0;     // mime 結尾
  head[2 + mime.length] = 3;     // 封面（正面）
  head[3 + mime.length] = 0;     // 描述（空）
  const body = new Uint8Array(head.length + bytes.length);
  body.set(head); body.set(bytes, head.length);
  return frame("APIC", body);
}

/** 圖片 → 600x600 以內的 JPEG（封面不要太大） */
export async function coverJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const out = await new Promise(r => c.toBlob(r, "image/jpeg", 0.88));
  return new Uint8Array(await out.arrayBuffer());
}

/** tags = { title, artist, album, coverJpeg(Uint8Array) } */
export function tagMp3(mp3, tags) {
  const frames = [];
  if (tags.title) frames.push(textFrame("TIT2", tags.title.slice(0, 120)));
  if (tags.artist) frames.push(textFrame("TPE1", tags.artist));
  if (tags.album) frames.push(textFrame("TALB", tags.album));
  frames.push(textFrame("TSSE", "小柯機器人台灣語音 MP3 工具"));
  if (tags.coverJpeg) frames.push(apic("image/jpeg", tags.coverJpeg));
  const size = frames.reduce((n, f) => n + f.length, 0);
  const h = new Uint8Array(10);
  h.set([0x49, 0x44, 0x33, 3, 0, 0]);
  h[6] = (size >> 21) & 127; h[7] = (size >> 14) & 127; h[8] = (size >> 7) & 127; h[9] = size & 127;
  return new Blob([h, ...frames, mp3], { type: "audio/mpeg" });
}
