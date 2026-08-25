"""
GPU 抠白底：assets-raw/ → taozi-pet/incoming-assets/（透明 PNG，默认全量）

用 BiRefNet 在 CUDA 上推理生成基础 alpha，再叠加 v7 后处理
（保护色 / 清底线 / 最大连通块）保证 QA 兼容。无 GPU 时自动退 CPU。

保护色对肤色区做 2px 膨胀，可挽回手部/高光边缘的浅色像素，
避免 happy/starfish-wave 等挥手状态的手颜色被“洗掉”。

用法:
  python "preprocess-v7 -gpu.py"              # 处理 assets-raw 全部帧
  python "preprocess-v7 -gpu.py" walk-01.png  # 只处理指定文件
  python "preprocess-v7 -gpu.py" --states walk sleep   # 只处理指定状态
  python "preprocess-v7 -gpu.py" --cpu        # 强制 CPU 推理

环境: conda activate my_project（torch + CUDA）
模型: ZhengPeng7/BiRefNet（首次从 HF 镜像下载，约 350MB）
"""
import os
# 国内环境：让 HF 下载走镜像，避免 huggingface.co 直连超时
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

import sys
import numpy as np
from PIL import Image
from scipy import ndimage

INPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'
OUTPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\taozi-pet\incoming-assets'

BG_THRESHOLD = 28
# BiRefNet 在 1024 边长上训练；大图等比缩放到此尺寸推理，再还原
MODEL_SIZE = 1024

# ---------- GPU 模型（懒加载，单例，进程内只加载一次） ----------
_MODEL = None

def get_model():
    """加载 BiRefNet 到 CUDA（无 GPU 自动退 CPU）。"""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    import torch
    from transformers import AutoModelForImageSegmentation
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    if device == 'cuda':
        cap = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f'  [model] loading BiRefNet on cuda ({torch.cuda.get_device_name(0)}, {cap:.1f}GB) ...')
    else:
        print('  [model] loading BiRefNet on CPU (no CUDA) ...')
    model = AutoModelForImageSegmentation.from_pretrained(
        'ZhengPeng7/BiRefNet', trust_remote_code=True
    )
    model.to(device)
    model.float()  # 权重可能以 fp16 载入，统一转 fp32 避免 half/float 不匹配
    model.eval()
    _MODEL = (model, device)
    return _MODEL

def rmbg_alpha(rgba_pil):
    """返回与原图同尺寸的 uint8 alpha (0-255)，前景=255。GPU 推理。"""
    import torch
    from torchvision.transforms.functional import to_tensor, resize
    model, device = get_model()
    img = rgba_pil.convert('RGB')
    w, h = img.size
    # 等比缩放到模型输入（最长边 1024）
    if max(w, h) > MODEL_SIZE:
        scale = MODEL_SIZE / max(w, h)
        tw, th = int(round(w * scale)), int(round(h * scale))
    else:
        tw, th = w, h
    inp = to_tensor(resize(img, [th, tw])).unsqueeze(0).to(device)
    with torch.no_grad():
        preds = model(inp)
    out = preds[-1] if isinstance(preds, (list, tuple)) else preds
    # 压到 2D：[B,1,H,W] -> [H,W]
    while out.dim() > 2:
        out = out[0]
    prob = torch.sigmoid(out).cpu().float().numpy().astype(np.float32)
    # 还原到原图尺寸
    prob_img = Image.fromarray((prob * 255).clip(0, 255).astype('uint8')).resize((w, h), Image.BILINEAR)
    return np.asarray(prob_img).astype(np.uint8)


# ===================== v7 后处理（原样保留，保 QA 兼容） =====================
def get_protected_mask(arr, alpha):
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    # 肤色保护：覆盖偏粉/浅的肤色高光，避免手部阴影或浅色手指被 BiRefNet 低置信删除
    skin = (r > 150) & (g > 110) & (b > 70) & (r >= g) & (g >= b) & ((r - b) > 1)
    pumpkin = (r > 170) & (g > 110) & (b < 140) & ((r - b) > 70)
    return (skin | pumpkin) & (alpha > 16)

def remove_connected_white_bg(arr, alpha, protected=None):
    from scipy import ndimage
    h, w = alpha.shape
    if protected is None:
        protected = get_protected_mask(arr, alpha)
    bg_ref = arr[0, 0].astype(int)
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    dist = np.sqrt((r - bg_ref[0])**2 + (g - bg_ref[1])**2 + (b - bg_ref[2])**2)
    near_bg = (dist < BG_THRESHOLD) & (alpha > 16) & ~protected

    labeled, num = ndimage.label(near_bg)
    if num == 0:
        return alpha
    sl = ndimage.find_objects(labeled)
    delete = np.zeros((h, w), dtype=bool)
    for lab in range(1, num + 1):
        obj = sl[lab - 1]
        if obj is None:
            continue
        top, bot = obj[0].start, obj[0].stop - 1
        left, right = obj[1].start, obj[1].stop - 1
        hb, wb = bot - top + 1, right - left + 1
        size = int((labeled[obj] == lab).sum())
        if size < 30:
            continue
        if bot >= h - 15 and wb > w * 0.2 and wb >= hb:
            delete |= (labeled == lab)
    alpha[delete] = 0
    return alpha

def remove_bottom_ground_line(arr, alpha):
    h, w = alpha.shape
    ys, xs = np.where(alpha > 16)
    if not len(ys):
        return alpha
    y_bot = ys.max()
    min_n = max(40, int(w * 0.15))
    for y in range(y_bot, max(0, y_bot - 8), -1):
        row = alpha[y, :] > 16
        n = int(row.sum())
        if n < min_n:
            continue
        rp = arr[y, row, :3]
        mean = float(rp.mean())
        if mean > 150:
            alpha[y, row] = 0
            print(f'    ground line cleared at y={y} n={n} mean={mean:.0f}')
        break
    return alpha

def keep_largest_connected(alpha):
    from scipy import ndimage
    h, w = alpha.shape
    fg = alpha > 16
    labeled, num = ndimage.label(fg)
    if num == 0:
        return alpha
    sizes = ndimage.sum(fg, labeled, range(1, num + 1))
    centers = ndimage.center_of_mass(fg, labeled, range(1, num + 1))
    max_area = float(sizes.max())
    keep = np.zeros((h, w), dtype=bool)
    for lab in range(1, num + 1):
        area = float(sizes[lab - 1])
        if area == max_area:
            keep |= (labeled == lab)
        elif area > max_area * 0.3:
            cy, cx = centers[lab - 1]
            if ((cy - h/2)**2 + (cx - w/2)**2) ** 0.5 < h * 0.4:
                keep |= (labeled == lab)
    new_alpha = np.zeros((h, w), dtype=np.uint8)
    new_alpha[keep] = alpha[keep]
    return new_alpha


def process_image(input_path, output_path):
    img = Image.open(input_path).convert('RGBA')
    arr = np.array(img)
    alpha = arr[:, :, 3].copy()

    # 1) GPU 模型抠图（基础 alpha）
    model_alpha = rmbg_alpha(img)
    alpha = model_alpha.copy()

    # 2) 保护色：被保护的像素强制为前景（防止模型把肤色/南瓜色误删）
    # 对保护区做少量膨胀，可挽回 BiRefNet 在手部/高光边缘丢失的相邻有色像素，
    # 让 happy/starfish-wave 等挥手状态的手指颜色不被“洗掉”。
    # 先去掉贴边保护区，避免膨胀后触发 process-assets 的 SUBJECT_TOUCHES_BORDER。
    protected = get_protected_mask(arr, alpha)
    border = 4
    protected[:border, :] = False
    protected[-border:, :] = False
    protected[:, :border] = False
    protected[:, -border:] = False
    protected = ndimage.binary_dilation(protected, iterations=2)
    alpha[protected] = 255

    # 3) 去除与主体连通的底部横线（贴画布底的近背景宽条）
    alpha = remove_connected_white_bg(arr, alpha, protected)
    # 4) 去除主体实际最底部的浅色地面线（脚底阴影带）
    alpha = remove_bottom_ground_line(arr, alpha)
    # 5) 保留中心最大连通块
    alpha = keep_largest_connected(alpha)

    # 6) 清理最边缘 2px 前景，避免 peek 等“贴边出场”状态触发 process-assets 的 SUBJECT_TOUCHES_BORDER。
    # 贴边帧的源图本身就切到画面外，留 2px 透明边不影响观感。
    border = 2
    alpha[:border, :] = 0
    alpha[-border:, :] = 0
    alpha[:, :border] = 0
    alpha[:, -border:] = 0

    arr[:, :, 3] = alpha
    Image.fromarray(arr).save(output_path)

# 默认 --states 为 None → 处理 assets-raw 全部帧（GPU 全量扣图）。
# idle/blink 的 SCALE_DRIFT 由下游 assemble 的帧间尺寸对齐处理，CPU 版仅作最后手段。

def _state_of(fname):
    """从 'walk-01.png' / 'pet-head-03.png' 取状态前缀。"""
    return fname.rsplit('-', 1)[0]

def main():
    import argparse
    ap = argparse.ArgumentParser(description="GPU 抠图：assets-raw → taozi-pet/incoming-assets（默认全量）")
    ap.add_argument('files', nargs='*', help='指定文件（默认处理 --states 全部）')
    ap.add_argument('--states', nargs='*', default=None,
                    help='只处理这些状态（默认 None=全部状态，全量处理）')
    ap.add_argument('--cpu', action='store_true', help='强制 CPU 推理（无 GPU 兜底）')
    args = ap.parse_args()
    if args.cpu:
        os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    states = set(args.states) if args.states else None
    if args.files:
        files = [f for f in args.files if f.lower().endswith('.png')]
        print(f'Selected files: {len(files)} files')
    else:
        files = sorted([f for f in os.listdir(INPUT_DIR)
                        if f.lower().endswith('.png') and (states is None or _state_of(f) in states)])
        label = sorted(states) if states else 'ALL'
        print(f'Processing states {label}: {len(files)} files')
    success = 0
    for i, fname in enumerate(files):
        in_path = os.path.join(INPUT_DIR, fname)
        out_path = os.path.join(OUTPUT_DIR, fname)
        if not os.path.exists(in_path):
            print(f'  SKIP (not found): {fname}')
            continue
        try:
            process_image(in_path, out_path)
            success += 1
            print(f'  [{i+1}/{len(files)}] {fname} OK')
        except Exception as e:
            print(f'  ERROR {fname}: {e}')
    print(f'Done: {success}/{len(files)} succeeded')

if __name__ == '__main__':
    main()
