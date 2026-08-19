"""修复 OCCUPANCY_TOO_LARGE：max(宽,高)/512 > 0.805"""
import os
from PIL import Image
import numpy as np

ASSET_DIR = r'C:\Users\Modern_eve\Doubao\chats\2026-08-12\new-chat\taozi-pet\src\assets\pet'
MAX_DIM = int(512 * 0.80)  # 409，留余量

def get_bounds(arr):
    alpha = arr[:, :, 3]
    rows = np.any(alpha > 16, axis=1)
    cols = np.any(alpha > 16, axis=0)
    if not np.any(rows) or not np.any(cols):
        return None
    top = int(np.argmax(rows))
    bottom = len(rows) - int(np.argmax(rows[::-1])) - 1
    left = int(np.argmax(cols))
    right = len(cols) - int(np.argmax(cols[::-1])) - 1
    return (left, top, right, bottom)

fixed = 0
for fname in os.listdir(ASSET_DIR):
    if not fname.endswith('.png'):
        continue
    path = os.path.join(ASSET_DIR, fname)
    img = Image.open(path).convert('RGBA')
    arr = np.array(img)
    b = get_bounds(arr)
    if not b:
        continue
    w = b[2] - b[0] + 1
    h = b[3] - b[1] + 1
    max_dim = max(w, h)
    if max_dim > MAX_DIM:
        scale = MAX_DIM / max_dim
        new_w = int(w * scale)
        new_h = int(h * scale)
        left, top, right, bottom = b
        cropped = img.crop((left, top, right + 1, bottom + 1))
        resized = cropped.resize((new_w, new_h), Image.LANCZOS)
        canvas = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
        paste_x = left + (w - new_w) // 2
        paste_y = bottom - new_h + 1
        canvas.paste(resized, (paste_x, paste_y), resized)
        canvas.save(path)
        fixed += 1
        print(f'  {fname}: max_dim={max_dim} -> scaled to {max(new_w,new_h)}')

print(f'Fixed {fixed} files')
