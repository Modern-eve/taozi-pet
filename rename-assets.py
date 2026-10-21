"""
rename-assets.py — assets-raw 帧整理（流水线第 1 步）：统一转 .jpg + 连续编号

格式契约（唯一职责）：
    <任意格式>  ──rename──▶  <state>-NN.jpg

源素材可能是 png/jpg/jpeg/webp/bmp 任意一种，扩展名未必等于真实格式
（按文件头魔数判定，不信任扩展名）。本脚本把它们统一收敛为
「<state>-01.jpg … <state>-NN.jpg」，再由 preprocess 统一产出透明 png。

做三件事：
  1. 转 jpg：真实格式非 jpg 者解码后存 JPEG（默认 q95、4:4:4 无子采样；
     subsampling=0 避免角色边缘色渗）。源为 jpg 时只改名不重编码（无损）。
     RGBA 源按 RGB 落盘（白底图无透明信息需保留）。
  2. 编号收拢：按帧号排序后重映射为连续整数，收拢数字缺口、把 x.5 过渡帧
     各自并入连续序列、消除文件名空格（" blink - 1 .png" → "blink-01.jpg"）。
     落盘分两阶段：先把所有需要改名的源搬到临时名，再统一落到目标名。
     x.5 过渡帧占一个序号后，其目标编号可能**大于**源编号（5.5 → 06），
     单阶段原地改名会覆盖尚未搬走的高编号源（06 → 07），导致真实帧被删。
  3. 去多余尾缀：文件名形如 <state>-NN-<尾缀>...（尾缀可含连字符/数字/点）统一收敛为
     <state>-NN（仅保留「前缀-帧号」两段），例如 look-01-extra-2.jpg → look-01.jpg。
     与编号收拢共用：尾缀帧按其帧号入桶，输出标准名即自动去掉尾缀（mtime 冲突裁决规则一致）。
  4. 补帧号：不带帧号的单帧文件（文件名恰为 <state>.<ext>，即无常规「-编号」段）
     视为首帧，补 01 → <state>-01.jpg，例如 core-ip.jpg → core-ip-01.jpg。
     若同帧号另有带号源（core-ip.jpg 与 core-ip-1.jpg 并存），一并入 01 桶按 mtime 裁决。

命名冲突（同帧号多源文件）：保留**源文件修改日期最新者**，落败者被覆盖，不报错中止。

默认只预览（dry-run），加 --apply 才真正落盘。
"""
import os
import re
import argparse

from python_env import ensure_env

DEFAULT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'

# 可识别的源格式（扩展名不可信，真实格式由文件头魔数判定）
IMG_EXTS = ('png', 'jpg', 'jpeg', 'webp', 'bmp')

# 统一出口格式：preprocess 只吃 jpg，输出恒为 png
TARGET_EXT = 'jpg'

FRAME_RE = re.compile(
    r'^(?P<prefix>.+)-(?P<num>\d+(?:\.\d+)?)\.(?P<ext>' + '|'.join(IMG_EXTS) + r')$',
    re.IGNORECASE,
)

# 去尾缀：<前缀>-<帧号>-<尾缀>...<ext>，尾缀可含连字符/数字/点，仅取「前缀-帧号」
FRAME_RE_TAIL = re.compile(
    r'^(?P<prefix>.+)-(?P<num>\d+(?:\.\d+)?)-.+\.(?P<ext>' + '|'.join(IMG_EXTS) + r')$',
    re.IGNORECASE,
)

# 补帧号：<前缀>.<ext>（整名无「-编号」段，即不带帧号）→ 视为首帧，补 01
BARE_RE = re.compile(
    r'^(?P<prefix>.+)\.(?P<ext>' + '|'.join(IMG_EXTS) + r')$',
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
    """返回 (items, tail_origins, bare_origins)。

    items: {帧号(float): [原始文件名, ...]}，匹配 <prefix>-<num>.<ext>、
           <prefix>-<num>-<尾缀>.<ext>（去尾缀）、或 <prefix>.<ext>（无帧号，补 01）。
    源导出文件名常带空格（" blink - 1 .png"），匹配前先去空格；
    同一帧号多文件（多格式/带尾缀并存）全部收集，冲突在 plan 阶段按 mtime 裁决。
    tail_origins: set，记录带尾缀的源文件名（供预览标注「去尾缀」）。
    bare_origins: set，记录不带帧号、补 01 的源文件名（供预览标注「补帧号」）。
    """
    items = {}
    tail_origins = set()
    bare_origins = set()
    for orig in names:
        base, ext = os.path.splitext(orig.strip())
        if not ext or ext[1:].lower() not in IMG_EXTS:
            continue
        cleaned = base.replace(' ', '') + ext.lower()
        m = FRAME_RE.match(cleaned)
        if not m:
            m = FRAME_RE_TAIL.match(cleaned)
            if m:
                tail_origins.add(orig.strip())
        if m:
            num = float(m.group('num'))
        else:
            # 整名恰为 <prefix>.<ext>（不带帧号）→ 视为首帧
            m = BARE_RE.match(cleaned)
            if not m:
                continue
            num = 1.0
            bare_origins.add(orig.strip())
        if m.group('prefix').lower() != prefix.lower():
            continue
        items.setdefault(num, []).append(orig.strip())
    return items, tail_origins, bare_origins


def plan(prefix, items, d):
    """计算 (converts, deletes)。

    converts: [(源名, 目标 jpg 名)] —— 每个连续编号 NN 从其同帧号源里选 mtime 最新者，
              真实格式非 jpg 者需转 jpg（源即 jpg 时仅改名）。
    deletes:  [文件名] —— 同帧号竞争中落败的文件（保留 mtime 最新者，其余覆盖）。
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

    分两阶段落盘：源文件先全部搬到临时名，再从临时名落到目标名。
    收拢只会前移编号的假设对 x.5 过渡帧不成立（5.5 的目标是 06，源编号更小），
    升序原地改名会让它覆盖尚未搬走的 jump-06 源，使真实帧被静默删除。
    """
    from PIL import Image
    if not apply:
        return
    # 先删落败候选
    for name in deletes:
        p = os.path.join(d, name)
        if os.path.exists(p):
            os.remove(p)
    # 先把每个要改名的源搬到临时名，腾空所有目标编号（避免 x.5 帧覆盖尚未搬走的高编号源）
    staged = []
    for i, (src, dst) in enumerate(converts):
        sp = os.path.join(d, src)
        if src.lower() == dst.lower():
            staged.append((sp, dst))
            continue
        tmp = os.path.join(d, f'.__rename_{i:03d}{os.path.splitext(src)[1].lower()}')
        os.rename(sp, tmp)
        staged.append((tmp, dst))
    # 再从临时名落到目标名（真 jpg 仅改名；其余解码后存 jpg）
    for sp, dst in staged:
        dp = os.path.join(d, dst)
        if sp.lower() == dp.lower():
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
    ensure_env(__file__, requires=('PIL',))
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
        items, tail_origins, bare_origins = collect(prefix, os.listdir(d))
        if not items:
            print(f"[{prefix}] {short} · 未找到该前缀的帧")
            continue
        converts, deletes = plan(prefix, items, d)
        print(f"[{prefix}] {short} · {len(items)} 帧")
        for src, dst in converts:
            tag = "保留" if src.lower() == dst.lower() else (
                "转 jpg" if real_ext(os.path.join(d, src)) != TARGET_EXT else "改名")
            if src in tail_origins:
                tag = "去尾缀" if tag == "保留" else f"去尾缀·{tag}"
            elif src in bare_origins:
                tag = "补帧号" if tag == "保留" else f"补帧号·{tag}"
            print(f"  · {src} → {dst}   [{tag}]")
        for name in deletes:
            if name in tail_origins:
                print(f"  · {name}   [去尾缀·覆盖删除（非最新）]")
            else:
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
