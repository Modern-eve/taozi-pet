"""
rename-assets.py — assets-raw 帧整理（流水线第 1 步）：统一转 .jpg + 连续编号

格式契约（唯一职责）：
    <任意格式>  ──rename──▶  <state>-NN.jpg

源素材可能是 png/jpg/jpeg/webp/bmp 任意一种，扩展名未必等于真实格式
（按文件头魔数判定，不信任扩展名）。本脚本把它们统一收敛为
「<state>-01.jpg … <state>-NN.jpg」，再由 preprocess 统一产出透明 png。

做两件事：
  1. 转 jpg：真实格式非 jpg 者解码后存 JPEG（默认 q95、4:4:4 无子采样；
     subsampling=0 避免角色边缘色渗）。源为 jpg 时只改名不重编码（无损）。
     RGBA 源按 RGB 落盘（白底图无透明信息需保留）。
  2. 编号收拢：按帧号排序后重映射为连续整数，收拢数字缺口、把 x.5 过渡帧
     各自并入连续序列、消除文件名空格（" blink - 1 .png" → "blink-01.jpg"）。
     落盘按**降序执行**（先写高编号），原地重编号时目标名若与未处理帧的源同名
     （如 look-03.5 的目标 look-04.jpg 恰是帧 4 的源），先腾走旧名再写入，不会覆盖真实帧。

命名冲突（同帧号多源文件）：按**源文件修改日期最新者**直接覆盖旧的
（不再送回收站、不再报错中止）。

默认只预览（dry-run），加 --apply 才真正落盘。
"""
import os
import re
import argparse

DEFAULT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'

# 可识别的源格式（扩展名不可信，真实格式由文件头魔数判定）
IMG_EXTS = ('png', 'jpg', 'jpeg', 'webp', 'bmp')

# 统一出口格式：preprocess 只吃 jpg，输出恒为 png
TARGET_EXT = 'jpg'

FRAME_RE = re.compile(
    r'^(?P<prefix>.+)-(?P<num>\d+(?:\.\d+)?)\.(?P<ext>' + '|'.join(IMG_EXTS) + r')$',
    re.IGNORECASE,
)


def real_ext(path):
    """读文件头魔数判定真实格式，返回 'png'/'jpg'/'webp'/'bmp'；识别不出返回 None。"""
    try:
        with open(path, 'rb') as fh:
            head = fh.read(12)
    except OSError:
        return None
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if head[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return 'webp'
    if head[:2] == b'BM':
        return 'bmp'
    return None


def collect(prefix, names):
    """返回 {帧号(float): [原始文件名, ...]}，只保留匹配 <prefix>-<num>.<ext> 的帧。

    源导出文件名常带空格（" blink - 1 .png"），匹配前先去空格；
    同一帧号多文件（多格式并存）全部收集，冲突在 plan 阶段按 mtime 裁决。
    """
    items = {}
    for orig in names:
        base, ext = os.path.splitext(orig.strip())
        if not ext or ext[1:].lower() not in IMG_EXTS:
            continue
        cleaned = base.replace(' ', '') + ext.lower()
        m = FRAME_RE.match(cleaned)
        if not m or m.group('prefix').lower() != prefix.lower():
            continue
        num = float(m.group('num'))
        items.setdefault(num, []).append(orig.strip())
    return items


def plan(prefix, items, d):
    """计算 (converts, deletes)。

    converts: [(源名, 目标 jpg 名)] —— 每个连续编号 NN 从其同帧号源里选 mtime 最新者，
              真实格式非 jpg 者需转 jpg（源即 jpg 时仅改名）。
    deletes:  [文件名] —— 同帧号竞争落败的旧文件（按 mtime 最新者直接覆盖）。
    """
    converts, deletes = [], []
    for i, num in enumerate(sorted(items)):
        dst = f"{prefix}-{i + 1:02d}.{TARGET_EXT}"
        # 候选只限该帧号自己的源文件；不把同名目标拉入裁决，
        # 否则 x.5 收拢的目标名恰与其它帧源同名时会误删真实帧。
        cands = list(items[num])
        best = max(cands, key=lambda n: os.path.getmtime(os.path.join(d, n)))
        for n in cands:
            if n != best:
                deletes.append(n)
        converts.append((best, dst))
    return converts, deletes


def do_convert(d, converts, deletes, quality, apply):
    """转 jpg + 覆盖冲突。默认 dry-run 不落盘。

    按**降序**执行（先写高编号）：原地重编号时目标名可能是未处理帧的旧名
    （如 look-03.5 → look-04.jpg，而 look-04.jpg 还是帧 4 的源），
    从高往低写可保证写目标前旧名已被腾走，永不覆盖尚未处理的源文件。
    """
    from PIL import Image
    if not apply:
        return
    # 先删落败候选
    for name in deletes:
        p = os.path.join(d, name)
        if os.path.exists(p):
            os.remove(p)
    # 再把每个 NN 的最新源落到目标（降序执行，避免目标名压到未处理帧的源）
    for src, dst in reversed(converts):
        sp, dp = os.path.join(d, src), os.path.join(d, dst)
        if src.lower() == dst.lower():
            continue  # 最新者已是目标名，无需改动
        if real_ext(sp) == TARGET_EXT:
            if os.path.exists(dp):
                os.remove(dp)
            os.rename(sp, dp)  # 真 jpg 仅改名（无损）
        else:
            with Image.open(sp) as img:
                img.convert('RGB').save(dp, 'JPEG', quality=quality,
                                       subsampling=0, optimize=True)
            os.remove(sp)


def main():
    ap = argparse.ArgumentParser(
        description=f"assets-raw 帧整理（流水线第 1 步）：统一转 {TARGET_EXT} + 连续编号")
    ap.add_argument("--dir", default=DEFAULT_DIR,
                    help="目标目录（默认 assets-raw；也可指向 incoming-assets 等）")
    ap.add_argument("--prefix", required=True, nargs='+',
                    help="状态前缀，如 walk / sleep / sad；可一次传多个")
    ap.add_argument("--quality", type=int, default=95,
                    help="转 jpg 的质量（1-95，默认 95；仅对非 jpg 源生效）")
    ap.add_argument("--apply", action="store_true",
                    help="真正执行；缺省只打印计划（dry-run）")
    args = ap.parse_args()
    if not 1 <= args.quality <= 95:
        print("错误：--quality 需在 1-95 之间")
        raise SystemExit(1)
    d = args.dir
    if not os.path.isdir(d):
        print(f"错误：目录不存在 {d}")
        raise SystemExit(1)
    short = os.path.basename(d.rstrip('/\\')) or d

    for prefix in args.prefix:
        items = collect(prefix, os.listdir(d))
        if not items:
            print(f"[{prefix}] {short} · 未找到该前缀的帧")
            continue
        converts, deletes = plan(prefix, items, d)
        print(f"[{prefix}] {short} · {len(items)} 帧")
        for src, dst in converts:
            tag = "保留" if src.lower() == dst.lower() else (
                "转 jpg" if real_ext(os.path.join(d, src)) != TARGET_EXT else "改名")
            print(f"  · {src} → {dst}   [{tag}]")
        for name in deletes:
            print(f"  · {name}   [覆盖删除（非最新）]")
        if not args.apply:
            continue
        do_convert(d, converts, deletes, args.quality, True)
        done = " · ".join(f"{k} {v}" for k, v in
                          (("转换", len(converts)), ("删除", len(deletes))) if v)
        if done:
            print(f"  ✓ {done}")
    if not args.apply:
        print("确认后加 --apply 执行")


if __name__ == "__main__":
    main()
