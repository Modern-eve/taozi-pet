from PIL import Image
import os
import glob

src_dir = r'C:\Users\Modern_eve\Doubao\chats\2026-08-12\new-chat\assets-processed'
dst_dir = r'C:\Users\Modern_eve\Doubao\chats\2026-08-12\new-chat\taozi-pet\incoming-assets'

target_width = 1024

files = sorted(glob.glob(os.path.join(src_dir, '*.png')))
print(f'Resizing {len(files)} images to width={target_width}...')

for i, f in enumerate(files):
    img = Image.open(f).convert('RGBA')
    w, h = img.size
    if w != target_width:
        ratio = target_width / w
        new_h = int(h * ratio)
        img = img.resize((target_width, new_h), Image.LANCZOS)
    fname = os.path.basename(f)
    img.save(os.path.join(dst_dir, fname))
    if (i+1) % 20 == 0:
        print(f'  [{i+1}/{len(files)}] done')

print(f'Done: {len(files)} images resized and copied to incoming-assets')
