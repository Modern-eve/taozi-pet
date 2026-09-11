"""
CPU 抠白底（洪水填充算法）：assets-raw/ → taozi-pet/incoming-assets/（透明 PNG）

从四边发起洪水填充删除与边缘连通的近背景像素（底边也发起），叠加保护色
障碍物、主体连通块 + 可信分离部件（头顶光环）保留。输入格式、产物命名与
后处理实现见 preprocess_common.py。

GPU 版（preprocess-v7-gpu.py）为默认路径，本脚本仅作**应急兜底**。

用法:
  python preprocess-v7-cpu.py                    # 处理 assets-raw 全部帧
  python preprocess-v7-cpu.py walk-01.jpg       # 只处理指定文件
  python preprocess-v7-cpu.py --states walk sleep   # 只处理指定状态
"""
import os

import numpy as np
from PIL import Image

from preprocess_common import (
    OUTPUT_DIR,
    flood_fill_from_edges,
    get_protected_mask,
    job_list,
    refine_alpha,
    select_frames,
)


def process_image(input_path, output_path):
    """单帧：洪水填充删边缘近背景 → 保留主体与可信分离部件，写出透明 png。"""
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


def main():
    import argparse
    ap = argparse.ArgumentParser(description="CPU 抠图（应急兜底）：assets-raw → taozi-pet/incoming-assets（默认全量，--states 限定部分状态）")
    ap.add_argument('files', nargs='*', help='指定文件（默认处理 --states 全部）')
    ap.add_argument('--states', nargs='*', default=None,
                    help='只处理这些状态（默认处理全部状态）')
    args = ap.parse_args()
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    jobs = job_list(select_frames(args.files, args.states))
    success = 0
    for i, (fname, in_path, out_path) in enumerate(jobs):
        try:
            process_image(in_path, out_path)
            success += 1
            print(f'  [{i+1}/{len(jobs)}] {fname} OK')
        except Exception as e:
            print(f'  ERROR {fname}: {e}')
    print(f'Done: {success}/{len(jobs)} succeeded')


if __name__ == '__main__':
    main()
