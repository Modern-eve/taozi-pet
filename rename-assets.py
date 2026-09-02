"""
rename-assets.py — assets-raw 帧整理（流水线第 1 步）：格式归一 + 连续编号

新图丢进 assets-raw/ 之后、抠图之前先跑本脚本，把文件整理成
「<state>-01.png … <state>-NN.png」的连续 png 序列。

做两件事：
  1. 格式归一（--to-png）：把 jpg/jpeg/webp/bmp 转成 png。
     下游 preprocess-v7 -gpu.py / -cpu.py 的入口只认 .png（endswith('.png')），
     非 png 会被静默跳过，所以必须先转成 png。
     ⚠️ 若目标 png 已存在（如 sad-01.jpg 与 sad-01.png 并存），
     先把旧 png **送进回收站**再转换，不静默跳过、也不覆盖。
  2. 编号收拢：按帧号排序后重映射为连续整数，收拢数字缺口、
     并把 x.5 过渡帧并入连续序列。

默认只预览（dry-run），加 --apply 才真正落盘。

用法：
  python rename-assets.py --prefix notify                 # 预览编号计划（默认）
  python rename-assets.py --prefix notify --apply         # 执行编号收拢
  python rename-assets.py --prefix sad --to-png --apply   # 先转 png，再编号
  python rename-assets.py --prefix sad --to-png --keep-src --apply   # 转换后保留原文件
  python rename-assets.py --dir taozi-pet/incoming-assets --prefix walk --apply  # 换目录
"""
import os
import re
import argparse

DEFAULT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'

# 支持的图片扩展名（png 是流水线的目标格式，其余需先转换）
IMG_EXTS = ('png', 'jpg', 'jpeg', 'webp', 'bmp')

# 匹配 <prefix>-<数字[.数字]>.<ext>，如 sad-02.png / walk-02.5.jpg
FRAME_RE = re.compile(
    r'^(?P<prefix>.+)-(?P<num>\d+(?:\.\d+)?)\.(?P<ext>' + '|'.join(IMG_EXTS) + r')$',
    re.IGNORECASE,
)


def collect(prefix, names):
    """返回 {帧号(float): [文件名, ...]}，只保留匹配 <prefix>-<num>.<ext> 的帧。

    同一帧号可能同时存在多种格式（如 sad-01.jpg 与 sad-01.png），此时全部收集，
    由 plan_convert 决定取舍。
    """
    items = {}
    for n in names:
        m = FRAME_RE.match(n)
        if not m or m.group('prefix').lower() != prefix.lower():
            continue
        num = float(m.group('num'))
        items.setdefault(num, []).append(n)
    return items


def _png_names(names):
    return [n for n in names if n.lower().endswith('.png')]


def final_name_map(items):
    """计算「转换完成后」每个帧号对应的 png 文件名。

    已有 png → 直接用；只有其它格式 → 换成同名 .png（由 plan_convert 生成）。
    """
    return {
        num: (_png_names(names)[0] if _png_names(names)
              else os.path.splitext(names[0])[0] + '.png')
        for num, names in items.items()
    }


def plan_convert(items):
    """计算格式归一计划。

    返回 (converts, recycles)：
      converts: [(源名, 目标 png 名)] —— 非 png 转 png
      recycles: [文件名] —— 需先送回收站的文件：与目标 png 重名的旧 png，
                以及同一帧号下的冗余非 png 副本（否则转换后会覆盖新 png）
    """
    converts, recycles = [], []
    for num in sorted(items):
        names = items[num]
        pngs = _png_names(names)
        others = [n for n in names if not n.lower().endswith('.png')]
        if not others:
            continue
        src = others[0]
        dst = os.path.splitext(src)[0] + '.png'
        # 已存在同名 png（sd-01.jpg ↔ sad-01.png）→ 先回收旧 png，再转换
        recycles.extend(pngs)
        converts.append((src, dst))
        # 同一帧号的其余非 png 副本 → 一并回收
        recycles.extend(others[1:])
    return converts, recycles


def plan_rename(prefix, final_map):
    """对 {帧号: 转换后的 png 名} 计算重命名计划：排序后逐个重映射为连续整数。

    返回 ([(旧名, 新名)], [无需改名的文件名])。
    """
    nums = sorted(final_map)
    plan, unchanged = [], []
    for i, num in enumerate(nums):
        old = final_map[num]
        new = f"{prefix}-{i + 1:02d}.png"
        (plan if old != new else unchanged).append(
            (old, new) if old != new else old
        )
    return plan, unchanged


# ---------- 回收站（Windows SHFileOperationW + FOF_ALLOWUNDO） ----------
FO_DELETE = 3
FOF_SILENT = 0x0004
FOF_NOCONFIRMATION = 0x0010
FOF_ALLOWUNDO = 0x0040
FOF_NOERRORUI = 0x0400


def send_to_recycle_bin(path):
    """把文件移到回收站（可恢复）。非 Windows 平台退化为直接删除。"""
    path = os.path.abspath(path)
    if os.name != 'nt':
        os.remove(path)
        return
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_uint16),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", wintypes.LPVOID),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = path + "\0\0"  # 双 null 结尾的路径串
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    res = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if res != 0:
        raise OSError(f"移到回收站失败 (SHFileOperationW={res}): {path}")


def do_convert(d, converts, recycles, keep_src):
    """执行格式归一：先回收冲突文件，再把非 png 转成 png（白底源图统一存 RGB）。"""
    from PIL import Image
    for name in recycles:
        send_to_recycle_bin(os.path.join(d, name))
        print(f"  [recycle] {name}   (已移入回收站，可恢复)")
    for src, dst in converts:
        sp, dp = os.path.join(d, src), os.path.join(d, dst)
        with Image.open(sp) as img:
            img.convert('RGB').save(dp, 'PNG')
        if not keep_src:
            send_to_recycle_bin(sp)
        print(f"  [convert] {src} -> {dst}" + ("" if keep_src else "  (原文件已移入回收站)"))


def do_rename(d, plan):
    """两阶段改名避免冲突：先全部改成临时名，再落终名。"""
    tmp = {}
    for i, (old, _new) in enumerate(plan):
        t = f".__rn_tmp__{i}.png"
        os.rename(os.path.join(d, old), os.path.join(d, t))
        tmp[old] = t
    for old, new in plan:
        os.rename(os.path.join(d, tmp[old]), os.path.join(d, new))
        print(f"  [rename ] {old} -> {new}")


def main():
    ap = argparse.ArgumentParser(
        description="assets-raw 帧整理（流水线第 1 步）：格式归一 + 连续编号")
    ap.add_argument("--dir", default=DEFAULT_DIR,
                    help=f"目标目录（默认 assets-raw；也可指向 incoming-assets 等）")
    ap.add_argument("--prefix", required=True, nargs='+',
                    help="状态前缀，如 walk / sleep / sad；可一次传多个")
    ap.add_argument("--to-png", action="store_true",
                    help="把 jpg/jpeg/webp/bmp 转成 png（下游抠图脚本只认 .png）")
    ap.add_argument("--keep-src", action="store_true",
                    help="配合 --to-png：转换后保留原文件（默认删除）")
    ap.add_argument("--apply", action="store_true",
                    help="真正执行；缺省只打印计划（dry-run）")
    args = ap.parse_args()

    d = args.dir
    if not os.path.isdir(d):
        print(f"错误：目录不存在 {d}")
        raise SystemExit(1)

    mode = "DRY-RUN 不执行" if not args.apply else "将执行"
    total_conv = total_ren = 0

    for prefix in args.prefix:
        items = collect(prefix, os.listdir(d))
        if not items:
            print(f"\n[{prefix}] {d}: 未找到该前缀的帧")
            continue

        conv_plan, recycles = plan_convert(items) if args.to_png else ([], [])
        final_map = final_name_map(items)
        ren_plan, unchanged = plan_rename(prefix, final_map)

        print(f"\n[{prefix}] {d}: {len(items)} 帧，"
              f"回收 {len(recycles)} / 转换 {len(conv_plan)} 处 / 改名 {len(ren_plan)} 处 / "
              f"无需改动 {len(unchanged)} 处（{mode}）")

        for name in recycles:
            print(f"  recycle  {name}  -> 回收站（可恢复）")
        for src, dst in conv_plan:
            print(f"  convert  {src}  ->  {dst}")
        for old, new in ren_plan:
            print(f"  rename   {old}  ->  {new}")
        if not conv_plan and not ren_plan and not recycles:
            print(f"  {prefix} 已是连续的 png 序列，无需改动")

        # 校验：改名目标是否被本次计划之外的文件占用（将被回收的不算占用）
        sources = {old for old, _ in ren_plan}
        for _old, new in ren_plan:
            dst = os.path.join(d, new)
            if os.path.exists(dst) and new not in sources and new not in recycles:
                print(f"\n错误：目标名 {new} 已被占用且不在本次改名范围内，中止。"
                      f"（请手工处理该文件或改用其它前缀）")
                raise SystemExit(1)

        if not args.apply:
            continue

        if conv_plan or recycles:
            do_convert(d, conv_plan, recycles, args.keep_src)
        if ren_plan:
            do_rename(d, ren_plan)
        total_conv += len(conv_plan)
        total_ren += len(ren_plan)
        print(f"  DONE: {prefix} 转换 {len(conv_plan)} / 改名 {len(ren_plan)}")

    if not args.apply:
        print("\n确认无误后加 --apply 真正执行。")
    else:
        print(f"\nDONE: 共转换 {total_conv} 张、改名 {total_ren} 张")


if __name__ == "__main__":
    main()
