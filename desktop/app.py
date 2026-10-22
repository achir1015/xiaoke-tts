# -*- coding: utf-8 -*-
"""
小柯機器人台灣語音 MP3 工具 — 桌面版（Windows 11／macOS 共用這支程式）

一打開就能用：本機伺服器、視窗、雲端語音引擎（網頁自動連線）全部自動啟動；關掉視窗就整個結束。

  AppInfo        名稱、版本、資料夾位置
  LocalServer    本機 http 伺服器：提供網頁檔案（web/，和線上版同一份），只聽 127.0.0.1
  SaveSession    存檔（網頁把 MP3 分段傳過來，Python 寫進「音樂\\小柯語音」或使用者選的位置）
  DesktopBridge  網頁可以呼叫的 Python 功能（window.pywebview.api.xxx）
  Updater        版本更新：查 GitHub Releases 最新版 → 下載 → 安裝 → 自動重開
  SelfTest       安裝後自動測試（CI 用）：聲音清單、劇本混音、MP3 編碼、存檔、雲端引擎連線
  main()         開啟視窗

畫面：Windows 用內建的 Edge WebView2；Mac 用 Qt WebEngine（同樣是 Chromium 核心）。
"""
import base64
import http.server
import json
import mimetypes
import os
import platform
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import uuid
from pathlib import Path

APP_NAME = "小柯機器人台灣語音 MP3 工具"
APP_ID = "XiaokeTTS"
GITHUB_REPO = "achir1015/xiaoke-tts"
ONLINE_URL = "https://achir1015.github.io/xiaoke-tts/"
SAVE_FOLDER = "小柯語音"
HTTP_PORT = int(os.environ.get("XKT_PORT") or 48161)   # 固定埠號：網頁資料（權杖、產生紀錄、自訂聲音）綁在這個網址上

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
MAC_ARCH = "AppleSilicon" if IS_MAC and platform.machine() == "arm64" else "Intel"

BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def safe_print(text: str):
    """視窗程式的主控台可能不支援中文：印不出來就改用跳脫字元，絕不讓程式因此出錯。"""
    out = sys.stdout
    if out is None:
        return
    try:
        print(text, file=out, flush=True)
    except Exception:
        try:
            print(text.encode("ascii", "backslashreplace").decode("ascii"), file=out, flush=True)
        except Exception:
            pass


def _bundled_version() -> str:
    try:
        return json.loads((BASE / "web" / "version.json").read_text(encoding="utf-8"))["version"]
    except Exception:
        return "0.0.0"


APP_VERSION = _bundled_version()


class AppInfo:
    @staticmethod
    def web_dir() -> Path:
        return BASE / "web"

    @staticmethod
    def data_dir() -> Path:
        # 自我測試會設定 XKT_DATA_DIR，才不會動到使用者自己的設定與紀錄
        if os.environ.get("XKT_DATA_DIR"):
            d = Path(os.environ["XKT_DATA_DIR"])
        elif IS_MAC:
            d = Path.home() / "Library" / "Application Support" / APP_ID
        elif IS_WIN:
            d = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / APP_ID
        else:
            d = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / APP_ID
        d.mkdir(parents=True, exist_ok=True)
        return d

    @staticmethod
    def save_dir() -> Path:
        """產生的 MP3 自動存在「音樂\\小柯語音」"""
        d = Path(os.environ["XKT_SAVE_DIR"]) if os.environ.get("XKT_SAVE_DIR") else Path.home() / "Music" / SAVE_FOLDER
        try:
            d.mkdir(parents=True, exist_ok=True)
        except OSError:
            d = Path.home()
        return d


# ---------------------------------------------------------------- 本機伺服器
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("audio/mpeg", ".mp3")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(AppInfo.web_dir()), **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        # 單一執行個體：第二次開啟 App 時，用這兩個網址確認並叫出已經開著的視窗
        if self.path == "/__xkt_ping":
            return self._reply(APP_ID)
        if self.path == "/__xkt_show":
            cb = LocalServer.on_show
            if cb:
                threading.Thread(target=cb, daemon=True).start()
            return self._reply("ok")
        return super().do_GET()

    def _reply(self, text):
        b = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


class ExclusiveServer(http.server.ThreadingHTTPServer):
    # Python 預設 allow_reuse_address=True：在 Windows 上會讓第二個程式綁到同一個埠，請求被舊程式接走
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        import socket
        if IS_WIN and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class LocalServer:
    on_show = None   # 另一個執行個體要求顯示視窗時呼叫

    @staticmethod
    def existing_instance() -> bool:
        """固定埠號上已經有小柯語音在跑？有的話請它把視窗叫出來。"""
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{HTTP_PORT}/__xkt_ping", timeout=1.5) as r:
                if r.read().decode("utf-8", "replace").strip() != APP_ID:
                    return False
            urllib.request.urlopen(f"http://127.0.0.1:{HTTP_PORT}/__xkt_show", timeout=1.5).read()
            return True
        except Exception:
            return False

    def __init__(self):
        self.port = HTTP_PORT
        for port in (HTTP_PORT, HTTP_PORT + 1, HTTP_PORT + 2, 0):
            try:
                self.httpd = ExclusiveServer(("127.0.0.1", port), Handler)
                self.port = self.httpd.server_address[1]
                break
            except OSError:
                continue
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/"


# ---------------------------------------------------------------- 存檔
class SaveSession:
    def __init__(self, path: Path):
        self.path = path
        self.tmp = path.with_name(path.name + ".part")
        self.fh = open(self.tmp, "wb")
        self.size = 0

    def write(self, b64: str) -> int:
        data = base64.b64decode(b64)
        self.fh.write(data)
        self.size += len(data)
        return self.size

    def finish(self) -> Path:
        self.fh.close()
        if self.path.exists():
            self.path.unlink()
        self.tmp.rename(self.path)
        return self.path


def unique_path(d: Path, filename: str) -> Path:
    """同名檔案已存在就加 (2)、(3)…，不覆蓋舊的 MP3"""
    p = d / filename
    n = 2
    while p.exists():
        p = d / f"{Path(filename).stem} ({n}){Path(filename).suffix}"
        n += 1
    return p


class DesktopBridge:
    """網頁端透過 window.pywebview.api 呼叫。"""

    def __init__(self, server: LocalServer):
        self._window = None
        self._server = server
        self._sessions = {}
        self._updater = Updater()
        self.forced_save_dir = None

    def attach(self, window):
        self._window = window
        self._updater.window = window

    # ---- 基本 ----
    def app_info(self):
        return {"status": "ok", "name": APP_NAME, "version": APP_VERSION, "platform": sys.platform,
                "arch": MAC_ARCH if IS_MAC else platform.machine(), "saveDir": str(AppInfo.save_dir()), "online": ONLINE_URL}

    def open_folder(self, path: str = ""):
        target = Path(path) if path else AppInfo.save_dir()
        if target.is_file():
            if IS_WIN:
                subprocess.Popen(["explorer", "/select,", str(target)])
                return True
            target = target.parent
        if IS_WIN:
            os.startfile(str(target))  # noqa: S606
        else:
            subprocess.Popen(["open", str(target)])
        return True

    def open_url(self, url: str):
        # 只開自己的網站、GitHub、Hugging Face（申請權杖）
        url = str(url)
        if not (url.startswith(ONLINE_URL) or url.startswith("https://github.com/") or url.startswith("https://huggingface.co/")):
            return False
        import webbrowser
        webbrowser.open(url)
        return True

    # ---- 更新 ----
    def check_update(self):
        return self._updater.check()

    def install_update(self, url: str, version: str):
        return self._updater.install(str(url), str(version))

    def update_status(self):
        return self._updater.status

    # ---- 存檔：ask=False 直接存到「音樂\小柯語音」，ask=True 跳出另存新檔 ----
    def begin_save(self, filename: str, ask: bool = False):
        try:
            filename = "".join(c for c in str(filename) if c not in '\\/:*?"<>|\r\n').strip() or "xiaoke.mp3"
            if self.forced_save_dir is not None:
                path = unique_path(Path(self.forced_save_dir), filename)
            elif ask:
                import webview
                ext = Path(filename).suffix.lstrip(".") or "*"
                # 檔案類型名稱只能用英數字與空白（其他字元會讓 pywebview 的對話框直接失敗）
                result = self._window.create_file_dialog(
                    webview.SAVE_DIALOG, directory=str(AppInfo.save_dir()), save_filename=filename,
                    file_types=(f"{ext.upper()} (*.{ext})", "All files (*.*)"))
                if not result:
                    return {"status": "declined"}
                path = Path(result if isinstance(result, str) else result[0])
            else:
                path = unique_path(AppInfo.save_dir(), filename)
            token = uuid.uuid4().hex
            self._sessions[token] = SaveSession(path)
            return {"status": "ok", "token": token, "path": str(path)}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def write_chunk(self, token: str, b64: str):
        s = self._sessions.get(token)
        if not s:
            return {"status": "error", "message": "no session"}
        return {"status": "ok", "size": s.write(b64)}

    def end_save(self, token: str):
        s = self._sessions.pop(token, None)
        if not s:
            return {"status": "error", "message": "no session"}
        p = s.finish()
        return {"status": "ok", "path": str(p), "size": p.stat().st_size}


# ---------------------------------------------------------------- 版本更新
class Updater:
    """問 GitHub 最新版本 → 下載對應平台的安裝檔 → 安裝 → 重開。
    Windows：Inno Setup 安裝檔靜默安裝後自動重開。
    Mac：下載 .dmg 並打開，拖進「應用程式」覆蓋（未簽章 App 無法自動替換）。"""

    API = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    DOWNLOAD_PREFIX = f"https://github.com/{GITHUB_REPO}/releases/download/"

    def __init__(self):
        self.window = None
        self.status = {"state": "idle", "pct": 0}

    @staticmethod
    def wanted(name: str) -> bool:
        n = name.lower()
        if IS_WIN:
            return n.endswith(".exe")
        if IS_MAC:
            return n.endswith(".dmg") and MAC_ARCH.lower() in n
        return False

    def check(self):
        try:
            req = urllib.request.Request(self.API, headers={"Accept": "application/vnd.github+json", "User-Agent": f"{APP_ID}/{APP_VERSION}"})
            with urllib.request.urlopen(req, timeout=15) as r:
                rel = json.load(r)
            asset = next((a for a in rel.get("assets", []) if self.wanted(a.get("name", ""))), None)
            notes = (rel.get("body") or "").split("## 下載安裝")[0].strip()
            return {"status": "ok", "current": APP_VERSION, "latest": str(rel.get("tag_name", "")).lstrip("vV"), "notes": notes,
                    "date": (rel.get("published_at") or "")[:10], "url": asset["browser_download_url"] if asset else "", "page": rel.get("html_url", "")}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def install(self, url: str, version: str):
        if not url.startswith(self.DOWNLOAD_PREFIX):
            return {"status": "error", "message": "bad url"}
        if self.status["state"] in ("downloading", "launching"):
            return {"status": "ok"}
        self.status = {"state": "downloading", "pct": 0}
        threading.Thread(target=self._run, args=(url, version), daemon=True).start()
        return {"status": "ok"}

    def _run(self, url, version):
        try:
            name = "".join(ch for ch in url.rsplit("/", 1)[-1] if ch not in '\\/:*?"<>|') or f"{APP_ID}-{version}"
            dest = Path(tempfile.gettempdir()) / name
            req = urllib.request.Request(url, headers={"User-Agent": f"{APP_ID}/{APP_VERSION}"})
            with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as fh:
                total, done = int(r.headers.get("Content-Length") or 0), 0
                while chunk := r.read(256 * 1024):
                    fh.write(chunk)
                    done += len(chunk)
                    if total:
                        self.status = {"state": "downloading", "pct": int(done * 100 / total)}
            if dest.stat().st_size < 1_000_000:
                raise RuntimeError("下載的安裝檔不完整")
            if IS_MAC:
                subprocess.Popen(["open", str(dest)])
                self.status = {"state": "manual", "pct": 100}
                return
            self.status = {"state": "launching", "pct": 100}
            subprocess.Popen([str(dest), "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/relaunch=1"],
                             creationflags=0x00000008 | 0x00000200, close_fds=True)
            self._quit()
        except Exception as e:
            self.status = {"state": "error", "pct": 0, "message": str(e)}

    def _quit(self):
        time.sleep(1.5)
        try:
            self.window.destroy()
        finally:
            time.sleep(.5)
            os._exit(0)


# ---------------------------------------------------------------- 自我測試
class SelfTest:
    """XiaokeTTS --selftest 報告.json：CI 安裝後執行，確認整個 App 能用（不消耗雲端 GPU 額度）。"""

    JS_TEST = r"""
    (async function () {
      const r = { steps: [] };
      const step = async (name, fn) => { window.__xktProgress = '進行中：' + name; try { const v = await fn(); r.steps.push({ name, ok: true, info: String(v ?? '') }); } catch (e) { r.steps.push({ name, ok: false, info: String(e && (e.stack || e.message) || e).slice(0, 400) }); } };
      const O = location.origin;
      const V = await import(O + '/js/voices.js');
      const D = await import(O + '/js/drama.js');
      const A = await import(O + '/js/audio.js');
      const S = await import(O + '/js/sounds.js');
      const { desktopSave } = await import(O + '/js/desktop.js');
      const voices = (await V.listVoices(true)).filter(v => v.ready);
      await step('內建聲音', async () => { if (voices.length < 11) throw new Error('只有 ' + voices.length + ' 個'); return voices.length + ' 個'; });
      await step('解碼聲音樣本', async () => { const x = await A.decodeMono(await V.sampleBlob('young_female')); return (x.data.length / x.sr).toFixed(1) + ' 秒'; });
      await step('環境音與音效', async () => { const a = await S.makeAmbience('雷雨', 3, [], 1); const b = await S.makeSfx('鳥叫', 1); return a[0].length + '/' + b[0].length; });
      let ch;
      await step('劇本解析與混音', async () => {
        const s = new D.ScriptParser(voices, []).parse(D.TEMPLATES.storm.text);
        const tone = () => { const sr = 22050, d = new Float32Array(sr); for (let i = 0; i < sr; i++) d[i] = 0.3 * Math.sin(i / sr * 2 * Math.PI * 220); return { data: d, sr }; };
        ch = await D.mixScript({ script: s, audioOf: tone, pace: '一般', room: '房間', ambienceVolume: 1, musicVolume: 1, voiceBuffers: [], assetAudio: async () => null });
        return (ch[0].length / 44100).toFixed(1) + ' 秒';
      });
      await step('MP3 編碼並存檔', async () => { const mp3 = await A.encodeMp3(ch, 44100, 128); const p = await desktopSave('selftest.mp3', mp3); r.mp3 = { path: p, size: mp3.size }; return p + ' ' + mp3.size; });
      await step('雲端語音引擎連線', async () => { const E = await import(O + '/js/engines.js'); return (await new E.CloudEngine('2.5').status()).message; });
      await step('網頁版本號', async () => (await import(O + '/js/version.js')).APP_VERSION);
      r.ok = r.steps.every(s => s.ok || s.name === '雲端語音引擎連線');
      window.__xktTest = r;
    })();
    'started'
    """

    def __init__(self, window, bridge: DesktopBridge, report_path: Path):
        self.window, self.bridge, self.report_path = window, bridge, report_path
        self.out_dir = report_path.parent
        bridge.forced_save_dir = self.out_dir

    def run(self):
        report = {"app": APP_NAME, "version": APP_VERSION, "platform": sys.platform, "ok": False}
        try:
            for _ in range(180):
                if self.window.evaluate_js("!!(window.pywebview && window.pywebview.api && document.querySelectorAll('#ttsVoices .vchip').length)"):
                    break
                time.sleep(0.5)
            time.sleep(1)
            self.window.evaluate_js(self.JS_TEST)
            res, last = None, None
            for _ in range(400):
                time.sleep(0.5)
                res = self.window.evaluate_js("window.__xktTest ? JSON.stringify(window.__xktTest) : null")
                if res:
                    break
                prog = self.window.evaluate_js("window.__xktProgress || ''")
                if prog and prog != last:
                    safe_print("[selftest] " + prog)
                    last = prog
            report["web"] = json.loads(res) if res else {"ok": False, "note": "網頁沒有回傳測試結果"}
            mp3 = Path((report["web"].get("mp3") or {}).get("path") or "")
            head = mp3.read_bytes()[:3] if mp3.is_file() else b""
            # ID3 標籤開頭，或直接是 MP3 音框（0xFFE 同步碼）
            report["mp3_ok"] = mp3.is_file() and mp3.stat().st_size > 1000 and (head == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0))
            report["update_check"] = self.bridge.check_update()
            self.screenshot("selftest.png")
            report["ok"] = bool(report["web"].get("ok") and report["mp3_ok"])
        except Exception:
            report["error"] = traceback.format_exc()
        finally:
            self.report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                self.window.destroy()
            except Exception:
                os._exit(0 if report["ok"] else 1)

    def screenshot(self, name):
        try:
            from PIL import ImageGrab
            ImageGrab.grab().save(self.out_dir / name)
        except Exception as e:
            (self.out_dir / (name + ".txt")).write_text(str(e), encoding="utf-8")


def make_dpi_aware():
    if not IS_WIN:
        return
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass


def main():
    args = sys.argv[1:]
    if "--version" in args:
        print(f"{APP_NAME} {APP_VERSION}")
        return
    selftest = None
    if "--selftest" in args:
        i = args.index("--selftest")
        selftest = Path(args[i + 1] if i + 1 < len(args) else "selftest.json").resolve()
        selftest.parent.mkdir(parents=True, exist_ok=True)
        # 測試用獨立的資料夾與埠號，不影響使用者正在開的小柯語音
        os.environ.setdefault("XKT_DATA_DIR", str(selftest.parent / "data"))
        os.environ.setdefault("XKT_SAVE_DIR", str(selftest.parent))
        global HTTP_PORT
        HTTP_PORT = int(os.environ.get("XKT_PORT") or 48171)

    make_dpi_aware()
    if IS_MAC:
        # 麥克風錄聲音範本、不需要點一下才能播放
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--autoplay-policy=no-user-gesture-required")
    import webview

    if not selftest and LocalServer.existing_instance():
        return   # 已經開著：已請它把視窗叫到最前面
    server = LocalServer()
    bridge = DesktopBridge(server)
    window = webview.create_window(APP_NAME, url=server.url, js_api=bridge, width=1280, height=860, min_size=(420, 600),
                                   background_color="#f4f6f5")
    bridge.attach(window)

    def show_window():
        try:
            window.restore()
            window.show()
            window.on_top = True
            time.sleep(0.3)
            window.on_top = False
        except Exception:
            pass

    LocalServer.on_show = show_window
    tester = SelfTest(window, bridge, selftest) if selftest else None

    def on_start():
        if tester:
            threading.Thread(target=tester.run, daemon=True).start()

    gui = "edgechromium" if IS_WIN else "qt"
    try:
        webview.start(on_start, gui=gui, private_mode=False, storage_path=str(AppInfo.data_dir() / "webview"), debug=False)
    finally:
        # 視窗關掉 = 整個程式結束（伺服器、背景工作一起停止）
        server.stop()
        os._exit(0)


if __name__ == "__main__":
    main()
