#!/usr/bin/env python3
"""从角色母版源图生成应用图形资源：托盘图标 + 页面状态头像。

抠图复用 preprocess-v7（BiRefNet GPU 推理，发丝/光环等细节更完整）。产物：
- 托盘图标：core-ip.jpg → taozi-pet/src/assets/tray/tray-icon.png（32×32）
- 页面状态头像（--dashboard，仅截头部特写，与托盘观感一致）：
    core-ip.jpg  → taozi-pet/src/renderer/dashboard/assets/avatar-ip.png    「正常」
    sad-ip.jpg   → taozi-pet/src/renderer/dashboard/assets/avatar-sad.png   「伤心」
    sleep-ip.jpg → taozi-pet/src/renderer/dashboard/assets/avatar-sleep.png 「睡眠」

头部裁剪后各自等比缩放、居中；只截头部/光环的取舍与整帧产线互不影响。
运行前提：与 preprocess-v7 相同的 torch/CUDA 环境（conda activate my_project）。

用法:
  python make-graphics.py               # 仅生成托盘图标
  python make-graphics.py --dashboard   # 同时生成托盘图标 + 三张页面状态头像
  python make-graphics.py --core 其他源图.jpg --out tray2.png --size 48   # 自定义托盘
"""
import argparse
import importlib.util
import os
import sys

import numpy as np
from PIL import Image

DEFAULT_CORE = "core-ip.jpg"
DEFAULT_OUT = os.path.join("taozi-pet", "src", "assets", "tray", "tray-icon.png")

# 托盘与头像默认头部裁剪：横向 34%-66%、纵向 6%-30%，比例接近正方形，脸更完整更撑满。
# 相对比例，对任意 3:4 全身立绘自动适配（源图分辨率不同也按比例重算）。
DEFAULT_CROP_RATIO = (0.34, 0.06, 0.66, 0.30)

# 页面状态头像专用裁剪：顶部上移到刚露出头顶光环（源图最上主体在约 1% 处，故取 1.2%）。
PORTRAIT_CROP_RATIO = (0.34, 0.012, 0.66, 0.30)

# 页面状态头像输出画布边长：DOM 以 64px 圆形显示，这里取 4x 保证高清
PORTRAIT_SIZE = 256

# 页面状态头像清单：key → (源图, 输出路径)。三张均为 3:4 全身立绘，头部相对位置一致，
# 共用 PORTRAIT_CROP_RATIO（刚露头顶光环）；个别姿势若头部偏移可单独覆盖 crop。
PORTRAITS = {
    "ip": ("core-ip.jpg", os.path.join("taozi-pet", "src", "renderer", "dashboard", "assets", "avatar-ip.png")),
    "sad": ("sad-ip.jpg", os.path.join("taozi-pet", "src", "renderer", "dashboard", "assets", "avatar-sad.png")),
    "sleep": ("sleep-ip.jpg", os.path.join("taozi-pet", "src", "renderer", "dashboard", "assets", "avatar-sleep.png")),
}


# ---- 复用 preprocess-v7 的抠图管线（文件名带空格与减号，用 importlib 加载）----
_PROCESSOR_CACHE = None


def load_preprocess():
    """按绝对路径加载 preprocess-v7（进程内只加载一次）。"""
    global _PROCESSOR_CACHE
    if _PROCESSOR_CACHE is not None:
        return _PROCESSOR_CACHE
    here = os.path.dirname(os.path.abspath(__file__)) or '.'
    path = os.path.join(here, 'preprocess-v7-gpu.py')
    spec = importlib.util.spec_from_file_location('preprocess_v7', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # 触发 torch / BiRefNet 依赖检查
    _PROCESSOR_CACHE = module
    return module


def cutout(rgba):
    """对一张头部特写抠图：BiRefNet 生成 alpha + 保护色 + 保留光环等分离部件。

    后处理复用 preprocess_common，保证与动画帧产线相同的抠图口径。
    """
    pv = load_preprocess()
    # BiRefNet 要求输入各边可被其 patch 网格整除；头部特写尺寸任意，
    # 先补齐到 32 的倍数再送模型，推理后截回原尺寸（与 preprocess 全帧的区别）。
    w0, h0 = rgba.size
    pw, ph = -(-w0 // 32) * 32, -(-h0 // 32) * 32
    padded = rgba if (pw, ph) == (w0, h0) else Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    if padded is not rgba:
        padded.paste(rgba, (0, 0))
    alpha_pad = pv.rmbg_alpha(padded)
    alpha = alpha_pad[:h0, :w0].copy()  # 截回原始头部尺寸

    arr = np.array(rgba)
    # 保护色：强制保留被保护的肤色/南瓜色像素
    protected = pv.get_protected_mask(arr, alpha)
    alpha[protected] = 255
    # 保留中心最大连通块 + 可信的分离部件（头顶光环），并清掉光环内部背景
    alpha = pv.refine_alpha(arr, alpha, protected)
    # 清理最边缘前景
    pv.clear_outer_border(alpha)
    img = rgba.copy()
    img.putalpha(Image.fromarray(np.clip(alpha, 0, 255).astype('uint8')))
    return img


def parse_crop(value):
    parts = [int(v) for v in value.split(",")]
    if len(parts) != 4 or parts[0] >= parts[2] or parts[1] >= parts[3]:
        raise argparse.ArgumentTypeError("crop 必须是 x1,y1,x2,y2 且 x1<x2, y1<y2")
    return tuple(parts)


def default_crop(width, height, ratio=DEFAULT_CROP_RATIO):
    """基于源图尺寸与裁剪比例返回裁剪区域（绝对像素坐标）。"""
    return (
        int(width * ratio[0]),
        int(height * ratio[1]),
        int(width * ratio[2]),
        int(height * ratio[3]),
    )


def premultiply_alpha(image):
    """RGBA 预乘：R' = R*A/255 等。透明像素 RGB 强制为 0，避免插值污染。"""
    pixels = image.load()
    w, h = image.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            pixels[x, y] = (r * a // 255, g * a // 255, b * a // 255, a)
    return image


def unpremultiply_alpha(image):
    """RGBA 反预乘：R = R' * 255 / A。A=0 保持 RGB=0。"""
    pixels = image.load()
    w, h = image.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a == 0:
                pixels[x, y] = (0, 0, 0, 0)
            elif a != 255:
                pixels[x, y] = (
                    min(255, r * 255 // a),
                    min(255, g * 255 // a),
                    min(255, b * 255 // a),
                    a,
                )
    return image


def render_icon(core_path, out_path, size, inner, crop, ratio):
    """对单张源图执行"头部裁剪 + preprocess 抠图 + 等比缩放 + 居中"并输出。

    crop 为绝对值覆盖（CLI --crop）时优先；否则按 ratio 比例裁剪。
    """
    if not os.path.exists(core_path):
        print(f"ERROR: 源图不存在: {core_path}", file=sys.stderr)
        return 1
    if inner is not None and inner > size:
        print(f"ERROR: --inner({inner}) 不能大于 --size({size})", file=sys.stderr)
        return 1

    src = Image.open(core_path).convert("RGBA")
    w, h = src.size
    crop_bounds = crop or default_crop(w, h, ratio)
    print(f"源图: {core_path} {src.size}")
    print(f"裁剪: x={crop_bounds[0]}..{crop_bounds[2]}  y={crop_bounds[1]}..{crop_bounds[3]}  "
          f"({crop_bounds[2]-crop_bounds[0]}x{crop_bounds[3]-crop_bounds[1]})")

    head = src.crop(crop_bounds)
    head = cutout(head)  # 抠图：复用 preprocess-v7（BiRefNet GPU）
    head = premultiply_alpha(head)
    head.thumbnail((inner, inner), Image.LANCZOS)
    head = unpremultiply_alpha(head)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = ((size - head.width) // 2, (size - head.height) // 2)
    canvas.paste(head, offset, head)

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    canvas.save(out_path, "PNG", optimize=True)
    print(f"输出: {out_path}  {canvas.size} RGBA  内容{head.size}  边距{offset}  "
          f"{os.path.getsize(out_path)} bytes")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", default=DEFAULT_CORE, help=f"托盘源图路径（默认 {DEFAULT_CORE}）")
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"托盘输出路径（默认 {DEFAULT_OUT}）")
    parser.add_argument("--crop", type=parse_crop, help="覆盖托盘默认裁剪区域：x1,y1,x2,y2（原图坐标）")
    parser.add_argument("--size", type=int, default=32, help="托盘输出画布边长（默认 32）")
    parser.add_argument(
        "--inner", type=int, default=None,
        help="托盘内容最大边长（默认等于 --size）。内容按原比例等比缩放，居中放置",
    )
    parser.add_argument(
        "--dashboard", action="store_true",
        help="同时更新页面状态头像（core/sad/sleep 三张头部特写，输出到 dashboard/assets）",
    )
    args = parser.parse_args()

    if args.dashboard:
        print("\n== 页面状态头像 ==")
        for key, (core, out_path) in PORTRAITS.items():
            print(f"-- [{key}] --")
            render_icon(core, out_path, PORTRAIT_SIZE, PORTRAIT_SIZE, None, PORTRAIT_CROP_RATIO)
        print()

    print("== 托盘图标 ==")
    inner = args.inner if args.inner is not None else args.size
    return render_icon(args.core, args.out, args.size, inner, args.crop, DEFAULT_CROP_RATIO)


if __name__ == "__main__":
    sys.exit(main())