"""从封面素材裁剪出程序图标全套尺寸。需要 Pillow：pip install Pillow"""
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "封面素材", "糖.png")
OUT = os.path.join(ROOT, "src-tauri", "icons")

SIDE = 920
CENTER = (620, 505)


def square_crop(im, side, center):
    w, h = im.size
    left = max(0, center[0] - side // 2)
    top = max(0, center[1] - side // 2)
    right = min(w, left + side)
    bottom = min(h, top + side)
    span = min(right - left, bottom - top)
    left += (right - left - span) // 2
    top += (bottom - top - span) // 2
    return im.crop((left, top, left + span, top + span))


def main():
    os.makedirs(OUT, exist_ok=True)
    im = Image.open(SRC).convert("RGB")
    sq = square_crop(im, SIDE, CENTER).resize((1024, 1024), Image.LANCZOS)
    sq.save(os.path.join(OUT, "source.png"))
    sq.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon.png"))
    sq.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "128x128@2x.png"))
    sq.resize((128, 128), Image.LANCZOS).save(os.path.join(OUT, "128x128.png"))
    sq.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, "32x32.png"))
    sq.save(
        os.path.join(OUT, "icon.ico"),
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("icons written:", sorted(os.listdir(OUT)))


if __name__ == "__main__":
    main()
