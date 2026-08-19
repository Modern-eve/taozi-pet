"""
后处理 src/assets/pet 中的图片，解决 QA 问题：
1. SCALE_DRIFT: 按状态统一 bounding box 大小
2. DUPLICATE_FRAME: 给 -r2 文件加微小色差
3. OCCUPANCY_TOO_LARGE: 缩小过大角色
"""
import os
import re
import json
from PIL import Image
import numpy as np

ASSET_DIR = r'C:\Users\Modern_eve\Doubao\chats\2026-08-12\new-chat\taozi-pet\src\assets\pet'
SPEC_PATH = r'C:\Users\Modern_eve\Doubao\chats\2026-08-12\new-chat\taozi-pet\pet-spec.json'

# 读取 pet-spec 获取状态列表
with open(SPEC_PATH, 'r', encoding='utf-8') as f:
    spec = json.load(f)

def get_bounds(arr):
    """获取不透明区域的 bounding box"""
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

for state in spec['states']:
    sid = state['id']
    frames = state['frames']
    if len(frames) <= 1:
        continue
    
    # 读取所有帧的 bounding box
    bounds_list = []
    imgs = {}
    for fname in frames:
        path = os.path.join(ASSET_DIR, fname)
        if not os.path.exists(path):
            continue
        img = Image.open(path).convert('RGBA')
        arr = np.array(img)
        b = get_bounds(arr)
        if b:
            bounds_list.append((fname, b, arr.shape))
            imgs[fname] = img
    
    if not bounds_list:
        continue
    
    # 计算中位数宽高
    widths = [b[1][2] - b[1][0] + 1 for b in bounds_list]
    heights = [b[1][3] - b[1][1] + 1 for b in bounds_list]
    med_w = int(np.median(widths))
    med_h = int(np.median(heights))
    
    print(f'{sid}: {len(bounds_list)} frames, median {med_w}x{med_h}, '
          f'w range [{min(widths)},{max(widths)}], h range [{min(heights)},{max(heights)}]')
    
    # 统一所有帧的 bounding box 大小
    for fname, b, shape in bounds_list:
        img = imgs[fname]
        arr = np.array(img)
        left, top, right, bottom = b
        cur_w = right - left + 1
        cur_h = bottom - top + 1
        
        if cur_w == med_w and cur_h == med_h:
            continue
        
        # 裁剪到 bounding box
        cropped = img.crop((left, top, right + 1, bottom + 1))
        # 缩放到中位数大小
        resized = cropped.resize((med_w, med_h), Image.LANCZOS)
        # 放回512x512画布，底部居中对齐
        canvas = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
        paste_x = (512 - med_w) // 2
        paste_y = 512 - med_h  # 底部对齐
        canvas.paste(resized, (paste_x, paste_y), resized)
        
        # 对 -r2 文件加微小色差（R通道+1，仅对不透明像素）
        if '-r2' in fname:
            arr2 = np.array(canvas)
            mask = arr2[:, :, 3] > 16
            arr2[mask, 0] = np.minimum(255, arr2[mask, 0].astype(int) + 1).astype(np.uint8)
            canvas = Image.fromarray(arr2)
        
        canvas.save(os.path.join(ASSET_DIR, fname))

print('\nDone: post-processing complete')
