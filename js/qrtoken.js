// 權杖用 QR Code 從電腦傳到手機：電腦顯示 QR → 手機 App 用相機掃描，不用剪貼簿，也不經過任何伺服器。
// QR 內容：XKT-TOKEN:hf_xxx（掃描時也接受單純的 hf_ 權杖）

const PREFIX = "XKT-TOKEN:";
const loaded = {};
function loadScript(src) {
  if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("載入失敗：" + src));
    document.head.appendChild(s);
  });
  return loaded[src];
}

function dialog(html) {
  const d = document.createElement("div");
  d.className = "dlg";
  d.innerHTML = `<div class="dlgbox center">${html}</div>`;
  document.body.appendChild(d);
  return d;
}

/** 電腦：顯示權杖的 QR Code */
export async function showTokenQR(token) {
  await loadScript("vendor/qrcode.js");
  const qr = qrcode(0, "M");
  qr.addData(PREFIX + token);
  qr.make();
  const d = dialog(`<h3>📱 用手機 App 掃描</h3>
    <div class="qrbox">${qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true })}</div>
    <p class="hint">手機打開「小柯語音」→ ⚙️ 設定 → 🔑 權杖 →「📷 掃描 QR Code」，對準這個畫面。</p>
    <p class="warnline">⚠️ 這個 QR Code 就是你的權杖，不要拍照或給別人看。</p>
    <button class="primary">關閉</button>`);
  d.querySelector("button").onclick = () => d.remove();
  d.onclick = e => { if (e.target === d) d.remove(); };
}

/** 手機：用相機掃描 QR Code，回傳權杖（取消時回傳 null） */
export async function scanTokenQR() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("這個裝置不能使用相機");
  await loadScript("vendor/jsQR.js");
  return new Promise((resolve, reject) => {
    const d = dialog(`<h3>📷 掃描電腦上的 QR Code</h3>
      <div class="scanbox"><video playsinline muted></video><i></i></div>
      <p class="hint">電腦打開小柯語音 → ⚙️ 設定 →「📱 傳到手機」，把 QR Code 放進框框裡。</p>
      <button class="ghost">取消</button>`);
    const video = d.querySelector("video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let stream = null, raf = 0, done = false;
    const finish = (val, err) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      stream && stream.getTracks().forEach(t => t.stop());
      d.remove();
      err ? reject(err) : resolve(val);
    };
    d.querySelector("button").onclick = () => finish(null);
    const tick = () => {
      if (done) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));   // 縮小再辨識，手機比較快
        canvas.width = Math.round(video.videoWidth * k); canvas.height = Math.round(video.videoHeight * k);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        const m = code && code.data.match(/hf_[A-Za-z0-9]{20,}/);
        if (m) return finish(m[0]);
      }
      raf = requestAnimationFrame(tick);
    };
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false })
      .then(s => { stream = s; video.srcObject = s; return video.play(); })
      .then(() => { raf = requestAnimationFrame(tick); })
      .catch(() => finish(null, new Error("無法使用相機，請允許「小柯語音」使用相機")));
  });
}
