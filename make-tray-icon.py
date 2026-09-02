#!/usr/bin/env python3
"""从 core-ip.png 的头部裁剪生成托盘图标。

与 process-assets.mjs 解耦：因为 core-ip.png 是角色母版源图，永远不会
变化，所以托盘图标可以独立于动画帧流水线更新，不用每次重跑全部素材。

抠图策略：
- 不用全局"白→透明"阈值（会误抠角色内部的白色高光、裙摆、光环等），
  改用从裁剪区四角出发的 flood-fill：只有与边缘连通、颜色相近的背景
  区域才变透明，角色实体（包括内部浅色）保留，从而避免内部空洞。
- 缩放前先做 alpha 预乘（premultiply），LANCZOS 缩放后再反预乘，避免
  透明区域残留的浅色 RGB 被插值进角色边缘形成黑斑/灰斑。
- 默认按原图比例等比缩放到 32×32 画布内居中；不会为填满画布而压扁头像。
"""
import argparse
import os
import sys
from collections import deque
from PIL import Image

DEFAULT_CORE = "core-ip.png"
DEFAULT_OUT = os.path.join("taozi-pet", "src", "assets", "tray", "tray-icon.png")

# 默认只取头部+肩部区域（水平居中半宽、垂直 2%-30%），让脸在托盘里更完整。
DEFAULT_CROP_RATIO = (0.25, 0.02, 0.75, 0.30)


def parse_crop(value):
    parts = [int(v) for v in value.split(",")]
    if len(parts) != 4 or parts[0] >= parts[2] or parts[1] >= parts[3]:
        raise argparse.ArgumentTypeError("crop 必须是 x1,y1,x2,y2 且 x1<x2, y1<y2")
    return tuple(parts)


def default_crop(width, height):
    """基于源图尺寸返回默认头部裁剪区域（绝对像素坐标）。"""
    r = DEFAULT_CROP_RATIO
    return (
        int(width * r[0]),
        int(height * r[1]),
        int(width * r[2]),
        int(height * r[3]),
    )


def flood_fill_background(image, tol=12):
    """从图像四角 flood-fill，仅把与边缘连通的背景区域变透明。

    tol 是相邻像素的最大通道差；背景渐变通常差很小，而角色轮廓与背景
    的色差大，flood-fill 会自然停在角色边缘，不会进入角色实体内部。
    """
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    px = image.load()
    w, h = image.size

    visited = [[False] * w for _ in range(h)]
    is_bg = [[False] * w for _ in range(h)]
    q = deque()

    for sx, sy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if not visited[sy][sx]:
            visited[sy][sx] = True
            is_bg[sy][sx] = True
            q.append((sx, sy))

    while q:
        x, y = q.popleft()
        cr, cg, cb = px[x, y][:3]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx]:
                nr, ng, nb = px[nx, ny][:3]
                if max(abs(nr - cr), abs(ng - cg), abs(nb - cb)) <= tol:
                    visited[ny][nx] = True
                    is_bg[ny][nx] = True
                    q.append((nx, ny))
                else:
                    visited[ny][nx] = True

    for y in range(h):
        for x in range(w):
            if is_bg[y][x]:
                px[x, y] = (px[x, y][0], px[x, y][1], px[x, y][2], 0)
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
            elif a != 255:
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
        help="内容最大边长（默认等于 --size）。内容按原比例等比缩放，居中放置",
    )
    parser.add_argument("--bg-tol", type=int, default=12, help="flood-fill 背景容差（默认 12）")
    args = parser.parse_args()

    if not os.path.exists(args.core):
        print(f"ERROR: 源图不存在: {args.core}", file=sys.stderr)
        return 1

    inner = args.inner if args.inner is not None else args.size
    if inner > args.size:
        print(f"ERROR: --inner({inner}) 不能大于 --size({args.size})", file=sys.stderr)
        return 1

    src = Image.open(args.core).convert("RGBA")
    w, h = src.size
    crop = args.crop or default_crop(w, h)
    print(f"源图: {args.core} {src.size}")
    print(f"裁剪: x={crop[0]}..{crop[2]}  y={crop[1]}..{crop[3]}  ({crop[2]-crop[0]}x{crop[3]-crop[1]})")

    # 1) 裁出头部工作区
    head = src.crop(crop)
    # 2) flood-fill 只去外背景（保留角色内部浅色，避免空洞）
    head = flood_fill_background(head, tol=args.bg_tol)
    # 3) alpha 预乘（防缩放黑斑）
    head = premultiply_alpha(head)
    # 4) 等比缩放到 inner×inner 区域内
    head.thumbnail((inner, inner), Image.LANCZOS)
    # 5) 反预乘恢复 RGB
    head = unpremultiply_alpha(head)

    canvas = Image.new("RGBA", (args.size, args.size), (0, 0, 0, 0))
    offset = ((args.size - head.width) // 2, (args.size - head.height) // 2)
    canvas.paste(head, offset, head)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    canvas.save(args.out, "PNG", optimize=True)
    size_bytes = os.path.getsize(args.out)
    print(f"输出: {args.out}  {canvas.size} RGBA  内容{head.size}  边距{offset}  {size_bytes} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
