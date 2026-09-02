#!/usr/bin/env python3
"""从 core-ip.png 的头部裁剪生成托盘图标。

与 process-assets.mjs 解耦：因为 core-ip.png 是角色母版源图，永远不会
变化，所以托盘图标可以独立于动画帧流水线更新，不用每次重跑全部素材。

默认裁剪区域对应 core-ip.png 头部+光环+肩部，可通过 --crop 覆盖。
缩放采用 alpha 预乘的 LANCZOS：先把 RGB 按 alpha 预乘（透明像素 RGB=0），
LANCZOS 缩放后再反预乘回 RGB。这样避免透明区域残留的浅色 RGB 在缩小
过程中被插值进角色边缘，形成黑斑/灰斑。

默认输出满画布（--inner = --size），不带内边距。
"""
import argparse
import os
import sys
from PIL import Image

DEFAULT_CORE = "core-ip.png"
DEFAULT_OUT = os.path.join("taozi-pet", "src", "assets", "tray", "tray-icon.png")


def parse_crop(value):
    parts = [int(v) for v in value.split(",")]
    if len(parts) != 4 or parts[0] >= parts[2] or parts[1] >= parts[3]:
        raise argparse.ArgumentTypeError("crop 必须是 x1,y1,x2,y2 且 x1<x2, y1<y2")
    return tuple(parts)


def default_crop(width, height):
    """头部+光环+肩部：水平居中取 1/2 宽、垂直取前 40%。"""
    return (
        int(width * 0.25),
        int(height * 0.03),
        int(width * 0.75),
        int(height * 0.40),
    )


def white_to_alpha(image, threshold=245):
    """将接近白色的像素转成透明，保留抗锯齿边缘。"""
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    pixels = image.load()
    w, h = image.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if r >= threshold and g >= threshold and b >= threshold:
                pixels[x, y] = (r, g, b, 0)
    return image


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
            elif a == 255:
                pass
            else:
                pixels[x, y] = (
                    min(255, r * 255 // a),
                    min(255, g * 255 // a),
                    min(255, b * 255 // a),
                    a,
                )
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", default=DEFAULT_CORE, help="源图路径（默认 core-ip.png）")
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"输出路径（默认 {DEFAULT_OUT}）")
    parser.add_argument("--crop", type=parse_crop, help="覆盖默认裁剪区域：x1,y1,x2,y2（原图坐标）")
    parser.add_argument("--size", type=int, default=32, help="输出画布边长（默认 32）")
    parser.add_argument(
        "--inner", type=int, default=None,
        help="内容区域边长（默认等于 --size，不留内边距；想留边距就传比 --size 小的值）",
    )
    parser.add_argument("--white-threshold", type=int, default=245, help="白→透明阈值（默认 245）")
    args = parser.parse_args()

    if not os.path.exists(args.core):
        print(f"ERROR: 源图不存在: {args.core}", file=sys.stderr)
        return 1

    inner = args.inner if args.inner is not None else args.size
    if inner > args.size:
        print(f"ERROR: --inner({inner}) 不能大于 --size({args.size})", file=sys.stderr)
        return 1

    src = Image.open(args.core)
    w, h = src.size
    crop = args.crop or default_crop(w, h)
    print(f"源图: {args.core} {src.size} {src.mode}")
    print(f"裁剪: x={crop[0]}..{crop[2]}  y={crop[1]}..{crop[3]}  ({crop[2]-crop[0]}x{crop[3]-crop[1]})")
    print(f"画布: {args.size}x{args.size}  内容: {inner}x{inner}  边距: {(args.size - inner) // 2}px")

    # 1) 白底转透明
    head = white_to_alpha(src, threshold=args.white_threshold).crop(crop)
    # 2) alpha 预乘（关键：避免缩放插值时把透明 RGB 混进边缘形成黑斑）
    head = premultiply_alpha(head)
    # 3) LANCZOS 缩放
    head = head.resize((inner, inner), Image.LANCZOS)
    # 4) 反预乘，恢复正确 RGB
    head = unpremultiply_alpha(head)

    canvas = Image.new("RGBA", (args.size, args.size), (0, 0, 0, 0))
    offset = (args.size - inner) // 2
    canvas.paste(head, (offset, offset), head)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    canvas.save(args.out, "PNG", optimize=True)
    size_bytes = os.path.getsize(args.out)
    print(f"输出: {args.out}  {canvas.size} RGBA  {size_bytes} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
