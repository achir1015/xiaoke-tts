"""不用 Gradle 的小柯語音 Android 版建置腳本：複製網頁 → aapt2 → javac → d8 → zipalign → apksigner。

需要：Python 3.8+、JDK 17、Android SDK（build-tools、platforms/android-34）。
SDK / JDK 位置依序讀取 local.properties（sdk.dir= / jdk.dir=）、ANDROID_HOME / JAVA_HOME。
網頁（和線上版同一份）在建置時複製到 assets/web；聲音樣本 voices/ 一起打包。
用法：python build.py              產生 build/XiaokeTTS.apk
      python build.py install      另外用 adb 安裝並啟動（adb 連到的第一台裝置，或環境變數 ANDROID_SERIAL）
      python build.py debug        允許 chrome://inspect 檢查網頁（測試用，不要發佈）
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.environ.get("XKT_WEB") or os.path.dirname(ROOT)
BUILD = os.path.join(ROOT, "build")
EXE = ".exe" if os.name == "nt" else ""
BAT = ".bat" if os.name == "nt" else ""
PKG = "com.achir.xiaoketts"


def props():
    p = {}
    f = os.path.join(ROOT, "local.properties")
    if os.path.exists(f):
        for line in open(f, encoding="utf-8"):
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                p[k.strip()] = v.strip().replace("\:", ":").replace("\\\\", "\\")
    return p


P = props()
SDK = P.get("sdk.dir") or os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") \
    or os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk")
JDK = P.get("jdk.dir") or os.environ.get("JAVA_HOME", "")


def latest(pattern):
    found = sorted(glob.glob(pattern))
    if not found:
        sys.exit("找不到 " + pattern)
    return found[-1]


BT = latest(os.path.join(SDK, "build-tools", "*"))
ANDROID_JAR = latest(os.path.join(SDK, "platforms", "android-*", "android.jar"))
JAVAC = os.path.join(JDK, "bin", "javac" + EXE) if JDK else "javac"
KEYTOOL = os.path.join(JDK, "bin", "keytool" + EXE) if JDK else "keytool"
ADB = os.path.join(SDK, "platform-tools", "adb" + EXE)
if JDK:
    os.environ["JAVA_HOME"] = JDK


def rel(p):
    try:
        return os.path.relpath(p, ROOT)
    except ValueError:
        return p


def run(*cmd):
    print(">", " ".join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd))[:300])
    subprocess.check_call(list(cmd), cwd=ROOT)


def copy_web(dest):
    """網頁檔案：和線上版同一份"""
    os.makedirs(dest)
    for f in ("index.html", "version.json", "manifest.webmanifest", "favicon-32.png", "favicon-16.png", "apple-touch-icon.png"):
        shutil.copy2(os.path.join(WEB, f), dest)
    for d in ("css", "js", "vendor", "icons", "voices", "samples"):
        shutil.copytree(os.path.join(WEB, d), os.path.join(dest, d), ignore=shutil.ignore_patterns("__pycache__", "*.ico", "icon-1024.png"))


def sync_version():
    """AndroidManifest 的 versionName 跟著 version.json；versionCode 由版本號換算（1.2.3 → 10203）"""
    ver = json.load(open(os.path.join(WEB, "version.json"), encoding="utf-8"))["version"]
    a, b, c = (int(x) for x in (ver.split(".") + ["0", "0"])[:3])
    code = a * 10000 + b * 100 + c
    mf = os.path.join(ROOT, "AndroidManifest.xml")
    s = open(mf, encoding="utf-8").read()
    s2 = re.sub(r'android:versionCode="\d+"', f'android:versionCode="{code}"', s)
    s2 = re.sub(r'android:versionName="[^"]*"', f'android:versionName="{ver}"', s2)
    if s2 != s:
        open(mf, "w", encoding="utf-8").write(s2)
    return ver


def ascii_relay():
    """專案資料夾有中文時，javac 會讀錯參數檔：複製到英文路徑的暫存資料夾建置，再把 APK 拿回來。"""
    try:
        ROOT.encode("ascii")
        return False
    except UnicodeEncodeError:
        pass
    import tempfile
    tmp = os.path.join(tempfile.gettempdir(), "xkt_android")
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(ROOT, tmp, ignore=shutil.ignore_patterns("build"))
    env = dict(os.environ, XKT_WEB=os.path.dirname(ROOT))
    subprocess.check_call([sys.executable, "-I", os.path.join(tmp, "build.py"), *sys.argv[1:]], cwd=tmp, env=env)
    os.makedirs(BUILD, exist_ok=True)
    shutil.copy2(os.path.join(tmp, "build", "XiaokeTTS.apk"), os.path.join(BUILD, "XiaokeTTS.apk"))
    shutil.copy2(os.path.join(tmp, "AndroidManifest.xml"), os.path.join(ROOT, "AndroidManifest.xml"))
    if not os.path.exists(os.path.join(ROOT, "xiaoketts.jks")):
        shutil.copy2(os.path.join(tmp, "xiaoketts.jks"), os.path.join(ROOT, "xiaoketts.jks"))
    print("APK：", os.path.join(BUILD, "XiaokeTTS.apk"))
    return True


def main():
    if ascii_relay():
        return
    debug = "debug" in sys.argv[1:]
    ver = sync_version()
    shutil.rmtree(BUILD, ignore_errors=True)
    for d in ("res", "gen", "classes", "dex"):
        os.makedirs(os.path.join(BUILD, d))
    assets = os.path.join(BUILD, "assets")
    copy_web(os.path.join(assets, "web"))
    gen_pkg = os.path.join(BUILD, "gen", *PKG.split("."))
    os.makedirs(gen_pkg, exist_ok=True)
    open(os.path.join(gen_pkg, "BuildFlags.java"), "w", encoding="utf-8").write(
        f"package {PKG};\nfinal class BuildFlags {{ static final boolean DEBUG = {'true' if debug else 'false'}; }}\n")

    # 1. 資源
    run(os.path.join(BT, "aapt2" + EXE), "compile", "--dir", "res", "-o", rel(os.path.join(BUILD, "res.zip")))
    unsigned = os.path.join(BUILD, "unsigned.apk")
    run(os.path.join(BT, "aapt2" + EXE), "link", "-o", rel(unsigned),
        "-I", rel(ANDROID_JAR), "--manifest", "AndroidManifest.xml",
        "--java", rel(os.path.join(BUILD, "gen")), "--auto-add-overlay",
        "-A", rel(assets), "-0", "mjs", "-0", "png", "-0", "mp3",
        rel(os.path.join(BUILD, "res.zip")))

    # 2. Java
    sources = glob.glob(os.path.join(ROOT, "src", "**", "*.java"), recursive=True)
    sources += glob.glob(os.path.join(BUILD, "gen", "**", "*.java"), recursive=True)
    argfile = os.path.join(BUILD, "sources.txt")
    with open(argfile, "w", encoding="utf-8") as f:
        f.write("\n".join('"%s"' % s.replace("\\", "/") for s in sources))
    run(JAVAC, "-encoding", "UTF-8", "--release", "8", "-nowarn", "-Xlint:-options",
        "-classpath", ANDROID_JAR, "-d", os.path.join(BUILD, "classes"), "@" + argfile)

    # 3. dex（先打包成 jar，避免 d8.bat 命令列超過 8191 字元）
    jar = os.path.join(BUILD, "classes.jar")
    cdir = os.path.join(BUILD, "classes")
    with zipfile.ZipFile(jar, "w") as z:
        for f in glob.glob(os.path.join(cdir, "**", "*.class"), recursive=True):
            z.write(f, os.path.relpath(f, cdir).replace(os.sep, "/"))
    run(os.path.join(BT, "d8" + BAT), "--release", "--min-api", "26", "--lib", ANDROID_JAR,
        "--output", os.path.join(BUILD, "dex"), jar)
    with zipfile.ZipFile(unsigned, "a") as z:
        for dex in sorted(glob.glob(os.path.join(BUILD, "dex", "*.dex"))):
            z.write(dex, os.path.basename(dex))

    # 4. 對齊 + 簽章（金鑰只在本機，不放進 git；之後的版本必須用同一把金鑰，才能覆蓋安裝）
    aligned = os.path.join(BUILD, "aligned.apk")
    run(os.path.join(BT, "zipalign" + EXE), "-f", "4", unsigned, aligned)
    ks = os.path.join(ROOT, "xiaoketts.jks")
    if not os.path.exists(ks):
        run(KEYTOOL, "-genkeypair", "-keystore", ks, "-storepass", "android", "-keypass", "android",
            "-alias", "xiaoketts", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
            "-dname", "CN=XiaokeTTS")
    out = os.path.join(BUILD, "XiaokeTTS.apk")
    run(os.path.join(BT, "apksigner" + BAT), "sign", "--ks", ks, "--ks-pass", "pass:android",
        "--out", out, aligned)
    print("完成：", out, "v" + ver, "%.1f MB" % (os.path.getsize(out) / 1048576), "（除錯版）" if debug else "")

    if "install" in sys.argv[1:]:
        run(ADB, "install", "-r", out)
        run(ADB, "shell", "am", "start", "-n", PKG + "/.MainActivity")


if __name__ == "__main__":
    main()
