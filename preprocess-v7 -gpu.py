"""
抠图算法 v8 (GPU)
==================================================
背景移除改用 RMBG-2.0 (BRIA) 在 CUDA 上推理，生成基础透明 alpha；
随后叠加 v7 的「保护色 / 清底线 / 最大连通块」后处理，保证流水线 QA 兼容。

与 v7 完全一致的契约：
  - 输入 assets-raw/（纯白底 PNG）
  - 输出 assets-processed/（同名同尺寸透明 PNG）
  - 保留 assemble-incoming-assets.py 所需的「白底已抠、保护色不丢、脚底线已清、
    最大连通块」行为

用法:
  python preprocess-v7.py              # 处理全部
  python preprocess-v7.py walk-01.png  # 只处理指定文件
  python preprocess-v7.py --cpu       # 强制 CPU（无 GPU 时兜底）

环境: conda activate my_project  (torch 2.5.1+cu121, CUDA)
模型: ZhengPeng7/BiRefNet（首次运行自动从 HF 镜像下载，约 350MB；RMBG-2.0 在 HF 上 gated 需授权，改用同架构开源版）
"""
import os
# 国内环境：让 HF 下载走镜像，避免 huggingface.co 直连超时
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

import sys
import numpy as np
from PIL import Image

INPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'
OUTPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-processed'

BG_THRESHOLD = 28
# RMBG 模型在 1024 边长上训练；大图等比缩放到此尺寸推理，再还原
RMBG_SIZE = 1024

# ---------- GPU 模型（懒加载，单例，进程内只加载一次） ----------
_MODEL = None

def get_model():
    """加载 RMBG-2.0 到 CUDA（无 GPU 自动退 CPU）。"""
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
    if max(w, h) > RMBG_SIZE:
        scale = RMBG_SIZE / max(w, h)
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
    skin = (r > 150) & (g > 110) & (b > 70) & (r >= g) & (g >= b) & ((r - b) > 3)
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
    protected = get_protected_mask(arr, alpha)
    alpha[protected] = 255

    # 3) 去除与主体连通的底部横线（贴画布底的近背景宽条）
    alpha = remove_connected_white_bg(arr, alpha, protected)
    # 4) 去除主体实际最底部的浅色地面线（脚底阴影带）
    alpha = remove_bottom_ground_line(arr, alpha)
    # 5) 保留中心最大连通块
    alpha = keep_largest_connected(alpha)

    arr[:, :, 3] = alpha
    Image.fromarray(arr).save(output_path)

def main():
    force_cpu = '--cpu' in sys.argv
    if force_cpu:
        os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if args:
        files = [f for f in args if f.lower().endswith('.png')]
        print(f'Selected processing: {len(files)} files')
    else:
        files = sorted([f for f in os.listdir(INPUT_DIR) if f.lower().endswith('.png')])
        print(f'Processing all: {len(files)} files')
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
