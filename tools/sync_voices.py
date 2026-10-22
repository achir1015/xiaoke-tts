# -*- coding: utf-8 -*-
"""從 achir1015/indextts2-taiwan-tts 抓聲音 mp3，納入內建（系統）聲音。

規則：檔名看得出「年齡」和「性別」的 mp3 才算聲音，例如
  年輕女.mp3、中年男.mp3、高齡女.mp3、女童音02.mp3、成熟女人.mp3、
  有一種鳥能成功飛越太平洋，靠的卻_年輕女音.mp3（某個聲音的朗讀成品，也可以當樣本）
劇場作品（星期天的菜市場.mp3…）檔名沒有年齡性別，不會納入。

每個檔案剪成前 12 秒（去掉開頭靜音）、24 kHz 單聲道 64 kbps → voices/<id>.mp3，
並產生 js/voices-builtin.js（名稱＝檔名、年齡、性別）。
執行：python tools/sync_voices.py（需要 ffmpeg）
"""
import hashlib
import json
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "achir1015/indextts2-taiwan-tts"
BRANCH = "main"

# 年齡關鍵字 →（代號, 顯示名稱）。「童」放最前面：女童音不是女聲成人
AGES = [("童", "child", "兒童"), ("年輕", "young", "青年"), ("中年", "middle", "中年"),
        ("成熟", "mature", "成熟"), ("高齡", "elder", "高齡"), ("老", "elder", "高齡")]
GENDERS = [("女", "female", "女"), ("男", "male", "男")]
# 已經在用的 id（劇本、快取都靠它）不能變
FIXED_IDS = {"child_female": "girl", "child_male": "boy"}


def classify(stem):
    # 「標題_年輕女音」這種朗讀成品：用底線後面那段判斷
    key = stem.rsplit("_", 1)[-1]
    age = next((a for a in AGES if a[0] in key), None)
    gender = next((g for g in GENDERS if g[0] in key), None)
    if not age or not gender:
        return None
    return age, gender, key


def main():
    url = f"https://api.github.com/repos/{REPO}/git/trees/{BRANCH}?recursive=1"
    tree = json.load(urllib.request.urlopen(url))["tree"]
    files = sorted(t["path"] for t in tree if t["path"].lower().endswith(".mp3"))
    out, used = [], set()
    vdir = ROOT / "voices"
    vdir.mkdir(exist_ok=True)
    for path in files:
        stem = Path(path).stem
        c = classify(stem)
        if not c:
            print("略過（檔名沒有年齡性別）：", path)
            continue
        (age_key, age_id, age_label), (_, g_id, g_label), key = c
        base = FIXED_IDS.get(f"{age_id}_{g_id}", f"{age_id}_{g_id}")
        is_read = "_" in stem
        num = re.search(r"(\d+)$", key)
        if is_read:
            vid = f"{base}_read_{hashlib.md5(stem.encode()).hexdigest()[:6]}"
            title = stem.rsplit("_", 1)[0]
            name = f"{key}（{title[:8]}）"
        else:
            vid = base + (str(int(num.group(1))) if num and int(num.group(1)) > 1 else "")
            name = stem
        while vid in used:
            vid += "x"
        used.add(vid)
        raw = urllib.request.urlopen(f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{urllib.parse.quote(path)}").read()
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp.write(raw)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp.name, "-af",
                        "silenceremove=start_periods=1:start_threshold=-45dB,atrim=0:12,afade=t=out:st=11.6:d=0.4",
                        "-ac", "1", "-ar", "24000", "-b:a", "64k", str(vdir / f"{vid}.mp3")], check=True)
        Path(tmp.name).unlink()
        out.append({"id": vid, "name": name, "gender": g_id, "genderLabel": g_label, "age": age_id, "ageLabel": age_label,
                    "read": is_read, "source": path})
        print(f"{vid:28s} {name}  ({age_label}・{g_label})")
    order = {"young": 0, "middle": 1, "mature": 2, "elder": 3, "child": 4}
    out.sort(key=lambda v: (v["read"], order[v["age"]], v["gender"] != "female", v["id"]))
    js = ("// 由 tools/sync_voices.py 自動產生，請勿手動修改。\n"
          f"// 來源：https://github.com/{REPO}（檔名看得出年齡、性別的 mp3）\n"
          "export const BUILTIN = " + json.dumps(out, ensure_ascii=False, indent=2) + ";\n")
    (ROOT / "js" / "voices-builtin.js").write_text(js, encoding="utf-8")
    # 不再使用的舊檔
    keep = {v["id"] + ".mp3" for v in out}
    for f in vdir.glob("*.mp3"):
        if f.name not in keep:
            print("刪除舊檔：", f.name)
            f.unlink()
    print(f"共 {len(out)} 個內建聲音")


if __name__ == "__main__":
    main()
