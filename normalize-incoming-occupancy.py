"""
normalize-incoming-occupancy.py — 统一 incoming-assets 中指定状态的角色占用率与摆放

单一职责（通用）：
  把每个状态的角色缩放到目标面积（TARGET_OCC × CANVAS²），居中 + 底部对齐到
  统一透明画布（CANVAS，留 MARGIN），避免 process-assets 的 NORMALIZATION_TOO_LARGE
  与 SUBJECT_TOUCHES_BORDER，并使同状态帧间尺寸一致（利于 lockedBody 通过）。

  normalize_state(state, target_occ, canvas, margin) 为纯函数，可对任意状态调用。
  默认处理项目预设状态（walk/peek/sleep/sad）；传 --states all 处理全部。

用法：
  python normalize-incoming-occupancy.py
  python normalize-incoming-occupancy.py --states all
  python normalize-incoming-occupancy.py --states walk --target-occ 0.60
"""
import os
import argparse
import numpy as np
from PIL import Image

INC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "taozi-pet", "incoming-assets")
CANVAS = 1280
MARGIN = 48
TARGET_OCC = 0.62                                  # 与各状态(如 walk 0.60)一致，避免源图过小
# 项目预设：需占用率归一化的状态（即已上 GPU 的状态）。
# 注意 idle/blink 为 lockedBody，其已提交的 CPU 帧天然满足 ≤2.5% 宽高一致性；
# 一旦归一化反而会触发 SCALE_DRIFT，故此处故意不含 idle/blink。
DEFAULT_STATES = ["walk", "peek", "sleep", "sad"]


def subject_bbox(arr):
    ys, xs = np.where(arr[:, :, 3] > 16)
    if len(ys) == 0:
        raise RuntimeError("frame has no foreground")
    return ys.min(), ys.max(), xs.min(), xs.max()


def normalize_state(state, target_occ, canvas, margin):
    """把该状态所有基础帧统一到目标占用率并居中+底部对齐，就地写回 incoming-assets。"""
    bases = sorted(f for f in os.listdir(INC)
                   if f.startswith(state + "-") and f.endswith(".png"))
    if not bases:
        print(f"{state}: 无帧，跳过")
        return
    infos = []
    for b in bases:
        arr = np.array(Image.open(os.path.join(INC, b)).convert("RGBA"))
        t, btm, l, r = subject_bbox(arr)
        infos.append((b, arr, t, btm, l, r, btm - t + 1, r - l + 1))
    target_area = target_occ * canvas * canvas
    # 第一遍：按目标面积缩放，记录尺寸
    scaled = []
    max_dim = 1
    for (name, arr, t, btm, l, r, h, w) in infos:
        factor = (target_area / (w * h)) ** 0.5
        nw, nh = max(1, round(w * factor)), max(1, round(h * factor))
        scaled.append((name, arr, t, btm, l, r, nw, nh))
        max_dim = max(max_dim, nw, nh)
    # 统一 fit 缩放（仅过大状态生效，防止贴边）
    fit = min((canvas - 2 * margin) / max_dim, 1.0)
    for (name, arr, t, btm, l, r, nw, nh) in scaled:
        nw2, nh2 = max(1, round(nw * fit)), max(1, round(nh * fit))
        sub = Image.fromarray(arr).crop((l, t, r + 1, btm + 1)).resize((nw2, nh2), Image.LANCZOS)
        cv = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        px, py = (canvas - nw2) // 2, canvas - margin - nh2
        cv.paste(sub, (px, py), sub)
        cv.save(os.path.join(INC, name))
    median_area = sorted(nw * nh for (_, _, _, _, _, _, nw, nh) in scaled)[len(scaled) // 2]
    occ = median_area / (canvas * canvas)
    print(f"{state}: 目标占用率->{target_occ} fitScale={fit:.3f} 实际中位占用≈{occ:.3f} (画布 {canvas})")


def _all_state_prefixes():
    prefixes = set()
    for f in os.listdir(INC):
        if f.endswith(".png") and "-" in f:
            prefixes.add(f.rsplit("-", 1)[0])
    return sorted(prefixes)


def main():
    ap = argparse.ArgumentParser(description="归一化 incoming-assets 角色占用率（通用）")
    ap.add_argument("--states", nargs="*", default=DEFAULT_STATES,
                    help=f"目标状态（默认 {DEFAULT_STATES}）；传 'all' 处理全部")
    ap.add_argument("--target-occ", type=float, default=TARGET_OCC)
    ap.add_argument("--canvas", type=int, default=CANVAS)
    ap.add_argument("--margin", type=int, default=MARGIN)
    args = ap.parse_args()

    states = _all_state_prefixes() if args.states == ["all"] else args.states
    for s in states:
        normalize_state(s, args.target_occ, args.canvas, args.margin)


if __name__ == "__main__":
    main()
