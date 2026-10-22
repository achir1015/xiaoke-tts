# -*- coding: utf-8 -*-
"""產生小柯機器人台灣語音 MP3 工具的所有圖示：網址列小圖示、主畫面捷徑、Windows .ico。
造型：小柯機器人的頭（天線、耳朵、螢幕臉），嘴巴是一排聲波，代表「會說話」。
執行：python tools/make_icons.py（需要 Pillow）
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024
SS = 4


def grad(size, top, bottom):
    g = Image.new("RGB", (1, 256))
    for y in range(256):
        t = y / 255
        g.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return g.resize((size, size))


def draw_robot(d, k, cx=512, cy=500, scale=1.0):
    def P(*v):
        return [round((cx + (x - 512) * scale) * k) if i % 2 == 0 else round((cy + (x - 500) * scale) * k) for i, x in enumerate(v)]
    R = lambda r: round(r * scale * k)
    white = (255, 255, 255)
    # 天線
    d.rounded_rectangle(P(498, 150, 526, 260), radius=R(10), fill=white)
    d.ellipse(P(457, 85, 567, 195), fill=(255, 196, 0))
    # 耳朵
    d.rounded_rectangle(P(80, 400, 176, 660), radius=R(40), fill=white)
    d.rounded_rectangle(P(848, 400, 944, 660), radius=R(40), fill=white)
    # 頭
    d.rounded_rectangle(P(150, 250, 874, 860), radius=R(130), fill=white)
    # 螢幕臉
    d.rounded_rectangle(P(214, 314, 810, 796), radius=R(80), fill=(14, 30, 45))
    cyan = (45, 212, 191)
    # 眼睛（彎彎的笑眼）
    d.arc(P(310, 400, 450, 520), start=200, end=340, fill=cyan, width=R(30))
    d.arc(P(574, 400, 714, 520), start=200, end=340, fill=cyan, width=R(30))
    # 嘴巴 = 聲波
    bars = [40, 80, 130, 90, 150, 100, 60]
    w, gap = 34, 22
    total = len(bars) * w + (len(bars) - 1) * gap
    x0 = 512 - total / 2
    for i, h in enumerate(bars):
        x = x0 + i * (w + gap)
        d.rounded_rectangle(P(x, 650 - h / 2, x + w, 650 + h / 2), radius=R(17), fill=(255, 196, 0) if i == 4 else cyan)


def make(size_px, maskable=False, rounded=True):
    k = SS
    img = Image.new("RGBA", (S * k, S * k), (0, 0, 0, 0))
    g = grad(S * k, (20, 184, 166), (14, 116, 144)).convert("RGBA")
    mask = Image.new("L", (S * k, S * k), 0)
    md = ImageDraw.Draw(mask)
    if maskable or not rounded:
        md.rectangle([0, 0, S * k, S * k], fill=255)
    else:
        md.rounded_rectangle([40 * k, 40 * k, (S - 40) * k, (S - 40) * k], radius=230 * k, fill=255)
    img.paste(g, (0, 0), mask)
    d = ImageDraw.Draw(img)
    draw_robot(d, k, scale=0.76 if maskable else 0.98, cy=520 if maskable else 500)
    return img.resize((size_px, size_px), Image.LANCZOS)


def main():
    icons = ROOT / "icons"
    icons.mkdir(exist_ok=True)
    make(512).save(icons / "icon-512.png")
    make(192).save(icons / "icon-192.png")
    make(512, maskable=True).save(icons / "icon-maskable-512.png")
    make(1024).save(icons / "icon-1024.png")
    # iOS 主畫面：不透明方形（系統自己加圓角）
    make(180, rounded=False).convert("RGB").save(ROOT / "apple-touch-icon.png")
    make(32).save(ROOT / "favicon-32.png")
    make(16).save(ROOT / "favicon-16.png")
    make(256).save(ROOT / "favicon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("icons ok")


if __name__ == "__main__":
    main()
