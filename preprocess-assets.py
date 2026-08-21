"""
统一素材预处理：仅用洪水填充从边缘向内清除白色/灰色及相邻颜色
不做任何内部二次清除，避免误删角色肤色、南瓜包、腿部等
"""
import os
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
INPUT_DIR = os.path.join(ROOT, 'assets-raw')
OUTPUT_DIR = os.path.join(ROOT, 'assets-processed')

PADDING = 100
BG_THRESHOLD = 20  # 只清除与边缘白色/灰色颜色差异小于20的连通像素
FLOOD_STEP = 8

STATE_SHRINK = {}

os.makedirs(OUTPUT_DIR, exist_ok=True)


def process_image(input_path, output_path, shrink=1.0):
    img = Image.open(input_path).convert("RGBA")
    w, h = img.size
    work = img.copy()

    # 1. 从边缘每8像素取点，洪水填充标记背景（只由外向内）
    fill_points = []
    for x in range(0, w, FLOOD_STEP):
        fill_points.append((x, 0))
        fill_points.append((x, h - 1))
    for y in range(FLOOD_STEP, h - FLOOD_STEP, FLOOD_STEP):
        fill_points.append((0, y))
        fill_points.append((w - 1, y))

    for pt in fill_points:
        try:
            ImageDraw.floodfill(work, pt, (255, 0, 255, 255), thresh=BG_THRESHOLD)
        except Exception:
            pass

    # 2. 品红色（洪水填充标记的背景）→ 透明
    arr = np.array(work)
    bg_mask = (arr[:, :, 0] > 200) & (arr[:, :, 1] < 80) & (arr[:, :, 2] > 200)
    arr[bg_mask, 3] = 0

    # 3. 统一缩小角色（保持脚底位置）
    result = Image.fromarray(arr, "RGBA")
    if shrink < 1.0:
        bbox = result.getbbox()
        if bbox:
            character = result.crop(bbox)
            cw, ch = character.size
            new_cw = int(cw * shrink)
            new_ch = int(ch * shrink)
            character = character.resize((new_cw, new_ch), Image.LANCZOS)
            result = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            offset_x = (w - new_cw) // 2
            offset_y = bbox[3] - new_ch
            result.paste(character, (offset_x, offset_y), character)

    # 4. 加边距
    new_img = Image.new("RGBA", (w + PADDING * 2, h + PADDING * 2), (0, 0, 0, 0))
    new_img.paste(result, (PADDING, PADDING), result)
    new_img.save(output_path, "PNG")


def main():
    files = sorted([
        os.path.join(INPUT_DIR, f)
        for f in os.listdir(INPUT_DIR)
        if f.lower().endswith(".png")
    ])
    print(f"Processing {len(files)} images...")
    print(f"Mode: flood-fill only (thresh={BG_THRESHOLD}), no internal cleanup")
    success = 0
    for i, f in enumerate(files):
        name = os.path.basename(f)
        out = os.path.join(OUTPUT_DIR, name)
        state = name.split("-")[0]
        shrink = STATE_SHRINK.get(state, 1.0)
        try:
            process_image(f, out, shrink)
            success += 1
            print(f"  [{i+1}/{len(files)}] OK: {name}")
        except Exception as e:
            print(f"  [{i+1}/{len(files)}] FAIL: {name} - {e}")
    print(f"\nDone: {success}/{len(files)}")


if __name__ == "__main__":
    main()
