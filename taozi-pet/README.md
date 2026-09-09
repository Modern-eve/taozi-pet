# 素材流水线（taozi-pet）

> **相关文档**
>
> - [README.md](../README.md) —— 应用完整文档（架构 · 状态机 · 数值规则 · 使用说明）
> - [tools/README.md](tools/README.md) —— QA 与校验体系指南

蓝发二次元女孩「套子」的桌面宠物项目（Electron + Electron Forge）。

- 应用代码：`taozi-pet/`
- 角色母版源图：`core-ip.jpg`
- 白底素材：`assets-raw/`
- 透明抠图 + 整合层：`taozi-pet/incoming-assets/`（由 `preprocess-v7-gpu.py` / `preprocess-v7-cpu.py` 抠图直出，再经 `assemble-incoming-assets.py` 原地归一化）

## 素材处理流程

新增/修改角色动画帧后，按下述步骤把新图整合进桌宠资源。

```
assets-raw/  (新图丢进来：白底 PNG/JPG/WebP/BMP 任意格式，命名可能不连续、扩展名可能不实)
   │  ★ 第 1 步 rename-assets.py  (按文件头魔数正名扩展名 + 帧号收拢为 01..NN，统一收敛为 .jpg)
   ▼
assets-raw/  (纯白底图，<state>-01..NN.jpg)
   │  preprocess-v7-gpu.py / -cpu.py  (GPU/CPU 抠白底 → 透明帧，直出 incoming-assets)
   ▼
taozi-pet/incoming-assets/  (透明抠图)
   │  assemble-incoming-assets.py  (全部 12 状态原地占用率归一化 + 居中；idle/blink 做帧间尺寸对齐)
   ▼
taozi-pet/src/assets/pet/  (node tools/process-assets.mjs 渲染为最终桌宠素材)
   │  node tools/validate-spec.mjs + node tools/qa-assets.mjs  (校验)
   ▼
QA: PASS (133/133)
```

> ⚠️ **第 1 步不能跳过**：`assemble-incoming-assets.py` 按 `pet-spec.json` 的 frames 取清单（**不扫描目录**），
> 帧号不连续会直接漏帧。
>
> 扩展名错**不会**卡住抠图——`preprocess-v7` 按内容解码（png/jpg/jpeg/webp/bmp 通吃，输出统一为透明 png）。
> 但扩展名骗人会让目录不可信，所以 `rename-assets.py` 按**文件头魔数**判定真实格式并正名
> （历史导出把 JPEG 存成 `.png`，会被改名为 `.jpg`）。

### 各脚本职责

Python 脚本在**仓库根目录**运行，Node 工具在 `taozi-pet/` 内运行。

| 脚本 | 输入 → 输出 | 职责 |
| --- | --- | --- |
| `rename-assets.py` | `assets-raw/` 内原地整理 | **流水线第 1 步**：按**文件头魔数**判定真实格式并正名（扩展名与内容不符时改名，如 `peek-01.png` 内容实为 JPEG → `peek-01.jpg`）；按帧号排序收拢为连续 `01..NN`（数字缺口顺移、x.5 过渡帧并入、消除文件名空格），**统一收敛为 `.jpg`**（真 jpg 免重编码、其余解码后存 JPEG q95，RGBA 源按 RGB 落盘）。`--prefix` 指定状态（可传多个），`--dir` 换目录；默认 dry-run，`--apply` 落盘。命名冲突按**源文件修改日期最新者直接覆盖**旧的（不再送回收站） |
| `preprocess-v7-gpu.py` | `assets-raw/` → `incoming-assets/` | GPU 抠白底（BiRefNet + CUDA），**默认全量**。输入 png/jpg/jpeg/webp/bmp（按内容解码，扩展名不可信），**输出统一为透明 png**；`--states` 可限定部分状态，`--cpu` 强制 CPU 推理 |
| `preprocess-v7-cpu.py` | `assets-raw/` → `incoming-assets/` | CPU 抠白底（洪水填充）。**应急兜底**，默认只处理 8 个常用状态，walk/sleep/sad/peek 需显式 `--states`；输入格式与输出规则同 GPU 版 |
| `assemble-incoming-assets.py` | `incoming-assets/` 原地归一化 | 全部 12 状态按 `sourceOccupancy` 缩放 + 居中 + 底部对齐到 `sourceCanvas`。idle/blink（lockedBody）额外做帧间尺寸对齐消除 `SCALE_DRIFT` |
| `tools/process-assets.mjs` | `incoming-assets/` → `src/assets/pet/` | 渲染为最终 512×512 桌宠素材（去背景、羽化、按状态统一尺寸、按 anchor 落位） |
| `tools/validate-spec.mjs` / `tools/qa-assets.mjs` | — | 校验 pet-spec 结构与素材像素质量，目标 `PASS (133/133)` |
| `repair-src-for-qa.py` | `qa/assets-report.json` → `src/assets/pet/` | 按 QA 报告自动修复失败帧（`SCALE_DRIFT` / `OCCUPANCY_TOO_LARGE` / `GROUND_RESIDUE` / `SUBJECT_TOUCHES_BORDER`），`--dry-run` 可预览 |
| `make-graphics.py` | `core-ip.jpg`(+`sad-ip.jpg`/`sleep-ip.jpg`) → 托盘图标 / 状态头像 | 复用 `preprocess-v7-gpu.py`（BiRefNet GPU）抠图，从母版头部生成 32×32 透明托盘图标 + 三张页面状态头像，**与动画帧流水线解耦** |

#### 补充说明

- **`assemble` 的归一化**：读 `pet-spec.json` 的帧清单（**不扫描目录**），以状态内**中位数帧**尺寸为参考；lockedBody（idle/blink）直接对齐参考尺寸，其余状态用有界非等比缩放（sx/sy 偏差 cap=0.035）吸收 GPU 抖动。
- **`preprocess` 的输入与输出**：输入支持 png/jpg/jpeg/webp/bmp（PIL 按内容解码，扩展名仅用于筛选文件），输出统一为透明 png（需 alpha 通道）。同名不同格式（如 `walk-01.jpg` 与 `walk-01.png`）会输出成同一个 png、后者覆盖前者——上游 `rename-assets.py` 已做格式正名 + 编号收拢（冲突按最新覆盖），正常流程不会出现同名不同格式。
- **`repair-src-for-qa.py` 修的是产物层** `src/assets/pet/`，不修上游 `incoming-assets/`。所以**每次全量 `process-assets` 重跑都会覆盖此前的修复**，需要在 `process-assets` 之后、`qa-assets` 之前重跑本脚本。

### 标准命令

```bash
# 1) 帧整理（新增/替换素材后必做）：格式正名 + 编号收拢为 01..NN（去掉 --apply 可先预览）
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
C:\PYTHON312\python.exe rename-assets.py --prefix <状态> --apply
#   rename 统一把源收敛为 .jpg，preprocess 再统一产出透明 .png

# 2) 抠白底（GPU，需 conda 环境 my_project；首次会下载 BiRefNet 模型）
#    在 my_project 环境下运行 preprocess-v7-gpu.py

# 3) 组装 + 归一化 + 渲染
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
C:\PYTHON312\python.exe assemble-incoming-assets.py
cd taozi-pet
<node> tools/process-assets.mjs          # 全状态；也可 --state <id> 单状态

# 4) 校验
<node> tools/validate-spec.mjs
<node> tools/qa-assets.mjs               # 期望输出 PASS (133/133)

# 5) QA 兜底（可选）：qa 报错时按报告自动修复
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
C:\PYTHON312\python.exe repair-src-for-qa.py --dry-run
```

### 更新托盘图标与状态头像（make-graphics.py）

两类产物都由 `make-graphics.py` 从**母版源图头部**独立裁剪生成，**与动画帧流水线解耦**：

- 托盘图标 `taozi-pet/src/assets/tray/tray-icon.png`（32×32 透明 PNG）：源 `core-ip.jpg`
- 页面状态头像 `taozi-pet/src/renderer/dashboard/assets/avatar-{ip,sad,sleep}.png`（256×256，状态页随情绪切换）：源 `core-ip.jpg` / `sad-ip.jpg` / `sleep-ip.jpg`

抠图复用 `preprocess-v7-gpu.py`（BiRefNet GPU 推理，发丝/半透明/头顶光环更完整），替代早期自实现的 flood-fill。因此运行需要 torch/CUDA 环境（`conda activate my_project`），与 preprocess 同条件。

```bash
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
conda activate my_project

# 仅更新托盘图标（向后兼容）
python make-graphics.py

# 同时更新托盘图标 + 三张页面状态头像
python make-graphics.py --dashboard

# 自定义裁剪区域（原图坐标，x1,y1,x2,y2）
python make-graphics.py --crop 571,134,1109,672

# 自定义源图 / 输出（托盘）
python make-graphics.py --core my-source.png --out tray-new.png

# 想留 2px 内边距（把内容最大边限制到 28，等比缩放到 28 后居中贴到 32×32 画布）
python make-graphics.py --inner 28
```

**何时跑**：

- 换 `core-ip.jpg` / `sad-ip.jpg` / `sleep-ip.jpg`（例如新立绘/新表情），跑一次 `--dashboard` 即可同步托盘与状态头像；
- 改了 `idle` / `happy` 等动画帧，**不需要**重新生成——图标/头像与动画无关；
- 头部裁剪用相对比例，1680×2240 与 1536×2048 的 3:4 立绘会自动适配；个别姿势头部偏移时可给对应源图覆盖 `--crop`。

**为什么走母版源图而非任一动画帧**：母版是"角色的真相"，不再变；动画帧可能改但不该影响托盘形象。把图标/头像与动画解耦后，UI 标识稳定可预期。

### 关键约定

- **素材共 133 张 base 帧**：idle 状态的帧素材是 `look-01..07.png`（7 帧，状态 id 仍为 idle 以保持 app:start/ambient:idle 语义），blink 为 `blink-01..06.png`（6 帧），其余 10 状态各 12 帧；无 `-r2`。非循环状态的「播两遍」通过 `pet-spec.json` 的 frames 重复引用 base 文件名实现（如 blink 12 项 = 6 帧 × 2）。
- **`pet-spec.json`（`taozi-pet/pet-spec.json`）是帧清单唯一权威**：新增帧时在 spec 的 frames 里加文件名即可。
- **资产阈值唯一权威**：归一化/边距/占用率等参数统一收敛到 `pet-spec.json` 的 `assetPipeline`——`targetOccupancy`/`safeMargin`（`process-assets.mjs` 输出层），以及 `sourceCanvas`/`sourceMargin`/`sourceOccupancy`/`sourcePad`（py 上游预处理层）。所有脚本（py + mjs）读取同一份配置，改一处即全局生效，避免阈值漂移。
- **GPU 抠图为默认全量**（`preprocess-v7-gpu.py` 不加 `--states` 即处理全部 12 状态）。GPU 图若触发 QA 问题优先由下流解决：扩展 `assemble` 归一化覆盖范围、对 idle/blink 做帧间尺寸对齐（消除 `SCALE_DRIFT`），而非退回 `CPU` 版——CPU 版仅作最后手段。

### 启动与打包

```bash
cd taozi-pet
npm run dev              # 开发运行
npm run package:win      # 打包
npm run portable:win     # 便携版
```
