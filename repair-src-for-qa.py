"""
repair-src-for-qa.py — 按 qa/assets-report.json 自动修复失败帧

读取 QA 报告，对每帧失败按 code 应用通用修复（不依赖硬编码帧名）：
  - SCALE_DRIFT (lockedBody)  : 把该状态各帧缩放到本状态中位 bbox（宽/高一致）
  - OCCUPANCY_TOO_LARGE       : 等比缩到 MAX_DIM
  - GROUND_RESIDUE[_REVIEW]   : 清掉角色最底 GROUND_ROWS 行
  - SUBJECT_TOUCHES_BORDER    : 带 MARGIN 重新居中
报告说坏修什么；无失败则无改动。

⚠️ 修复目标是**产物层** taozi-pet/src/assets/pet/，不是上游 incoming-assets/。
因此每次全量 `node tools/process-assets.mjs` 重跑都会覆盖掉此前的修复，
流程上需要在 process-assets 之后、qa-assets 之前重跑本脚本。

用法:
  python repair-src-for-qa.py
  python repair-src-for-qa.py --dry-run
  python repair-src-for-qa.py --report other.json --assets path/to/pet
"""
import os
import argparse
import json
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSET = os.path.join(ROOT, "taozi-pet", "src", "assets", "pet")
QA_DIR = os.path.join(ROOT, "taozi-pet", "qa")
MAX_DIM = 409          # OCCUPANCY_TOO_LARGE 阈值 412 之下的安全值
MARGIN = 8             # SUBJECT_TOUCHES_BORDER 重新居中的留白
GROUND_ROWS = 2        # GROUND_RESIDUE 清除的最底行数


def load_report(path):
    return json.load(open(path, encoding="utf-8"))


def bbox(arr):
    """返回 (top, bottom, left, right) 的透明前景包围盒；无前景返回 None。"""
    ys, xs = np.where(arr[:, :, 3] > 16)
    if len(ys) == 0:
        return None
    return ys.min(), ys.max(), xs.min(), xs.max()


def save(arr, path):
    Image.fromarray(arr).save(path)


def fix_scale_drift(records, assets_dir):
    """SCALE_DRIFT：把同状态各帧缩放到本状态中位 bbox（宽/高一致），
    保持各自中心 x 与底部 y，使帧间尺寸一致（满足 lockedBody ≤2.5%）。"""
    boxes = []
    for r in records:
        b = r.get("bounds")                      # 报告格式 [minX, minY, maxX, maxY]
        if not b:
            continue
        l, t, r_, btm = b
        boxes.append((r_ - l + 1, btm - t + 1))
    if not boxes:
        return
    mw = int(round(np.median([x[0] for x in boxes])))
    mh = int(round(np.median([x[1] for x in boxes])))
    for r in records:
        p = os.path.join(assets_dir, r["frame"])
        arr = np.array(Image.open(p).convert("RGBA"))
        t, btm, l, r_ = bbox(arr)
        if t is None:
            continue
        sub = Image.fromarray(arr).crop((l, t, r_ + 1, btm + 1)).resize((mw, mh), Image.LANCZOS)
        sa = np.array(sub)
        sa[:, :, 3] = (sa[:, :, 3] >= 128).astype(np.uint8) * 255   # 二值化边缘，避免半透明使 bbox 缩小
        canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
        cx = (l + r_) // 2
        bottom = btm
        px = int(round(cx - mw / 2))
        py = int(round(bottom - mh))
        canvas.paste(Image.fromarray(sa), (px, py), Image.fromarray(sa))
        save(np.array(canvas), p)
        print(f"  SCALE_DRIFT fix {r['frame']} -> {mw}x{mh}")


def fix_occupancy(path):
    arr = np.array(Image.open(path).convert("RGBA"))
    box = bbox(arr)
    if box is None:
        return False
    t, btm, l, r_ = box
    md = max(btm - t + 1, r_ - l + 1)
    if md <= MAX_DIM:
        return False
    cw, ch = r_ - l + 1, btm - t + 1
    f = MAX_DIM / md
    nw, nh = max(1, round(cw * f)), max(1, round(ch * f))
    sub = Image.fromarray(arr).crop((l, t, r_ + 1, btm + 1)).resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    cx = (l + r_) // 2
    px = int(round(cx - nw / 2))
    py = int(round(btm - nh))
    canvas.paste(sub, (px, py), sub)
    save(np.array(canvas), path)
    print(f"  OCCUPANCY fix {os.path.basename(path)} max_dim {md} -> {MAX_DIM}")
    return True


def fix_ground(path):
    arr = np.array(Image.open(path).convert("RGBA"))
    box = bbox(arr)
    if box is None:
        return
    t, btm, l, r_ = box
    if btm >= GROUND_ROWS:
        arr[btm - GROUND_ROWS + 1:btm + 1, :, 3] = 0
        save(arr, path)
        print(f"  GROUND fix {os.path.basename(path)} cleared bottom {GROUND_ROWS} row(s)")


def fix_border(path):
    arr = np.array(Image.open(path).convert("RGBA"))
    box = bbox(arr)
    if box is None:
        return
    t, btm, l, r_ = box
    w, h = arr.shape[:2]
    sub = Image.fromarray(arr).crop((l, t, r_ + 1, btm + 1))
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sw, sh = sub.size
    px = max(MARGIN, min(w - MARGIN - sw, (w - sw) // 2))
    py = max(MARGIN, min(h - MARGIN - sh, (h - sh) // 2))
    canvas.paste(sub, (px, py), sub)
    save(np.array(canvas), path)
    print(f"  BORDER fix {os.path.basename(path)} recentered")


def main():
    ap = argparse.ArgumentParser(description="按 QA 报告自动修复失败帧（通用）")
    ap.add_argument("--report", default=os.path.join(QA_DIR, "assets-report.json"))
    ap.add_argument("--assets", default=ASSET)
    ap.add_argument("--dry-run", action="store_true", help="只打印将执行的修复，不写文件")
    args = ap.parse_args()

    assets_dir = args.assets
    rep = load_report(args.report)

    # 按状态分组失败帧
    by_state = {}
    for a in rep.get("assets", []):
        if a.get("ok"):
            continue
        if not a.get("errors"):
            continue
        by_state.setdefault(a["state"], []).append(a)

    if not by_state:
        print("QA 报告无失败帧，无需修复。")
        return

    for state, recs in by_state.items():
        print(f"=== {state}: {len(recs)} 失败帧 ===")
        codes = {e.split("]")[0].strip("[") for r in recs for e in r.get("errors", [])}
        if "SCALE_DRIFT" in codes:
            if args.dry_run:
                print(f"  [dry-run] SCALE_DRIFT: 将把 {state} 各帧缩放到中位 bbox")
            else:
                fix_scale_drift(recs, assets_dir)
        for r in recs:
            p = os.path.join(assets_dir, r["frame"])
            for e in r.get("errors", []):
                code = e.split("]")[0].strip("[")
                if code == "OCCUPANCY_TOO_LARGE":
                    if args.dry_run:
                        print(f"  [dry-run] OCCUPANCY fix {r['frame']}")
                    else:
                        fix_occupancy(p)
                elif code in ("GROUND_RESIDUE", "GROUND_RESIDUE_REVIEW"):
                    if args.dry_run:
                        print(f"  [dry-run] GROUND fix {r['frame']}")
                    else:
                        fix_ground(p)
                elif code == "SUBJECT_TOUCHES_BORDER":
                    if args.dry_run:
                        print(f"  [dry-run] BORDER fix {r['frame']}")
                    else:
                        fix_border(p)
    if not args.dry_run:
        print("DONE: 已按 QA 报告修复。")


if __name__ == "__main__":
    main()
