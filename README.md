# 套子桌宠（taozi-pet）

蓝发二次元女孩「套子」的桌面宠物项目（Electron + Electron Forge）。

- 应用代码：`taozi-pet/`
- 角色母版源图：`core-ip.png`
- 白底素材：`assets-raw/`
- 透明抠图 + 整合层：`taozi-pet/incoming-assets/`（由 `preprocess-v7 -gpu.py` / `preprocess-v7-cpu.py` 抠图直出，再经 `assemble-incoming-assets.py` 原地归一化）

## 素材处理流程

新增/修改角色动画帧后，按下述步骤把新图整合进桌宠资源。

```
assets-raw/  (纯白底 PNG)
   │  preprocess-v7 -gpu.py / -cpu.py  (GPU/CPU 抠白底 → 透明帧，直出 incoming-assets)
   ▼
taozi-pet/incoming-assets/  (透明抠图)
   │  assemble-incoming-assets.py  (对 matted 状态原地占用率归一化 + 居中；其余已就绪跳过)
   ▼
taozi-pet/src/assets/pet/  (node tools/process-assets.mjs 渲染为最终桌宠素材)
   │  node tools/validate-spec.mjs + node tools/qa-assets.mjs  (校验)
   ▼
QA: PASS (142/142)
```

### 各脚本职责（都在仓库根目录，单一职责、数据驱动）

| 脚本 | 作用 |
|------|------|
| `preprocess-v7 -gpu.py` | GPU 抠白底（BiRefNet + CUDA），`assets-raw/` → `taozi-pet/incoming-assets/`（仅 `--states` 默认的 4 个 matted 状态）。CPU 回退版：`preprocess-v7-cpu.py`（输出 `incoming-assets` 的其余 8 个状态） |
| `assemble-incoming-assets.py` | 组装 + 归一化 `incoming-assets`：`--matted-states`（默认 walk/peek/sleep/sad）从 `incoming-assets` 读取 preprocess 写入的透明帧，原地做占用率归一化（居中 + 底部对齐到 `sourceCanvas` 画布）写回；其余状态已在 `incoming-assets` 就绪，跳过。阈值唯一权威来自 `pet-spec.json` 的 `assetPipeline.source*`（`sourceCanvas`/`sourceMargin`/`sourceOccupancy`/`sourcePad`） |
| `rename-assets.py` | 重命名工具：数字缺口顺移、x.5 过渡帧收拢为连续整数（默认 dry-run，`--apply` 执行） |
| `repair-src-for-qa.py` | 按 `qa/assets-report.json` 自动修复失败帧（SCALE_DRIFT / OCCUPANCY_TOO_LARGE / GROUND_RESIDUE / SUBJECT_TOUCHES_BORDER），`--dry-run` 可预览 |
| `tools/process-assets.mjs` | 把 `incoming-assets` 渲染为 `src/assets/pet/`（在 `taozi-pet/` 内运行） |
| `tools/validate-spec.mjs` / `tools/qa-assets.mjs` | 校验 pet-spec 与素材，目标 `PASS (142/142)` |

### 标准命令

```bash
# 1) 抠白底（GPU，需 conda 环境 my_project；首次会下载 BiRefNet 模型）
#    在 my_project 环境下运行 preprocess-v7 -gpu.py

# 2) 组装 + 归一化 + 渲染
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
C:\PYTHON312\python.exe assemble-incoming-assets.py
cd taozi-pet
<node> tools/process-assets.mjs          # 全状态；也可 --state <id> 单状态

# 3) 校验
<node> tools/validate-spec.mjs
<node> tools/qa-assets.mjs               # 期望输出 PASS (142/142)

# 4) 重命名帧（可选）：把某目录某状态的帧号收拢为连续整数
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
C:\PYTHON312\python.exe rename-assets.py --dir taozi-pet/incoming-assets --prefix walk --apply

# 5) QA 兜底（可选）：qa 报错时按报告自动修复
C:\PYTHON312\python.exe repair-src-for-qa.py --dry-run
```

> 注：`<node>` 使用托管 Node `C:\Users\Modern_eve\.workbuddy\binaries\node\versions\22.22.2\node.exe`。
> 系统 Python 3.12（`C:\PYTHON312\python.exe`）已装 PIL/numpy，用于各 `.py` 脚本。

### 关键约定

- **素材只有 142 张 base 帧，无 `-r2`**。非循环状态的「播两遍」通过 `pet-spec.json` 的 frames 重复引用 base 文件名实现。
- **`pet-spec.json`（`taozi-pet/pet-spec.json`）是帧清单唯一权威**：新增帧时在 spec 的 frames 里加文件名即可。
- **资产阈值唯一权威**：归一化/边距/占用率等参数统一收敛到 `pet-spec.json` 的 `assetPipeline`——`targetOccupancy`/`safeMargin`（`process-assets.mjs` 输出层），以及 `sourceCanvas`/`sourceMargin`/`sourceOccupancy`/`sourcePad`（py 上游预处理层）。所有脚本（py + mjs）读取同一份配置，改一处即全局生效，避免阈值漂移。
- **GPU 抠图只适配 4 个状态**（walk/peek/sleep/sad）；idle/blink/happy/notify/pet-head/pumpkin-bag/petal-spin/starfish-wave 这 8 个状态必须用 CPU(v7) 输出到 incoming-assets，否则破 QA 契约（idle/blink 的 lockedBody 一致性、其余 6 个的占用率上限）。
- **`assemble` 的 `--matted-states` 默认绝不可含 idle/blink**：二者为 lockedBody，已提交的 CPU 帧天然满足 ≤2.5% 宽高一致，归一化反而会触发 `SCALE_DRIFT`。

### 启动与打包

```bash
cd taozi-pet
npm run dev              # 开发运行
npm run package:win      # 打包
npm run portable:win     # 便携版
```
