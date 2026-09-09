"""
GPU 抠白底：assets-raw/ → taozi-pet/incoming-assets/（透明 PNG，默认全量）

格式的单一契约：
    <任意格式>  ──rename──▶  <state>-NN.jpg  ──preprocess──▶  <state>-NN.png

输入支持 png / jpg / jpeg / webp / bmp（PIL 按内容解码，扩展名不必可信）；
输出恒为透明 png —— 抠图结果带 alpha 通道，只有 png 存得下。
上游 rename-assets.py 已把源收敛为 .jpg，所以这里吃到的通常就是 jpg。

用 BiRefNet 在 CUDA 上推理生成基础 alpha，再叠加三步后处理保证 QA 兼容：
  1) 保护色（肤色 / 南瓜色，含 2px 膨胀）
  2) 保留主体连通块 + 可信的分离部件（头顶光环）
  3) 清理最边缘 2px 前景

光环浮在头顶、与身体不相连，面积只有主体的 0.5%~0.7% 且位于画面顶部，
按"只留最大块"的朴素规则会被整块删掉，故第 2 步用「面积 + 置信度」双闸门
把它与噪点区分开（详见 keep_largest_connected 注释）。

保护色对肤色区做 2px 膨胀，可挽回手部/高光边缘的浅色像素，
避免 happy/starfish-wave 等挥手状态的手颜色被“洗掉”。
无 GPU 时自动退 CPU（也可 --cpu 强制）。

用法:
  python "preprocess-v7 -gpu.py"              # 处理 assets-raw 全部帧
  python "preprocess-v7 -gpu.py" walk-01.jpg  # 只处理指定文件
  python "preprocess-v7 -gpu.py" --states walk sleep   # 只处理指定状态
  python "preprocess-v7 -gpu.py" --cpu        # 强制 CPU 推理

环境: conda activate my_project（torch + CUDA）
模型: ZhengPeng7/BiRefNet
"""
import os
# 国内环境：让 HF 下载走镜像，避免 huggingface.co 直连超时
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

import numpy as np
from PIL import Image
from scipy import ndimage

INPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\assets-raw'
OUTPUT_DIR = r'D:\Documents\Doubao\chats\2026-08-12\new-chat\taozi-pet\incoming-assets'

# 可识别的输入格式（源导出常是 jpg；扩展名不可信，PIL 按内容解码）
IMG_EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.bmp')

BG_THRESHOLD = 28
# BiRefNet 在 1024 边长上训练；大图等比缩放到此尺寸推理，再还原
MODEL_SIZE = 1024

# ---- GPU 模型（懒加载单例，进程内只加载一次）----
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


# ---- v7 后处理（保 QA 兼容）----
def get_protected_mask(arr, alpha):
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    # 肤色保护：覆盖偏粉/浅的肤色高光，避免手部阴影或浅色手指被 BiRefNet 低置信删除
    skin = (r > 150) & (g > 110) & (b > 70) & (r >= g) & (g >= b) & ((r - b) > 1)
    pumpkin = (r > 170) & (g > 110) & (b < 140) & ((r - b) > 70)
    return (skin | pumpkin) & (alpha > 16)

# 分离部件（头顶光环等）保留阈值。
# 实测 8 个状态：光环 面积占全图 0.148%~0.266%、平均置信度 187~196；
#               噪点 面积占全图 ≤0.026%、平均置信度 ≤93。
# 两个闸门各有约 2 倍余量，可稳定区分「小而可信的部件」与「噪点」。
PART_AREA_RATIO = 0.001   # 分离部件最小面积（占全图比例）
PART_MEAN_ALPHA = 150     # 分离部件最低平均置信度


def keep_largest_connected(alpha):
    """保留主体连通块，以及可信的分离部件（如头顶光环）。

    命中任一条件即保留：
      1) 面积最大的块 —— 主体
      2) 面积 > 主体 30% 且距画面中心 < 0.4h —— 与主体断开的大部件
      3) 面积 ≥ 全图 0.1% 且平均置信度 ≥ 150 —— 小而可信的分离部件（光环）

    第 3 条专为光环而设：它浮在头顶、与身体不相连，面积仅主体的 0.5%~0.7%，
    位置又在画面顶部（距中心约 0.47h > 0.4h），按旧规则两条判据同时不满足，
    会被当成噪声整块删除。面积用「占全图比例」而非绝对像素，兼顾
    1536×2048 与 1680×2240 两种源分辨率。
    """
    h, w = alpha.shape
    fg = alpha > 16
    labeled, num = ndimage.label(fg)
    if num == 0:
        return alpha
    labs = range(1, num + 1)
    sizes = ndimage.sum(fg, labeled, labs)
    centers = ndimage.center_of_mass(fg, labeled, labs)
    means = ndimage.mean(alpha, labeled, labs)
    max_area = float(sizes.max())
    min_area = h * w * PART_AREA_RATIO
    keep = np.zeros((h, w), dtype=bool)
    for lab in labs:
        area = float(sizes[lab - 1])
        if area == max_area:
            keep |= (labeled == lab)  # 主体
        elif area > max_area * 0.3:
            cy, cx = centers[lab - 1]  # 与主体断开的大部件：需靠近中心
            if ((cy - h / 2) ** 2 + (cx - w / 2) ** 2) ** 0.5 < h * 0.4:
                keep |= (labeled == lab)
        elif area >= min_area and float(means[lab - 1]) >= PART_MEAN_ALPHA:
            keep |= (labeled == lab)  # 小而可信的分离部件（光环）
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

    # 3) 保留中心最大连通块
    alpha = keep_largest_connected(alpha)

    # 4) 清理最边缘 2px 前景，避免 peek 等“贴边出场”状态触发 process-assets 的 SUBJECT_TOUCHES_BORDER。
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
    """从 'walk-01.png' / 'pet-head-03.jpg' 取状态前缀。"""
    return fname.rsplit('-', 1)[0]


def _out_name(fname):
    """输出统一为透明 png（需 alpha 通道），与输入格式无关。"""
    return os.path.splitext(fname)[0] + '.png'


def main():
    import argparse
    ap = argparse.ArgumentParser(description="GPU 抠图：assets-raw → taozi-pet/incoming-assets（默认全量）")
    ap.add_argument('files', nargs='*', help='指定文件（默认处理 --states 全部）')
    ap.add_argument('--states', nargs='*', default=None,
                    help='只处理这些状态（默认 None=全部状态；帧间尺寸漂移由下游 assemble 归一化收口）')
    ap.add_argument('--cpu', action='store_true', help='强制 CPU 推理（无 GPU 兜底）')
    args = ap.parse_args()
    if args.cpu:
        os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    states = set(args.states) if args.states else None
    if args.files:
        files = [f for f in args.files if f.lower().endswith(IMG_EXTS)]
        print(f'Selected files: {len(files)} files')
    else:
        files = sorted([f for f in os.listdir(INPUT_DIR)
                        if f.lower().endswith(IMG_EXTS) and (states is None or _state_of(f) in states)])
        label = sorted(states) if states else 'ALL'
        print(f'Processing states {label}: {len(files)} files')
    success = 0
    for i, fname in enumerate(files):
        in_path = os.path.join(INPUT_DIR, fname)
        out_path = os.path.join(OUTPUT_DIR, _out_name(fname))
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
