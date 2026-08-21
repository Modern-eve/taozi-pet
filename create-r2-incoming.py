import shutil
import os
import json

ROOT = os.path.dirname(os.path.abspath(__file__))
INCOMING = os.path.join(ROOT, 'taozi-pet', 'incoming-assets')
SPEC = os.path.join(ROOT, 'taozi-pet', 'pet-spec.json')

with open(SPEC, encoding='utf-8') as f:
    spec = json.load(f)

non_loop = ['blink', 'happy', 'notify', 'peek', 'pet-head', 'pumpkin-bag', 'petal-spin', 'starfish-wave']

count = 0
for state in spec['states']:
    if state['id'] in non_loop:
        # First 12 are original, next 12 are -r2
        original_frames = state['frames'][:12]
        for f in original_frames:
            r2_name = f.replace('.png', '-r2.png')
            src = os.path.join(INCOMING, f)
            dst = os.path.join(INCOMING, r2_name)
            if os.path.exists(src) and not os.path.exists(dst):
                shutil.copy2(src, dst)
                count += 1

print(f'Created {count} -r2 copies in incoming-assets')
