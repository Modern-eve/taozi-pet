"""抠图管线的公共实现：路径、保护色、连通域后处理与帧名工具。

被 preprocess-v7-gpu.py、preprocess-v7-cpu.py 与 make-graphics.py 共用，
使 GPU / CPU 两条抠图路径共用同一份阈值与同一套后处理判据。

格式契约（上游见 rename-assets.py）：
    <任意格式>  ──rename──▶  <state>-NN.jpg  ──preprocess──▶  <state>-NN.png

输入支持 png / jpg / jpeg / webp / bmp（PIL 按内容解码，扩展名不必可信）；
抠图结果带 alpha 通道，只有 png 存得下，故产物恒为透明 png。
"""
import os

import numpy as np
from scipy import ndimage

INPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'
OUTPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\taozi-pet\incoming-assets'

# 可识别的输入格式（源导出常是 jpg；扩展名不可信，PIL 按内容解码）
IMG_EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.bmp')

# 近背景判定：与左上角背景色的 RGB 欧氏距离小于该值即视为背景
BG_THRESHOLD = 28

# 贴边前景清理宽度（像素）。贴边帧的源图本就切到画面外，
# 留一条透明边可避免下游 process-assets 判 SUBJECT_TOUCHES_BORDER。
BORDER_CLEAR_PX = 2


def state_of(fname):
    """从 'walk-01.png' / 'pet-head-03.jpg' 取状态前缀。"""
    return fname.rsplit('-', 1)[0]


def out_name(fname):
    """输出统一为透明 png（需 alpha 通道），与输入格式无关。"""
    return os.path.splitext(fname)[0] + '.png'


def select_frames(files_arg, states_arg):
    """按命令行参数挑出待处理帧并打印选择结果，返回帧名列表。

    给定 files_arg 时只取其中扩展名可识别的文件；否则扫描 INPUT_DIR 全部帧，
    states_arg 非空时再按状态前缀过滤（前缀取自帧名，见 state_of）。
    """
    if files_arg:
        frames = [f for f in files_arg if f.lower().endswith(IMG_EXTS)]
        print(f'Selected files: {len(frames)} files')
        return frames
    states = set(states_arg) if states_arg else None
    frames = sorted(f for f in os.listdir(INPUT_DIR)
                    if f.lower().endswith(IMG_EXTS) and (states is None or state_of(f) in states))
    label = sorted(states) if states else 'ALL'
    print(f'Processing states {label}: {len(frames)} files')
    return frames


def job_list(frames):
    """把帧名展开成 (帧名, 输入路径, 输出路径)，跳过源图不存在的帧。"""
    jobs = []
    for fname in frames:
        in_path = os.path.join(INPUT_DIR, fname)
        if not os.path.exists(in_path):
            print(f'  SKIP (not found): {fname}')
            continue
        jobs.append((fname, in_path, os.path.join(OUTPUT_DIR, out_name(fname))))
    return jobs


def get_protected_mask(arr, alpha):
    """肤色 / 南瓜色保护掩码：命中的像素强制判为前景，避免被模型误删。

    种子限定在 alpha > 16 内，即只对模型已判为前景的像素生效，
    本身不向轮廓外扩张一个像素。
    """
    r = arr[:, :, 0].astype(np.int16)
    g = arr[:, :, 1].astype(np.int16)
    b = arr[:, :, 2].astype(np.int16)
    # 肤色保护：覆盖偏粉 / 偏浅的肤色高光，避免手部阴影或浅色手指被模型低置信删除
    skin = (r > 150) & (g > 110) & (b > 70) & (r >= g) & (g >= b) & ((r - b) > 1)
    pumpkin = (r > 170) & (g > 110) & (b < 140) & ((r - b) > 70)
    return (skin | pumpkin) & (alpha > 16)


# 分离部件（头顶光环等）保留阈值。
# 光环：面积占全图 0.148%~0.266%、平均置信度 187~196；
# 噪点：面积占全图 ≤0.026%、平均置信度 ≤93。
# 两个闸门各留约 2 倍余量，稳定区分「小而可信的部件」与「噪点」。
PART_AREA_RATIO = 0.001   # 分离部件最小面积（占全图比例）
PART_MEAN_ALPHA = 150     # 分离部件最低平均置信度
# 部件内部背景清除——仅处理小部件，主体不动
# （主体内部近白像素多是白色裙边/眼白/高光，删了会把角色打穿；
#  主体 fg 连通后的内洞多达数百个）。
PART_MAX_RATIO = 0.01     # 部件面积上限（占全图），超过则不清


def refine_alpha(arr, alpha, protected):
    """一次连通域分析：决定保留哪些块，并清掉分离部件内部的背景。

    保留判据（命中任一即保留）：
      1) 面积最大的块 —— 主体
      2) 面积 > 主体 30% 且距画面中心 < 0.4h —— 与主体断开的大部件
      3) 面积 ≥ 全图 0.1% 且平均置信度 ≥ 150 —— 小而可信的分离部件（光环）

    第 3 条专为光环而设：它浮在头顶、与身体不相连，面积仅主体的 0.5%~0.7%，
    位置又在画面顶部（距中心约 0.47h > 0.4h），前两条判据都不满足，不加本条
    就会被当成噪声整块删除。面积用「占全图比例」而非绝对像素，兼顾
    1536×2048 / 1680×2240 / 1440×1920 多种源分辨率。

    光环是闭合环（实心椭圆盘 + 外圈描边），环内背景与外界不连通，连通域处理
    进不去，故对「保留下来的小部件」再做一次内部近背景清除。主体内部近白多为
    高光 / 白裙，动不得，所以清除只作用于小部件（面积 0.1%~1% 全图）。

    中心与均值只对候选块（大部件 / 小部件）计算，避免对全部连通块做全图归约。
    """
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

    main = labels[sizes == max_area]           # 主体（含同面积的并列块）
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


def flood_fill_from_edges(arr, alpha, protected=None):
    """删与四边连通的近背景像素（底边也发起）。

    scipy.ndimage.label 向量化实现，等价于逐像素 BFS 且快 10×+。
    """
    h, w = arr.shape[:2]
    if protected is None:
        protected = get_protected_mask(arr, alpha)
    bg_ref = arr[0, 0].astype(int)
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    dist = np.sqrt((r - bg_ref[0]) ** 2 + (g - bg_ref[1]) ** 2 + (b - bg_ref[2]) ** 2)
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


def clear_outer_border(alpha, px=BORDER_CLEAR_PX):
    """把最外 px 圈前景清零，就地修改 alpha。"""
    alpha[:px, :] = 0
    alpha[-px:, :] = 0
    alpha[:, :px] = 0
    alpha[:, -px:] = 0
