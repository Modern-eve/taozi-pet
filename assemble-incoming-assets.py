"""
assemble-incoming-assets.py — 组装 + 归一化 taozi-pet/incoming-assets

读取 preprocess 写入的透明帧，按 pet-spec.json 的 frames 逐状态原地归一化
（按 sourceOccupancy 缩放 + 居中 + 底部对齐到 sourceCanvas）。
全部 12 状态都处理；其中 idle/blink 为 lockedBody，额外做帧间尺寸对齐
（首帧尺寸为参考，非等比），消除 qa 的 SCALE_DRIFT（≤2.5% 宽高漂移）。

阈值唯一权威来自 pet-spec.json 的 assetPipeline.source*，与 process-assets.mjs / qa-assets.mjs 共用。

用法：
  python assemble-incoming-assets.py
  python assemble-incoming-assets.py --states idle blink
"""
import os
import argparse
import json
import shutil
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
INC = os.path.join(ROOT, "taozi-pet", "incoming-assets")            # 透明帧源 + 归一化输出（原地）
SPEC = os.path.join(ROOT, "taozi-pet", "pet-spec.json")             # 帧清单权威来源

# 阈值唯一权威来自 pet-spec.json assetPipeline（与 process-assets.mjs / qa-assets.mjs 共用）
_pipeline = json.load(open(SPEC, encoding="utf-8")).get("assetPipeline", {})
CANVAS = _pipeline.get("sourceCanvas", 1280)                        # 统一透明画布边长
MARGIN = _pipeline.get("sourceMargin", 48)                          # 画布边缘留白（防贴边）
TARGET_OCC = _pipeline.get("sourceOccupancy", 0.62)                 # 目标占用率（面积占比）
PAD = _pipeline.get("sourcePad", 4)                                 # bbox 外扩留白

# 全部状态原地归一化；lockedBody 状态(idle/blink) 额外做帧间尺寸对齐消除 SCALE_DRIFT。
LOCKED_BODY_STATES = ["idle", "blink"]


def load_states():
    """返回 {state_id: [去重后的帧文件名, 如 'idle-01.png']}，顺序按文件名。"""
    spec = json.load(open(SPEC, encoding="utf-8"))
    out = {}
    for st in spec["states"]:
        frames = sorted({f for f in st["frames"] if f.endswith(".png")})
        out[st["id"]] = frames
    return out


def subject_bbox(arr):
    """返回 (top, bottom, left, right) 的透明前景包围盒；无前景则抛错。"""
    ys, xs = np.where(arr[:, :, 3] > 16)
    if len(ys) == 0:
        raise RuntimeError("frame has no foreground")
    return ys.min(), ys.max(), xs.min(), xs.max()


def _target_size(w, h):
    """按目标占用率（面积）计算缩放后尺寸，必要时 fit 防贴边。"""
    factor = (TARGET_OCC * CANVAS * CANVAS / (w * h)) ** 0.5
    nw = max(1, round(w * factor))
    nh = max(1, round(h * factor))
    fit = min((CANVAS - 2 * MARGIN) / max(nw, nh), 1.0)
    return max(1, round(nw * fit)), max(1, round(nh * fit))


def render_matted(src_name, lock_size=None):
    """从 incoming 读透明帧，裁 bbox(+PAD)，缩放并居中+底部对齐到统一画布，原地写回。
    lock_size 为 None 时按占用率缩放；为 (w,h) 时强制该宽高（非等比），用于 lockedBody 帧间对齐。"""
    arr = np.array(Image.open(os.path.join(INC, src_name + ".png")).convert("RGBA"))
    t, btm, l, r = subject_bbox(arr)
    t = max(0, t - PAD)
    btm = min(arr.shape[0] - 1, btm + PAD)
    l = max(0, l - PAD)
    r = min(arr.shape[1] - 1, r + PAD)
    h = btm - t + 1
    w = r - l + 1
    if lock_size is not None:
        nw2, nh2 = lock_size          # 帧间尺寸对齐：强制参考宽高（非等比）
    else:
        nw2, nh2 = _target_size(w, h)  # 按占用率缩放
    sub = Image.fromarray(arr).crop((l, t, r + 1, btm + 1)).resize((nw2, nh2), Image.LANCZOS)
    cv = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    px, py = (CANVAS - nw2) // 2, CANVAS - MARGIN - nh2
    cv.paste(sub, (px, py), sub)
    return cv


def build_state(state, frames):
    """处理单个状态：每帧从 incoming 读透明帧并原地归一化写回。lockedBody 用首帧尺寸做帧间对齐。"""
    # 全状态帧间尺寸对齐（下流吸收 GPU 抠图各帧尺寸抖动，不动 QA 阈值/不回退 CPU）：
    # 以状态内“中位数帧”缩放后尺寸为参考，强制每帧对齐到该 (宽,高)（非等比）。
    # 用中位数而非首帧，可把最大拉伸/压缩幅度降到最低。
    lock_size = None
    if frames:
        sizes = []
        for fr in frames:
            arr0 = np.array(Image.open(os.path.join(INC, fr[:-4] + ".png")).convert("RGBA"))
            t0, b0, l0, r0 = subject_bbox(arr0)
            t0 = max(0, t0 - PAD); b0 = min(arr0.shape[0] - 1, b0 + PAD)
            l0 = max(0, l0 - PAD); r0 = min(arr0.shape[1] - 1, r0 + PAD)
            sizes.append(_target_size(r0 - l0 + 1, b0 - t0 + 1))
        sizes.sort(key=lambda s: s[0] * s[1])
        lock_size = sizes[len(sizes) // 2]
    done = 0
    for fr in frames:
        dst = os.path.join(INC, fr)
        if not os.path.exists(dst):
            raise RuntimeError(f"帧缺失：{dst}（请先运行 preprocess 把透明帧写入 incoming）")
        render_matted(fr[:-4], lock_size=lock_size).save(dst)
        done += 1
        print(f"  norm   {fr}")
    return done


def main():
    ap = argparse.ArgumentParser(description="组装+归一化 incoming-assets（通用、数据驱动，全部状态）")
    ap.add_argument("--states", nargs="*", default=None,
                    help="只处理这些状态（默认全部 12 状态）")
    args = ap.parse_args()

    states = load_states()
    if args.states:
        wanted = set(args.states)
        states = {k: v for k, v in states.items() if k in wanted}

    total = 0
    for state, frames in states.items():
        tag = "locked" if state in LOCKED_BODY_STATES else "occ"
        print(f"=== {state} ({tag}, {len(frames)} 帧) ===")
        total += build_state(state, frames)
    print(f"\nDONE: {total} 帧写入 {INC}（画布 {CANVAS}，占用率 {TARGET_OCC}，margin {MARGIN}，pad {PAD}；"
          f"lockedBody={LOCKED_BODY_STATES} 走帧间对齐）")


if __name__ == "__main__":
    main()
