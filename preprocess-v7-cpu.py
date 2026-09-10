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
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
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


def clear_part_background(arr, alpha, protected):
    """清除分离小部件（头顶光环）内部的近背景色像素。

    光环是闭合环（实心椭圆盘+外圈描边），中间背景与外部不连通，
    洪水填充/连通块都进不去，保留后需单独清除。主体内部近白多为
    高光/白裙，动不得；本函数只清小部件（面积 0.1%~1% 全图）。
    """
    from scipy import ndimage
    h, w = alpha.shape
    fg = alpha > 16
    labeled, num = ndimage.label(fg)
    if num == 0:
        return alpha
    labs = range(1, num + 1)
    sizes = ndimage.sum(fg, labeled, labs)
    main = int(np.argmax(sizes)) + 1
    bg_ref = arr[0, 0].astype(int)
    r, g, b = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)
    dist = np.sqrt((r - bg_ref[0]) ** 2 + (g - bg_ref[1]) ** 2 + (b - bg_ref[2]) ** 2)
    near_bg = (dist < BG_THRESHOLD) & ~protected
    out = alpha.copy()
    min_area = h * w * PART_AREA_RATIO
    max_area = h * w * PART_MAX_RATIO
    for lab in labs:
        if lab == main:
            continue
        area = float(sizes[lab - 1])
        if area < min_area or area > max_area:
            continue
        m = (labeled == lab)
        out[m & near_bg] = 0
    return out


def keep_largest_connected(alpha):
    """保留主体连通块，以及可信的分离部件（如头顶光环），命中任一条件即保留：
      1) 面积最大的块 —— 主体
      2) 面积 > 主体 30% 且距画面中心 < 0.4h —— 与主体断开的大部件
      3) 面积 ≥ 全图 0.1% 且平均置信度 ≥ 150 —— 小而可信的分离部件（光环）
    """
    from scipy import ndimage
    h, w = alpha.shape
    fg = alpha > 16
    labeled, num = ndimage.label(fg)
    if num == 0:
        return alpha
    labs = range(1, num + 1)
    sizes = ndimage.sum(fg, labeled, labs)
    centers = ndimage.center_of_mass(fg, labeled, labs)
    means = ndimage.mean(alpha, labeled, labs)
    max_area = float(sizes.max())
    min_area = h * w * PART_AREA_RATIO
    keep = np.zeros((h, w), dtype=bool)
    for lab in labs:
        area = float(sizes[lab - 1])
        if area == max_area:
            keep |= (labeled == lab)  # 主体
        elif area > max_area * 0.3:
            cy, cx = centers[lab - 1]  # 与主体断开的大部件：需靠近中心
            if ((cy - h / 2) ** 2 + (cx - w / 2) ** 2) ** 0.5 < h * 0.4:
                keep |= (labeled == lab)
        elif area >= min_area and float(means[lab - 1]) >= PART_MEAN_ALPHA:
            keep |= (labeled == lab)  # 小而可信的分离部件（光环）
    new_alpha = np.zeros((h, w), dtype=np.uint8)
    new_alpha[keep] = alpha[keep]
    return new_alpha

def process_image(input_path, output_path):
    img = Image.open(input_path).convert('RGBA')
    arr = np.array(img)
    alpha = arr[:, :, 3].copy()
    protected = get_protected_mask(arr, alpha)  # 一帧只算一次，供各步复用

    # 1. 洪水填充（从四边发起，删与边缘连通的近背景像素）
    delete_mask = flood_fill_from_edges(arr, alpha, protected)
    alpha[delete_mask] = 0
    # 2. 保留中心最大连通块
    alpha = keep_largest_connected(alpha)

    # 3. 分离小部件（头顶光环）内部的近背景像素清掉。
    # 光环是闭合环，内部背景与外界不连通，洪水填充删不到，必须保留后单独清。
    alpha = clear_part_background(arr, alpha, protected)

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
