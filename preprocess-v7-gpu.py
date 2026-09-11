"""
GPU 抠白底：assets-raw/ → taozi-pet/incoming-assets/（透明 PNG，默认全量）

输入格式与产物命名见 preprocess_common.py。

推理预处理严格对齐官方姿势：保比例缩放 + 补边到方形 + ToTensor + ImageNet Normalize
（见 BiRefNet 官方 inference.py 与 ToonOut 官方 demo notebook）。方形输入与 Normalize
都是必需项：非方形 / 缺 Normalize 会让输入分布偏离训练分布，诱发「贴边白底误判 /
光环实心 / 手部半透」。

抠图引擎用 ToonOut（BiRefNet 的动漫域微调版，MIT）在 CUDA 上推理生成基础 alpha，
再叠加三步后处理保证 QA 兼容（实现见 preprocess_common.py）：
  1) 保护色：把肤色 / 南瓜色像素强判为前景，避免 happy/starfish-wave 等挥手状态的
     手颜色被模型“洗掉”；只取原像素、不向轮廓外扩张
  2) refine_alpha：保留主体 + 可信的分离部件（头顶光环），并清掉光环内部近背景
  3) 清理最边缘 2px 前景（避免 SUBJECT_TOUCHES_BORDER）

无 GPU 时自动退 CPU（也可 --cpu 强制）。

用法:
  python preprocess-v7-gpu.py              # 处理 assets-raw 全部帧
  python preprocess-v7-gpu.py walk-01.jpg  # 只处理指定文件
  python preprocess-v7-gpu.py --states walk sleep   # 只处理指定状态
  python preprocess-v7-gpu.py --cpu        # 强制 CPU 推理
  python preprocess-v7-gpu.py --serial     # 关闭流水线（逐帧同步，便于定位问题）

环境变量:
  INFER_FP16=0   推理回到 fp32（默认 fp16 autocast，约快 1.5×）
  USE_TOONOUT=0  回退原版 BiRefNet（A/B 用）
  TOONOUT_CKPT   指定 ToonOut 权重路径

速度: 瓶颈依次是 GPU 推理、连通域分析、PNG 编码，对应四条措施——
  推理走 fp16 autocast；「保留主体 + 清部件背景」合并为一次连通域分析且只对
  候选块做全图归约；PNG 以 compress_level=1 写出（中间产物不入库，用体积换速度）；
  三阶段流水线——预取线程备模型输入、主线程只跑推理、收尾线程后处理并写出。
  流水线跑满后主线程只剩推理时间（约 0.39s/帧），GPU 与 CPU 并行工作；
  此时瓶颈完全落在 GPU 推理上，再快需要动模型或输入分辨率。

环境: conda activate my_project（torch + CUDA）
模型: ZhengPeng7/BiRefNet + ToonOut 微调权重（设 USE_TOONOUT=0 可回退原版做 A/B）
"""
import os
import time
# 国内环境：让 HF 下载走镜像，避免 huggingface.co 直连超时
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

import numpy as np
from PIL import Image

from preprocess_common import (
    INPUT_DIR,
    OUTPUT_DIR,
    clear_outer_border,
    get_protected_mask,
    job_list,
    refine_alpha,
    select_frames,
)

# 模型输入边长。官方在 1024×1024 方形上训练/推理，见 prepare_input 的补边逻辑。
MODEL_SIZE = 1024

# 方形输入的补边色。源图是白底，补白可与背景同色、不在边界造出一条假轮廓；
# ToonOut 官方训练底其实是 #808080 灰，若发现白补边干扰判别，改这一行即可：
#   PAD_COLOR = (128, 128, 128)
PAD_COLOR = (255, 255, 255)

# 推理输入归一化（ImageNet 统计量）——官方推理流程的必备一步。
# 缺它则输入分布与训练不一致，模型对浅色边缘（白底 vs 白裙 vs 肤色高光）判别变差。
NORM_MEAN = [0.485, 0.456, 0.406]
NORM_STD = [0.229, 0.224, 0.225]

# ToonOut 微调权重（BiRefNet 的动漫域微调版，MIT，arXiv:2509.06839）。
# 它是一份 state_dict，不是完整的 transformers 仓库，所以用法是「先载基础 BiRefNet
# 再灌权重」（见 _apply_toonout）。下载：
#   curl -L -o <TOONOUT_CKPT 路径> \
#     https://hf-mirror.com/joelseytre/toonout/resolve/main/birefnet_finetuned_toonout.pth
# 设 USE_TOONOUT=0（或 TOONOUT_CKPT 指向别处）可回退原版 BiRefNet 做 A/B。
TOONOUT_CKPT = os.environ.get(
    'TOONOUT_CKPT',
    os.path.join(os.path.expanduser('~'), '.cache', 'huggingface', 'toonout',
                 'birefnet_finetuned_toonout.pth'),
)
USE_TOONOUT = os.environ.get('USE_TOONOUT', '1') != '0'

# 推理精度：autocast 到 fp16，约快 1.5×（fp32 0.58s/帧 → fp16 0.39s/帧）。
# 输出与 fp32 的差异只出现在边缘过渡带：前景 mask IoU 0.99998，逐像素最大差 13/255。
# 若需要与 fp32 逐像素完全一致，设 INFER_FP16=0。
INFER_FP16 = os.environ.get('INFER_FP16', '1') != '0'

# PNG 压缩级别。输出是流水线中间产物（不入库，最终由 process-assets 降采样），
# 这里用体积换编码速度：level=1 约 0.09s/帧，level=6 约 0.18s/帧。
PNG_COMPRESS_LEVEL = 1

# 流水线各阶段的队列深度（同时驻留在内存里的未完成帧数），只影响内存占用。
PIPELINE_DEPTH = 3

# ---- GPU 模型（懒加载单例，进程内只加载一次）----
_MODEL = None

def _apply_toonout(model, torch):
    """把 ToonOut 的动漫域微调权重灌进基础 BiRefNet。

    ToonOut 发布的是 state_dict（birefnet_finetuned_toonout.pth），不是完整仓库，
    所以不能直接换 from_pretrained 的 repo id，只能在基础模型上 load_state_dict。
    训练时可能被 DDP / torch.compile 包过，键名带 module. / module._orig_mod. 前缀。
    """
    if not USE_TOONOUT:
        print('  [model] USE_TOONOUT=0 → 使用原版 BiRefNet 权重')
        return
    if not os.path.isfile(TOONOUT_CKPT):
        print(f'  [model] WARN 未找到 ToonOut 权重：{TOONOUT_CKPT}')
        print('  [model] WARN → 回退原版 BiRefNet（下载命令见项目记忆 / _toonout 说明）')
        return
    try:
        sd = torch.load(TOONOUT_CKPT, map_location='cpu', weights_only=True)
    except Exception:
        sd = torch.load(TOONOUT_CKPT, map_location='cpu')
    if isinstance(sd, dict) and 'state_dict' in sd:
        sd = sd['state_dict']
    clean = {k.removeprefix('module._orig_mod.').removeprefix('module.'): v
             for k, v in sd.items()}
    missing, unexpected = model.load_state_dict(clean, strict=False)
    print(f'  [model] ToonOut 权重已加载（{os.path.basename(TOONOUT_CKPT)}）'
          f' missing={len(missing)} unexpected={len(unexpected)}')
    if missing:
        print(f'  [model] WARN 缺失键示例：{list(missing)[:3]}')

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
    _apply_toonout(model, torch)
    model.to(device)
    model.float()  # 权重可能以 fp16 载入，统一转 fp32 避免 half/float 不匹配
    model.eval()
    _MODEL = (model, device)
    return _MODEL

def prepare_input(rgba_pil):
    """把整帧准备成模型输入：保比例缩放 → 补边成方形 → ToTensor → ImageNet Normalize。

    返回 (张量, meta)。meta = (w, h, tw, th, off_x, off_y) 供 restore_alpha 裁补边还原。
    这一步是纯 CPU（PIL 缩放），与 run_model 拆开是为了让它能在预取线程里先跑。
    """
    from torchvision.transforms.functional import to_tensor, normalize
    img = rgba_pil.convert('RGB')
    w, h = img.size

    # 1) 保比例缩放，让长边贴满 MODEL_SIZE（绝不拉伸长宽比）
    scale = MODEL_SIZE / max(w, h)
    tw, th = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    scaled = img.resize((tw, th), Image.LANCZOS)

    # 2) 补边成方形 —— 对齐官方 1024×1024 输入，同时不引入形变。
    #    补边区只是为了凑形状，推理后会被裁掉，不进最终 alpha。
    canvas = Image.new('RGB', (MODEL_SIZE, MODEL_SIZE), PAD_COLOR)
    off_x, off_y = (MODEL_SIZE - tw) // 2, (MODEL_SIZE - th) // 2
    canvas.paste(scaled, (off_x, off_y))

    # 3) ToTensor 把像素压到 [0,1] 后，必须再按 ImageNet 统计量归一化（官方要求）
    tensor = normalize(to_tensor(canvas), NORM_MEAN, NORM_STD)
    return tensor, (w, h, tw, th, off_x, off_y)


def run_model(tensor):
    """在 GPU 上跑模型，返回 1024² 的前景概率（float32, 0~1）。"""
    import torch
    model, device = get_model()
    with torch.inference_mode():
        inp = tensor.unsqueeze(0).to(device)
        if INFER_FP16 and device == 'cuda':
            with torch.autocast('cuda', dtype=torch.float16):
                preds = model(inp)
        else:
            preds = model(inp)
    out = preds[-1] if isinstance(preds, (list, tuple)) else preds
    # 压到 2D：[B,1,H,W] -> [H,W]
    while out.dim() > 2:
        out = out[0]
    return torch.sigmoid(out).cpu().float().numpy().astype(np.float32)


def restore_alpha(prob, meta):
    """裁掉补边 → 缩回原图尺寸，返回 uint8 alpha (0-255)。"""
    w, h, tw, th, off_x, off_y = meta
    prob_img = Image.fromarray((prob * 255).clip(0, 255).astype('uint8'))
    prob_img = prob_img.crop((off_x, off_y, off_x + tw, off_y + th))
    return np.asarray(prob_img.resize((w, h), Image.BILINEAR)).astype(np.uint8)


def rmbg_alpha(rgba_pil):
    """同步跑完「准备 → 推理 → 还原」，返回与原图同尺寸的 uint8 alpha。

    单帧调用与 make-graphics.py 走这个入口；批量流水线则把三步分别放到不同线程。
    """
    tensor, meta = prepare_input(rgba_pil)
    return restore_alpha(run_model(tensor), meta)


def read_frame(input_path):
    """读图 + 备好模型输入，返回 (原图 RGBA 数组, 输入张量, meta)。供预取线程调用。"""
    img = Image.open(input_path).convert('RGBA')
    arr = np.array(img)
    tensor, meta = prepare_input(img)
    return arr, tensor, meta


# ---- v7 后处理（保 QA 兼容）----
# 保护色、连通域后处理与贴边清理的实现见 preprocess_common.py。


def finish_frame(arr, model_alpha, output_path):
    """后处理基础 alpha 并写出透明 png。纯 CPU，可放到后台线程与推理重叠。"""
    alpha = model_alpha.copy()

    # 1) 保护色：被保护的像素强制为前景（防止模型把肤色/南瓜色误删），
    # 让 happy/starfish-wave 等挥手状态的手指颜色不被“洗掉”。
    # 保护色只取原像素、不膨胀：扩张进来的相邻像素多是背景，会在剪影外缘留下白边。
    protected = get_protected_mask(arr, alpha)
    alpha[protected] = 255

    # 2) 保留主体 + 可信分离部件，并清掉分离部件内部背景
    alpha = refine_alpha(arr, alpha, protected)

    # 3) 清理最边缘前景，避免 peek 等“贴边出场”状态触发 process-assets 的 SUBJECT_TOUCHES_BORDER
    clear_outer_border(alpha)

    arr[:, :, 3] = alpha
    Image.fromarray(arr).save(output_path, compress_level=PNG_COMPRESS_LEVEL)


def finish_alpha(arr, prob, meta, output_path):
    """还原 alpha → 后处理 → 写出。流水线收尾线程的入口。"""
    finish_frame(arr, restore_alpha(prob, meta), output_path)


def process_image(input_path, output_path):
    """单帧同步处理（少量文件、或需要严格顺序时使用）。"""
    img = Image.open(input_path).convert('RGBA')
    arr = np.array(img)
    tensor, meta = prepare_input(img)
    finish_frame(arr, restore_alpha(run_model(tensor), meta), output_path)

# 默认 --states 为 None → 处理 assets-raw 全部帧（GPU 全量扣图）。
# 帧间尺寸漂移统一由下游 assemble 的有界非等比归一化收口，CPU 版仅作应急兜底。


def main():
    import argparse
    ap = argparse.ArgumentParser(description="GPU 抠图：assets-raw → taozi-pet/incoming-assets（默认全量）")
    ap.add_argument('files', nargs='*', help='指定文件（默认处理 --states 全部）')
    ap.add_argument('--states', nargs='*', default=None,
                    help='只处理这些状态（默认 None=全部状态；帧间尺寸漂移由下游 assemble 归一化收口）')
    ap.add_argument('--cpu', action='store_true', help='强制 CPU 推理（无 GPU 兜底）')
    ap.add_argument('--serial', action='store_true',
                    help='关闭流水线，逐帧 准备→推理→收尾 全在主线程（便于定位问题或测单帧耗时）')
    args = ap.parse_args()
    if args.cpu:
        os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    jobs = job_list(select_frames(args.files, args.states))

    t_start = time.perf_counter()
    success = 0

    def report(done, fname, err=None):
        nonlocal success
        if err is None:
            success += 1
        el = time.perf_counter() - t_start
        tail = 'OK' if err is None else f'ERROR {err}'
        print(f'  [{done}/{len(jobs)}] {fname} {tail}  ({el:.0f}s, {el / done:.2f}s/frame)')

    def run_serial():
        """逐帧同步：准备→推理→收尾全在主线程，便于定位问题或测单帧耗时。"""
        for n, (fname, in_path, out_path) in enumerate(jobs, 1):
            try:
                process_image(in_path, out_path)
                report(n, fname)
            except Exception as e:
                report(n, fname, e)

    def run_pipeline():
        """三阶段流水线：预取线程准备模型输入 → 主线程只跑推理 → 收尾线程后处理并写出。

        三阶段各占一个线程，任一阶段慢下来都会立刻被下一帧的其它阶段掩盖；
        实测主线程只剩推理时间，GPU 利用率与 CPU 并行度同时抬升。
        """
        from collections import deque
        from concurrent.futures import ThreadPoolExecutor
        pending_pre, pending_post = deque(), deque()
        it = iter(jobs)
        n = 0

        def drain_post(force=False):
            nonlocal n
            while pending_post and (force or len(pending_post) >= PIPELINE_DEPTH):
                fut, fname = pending_post.popleft()
                n += 1
                try:
                    fut.result()
                    report(n, fname)
                except Exception as e:
                    report(n, fname, e)

        with ThreadPoolExecutor(max_workers=1) as pool_pre, \
                ThreadPoolExecutor(max_workers=1) as pool_post:
            def push_pre():
                job = next(it, None)
                if job:
                    pending_pre.append((job, pool_pre.submit(read_frame, job[1])))

            for _ in range(PIPELINE_DEPTH):   # 先填满预取队列，让首帧不必等
                push_pre()
            while pending_pre:
                (fname, _, out_path), fut = pending_pre.popleft()
                push_pre()                    # 立刻补下一个预取，与本次推理并行
                try:
                    arr, tensor, meta = fut.result()
                except Exception as e:
                    n += 1
                    report(n, fname, e)
                    continue
                prob = run_model(tensor)      # 主线程只做这一件事
                pending_post.append(
                    (pool_post.submit(finish_alpha, arr, prob, meta, out_path), fname))
                drain_post()
            drain_post(force=True)

    (run_serial if args.serial else run_pipeline)()
    el = time.perf_counter() - t_start
    print(f'Done: {success}/{len(jobs)} succeeded in {el:.1f}s ({el / max(1, len(jobs)):.2f}s/frame)')

if __name__ == '__main__':
    main()
