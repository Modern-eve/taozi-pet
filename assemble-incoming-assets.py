"""
assemble-incoming-assets.py — 组装 taozi-pet/incoming-assets

单一职责（通用）：
  把「已抠透明底的素材」整理为 process-assets 所需的 incoming-assets。
  对每个状态、每帧：
    - 若该状态在 --matted-states 且 assets-processed 有对应帧
        → 渲染该帧：裁 bbox(+PAD) → 等比缩放到参考角色高 → 居中+底部对齐到参考画布
    - 否则 → 从 incoming-assets 原样复制（保留既有结果，例如仍用 CPU 抠图的 8 个状态）

  参考画布/角色尺寸取自该状态首个可用帧（incoming-assets 优先，缺则 assets-processed）。
  帧清单由各状态在 pet-spec.json 的 frames 推导（去重，因双播会重复引用同一文件），不再硬编码。

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

DEFAULT_MATTED = ["walk", "sleep", "sad", "peek"]                  # 当前已验证可上 GPU 的状态
PAD = 4                                                            # bbox 外扩留白


def load_states():
    """返回 {state_id: [去重后的帧文件名, 如 'idle-01.png']}，顺序按文件名。"""
    spec = json.load(open(SPEC, encoding="utf-8"))
    out = {}
    for st in spec["states"]:
        frames = sorted({f for f in st["frames"] if f.endswith(".png")})
        out[st["id"]] = frames
    return out


def open_rgba(path):
    return np.array(Image.open(path).convert("RGBA"))


def bbox(arr):
    """返回 (top, bottom, left, right) 的透明前景包围盒；无前景则抛错。"""
    ys, xs = np.where(arr[:, :, 3] > 16)
    if len(ys) == 0:
        raise RuntimeError("frame has no foreground")
    return ys.min(), ys.max(), xs.min(), xs.max()


def ref_of(state):
    """参考：该状态首个可用帧的画布尺寸 + 角色高 + 中心x + 底部y。"""
    for d in (INC, PROC):
        p = os.path.join(d, f"{state}-01.png")
        if os.path.exists(p):
            arr = open_rgba(p)
            h, w = arr.shape[:2]
            t, b, l, r = bbox(arr)
            return w, h, (b - t + 1), (l + r) // 2, b
    raise RuntimeError(f"无参考帧：{state}-01（检查 {INC} 与 {PROC}）")


def render_matted(src_name, ref):
    """从 assets-processed 读取透明帧，裁 bbox(+PAD)，缩放到参考角色高，
    居中+底部对齐到参考画布，返回 RGBA 图像。src_name 不含扩展名。"""
    ref_W, ref_H, ref_h, ref_cx, ref_bottom = ref
    arr = open_rgba(os.path.join(PROC, src_name + ".png"))
    t, b, l, r = bbox(arr)
    t = max(0, t - PAD)
    b = min(arr.shape[0] - 1, b + PAD)
    l = max(0, l - PAD)
    r = min(arr.shape[1] - 1, r + PAD)
    sub = Image.fromarray(arr).crop((l, t, r + 1, b + 1))
    subw, subh = sub.size
    scale = ref_h / subh
    new_w, new_h = max(1, round(subw * scale)), max(1, round(subh * scale))
    sub = sub.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (ref_W, ref_H), (0, 0, 0, 0))
    px = int(round(ref_cx - new_w / 2))
    py = int(round(ref_bottom - new_h))
    canvas.paste(sub, (px, py), sub)
    return canvas


def build_state(state, frames, matted):
    """处理单个状态：matted 帧从 PROC 渲染，其余从 INC 复制。返回处理的帧数。"""
    ref = ref_of(state) if matted else None
    done = 0
    for fr in frames:
        dst = os.path.join(INC, fr)
        if matted and os.path.exists(os.path.join(PROC, fr)):
            render_matted(fr[:-4], ref).save(dst)
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
    ap = argparse.ArgumentParser(description="组装 incoming-assets（通用、数据驱动）")
    ap.add_argument("--matted-states", nargs="*", default=DEFAULT_MATTED,
                    help=f"从 assets-processed 渲染的状态（默认 {DEFAULT_MATTED}）；其余状态从 incoming 复制")
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
    print(f"\nDONE: {total} 帧写入 {INC}")


if __name__ == "__main__":
    main()
