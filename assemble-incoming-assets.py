"""
assemble-incoming-assets.py — 组装 + 归一化 taozi-pet/incoming-assets

读取 preprocess 写入的透明帧，按 pet-spec.json 的 frames 逐状态原地归一化
（按 sourceOccupancy 缩放 + 居中 + 底部对齐到 sourceCanvas）。
全部 12 状态都做**有界非等比缩放**：以状态内中位数帧为参考，
每帧先按占用率算统一因子 su，再分别把 sx、sy 限定在 su*(1±cap) 内：
  - lockedBody（idle/blink）cap=0.025，满足 qa 逐轴 ≤2.5%
  - 其余状态 cap=0.035，保证面积漂移 <7%（qa 限 8%）
这样既吸收 GPU 抠图带来的帧间尺寸抖动，又不会因非等比过度而压扁/拉长。

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

# 全部状态原地归一化；lockedBody 用于决定非等比边界 cap。
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


def render_matted(src_name, ref_size, locked, cap):
    """从 incoming 读透明帧，裁 bbox(+PAD)，按有界非等比缩放并居中+底部对齐到统一画布，原地写回。
    - ref_size=(W_ref,H_ref)：状态内中位数帧的缩放后尺寸。
    - locked：是否 lockedBody（idle/blink），直接对齐到参考尺寸。
    - cap：非 locked 状态下 sx/sy 相对 su（统一因子）的最大偏差。
    """
    arr = np.array(Image.open(os.path.join(INC, src_name + ".png")).convert("RGBA"))
    t, btm, l, r = subject_bbox(arr)
    t = max(0, t - PAD)
    btm = min(arr.shape[0] - 1, btm + PAD)
    l = max(0, l - PAD)
    r = min(arr.shape[1] - 1, r + PAD)
    h = btm - t + 1
    w = r - l + 1

    W_ref, H_ref = ref_size
    sx = W_ref / w
    sy = H_ref / h
    if locked:
        # lockedBody（idle/blink）：姿势近同，直接对齐到参考尺寸，把逐轴漂移压到最低。
        pass
    else:
        # 其余状态：有界非等比，每轴相对统一因子 su 的偏差不超过 cap，避免过度压扁/拉长。
        su = (sx * sy) ** 0.5
        lo = su / (1 + cap)
        hi = su * (1 + cap)
        sx = max(lo, min(hi, sx))
        sy = max(lo, min(hi, sy))
    nw2 = max(1, round(w * sx))
    nh2 = max(1, round(h * sy))

    # 最终 fit：确保缩放后的主体不会顶到画布边缘，避免 process-assets 的 SUBJECT_TOUCHES_BORDER。
    fit = min((CANVAS - 2 * MARGIN) / max(nw2, nh2), 1.0)
    nw2 = max(1, round(nw2 * fit))
    nh2 = max(1, round(nh2 * fit))

    sub = Image.fromarray(arr).crop((l, t, r + 1, btm + 1)).resize((nw2, nh2), Image.LANCZOS)
    cv = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    px, py = (CANVAS - nw2) // 2, CANVAS - MARGIN - nh2
    cv.paste(sub, (px, py), sub)
    return cv


def build_state(state, frames):
    """处理单个状态：先算中位数参考尺寸，再逐帧做有界非等比归一化写回。"""
    locked = state in LOCKED_BODY_STATES
    cap = 0.025 if locked else 0.035

    # 1) 计算状态内中位数参考尺寸
    sizes = []
    for fr in frames:
        arr = np.array(Image.open(os.path.join(INC, fr[:-4] + ".png")).convert("RGBA"))
        t, btm, l, r = subject_bbox(arr)
        t = max(0, t - PAD); btm = min(arr.shape[0] - 1, btm + PAD)
        l = max(0, l - PAD); r = min(arr.shape[1] - 1, r + PAD)
        sizes.append(_target_size(r - l + 1, btm - t + 1))
    sizes.sort(key=lambda s: s[0] * s[1])
    ref_size = sizes[len(sizes) // 2]

    done = 0
    for fr in frames:
        dst = os.path.join(INC, fr)
        if not os.path.exists(dst):
            raise RuntimeError(f"帧缺失：{dst}（请先运行 preprocess 把透明帧写入 incoming）")
        render_normalized(fr[:-4], ref_size, locked, cap).save(dst)
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
        tag = "locked" if state in LOCKED_BODY_STATES else "free"
        print(f"=== {state} ({tag}, {len(frames)} 帧) ===")
        total += build_state(state, frames)
    print(f"\nDONE: {total} 帧写入 {INC}（画布 {CANVAS}，占用率 {TARGET_OCC}，margin {MARGIN}，pad {PAD}；"
          f"全部状态有界非等比缩放，lockedBody={LOCKED_BODY_STATES} cap=0.025，其余 cap=0.035）")


if __name__ == "__main__":
    main()
