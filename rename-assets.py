"""
rename-assets.py — 按套子桌宠重命名规则批量重命名帧

单一职责（通用）：
  把 assets-raw / taozi-pet/incoming-assets / src/assets/pet 任一目录中的
  帧文件按既定规则统一重命名，保证帧名连续、无数字缺口、无 `.5` 过渡后缀（或反向合并）。

规则（源自 walk/sleep/sad 的最终指令）：
  - 数字缺口顺移：帧号出现缺口时，比缺口大的命名整体 -1 直至无缺口（保持顺序、不留空洞）。
  - 小数点过渡帧：有 x.5 → 保留 +0.5（作为独立过渡帧），其后顺势 +1，使全部帧连成连续整数序列。
  - 目标：目录内某前缀的帧名收拢为连续整数（walk-01..12、sleep-01..10、sad-01..12）。

默认**只预览**（--dry-run）；确认无误后去掉 --dry-run 才真正改名。
注意：只处理单个目录内的同名文件，不做跨目录同步；若需同步到其他目录，请对每个目录分别跑。

用法：
  python rename-assets.py --dir taozi-pet/incoming-assets --prefix walk
  python rename-assets.py --dir assets-raw --prefix sad
  python rename-assets.py --dir taozi-pet/incoming-assets --prefix sleep --apply   # 真正执行
  python rename-assets.py --dir taozi-pet/incoming-assets --prefix walk --apply
"""
import os
import re
import argparse

# 匹配 <prefix>-<数字[.数字]>.png，如 walk-02.png / walk-02.5.png
FRAME_RE = re.compile(r'^(.+)-(\d+(?:\.\d+)?)\.png$')


def collect(prefix, names):
    """返回 {帧号: 文件名}，只保留匹配 <prefix>-<num>.png 的帧；忽略 -r2 等其他后缀。"""
    items = {}
    for n in names:
        m = FRAME_RE.match(n)
        if not m or m.group(1) != prefix:
            continue
        num = float(m.group(2))
        # 忽略整数（不带小数）？不：整数是主体，要参与排序
        items[num] = n
    return items


def plan_rename(items):
    """对 {帧号: 文件名} 计算重命名计划：把帧号排序，逐个重映射为连续整数（先取整）。
    返回 [(旧名, 新名)]，新名 = <prefix>-<连续整数>.png。"""
    nums = sorted(items.keys())
    if not nums:
        return []
    prefix = next(iter(FRAME_RE.match(items[n]).group(1) for n in nums))
    # 连续整数重映射：第 i 个（从0计）→ 帧号 i+1
    plan = []
    for i, old_num in enumerate(nums):
        new_num = i + 1
        if new_num == old_num:
            continue  # 无需改名
        new_name = f"{prefix}-{new_num:02d}.png"
        plan.append((items[old_num], new_name))
    return plan


def main():
    ap = argparse.ArgumentParser(description="按套子桌宠重命名规则批量重命名帧（通用）")
    ap.add_argument("--dir", required=True, help="目标目录（assets-raw / taozi-pet/incoming-assets / src/assets/pet 等）")
    ap.add_argument("--prefix", required=True, help="状态前缀，如 walk / sleep / sad")
    ap.add_argument("--apply", action="store_true", help="真正执行改名；缺省只打印计划（dry-run）")
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print(f"错误：目录不存在 {args.dir}")
        raise SystemExit(1)

    items = collect(args.prefix, os.listdir(args.dir))
    if not items:
        print(f"{args.dir}: 未找到前缀 '{args.prefix}' 的帧")
        return
    plan = plan_rename(items)
    if not plan:
        print(f"{args.dir}: {args.prefix} 帧号已连续，无需改名")
        return

    print(f"{args.dir}: {args.prefix} 计划 {len(plan)} 处改名（{'DRY-RUN 不执行' if not args.apply else '将执行'}）:")
    for old, new in plan:
        print(f"  {old}  ->  {new}")

    if not args.apply:
        print("\n确认无误后加 --apply 真正执行。")
        return

    # 两阶段改名避免冲突：先全部改成临时名，再落终名
    tmp = {old: f".__rn_tmp__{i}.png" for i, (old, _) in enumerate(plan)}
    for old, t in tmp.items():
        os.rename(os.path.join(args.dir, old), os.path.join(args.dir, t))
    for (old, new), t in zip(plan, [tmp[o] for o, _ in plan]):
        os.rename(os.path.join(args.dir, t), os.path.join(args.dir, new))
    print(f"DONE: {args.prefix} 已改名 {len(plan)} 帧")


if __name__ == "__main__":
    main()
