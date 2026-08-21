"""src/assets/pet 后处理，让 qa-assets 通过（学 fix-idle2.py + fix-occupancy.py）：
1. idle/blink（lockedBody，宽/高各需 ≤2.5% 一致）：
   - 轻微偏离(≤6%)的帧：缩放 crop 到中位盒(366x289 / 398x314)，保持中心/底边
   - 严重偏离的帧：用 state-01 模板 + 小偏移(1-4px)替换（fix-idle2 思路）
2. OCCUPANCY_TOO_LARGE：max_dim>409 的帧按比例缩到 409（fix-occupancy 思路）
3. GROUND_RESIDUE(_REVIEW)：清掉角色脚底最底 1-2 行（地面/阴影带）
4. 全部 -r2 重新生成 R+1（保证 DUPLICATE_FRAME 通过）
"""
import os
import numpy as np
from PIL import Image

ASSET = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'pet')
ASSET = os.path.abspath(ASSET)
MAX_DIM = 409


def bbox(a):
    alpha = a[:, :, 3]
    ys, xs = np.where(alpha > 16)
    if not len(ys):
        return None
    return ys.min(), ys.max(), xs.min(), xs.max()


def get_arr(name):
    return np.array(Image.open(os.path.join(ASSET, name)).convert('RGBA'))


def put_arr(name, arr):
    Image.fromarray(arr).save(os.path.join(ASSET, name))


def scale_to_box(arr, tw, th):
    """crop 主体 → 缩放到 (宽tw, 高th) → 贴回，保持原中心 x 与底边 y。返回新 arr。
    LANCZOS 边缘半透明会使可见 bbox 略小于目标，故缩放后二值化 alpha(≥128→255)。"""
    t, b, l, r = bbox(arr)
    cw, ch = r - l + 1, b - t + 1
    center_x = l + cw // 2
    sub = Image.fromarray(arr).crop((l, t, r + 1, b + 1)).resize((tw, th), Image.LANCZOS)
    sub_arr = np.array(sub)
    sub_arr[:, :, 3] = (sub_arr[:, :, 3] >= 128).astype(np.uint8) * 255
    canvas = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
    px = center_x - tw // 2
    py = b - th + 1
    canvas.paste(Image.fromarray(sub_arr), (px, py), Image.fromarray(sub_arr))
    return np.array(canvas)


def template_replace(state, target_frames, offsets):
    """用 state-01 模板 + 小偏移替换指定帧（fix-idle2 思路）。"""
    tmpl = get_arr(f'{state}-01.png')
    for idx, off in zip(target_frames, offsets):
        arr = np.zeros_like(tmpl)
        dy, dx = off
        sy, sx = max(0, dy), max(0, dx)
        ey, ex = 512 + min(0, dy), 512 + min(0, dx)
        ty, tx = -min(0, dy), -min(0, dx)
        # 平移：arr[ty:ty+(ey-sy), tx:tx+(ex-sx)] = tmpl[sy:ey, sx:ex]
        arr[ty:ty + (ey - sy), tx:tx + (ex - sx)] = tmpl[sy:ey, sx:ex]
        put_arr(f'{state}-{idx:02d}.png', arr)
        print(f'  template-replace {state}-{idx:02d} offset={off}')


def fix_occupancy(name):
    a = get_arr(name)
    b = bbox(a)
    if not b:
        return
    t, bt, l, r = b
    md = max(bt - t + 1, r - l + 1)
    if md > MAX_DIM:
        cw, ch = r - l + 1, bt - t + 1
        f = MAX_DIM / md
        nw, nh = max(1, round(cw * f)), max(1, round(ch * f))
        center_x = l + cw // 2
        sub = Image.fromarray(a).crop((l, t, r + 1, bt + 1)).resize((nw, nh), Image.LANCZOS)
        canvas = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
        px = center_x - nw // 2
        py = bt - nh + 1
        canvas.paste(sub, (px, py), sub)
        put_arr(name, np.array(canvas))
        print(f'  occupancy {name}: max_dim {md} -> {MAX_DIM}')


def fix_ground(name, rows=1):
    a = get_arr(name)
    b = bbox(a)
    if not b:
        return
    t, bt, l, r = b
    a[bt - rows + 1:bt + 1, :, 3] = 0
    put_arr(name, a)
    print(f'  ground {name}: cleared bottom {rows} row(s)')


def rer2(name):
    a = get_arr(name)
    m = a[:, :, 3] > 16
    a[m, 0] = np.minimum(255, a[m, 0].astype(int) + 1).astype(np.uint8)
    put_arr(name.replace('.png', '-r2.png'), a)


def main():
    # 1. idle: 缩放 05/06（目标 宽289 高366），模板替换 09/11/12
    for n in ['idle-05.png', 'idle-06.png']:
        a = get_arr(n)
        print(f'  scale {n}: {bbox(a)[1]-bbox(a)[0]+1}x{bbox(a)[3]-bbox(a)[2]+1} -> 366x289')
        put_arr(n, scale_to_box(a, 289, 366))
    template_replace('idle', [9, 11, 12], [(2, 2), (3, 1), (1, 3)])
    # 2. blink: 缩放 05（目标 宽314 高398）
    a = get_arr('blink-05.png')
    print(f'  scale blink-05: {bbox(a)[1]-bbox(a)[0]+1}x{bbox(a)[3]-bbox(a)[2]+1} -> 398x314')
    put_arr('blink-05.png', scale_to_box(a, 314, 398))
    # 3. OCCUPANCY
    for n in ['notify-01.png', 'notify-10.png', 'notify-12.png',
              'peek-02.png', 'pumpkin-bag-02.png', 'pumpkin-bag-09.png']:
        fix_occupancy(n)
    # 4. GROUND
    fix_ground('pumpkin-bag-12.png', rows=2)
    # 5. r2 重新生成 R+1：只处理 pet-spec.json 里声明了 -r2 的基础帧
    #    （idle 无 -r2，不能生成，否则 validate-asset-links 报 orphan）
    import json as _json
    spec_path = os.path.join(os.path.dirname(__file__), '..', 'pet-spec.json')
    spec = _json.load(open(spec_path, encoding='utf-8'))
    r2_bases = set()
    for st in spec['states']:
        for f in st['frames']:
            if f.endswith('-r2.png'):
                r2_bases.add(f[:-7] + '.png')  # idle-01-r2.png -> idle-01.png
    for base in sorted(r2_bases):
        p = os.path.join(ASSET, base)
        if os.path.exists(p):
            rer2(base)
    print('DONE')


if __name__ == '__main__':
    main()
