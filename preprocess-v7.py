"""
抠图算法 v7
- 支持指定文件处理
- 洪水填充前用白色替换黑色描边，填充后恢复描边
- 仅从左、右、上边缘发起洪水填充，下方不发起
- 保护色（肤色、南瓜色）作为洪水填充障碍物
- 内部纯白小空洞填充（HOLE_FILL_THRESHOLD）
- 保守清除底部横线
- 保留中心最大连通块
用法:
  python preprocess-v7.py              # 处理全部
  python preprocess-v7.py walk-01.png  # 只处理指定文件
"""
import os
import sys
import numpy as np
from PIL import Image
from collections import deque

INPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'
OUTPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-processed'

BG_THRESHOLD = 28
FLOOD_STEP = 3
HOLE_FILL_THRESHOLD = 3000
STROKE_THRESHOLD = 80
BOTTOM_LINE_HEIGHT = 15  # 底部横线检测高度
BOTTOM_LINE_RATIO = 0.6  # 横线宽度占比阈值

def get_protected_mask(arr, alpha):
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    # 肤色：r-b > 3 即可保护，避免高光像素（r-b≈6-11、距白色<28）被误判为背景。
    # 纯白背景 r-b=0 仍不满足；南瓜色保持不变。
    skin = (r > 150) & (g > 110) & (b > 70) & (r >= g) & (g >= b) & ((r - b) > 3)
    pumpkin = (r > 170) & (g > 110) & (b < 140) & ((r - b) > 70)
    return (skin | pumpkin) & (alpha > 16)

def get_stroke_mask(arr, alpha):
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    return (r < STROKE_THRESHOLD) & (g < STROKE_THRESHOLD) & (b < STROKE_THRESHOLD) & (alpha > 16)

def flood_fill_from_edges(arr, alpha):
    h, w = arr.shape[:2]
    bg_ref = arr[0, 0].astype(int)
    protected = get_protected_mask(arr, alpha)
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    dist = np.sqrt((r - bg_ref[0])**2 + (g - bg_ref[1])**2 + (b - bg_ref[2])**2)
    is_bg = (dist < BG_THRESHOLD) & (alpha > 16) & ~protected
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[protected] = 2
    queue = deque()
    for y in range(0, h, FLOOD_STEP):
        if is_bg[y, 0] and mask[y, 0] == 0:
            mask[y, 0] = 1; queue.append((y, 0))
        if is_bg[y, w-1] and mask[y, w-1] == 0:
            mask[y, w-1] = 1; queue.append((y, w-1))
    for x in range(0, w, FLOOD_STEP):
        if is_bg[0, x] and mask[0, x] == 0:
            mask[0, x] = 1; queue.append((0, x))
    directions = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    while queue:
        y, x = queue.popleft()
        for dy, dx in directions:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] == 0:
                if protected[ny, nx]:
                    mask[ny, nx] = 2
                elif is_bg[ny, nx]:
                    mask[ny, nx] = 1; queue.append((ny, nx))
                else:
                    mask[ny, nx] = 2
    return mask == 1

def fill_holes(alpha):
    """填充内部小空洞"""
    h, w = alpha.shape
    # 从边缘洪水填充透明区域，未被填充的透明区域就是内部空洞
    visited = np.zeros((h, w), dtype=bool)
    queue = deque()
    for y in range(h):
        if alpha[y, 0] <= 16:
            visited[y, 0] = True; queue.append((y, 0))
        if alpha[y, w-1] <= 16:
            visited[y, w-1] = True; queue.append((y, w-1))
    for x in range(w):
        if alpha[0, x] <= 16:
            visited[0, x] = True; queue.append((0, x))
        if alpha[h-1, x] <= 16:
            visited[h-1, x] = True; queue.append((h-1, x))
    while queue:
        y, x = queue.popleft()
        for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
            ny, nx = y+dy, x+dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and alpha[ny, nx] <= 16:
                visited[ny, nx] = True; queue.append((ny, nx))
    # 未被访问的透明像素是内部空洞
    hole_mask = ~visited & (alpha <= 16)
    # 按连通区域填充小空洞
    from scipy import ndimage
    labeled, num = ndimage.label(hole_mask)
    for i in range(1, num+1):
        region = labeled == i
        area = region.sum()
        if area <= HOLE_FILL_THRESHOLD:
            alpha[region] = 255
    return alpha

def remove_bottom_lines(arr, alpha):
    """保守清除底部横线：要求 std<15（极均匀颜色）且整行均值>240（接近白）"""
    h, w = arr.shape[:2]
    for y in range(h - BOTTOM_LINE_HEIGHT, h):
        row_alpha = alpha[y, :]
        visible = row_alpha > 16
        if visible.sum() / w > BOTTOM_LINE_RATIO:
            row_pixels = arr[y, visible, :3]
            if len(row_pixels) > 0:
                std = row_pixels.std(axis=0).mean()
                mean_val = row_pixels.mean()
                if std < 15 and mean_val > 240:
                    alpha[y, :] = 0
    return alpha

def keep_largest_connected(alpha):
    h, w = alpha.shape
    visited = np.zeros((h, w), dtype=bool)
    regions = []
    for y in range(h):
        for x in range(w):
            if alpha[y, x] > 16 and not visited[y, x]:
                region = []
                queue = deque([(y, x)])
                visited[y, x] = True
                while queue:
                    cy, cx = queue.popleft()
                    region.append((cy, cx))
                    for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
                        ny, nx = cy+dy, cx+dx
                        if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and alpha[ny, nx] > 16:
                            visited[ny, nx] = True; queue.append((ny, nx))
                cy_avg = np.mean([p[0] for p in region])
                cx_avg = np.mean([p[1] for p in region])
                dist = ((cy_avg - h/2)**2 + (cx_avg - w/2)**2) ** 0.5
                regions.append((len(region), dist, region))
    if not regions:
        return alpha
    regions.sort(key=lambda r: (-r[0], r[1]))
    keep = set(regions[0][2])
    max_area = regions[0][0]
    for area, dist, region in regions[1:]:
        if area > max_area * 0.3 and dist < h * 0.4:
            keep.update(region)
    new_alpha = np.zeros((h, w), dtype=np.uint8)
    for y, x in keep:
        new_alpha[y, x] = alpha[y, x]
    return new_alpha

def process_image(input_path, output_path):
    img = Image.open(input_path).convert('RGBA')
    arr = np.array(img)
    alpha = arr[:, :, 3].copy()
    
    # 1. 检测描边
    stroke_mask = get_stroke_mask(arr, alpha)
    # 2. 用白色替换描边（让洪水能冲入缝隙）
    arr_no_stroke = arr.copy()
    arr_no_stroke[stroke_mask, :3] = 255
    arr_no_stroke[stroke_mask, 3] = 255
    # 3. 洪水填充（在去描边的图上）
    delete_mask = flood_fill_from_edges(arr_no_stroke, alpha)
    # 4. 应用删除
    alpha[delete_mask] = 0
    # 5. 恢复描边：被删除的描边像素如果相邻有保留的前景，则恢复
    h, w = alpha.shape
    for y in range(h):
        for x in range(w):
            if stroke_mask[y, x] and alpha[y, x] == 0:
                for dy, dx in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]:
                    ny, nx = y+dy, x+dx
                    if 0 <= ny < h and 0 <= nx < w and alpha[ny, nx] > 16:
                        alpha[y, x] = 255
                        break
    # 6. 填充内部小空洞
    alpha = fill_holes(alpha)
    # 7. 清除底部横线
    alpha = remove_bottom_lines(arr, alpha)
    # 8. 保留中心最大连通块
    alpha = keep_largest_connected(alpha)
    
    arr[:, :, 3] = alpha
    Image.fromarray(arr).save(output_path)

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    if len(sys.argv) > 1:
        files = [f for f in sys.argv[1:] if f.lower().endswith('.png')]
        print(f'Selected processing: {len(files)} files')
    else:
        files = sorted([f for f in os.listdir(INPUT_DIR) if f.lower().endswith('.png')])
        print(f'Processing all: {len(files)} files')
    success = 0
    for i, fname in enumerate(files):
        in_path = os.path.join(INPUT_DIR, fname)
        out_path = os.path.join(OUTPUT_DIR, fname)
        if not os.path.exists(in_path):
            print(f'  SKIP (not found): {fname}')
            continue
        try:
            process_image(in_path, out_path)
            success += 1
            print(f'  [{i+1}/{len(files)}] {fname} OK')
        except Exception as e:
            print(f'  ERROR {fname}: {e}')
    print(f'Done: {success}/{len(files)} succeeded')

if __name__ == '__main__':
    main()
