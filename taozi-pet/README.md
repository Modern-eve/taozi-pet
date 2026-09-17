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
   │  assemble-incoming-assets.py  (全部状态原地占用率归一化 + 居中，同一套有界非等比规则)
   ▼
taozi-pet/src/assets/pet/  (node tools/process-assets.mjs 渲染为最终桌宠素材)
   │  node tools/validate-spec.mjs + node tools/qa-assets.mjs  (校验)
   ▼
QA: PASS (147/147)
```

> ⚠️ **第 1 步不能跳过**：`assemble-incoming-assets.py` 按 `pet-spec.json` 的 frames 取清单（**不扫描目录**），
> 帧号不连续会直接漏帧。
>
> 扩展名错**不会**卡住抠图——`preprocess-v7` 按内容解码（png/jpg/jpeg/webp/bmp 通吃，输出统一为透明 png）。
> 但扩展名骗人会让目录不可信，所以 `rename-assets.py` 按**文件头魔数**判定真实格式并正名
> （内容实为 JPEG 而扩展名写成 `.png` 时，改名为 `.jpg`）。

### 各脚本职责

Python 脚本在**仓库根目录**运行，Node 工具在 `taozi-pet/` 内运行。

| 脚本 | 输入 → 输出 | 职责 |
| --- | --- | --- |
| `rename-assets.py` | `assets-raw/` 内原地整理 | **流水线第 1 步**：按**文件头魔数**判定真实格式并正名（扩展名与内容不符时改名，如 `peek-01.png` 内容实为 JPEG → `peek-01.jpg`）；按帧号排序收拢为连续 `01..NN`（数字缺口顺移、x.5 过渡帧并入、消除文件名空格），**统一收敛为 `.jpg`**（真 jpg 免重编码、其余解码后存 JPEG q95，RGBA 源按 RGB 落盘）。`--prefix` 指定状态（可传多个），`--dir` 换目录；默认 dry-run，`--apply` 落盘。同帧号命名冲突保留**源文件修改日期最新者** |
| `preprocess_common.py` | 被 `preprocess-v7-*.py` 与 `make-graphics.py` 导入 | 抠图管线公共实现（非独立脚本）：源/产物路径、帧名工具（`state_of` / `out_name`）、参数与清单组装（`select_frames` / `job_list`）、保护色 `get_protected_mask`、连通域后处理 `refine_alpha`、内部孔洞合并 `combine_hole_decisions`、洪水填充 `flood_fill_from_edges`、贴边清理 `clear_outer_border`。**GPU 与 CPU 两条路径共用同一份阈值与判据**，调整只改这一处 |
| `preprocess-v7-gpu.py` | `assets-raw/` → `incoming-assets/` | GPU 抠白底（BiRefNet + CUDA），**默认全量**。输入 png/jpg/jpeg/webp/bmp（按内容解码，扩展名不可信），**输出统一为透明 png**；`--states` 可限定部分状态，`--cpu` 强制 CPU 推理，`--serial` 关闭三阶段流水线（默认开启）。`INFER_FP16=0` 可让推理回到 fp32；`USE_FALLBACK=0` 关闭兜底权重（约省一半推理耗时）。基础 alpha 由**主权重（ToonOut）与兜底权重（原版 BiRefNet）**共同决定，兜底只替换主权重挖出的**内部孔洞**——白色部件贴在白底上且缺轮廓线时，主权重会把整块判成背景，在画面内部挖出一个四周都是前景的洞，同一位置原版权重能连上。后处理见 `preprocess_common.py` |
| `preprocess-v7-cpu.py` | `assets-raw/` → `incoming-assets/` | CPU 抠白底（洪水填充）。**应急兜底**，默认全量处理全部状态，`--states` 可限定部分状态；输入格式、输出规则与后处理口径均同 GPU 版（共用 `preprocess_common.py`） |
| `assemble-incoming-assets.py` | `incoming-assets/` 原地归一化 | 全部状态按 `sourceOccupancy` 缩放 + 居中 + 底部对齐到 `sourceCanvas`，**同一套有界非等比规则**（不区分状态） |
| `tools/process-assets.mjs` | `incoming-assets/` → `src/assets/pet/` | 渲染为最终 512×512 桌宠素材（去背景、羽化、按状态统一尺寸、按 anchor 落位）。先按状态内公共比例缩放，再按帧面积校正到状态中位面积（上限 `processMaxCorrection`），最后把最长边夹在 `targetOccupancy + occupancyTolerance` 之内 |
| `tools/validate-spec.mjs` / `tools/qa-assets.mjs` | — | 校验 pet-spec 结构与素材像素质量，目标 `PASS (147/147)` |
| `repair-src-for-qa.py` | `qa/assets-report.json` → `src/assets/pet/` | 按 QA 报告自动修复失败帧（`SCALE_DRIFT` / `OCCUPANCY_TOO_LARGE` / `GROUND_RESIDUE` / `SUBJECT_TOUCHES_BORDER`），`--dry-run` 可预览 |
| `make-graphics.py` | `core-ip.jpg`(+`sad-ip.jpg`/`sleep-ip.jpg`) → 托盘图标 / 状态头像 | 复用 `preprocess-v7-gpu.py`（BiRefNet GPU）抠图，从母版头部生成 32×32 透明托盘图标 + 三张页面状态头像，**与动画帧流水线解耦**；后处理共用 `preprocess_common.py`，与动画帧同口径 |

#### 补充说明

- **`assemble` 的归一化**：读 `pet-spec.json` 的帧清单（**不扫描目录**），以状态内**中位数帧**尺寸为参考，**所有状态统一**用有界非等比缩放（sx/sy 相对统一因子 su 的偏差 ≤ `assetPipeline.sourceScaleAxisCap`，默认 0.035）吸收 GPU 抖动。该规则自适应：姿态几乎不动的状态其 sx≈sy≈su，钳制不生效，结果等同于逐轴精确对齐；姿态变化大的状态保留有限的非等比空间，避免被压扁/拉长。
- **阈值不区分状态**：`assemble` / `process-assets` / `qa-assets` 三步都**读 `pet-spec.json` 的 `assetPipeline` 同一套阈值**，不对任何状态 id / trigger 做分支——动作**改名 / 新增 / 删除**都不需要改代码，也不会出现某一环收紧而另一环放宽的静默失配。相关阈值：`sourceScaleAxisCap`（assemble）、`processMaxCorrection`（process-assets）、`qaMaxScaleRatio` / `qaMaxCenterDrift` / `qaMaxBottomDrift`（qa-assets）；尺度漂移按**等价尺度** √(宽×高) 判定，即允许姿态带来的有限长宽比变化，只拦真实的尺寸/面积漂移。
- **`preprocess` 的输入与输出**：输入支持 png/jpg/jpeg/webp/bmp（PIL 按内容解码，扩展名仅用于筛选文件），输出统一为透明 png（需 alpha 通道）。同名不同格式（如 `walk-01.jpg` 与 `walk-01.png`）会输出成同一个 png、后者覆盖前者——上游 `rename-assets.py` 已做格式正名 + 编号收拢（冲突按最新覆盖），正常流程不会出现同名不同格式。
- **抠图后处理的单一真源**：`preprocess_common.py` 是源/产物路径、帧名工具、保护色、连通域保留判据、内部孔洞合并、洪水填充与贴边宽度的唯一实现，`preprocess-v7-gpu.py`、`preprocess-v7-cpu.py`、`make-graphics.py` 三方共用，调整只改这一处。保护色种子限定在 `alpha > 16` 内，只对模型已判为前景的像素生效，不向轮廓外扩张。
- **内部孔洞合并**（`combine_hole_decisions`）：主权重判出的、被前景完全包住的透明区改用兜底权重的取值。它只改画面内部的孔洞，外轮廓仍由主权重决定；发丝之间的真实透空在两个权重下都是背景、取值一致，不受影响。代价是每帧多跑一次推理（`USE_FALLBACK=0` 可关）。
- **`repair-src-for-qa.py` 修的是产物层** `src/assets/pet/`，不修上游 `incoming-assets/`。全量 `process-assets` 会重写产物层，故本脚本须在 `process-assets` 之后、`qa-assets` 之前运行。

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
<node> tools/qa-assets.mjs               # 期望输出 PASS (147/147)

# 5) QA 兜底（可选）：qa 报错时按报告自动修复
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
C:\PYTHON312\python.exe repair-src-for-qa.py --dry-run
```

### 更新托盘图标与状态头像（make-graphics.py）

两类产物都由 `make-graphics.py` 从**母版源图头部**独立裁剪生成，**与动画帧流水线解耦**：

- 托盘图标 `taozi-pet/src/assets/tray/tray-icon.png`（32×32 透明 PNG）：源 `core-ip.jpg`
- 页面状态头像 `taozi-pet/src/renderer/dashboard/assets/avatar-{ip,sad,sleep}.png`（256×256，状态页随情绪切换）：源 `core-ip.jpg` / `sad-ip.jpg` / `sleep-ip.jpg`

抠图复用 `preprocess-v7-gpu.py`（BiRefNet GPU 推理，发丝/半透明/头顶光环更完整）。因此运行需要 torch/CUDA 环境（`conda activate my_project`），与 preprocess 同条件。

```bash
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
conda activate my_project

# 仅更新托盘图标
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
- 改了 `look` / `happy` 等动画帧，**不需要**重新生成——图标/头像与动画无关；
- 头部裁剪用相对比例，1680×2240 与 1536×2048 的 3:4 立绘会自动适配；个别姿势头部偏移时可给对应源图覆盖 `--crop`。

**为什么走母版源图而非任一动画帧**：母版是角色的权威形象，动画帧的增删改都不应影响托盘形象。把图标/头像与动画解耦后，UI 标识稳定可预期。

### 关键约定

- **素材共 147 张 base 帧**：待机轮播四个动作的素材是 `look-01..07.png`（7 帧，承载 `app:start` / `ambient:idle` 触发语义）、`blink-01..06.png`（6 帧）、`belly-ok-01..06.png`（6 帧）、`kick-01..07.png`（7 帧），待机间歇状态 `standby-gap` 用 `core-ip.png`（1 帧，母版全身静态帧），其余 10 状态各 12 帧；无 `-r2`。待机轮播动作**单轮播放**（每帧只出现一次，frames 直接列一遍），其余非循环状态的「播两遍」通过 `pet-spec.json` 的 frames 重复引用 base 文件名实现（如 happy 24 项 = 12 帧 × 2）。
- **待机间歇帧走同一条流水线**：`standby-gap` 是 `states` 里的普通单帧状态（帧名 `core-ip.png`，源图 `assets-raw/core-ip.jpg`），由 `idleRotation.gap.stateId` 引用。因此它与其他状态共用同一套抠图/归一化/质检规则，工具链无需特判：`preprocess-v7-gpu.py core-ip.jpg`（文件名直传，母版无帧号故不用 `--states`）→ `assemble-incoming-assets.py --states standby-gap` → `node tools/process-assets.mjs --state standby-gap`。间歇长度由 `idleRotation.gap.levels`（按随机行走挡位给**呼吸次数**区间）决定，时长 = 次数 × `motion.breathing.periodMs`，与帧的 `frameDurationMs` 无关。间歇的动感来自 `motion.breathing`（周期 `periodMs`），渲染层按状态挂载该动效，**只有 `standby-gap` 会呼吸**；因为时长恒为呼吸周期的整数倍，间歇结束时呼吸正好走完整数个周期，摘下时不会出现半相位回落。
- **`pet-spec.json`（`taozi-pet/pet-spec.json`）是帧清单唯一权威**：新增帧时在 spec 的 frames 里加文件名即可。
- **资产阈值唯一权威**：归一化/边距/占用率/漂移阈值等全部参数都收敛在 `pet-spec.json` 的 `assetPipeline`——`sourceCanvas` / `sourceMargin` / `sourceOccupancy` / `sourcePad` / `sourceScaleAxisCap`（py 上游预处理层），`processMaxCorrection`（process-assets 的面积校正上限），`targetOccupancy` / `occupancyTolerance` / `safeMargin`（输出层占用率及其上限容差），`qaMaxScaleRatio` / `qaMaxCenterDrift` / `qaMaxBottomDrift`（qa-assets）。所有脚本（py + mjs）读取同一份配置，改一处即全局生效，避免阈值漂移。
- **占用率上限双端一致**：`targetOccupancy` 是目标值，`targetOccupancy + occupancyTolerance` 是硬上限。qa-assets 用它判 `OCCUPANCY_TOO_LARGE`，process-assets 用同一个和夹住帧的最长边——面积校正需要把长宽比偏窄的帧按面积放大，最长边会因此超过目标值，夹到上限即止（占用是硬约束，帧间面积一致性让位于 `qaMaxScaleRatio`）。
- **人物横向占比是窗口收窄的依据**：`experience.petSizing.contentWidthRatio`（当前 0.62）声明人物在帧内最多占多大横向比例，桌宠窗口宽度据此派生，两侧透明留白由窗口裁掉。`qa-ui` 的 `content-width-fit` 会用**全部 147 帧实测的包围盒并集**校验实际占比不超过该值且人物水平居中——换素材后若人物横向变宽，会在 QA 阶段直接报出来。
- **GPU 抠图为默认全量**（`preprocess-v7-gpu.py` 不加 `--states` 即处理全部状态）。GPU 图若触发 QA 问题优先由下流解决：扩展 `assemble` 归一化覆盖范围（消除 `SCALE_DRIFT`），而非退回 `CPU` 版——CPU 版仅作应急兜底。
- **按需重跑，不要全量**：改动脚本或修单帧时用 `preprocess-v7-gpu.py --states <素材前缀>`（或直接传文件名，如 `preprocess-v7-gpu.py happy-11.jpg`）、`assemble-incoming-assets.py --states <状态 id>` 把范围收窄到受影响的帧；只有确实需要重建全部帧时才不加筛选参数。
- **抠图耗时**（RTX 4060 Laptop）：瓶颈依次是 GPU 推理 → 连通域分析 → PNG 编码，故推理走 fp16 autocast、连通域合并为一次分析且只对候选块做全图归约、PNG 用 `compress_level=1`，并让「预取 → 推理 → 收尾」三阶段流水线并行。稳态实测 **0.39 s/帧**（主线程只剩推理时间，GPU 利用率约 82%、CPU 并行度 1.4 核）；`--serial` 关闭流水线可对照，此时 0.72 s/帧、GPU 约 53%。全量 147 帧含模型加载约 2 分钟（兜底权重使每帧跑两次推理）。**瓶颈已完全落在 GPU 推理上**——再叠加 CPU 并行、批处理或 `cudnn.benchmark` 都没有收益，再快只能动模型或输入分辨率。

### 启动与打包

```bash
cd taozi-pet
npm run dev              # 开发运行
npm run package:win      # 打包
npm run portable:win     # 便携版
```
