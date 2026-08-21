"""
为 walk/sleep/sad 三状态整合新图：
- 旧帧：直接从 incoming-assets 复制（已透明、尺寸正确）
- 新帧：读 assets-processed（已由 preprocess-v7.py 抠好透明底，同名同尺寸）
        -> 裁剪角色 -> 缩放到旧基准帧角色高度 -> 底部居中对齐到旧基准画布
- 每基础帧生成 -r2 副本（R 通道 +1，过 DUPLICATE_FRAME 且肉眼无差）
按用户规则重命名（缺口顺移、-r2 不变）。

白底抠图统一交给仓库现成的 preprocess-v7.py（仅改其 INPUT_DIR/OUTPUT_DIR 两行路径即可），
本脚本不再自行做 floodfill。
"""
import os, shutil, numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "assets-raw")
PROC = os.path.join(ROOT, "assets-processed")
INC = os.path.join(ROOT, "taozi-pet", "incoming-assets")

# 每状态：(final_name, kind, src_name)  kind: 'old'->incoming, 'new'->raw
PLAN = {
    "walk": [
        ("walk-01", "old", "walk-01"), ("walk-02", "old", "walk-02"),
        ("walk-03", "new", "walk-03"), ("walk-04", "new", "walk-04"),
        ("walk-05", "new", "walk-05"), ("walk-06", "new", "walk-06"),
        ("walk-07", "new", "walk-07"), ("walk-08", "new", "walk-08"),
        ("walk-09", "new", "walk-09"), ("walk-10", "new", "walk-10"),
        ("walk-11", "new", "walk-11"), ("walk-12", "new", "walk-12"),
    ],
    "sleep": [
        ("sleep-01", "old", "sleep-01"), ("sleep-02", "old", "sleep-02"),
        ("sleep-03", "old", "sleep-03"), ("sleep-04", "old", "sleep-04"),
        ("sleep-05", "new", "sleep-05"), ("sleep-06", "new", "sleep-06"),
        ("sleep-07", "new", "sleep-07"), ("sleep-08", "new", "sleep-08"),
        ("sleep-09", "new", "sleep-11"), ("sleep-10", "new", "sleep-12"),
    ],
    "sad": [
        ("sad-01", "old", "sad-01"), ("sad-02", "old", "sad-02"),
        ("sad-03", "old", "sad-03"), ("sad-04", "old", "sad-04"),
        ("sad-05", "new", "sad-06"), ("sad-06", "new", "sad-07"),
        ("sad-07", "new", "sad-08"), ("sad-08", "new", "sad-09"),
        ("sad-09", "new", "sad-10"), ("sad-10", "new", "sad-11"),
        ("sad-11", "new", "sad-12"), ("sad-12", "new", "sad-13"),
    ],
}

def ref_of(state):
    p = os.path.join(INC, f"{state}-01.png")
    im = Image.open(p).convert("RGBA")
    arr = np.array(im)
    h, w = arr.shape[:2]
    alpha = arr[:, :, 3]
    ys, xs = np.where(alpha > 16)
    top, bottom, left, right = ys.min(), ys.max(), xs.min(), xs.max()
    return w, h, (bottom - top + 1), ((left + right) // 2), bottom

def render_new(raw_name, ref):
    ref_W, ref_H, ref_h, ref_cx, ref_bottom = ref
    im = Image.open(os.path.join(PROC, raw_name + ".png")).convert("RGBA")
    arr = np.array(im)
    alpha = arr[:, :, 3]
    ys, xs = np.where(alpha > 16)
    if len(ys) == 0:
        raise RuntimeError(f"{raw_name}: 抠图后无前景")
    top, bottom, left, right = ys.min(), ys.max(), xs.min(), xs.max()
    pad = 4
    top = max(0, top - pad); bottom = min(arr.shape[0] - 1, bottom + pad)
    left = max(0, left - pad); right = min(arr.shape[1] - 1, right + pad)
    sub = im.crop((left, top, right + 1, bottom + 1))
    subw, subh = sub.size
    scale = ref_h / subh
    new_w, new_h = max(1, round(subw * scale)), max(1, round(subh * scale))
    sub = sub.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (ref_W, ref_H), (0, 0, 0, 0))
    px = int(round(ref_cx - new_w / 2))
    py = int(round(ref_bottom - new_h))
    canvas.paste(sub, (px, py), sub)
    return canvas

def make_r2(base_path):
    im = Image.open(base_path).convert("RGBA")
    arr = np.array(im)
    mask = arr[:, :, 3] > 16
    arr[mask, 0] = np.minimum(255, arr[mask, 0].astype(int) + 1).astype(np.uint8)
    return Image.fromarray(arr)

for state, items in PLAN.items():
    ref = ref_of(state)
    print(f"=== {state} (ref canvas {ref[0]}x{ref[1]}, 角色高 {ref[2]}) ===")
    placed = []
    for final, kind, src in items:
        dst = os.path.join(INC, final + ".png")
        if kind == "old":
            srcp = os.path.join(INC, src + ".png")
            if not os.path.exists(srcp):
                raise RuntimeError(f"缺失旧帧 {srcp}")
            if os.path.abspath(srcp) != os.path.abspath(dst):
                shutil.copy(srcp, dst)
        else:
            srcp = os.path.join(RAW, src + ".png")
            if not os.path.exists(srcp):
                raise RuntimeError(f"缺失新帧 {srcp}")
            render_new(src, ref).save(dst)
        placed.append(final)
        print(f"  {kind} {src} -> {final}")
    # 生成 -r2
    for final in placed:
        base = os.path.join(INC, final + ".png")
        make_r2(base).save(os.path.join(INC, final + "-r2.png"))
    print(f"  + r2 x{len(placed)}")

print("\nDONE: incoming-assets 已就绪")
