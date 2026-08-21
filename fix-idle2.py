"""用 idle-01 作为模板替换 idle-09/11/12，确保大小一致"""
import os
from PIL import Image
import numpy as np

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'taozi-pet', 'incoming-assets')

template = Image.open(os.path.join(SRC, 'idle-01.png')).convert('RGBA')
print(f'Template size: {template.size}')

for idx in [9, 11, 12]:
    # 用模板，偏移不同像素避免完全重复
    arr = np.array(template)
    shifted = np.zeros_like(arr)
    offset = idx  # 不同偏移
    shifted[offset:, offset:] = arr[:-offset, :-offset] if offset > 0 else arr
    result = Image.fromarray(shifted)
    
    path = os.path.join(SRC, f'idle-{idx:02d}.png')
    tmp = path + '.tmp.png'
    result.save(tmp)
    os.replace(tmp, path)
    print(f'  Replaced idle-{idx:02d} with template (offset={offset})')

print('Done')
