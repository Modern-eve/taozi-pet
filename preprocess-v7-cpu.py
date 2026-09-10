"""
CPU 抠白底（v7 洪水填充算法）：assets-raw/ → taozi-pet/incoming-assets/（透明 PNG）

从四边发起洪水填充删除与边缘连通的近背景像素（底边也发起），叠加保护色
障碍物、主体连通块 + 可信分离部件（头顶光环）保留。

GPU 版（preprocess-v7-gpu.py）为默认路径，本脚本仅作**应急兜底**。

输入支持 png / jpg / jpeg / webp / bmp（PIL 按内容解码，扩展名不可信），
输出统一为透明 png（需 alpha 通道）。

用法:
  python preprocess-v7-cpu.py                    # 处理 assets-raw 全部帧
  python preprocess-v7-cpu.py walk-01.jpg       # 只处理指定文件
  python preprocess-v7-cpu.py --states walk sleep   # 只处理指定状态
"""
import os
import numpy as np
from PIL import Image

INPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'
OUTPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\taozi-pet\incoming-assets'

# 可识别的输入格式（源导出常是 jpg；扩展名不可信，PIL 按内容解码）
IMG_EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.bmp')

BG_THRESHOLD = 28

def get_protected_mask(arr, alpha):
    r = arr[:, :, 0].astype(np.int16)
    g = arr[:, :, 1].astype(np.int16)
    b = arr[:, :, 2].astype(np.int16)
    # 肤色保护：r-b>3，避免高光像素被误判为背景；南瓜色不变。
    skin = (r > 150) & (g > 110) & (b > 70) & (r >= g) & (g >= b) & ((r - b) > 3)
    pumpkin = (r > 170) & (g > 110) & (b < 140) & ((r - b) > 70)
    return (skin | pumpkin) & (alpha > 16)

def flood_fill_from_edges(arr, alpha, protected=None):
    """删与四边连通的近背景像素（底边也发起）。
    scipy.ndimage.label 向量化实现，等价于逐像素 BFS 且快 10×+。"""
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
    # 删与上/左/右/下边缘连通的块
    edge_labels = set(np.unique(labeled[0, :]))
    edge_labels |= set(np.unique(labeled[:, 0]))
    edge_labels |= set(np.unique(labeled[:, w - 1]))
    edge_labels |= set(np.unique(labeled[h - 1, :]))
    edge_labels.discard(0)
    if not edge_labels:
        return np.zeros((h, w), dtype=bool)
    return np.isin(labeled, list(edge_labels))

# 分离部件（头顶光环等）保留阈值，与 GPU 版同口径：
# 光环浮在头顶、与身体不相连，面积仅主体的 0.5%~0.7% 且在画面顶部，
# 按"只留最大块"会被整块删除。用「面积占全图比例 + 平均置信度」双闸门区分噪点。
PART_AREA_RATIO = 0.001
PART_MEAN_ALPHA = 150
# 部件内部背景清除——仅处理小部件，主体不动
# （主体内部近白像素多是白色裙边/眼白/高光，删了会把角色打穿）。
PART_MAX_RATIO = 0.01


def refine_alpha(arr, alpha, protected):
    """一次连通域分析：决定保留哪些块，并清掉分离部件内部的背景（与 GPU 版同口径）。

    保留判据（命中任一即保留）：
      1) 面积最大的块 —— 主体
      2) 面积 > 主体 30% 且距画面中心 < 0.4h —— 与主体断开的大部件
      3) 面积 ≥ 全图 0.1% 且平均置信度 ≥ 150 —— 小而可信的分离部件（光环）

    光环浮在头顶、与身体不相连，面积仅主体的 0.5%~0.7% 且在画面顶部，
    按"只留最大块"会被整块删除，故用「面积占全图比例 + 平均置信度」双闸门
    把它与噪点区分开。

    光环是闭合环，环内背景与外界不连通，连通域处理进不去，故对「保留下来的
    小部件」再做一次内部近背景清除。主体内部近白多为高光/白裙，动不得，
    清除只作用于小部件（面积 0.1%~1% 全图）。

    中心与均值只对候选块（大部件 / 小部件）计算，避免对全部连通块做全图归约。
    """
    from scipy import ndimage
    h, w = alpha.shape
    fg = alpha > 16
    labeled, num = ndimage.label(fg)
    if num == 0:
        return alpha
    labels = np.arange(1, num + 1)
    sizes = np.bincount(labeled.ravel(), minlength=num + 1)[1:].astype(np.int64)
    max_area = int(sizes.max())
    min_area = h * w * PART_AREA_RATIO
    max_part = h * w * PART_MAX_RATIO

    main = labels[sizes == max_area]                 # 主体（含同面积的并列块）
    rest = labels[sizes != max_area]
    big = rest[sizes[rest - 1] > max_area * 0.3]     # 与主体断开的大部件
    small = rest[sizes[rest - 1] >= min_area]        # 候选小部件
    small = small[sizes[small - 1] <= max_area * 0.3]  # 与 big 互斥，与保留判据一致

    keep = np.zeros((h, w), dtype=bool)
    for lab in main:
        keep |= (labeled == lab)

    if big.size:
        centers = ndimage.center_of_mass(fg, labeled, big)
        for lab, (cy, cx) in zip(big, centers):
            if ((cy - h / 2) ** 2 + (cx - w / 2) ** 2) ** 0.5 < h * 0.4:
                keep |= (labeled == lab)

    small_kept = np.empty(0, dtype=np.int64)
    if small.size:
        means = ndimage.mean(alpha, labeled, small)
        small_kept = small[means >= PART_MEAN_ALPHA]
        for lab in small_kept:
            keep |= (labeled == lab)  # 小而可信的分离部件（光环）

    new_alpha = np.where(keep, alpha, 0).astype(np.uint8)

    # 清掉保留下来的小部件内部的近背景像素
    clear_labs = small_kept[sizes[small_kept - 1] <= max_part]
    if clear_labs.size:
        bg_ref = arr[0, 0].astype(np.int32)
        r = arr[:, :, 0].astype(np.int32)
        g = arr[:, :, 1].astype(np.int32)
        b = arr[:, :, 2].astype(np.int32)
        near_bg = ((r - bg_ref[0]) ** 2 + (g - bg_ref[1]) ** 2
                   + (b - bg_ref[2]) ** 2) < BG_THRESHOLD ** 2
        near_bg &= ~protected
        hit = np.zeros((h, w), dtype=bool)
        for lab in clear_labs:
            hit |= (labeled == lab)
        new_alpha[near_bg & hit] = 0
    return new_alpha

def process_image(input_path, output_path):
    img = Image.open(input_path).convert('RGBA')
    arr = np.array(img)
    alpha = arr[:, :, 3].copy()
    protected = get_protected_mask(arr, alpha)  # 一帧只算一次，供各步复用

    # 1. 洪水填充（从四边发起，删与边缘连通的近背景像素）
    delete_mask = flood_fill_from_edges(arr, alpha, protected)
    alpha[delete_mask] = 0
    # 2. 保留主体 + 可信分离部件，并清掉分离部件内部背景
    alpha = refine_alpha(arr, alpha, protected)

    arr[:, :, 3] = alpha
    Image.fromarray(arr).save(output_path)

def _state_of(fname):
    """从 'walk-01.png' / 'pet-head-03.jpg' 取状态前缀。"""
    return fname.rsplit('-', 1)[0]


def _out_name(fname):
    """输出统一为透明 png（需 alpha 通道），与输入格式无关。"""
    return os.path.splitext(fname)[0] + '.png'


def main():
    import argparse
    ap = argparse.ArgumentParser(description="CPU 抠图（应急兜底）：assets-raw → taozi-pet/incoming-assets（默认全量，--states 限定部分状态）")
    ap.add_argument('files', nargs='*', help='指定文件（默认处理 --states 全部）')
    ap.add_argument('--states', nargs='*', default=None,
                    help='只处理这些状态（默认处理全部状态）')
    args = ap.parse_args()
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    states = set(args.states) if args.states else None
    if args.files:
        files = [f for f in args.files if f.lower().endswith(IMG_EXTS)]
        print(f'Selected files: {len(files)} files')
    else:
        files = sorted([f for f in os.listdir(INPUT_DIR)
                        if f.lower().endswith(IMG_EXTS) and (states is None or _state_of(f) in states)])
        label = sorted(states) if states else 'ALL'
        print(f'Processing states {label}: {len(files)} files')
    success = 0
    for i, fname in enumerate(files):
        in_path = os.path.join(INPUT_DIR, fname)
        out_path = os.path.join(OUTPUT_DIR, _out_name(fname))
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
