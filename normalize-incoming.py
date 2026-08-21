"""把 incoming-assets 中指定状态的所有基础帧统一到目标占用率，避免
process-assets 的 NORMALIZATION_TOO_LARGE，并保证角色不触碰画布四边
(SUBJECT_TOUCHES_BORDER)，且各状态源图大小一致（修复 sad/sleep 过小）。

做法：
1. 以目标占用率 TARGET_OCC 计算目标面积，把每帧等比缩放到该面积
   （保留各自比例），使角色占满画布比例与 walk 等状态一致。
2. 居中 + 底部对齐到统一透明画布 (CANVAS, 留 MARGIN)。
3. 若任一帧最长边超出 (CANVAS-2*MARGIN) 包围盒，整体再乘统一 fitScale 缩小。
4. 重建 -r2 (R 通道 +1，过 DUPLICATE_FRAME 且肉眼无差)。
"""
import os, numpy as np
from PIL import Image

INC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "taozi-pet", "incoming-assets")
CANVAS = 1280
MARGIN = 48
TARGET_OCC = 0.62  # 与各状态(如 walk 0.60)一致，避免 sad/sleep 源图过小

def subject_bbox(arr):
    alpha = arr[:, :, 3]
    ys, xs = np.where(alpha > 16)
    if len(ys) == 0:
        raise RuntimeError("frame has no foreground")
    return ys.min(), ys.max(), xs.min(), xs.max()

def make_r2(base_path):
    im = Image.open(base_path).convert("RGBA")
    arr = np.array(im)
    mask = arr[:, :, 3] > 16
    arr[mask, 0] = np.minimum(255, arr[mask, 0].astype(int) + 1).astype(np.uint8)
    return Image.fromarray(arr)

# 仅缩放 sad/sleep（walk 已在 0.60 占用率通过 QA，不改动）；
# 把两者主体放大到与 walk 一致的 TARGET_OCC，修复“处理后过小”。
for state in ["sleep", "sad"]:
    bases = sorted([f for f in os.listdir(INC)
                    if f.startswith(state + "-") and not f.endswith("-r2.png")])
    infos = []
    for b in bases:
        arr = np.array(Image.open(os.path.join(INC, b)).convert("RGBA"))
        t, btm, l, r = subject_bbox(arr)
        h, w = btm - t + 1, r - l + 1
        infos.append((b, arr, t, btm, l, r, h, w))
    target_area = TARGET_OCC * CANVAS * CANVAS
    # 第一遍：按目标面积缩放，记录尺寸
    scaled = []
    max_dim = 1
    for (name, arr, t, btm, l, r, h, w) in infos:
        factor = (target_area / (h * w)) ** 0.5
        nw, nh = max(1, round(w * factor)), max(1, round(h * factor))
        scaled.append((name, arr, t, btm, l, r, nw, nh))
        max_dim = max(max_dim, nw, nh)
    # 统一 fit 缩放（仅过大状态生效，防止贴边）
    fit = min((CANVAS - 2 * MARGIN) / max_dim, 1.0)
    for (name, arr, t, btm, l, r, nw, nh) in scaled:
        nw2, nh2 = max(1, round(nw * fit)), max(1, round(nh * fit))
        sub = Image.fromarray(arr).crop((l, t, r + 1, btm + 1)).resize((nw2, nh2), Image.LANCZOS)
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        px, py = (CANVAS - nw2) // 2, CANVAS - MARGIN - nh2
        canvas.paste(sub, (px, py), sub)
        canvas.save(os.path.join(INC, name))
        make_r2(os.path.join(INC, name)).save(os.path.join(INC, name[:-4] + "-r2.png"))
    occ = sorted(((max(nw, nh) ** 2 if False else (nw * nh)) for (_, _, _, _, _, _, nw, nh) in scaled))[len(scaled)//2] / (CANVAS*CANVAS)
    print(f"{state}: 目标占用率->{TARGET_OCC} fitScale={fit:.3f} 实际中位占用≈{occ:.3f} (画布 {CANVAS})")
