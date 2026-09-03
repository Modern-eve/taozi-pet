"""
CPU 抠白底（v7 洪水填充算法）：assets-raw/ → taozi-pet/incoming-assets/（透明 PNG）

仅从左/右/上边缘发起洪水填充（下方不发起，保护脚底），叠加保护色障碍物、
最大连通块保留。仅作最后手段（GPU 版为默认）。

用法:
  python preprocess-v7-cpu.py                    # 处理非 matted 的 8 个状态
  python preprocess-v7-cpu.py walk-01.png       # 只处理指定文件
  python preprocess-v7-cpu.py --states idle blink
"""
import os
import sys
import numpy as np
from PIL import Image

INPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'
OUTPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\taozi-pet\incoming-assets'

BG_THRESHOLD = 28

def get_protected_mask(arr, alpha):
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    # 肤色保护：r-b>3，避免高光像素被误判为背景；南瓜色不变。
    skin = (r > 150) & (g > 110) & (b > 70) & (r >= g) & (g >= b) & ((r - b) > 3)
    pumpkin = (r > 170) & (g > 110) & (b < 140) & ((r - b) > 70)
    return (skin | pumpkin) & (alpha > 16)

def flood_fill_from_edges(arr, alpha, protected=None):
    """删与上/左/右三边连通的近背景像素（下方不发起，保护脚底）。
    scipy.ndimage.label 向量化替代 Python deque BFS（等价且快 10×+）。"""
    from scipy import ndimage
    h, w = arr.shape[:2]
    if protected is None:
        protected = get_protected_mask(arr, alpha)
    bg_ref = arr[0, 0].astype(int)
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    dist = np.sqrt((r - bg_ref[0])**2 + (g - bg_ref[1])**2 + (b - bg_ref[2])**2)
    is_bg = (dist < BG_THRESHOLD) & (alpha > 16) & ~protected

    labeled, num = ndimage.label(is_bg)
    if num == 0:
        return np.zeros((h, w), dtype=bool)
    # 只删与上/左/右边缘连通的块（底边不发起）
    edge_labels = set(np.unique(labeled[0, :]))
    edge_labels |= set(np.unique(labeled[:, 0]))
    edge_labels |= set(np.unique(labeled[:, w - 1]))
    edge_labels.discard(0)
    if not edge_labels:
        return np.zeros((h, w), dtype=bool)
    return np.isin(labeled, list(edge_labels))

def keep_largest_connected(alpha):
    from scipy import ndimage
    h, w = alpha.shape
    fg = alpha > 16
    labeled, num = ndimage.label(fg)
    if num == 0:
        return alpha
    sizes = ndimage.sum(fg, labeled, range(1, num + 1))
    # 质心（用于"近中心"判定）
    centers = ndimage.center_of_mass(fg, labeled, range(1, num + 1))
    max_area = float(sizes.max())
    keep = np.zeros((h, w), dtype=bool)
    for lab in range(1, num + 1):
        area = float(sizes[lab - 1])
        if area == max_area:
            keep |= (labeled == lab)
        elif area > max_area * 0.3:
            cy, cx = centers[lab - 1]
            if ((cy - h/2)**2 + (cx - w/2)**2) ** 0.5 < h * 0.4:
                keep |= (labeled == lab)
    new_alpha = np.zeros((h, w), dtype=np.uint8)
    new_alpha[keep] = alpha[keep]
    return new_alpha

def process_image(input_path, output_path):
    img = Image.open(input_path).convert('RGBA')
    arr = np.array(img)
    alpha = arr[:, :, 3].copy()
    protected = get_protected_mask(arr, alpha)  # 一帧只算一次，供各步复用

    # 1. 洪水填充（只从左/右/上边缘发起，删背景）
    delete_mask = flood_fill_from_edges(arr, alpha, protected)
    alpha[delete_mask] = 0
    # 2. 保留中心最大连通块
    alpha = keep_largest_connected(alpha)

    arr[:, :, 3] = alpha
    Image.fromarray(arr).save(output_path)

# 默认处理非 matted 的 8 个状态（matted 4 状态由 GPU 版负责）
DEFAULT_STATES = ["idle", "blink", "happy", "notify", "pet-head", "pumpkin-bag", "petal-spin", "starfish-wave"]

def _state_of(fname):
    """从 'walk-01.png' / 'pet-head-03.png' 取状态前缀。"""
    return fname.rsplit('-', 1)[0]

def main():
    import argparse
    ap = argparse.ArgumentParser(description="CPU 抠图：assets-raw → taozi-pet/incoming-assets（仅非 matted 状态）")
    ap.add_argument('files', nargs='*', help='指定文件（默认处理 --states 全部）')
    ap.add_argument('--states', nargs='*', default=DEFAULT_STATES,
                    help=f'只处理这些状态（默认 {DEFAULT_STATES}）')
    args = ap.parse_args()
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    states = set(args.states)
    if args.files:
        files = [f for f in args.files if f.lower().endswith('.png')]
        print(f'Selected files: {len(files)} files')
    else:
        files = sorted([f for f in os.listdir(INPUT_DIR)
                        if f.lower().endswith('.png') and _state_of(f) in states])
        print(f'Processing states {sorted(states)}: {len(files)} files')
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
