"""
assemble-incoming-assets.py — 组装 + 归一化 taozi-pet/incoming-assets

合并自原 assemble-incoming-assets.py 与 normalize-incoming-occupancy.py：
  把「已抠透明底的素材」整理为 process-assets 所需的 incoming-assets，
  并在同一遍内完成占用率归一化（居中 + 底部对齐到统一画布）。

对每个状态、每帧：
  - 若该状态在 --matted-states 且 assets-processed 有对应帧
      → 渲染：裁 bbox(+PAD) → 按目标占用率缩放 → 居中+底部对齐到 sourceCanvas 画布
  - 否则 → 从 incoming-assets 原样复制（保留既有结果，例如仍用 CPU 抠图的 8 个状态）

归一化统一采用「面积占用率」方式（原 normalize 逻辑）；原 assemble 的「参考角色高
对齐」实现已丢弃，不再保留为校验——下游 process-assets.mjs 自带 NORMALIZATION_TOO_LARGE
质量门禁，无需第二套对齐实现。

帧清单由各状态在 pet-spec.json 的 frames 推导（去重，因双播会重复引用同一文件）。
阈值唯一权威来自 pet-spec.json assetPipeline（sourceCanvas/sourceMargin/sourceOccupancy/sourcePad），
与 process-assets.mjs / qa-assets.mjs 共用，避免漂移。

输入：assets-processed/(透明抠图) + taozi-pet/incoming-assets/(既有)
输出：taozi-pet/incoming-assets/(整合后)

用法：
  python assemble-incoming-assets.py
  python assemble-incoming-assets.py --matted-states walk sleep sad peek
  python assemble-incoming-assets.py --states idle            # 只处理 idle（idle 不在 matted 则纯复制）
"""
import os
import argparse
import json
import shutil
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
PROC = os.path.join(ROOT, "assets-processed")                       # 透明抠图（matted 源）
INC = os.path.join(ROOT, "taozi-pet", "incoming-assets")            # 整合目标 / 复制源
SPEC = os.path.join(ROOT, "taozi-pet", "pet-spec.json")             # 帧清单权威来源

# 阈值唯一权威来自 pet-spec.json assetPipeline（与 process-assets.mjs / qa-assets.mjs 共用）
_pipeline = json.load(open(SPEC, encoding="utf-8")).get("assetPipeline", {})
CANVAS = _pipeline.get("sourceCanvas", 1280)                        # 统一透明画布边长
MARGIN = _pipeline.get("sourceMargin", 48)                          # 画布边缘留白（防贴边）
TARGET_OCC = _pipeline.get("sourceOccupancy", 0.62)                 # 目标占用率（面积占比）
PAD = _pipeline.get("sourcePad", 4)                                 # bbox 外扩留白

# 项目预设：需从 assets-processed 渲染 + 占用率归一化的状态（即已上 GPU 的状态）。
# 注意 idle/blink 为 lockedBody，其已提交的 CPU 帧天然满足 ≤2.5% 宽高一致性；
# 一旦归一化反而会触发 SCALE_DRIFT，故此处故意不含 idle/blink。
DEFAULT_MATTED = ["walk", "sleep", "sad", "peek"]


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


def render_matted(src_name):
    """从 assets-processed 读取透明帧，裁 bbox(+PAD)，按目标占用率缩放，
    居中+底部对齐到统一画布，返回 RGBA 图像。src_name 不含扩展名。"""
    arr = np.array(Image.open(os.path.join(PROC, src_name + ".png")).convert("RGBA"))
    t, btm, l, r = subject_bbox(arr)
    t = max(0, t - PAD)
    btm = min(arr.shape[0] - 1, btm + PAD)
    l = max(0, l - PAD)
    r = min(arr.shape[1] - 1, r + PAD)
    h = btm - t + 1
    w = r - l + 1
    # 按目标面积（占用率）缩放
    factor = (TARGET_OCC * CANVAS * CANVAS / (w * h)) ** 0.5
    nw, nh = max(1, round(w * factor)), max(1, round(h * factor))
    # 防贴边：fit 缩放（仅过大时生效）
    fit = min((CANVAS - 2 * MARGIN) / max(nw, nh), 1.0)
    nw2, nh2 = max(1, round(nw * fit)), max(1, round(nh * fit))
    sub = Image.fromarray(arr).crop((l, t, r + 1, btm + 1)).resize((nw2, nh2), Image.LANCZOS)
    cv = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    px, py = (CANVAS - nw2) // 2, CANVAS - MARGIN - nh2
    cv.paste(sub, (px, py), sub)
    return cv


def build_state(state, frames, matted):
    """处理单个状态：matted 帧从 PROC 渲染并归一化，其余从 INC 复制。返回处理的帧数。"""
    done = 0
    for fr in frames:
        dst = os.path.join(INC, fr)
        if matted and os.path.exists(os.path.join(PROC, fr)):
            render_matted(fr[:-4]).save(dst)
            mode = "matted"
        else:
            srcp = os.path.join(INC, fr)
            if not os.path.exists(srcp):
                raise RuntimeError(f"缺失复制源 {srcp}")
            if os.path.abspath(srcp) != os.path.abspath(dst):
                shutil.copy(srcp, dst)
            mode = "copy"
        done += 1
        print(f"  {mode:7} {fr}")
    return done


def main():
    ap = argparse.ArgumentParser(description="组装+归一化 incoming-assets（通用、数据驱动）")
    ap.add_argument("--matted-states", nargs="*", default=DEFAULT_MATTED,
                    help=f"从 assets-processed 渲染并归一化的状态（默认 {DEFAULT_MATTED}）；其余状态从 incoming 复制")
    ap.add_argument("--states", nargs="*", default=None,
                    help="只处理这些状态（默认全部）")
    args = ap.parse_args()

    states = load_states()
    if args.states:
        wanted = set(args.states)
        states = {k: v for k, v in states.items() if k in wanted}
    matted = set(args.matted_states)

    total = 0
    for state, frames in states.items():
        print(f"=== {state} (matted={state in matted}, {len(frames)} 帧) ===")
        total += build_state(state, frames, state in matted)
    print(f"\nDONE: {total} 帧写入 {INC}（画布 {CANVAS}，占用率 {TARGET_OCC}，margin {MARGIN}，pad {PAD}）")


if __name__ == "__main__":
    main()
