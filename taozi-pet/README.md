# 素材流水线（taozi-pet）

> **相关文档**
>
> - [README.md](../README.md) —— 应用完整文档（架构 · 状态机 · 数值规则 · 使用说明）
> - [tools/README.md](tools/README.md) —— QA 与校验体系指南

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
   │  assemble-incoming-assets.py  (全部 12 状态原地占用率归一化 + 居中；idle/blink 做帧间尺寸对齐)
   ▼
taozi-pet/src/assets/pet/  (node tools/process-assets.mjs 渲染为最终桌宠素材)
   │  node tools/validate-spec.mjs + node tools/qa-assets.mjs  (校验)
   ▼
QA: PASS (144/144)
```

### 各脚本职责（都在仓库根目录，单一职责、数据驱动）

| 脚本                                                  | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preprocess-v7 -gpu.py`                             | GPU 抠白底（BiRefNet + CUDA），`assets-raw/` → `taozi-pet/incoming-assets/`，**默认全量**（`--states` 不设=处理全部 144 帧）；`--states` 可限定只跑部分状态。CPU 版 `preprocess-v7-cpu.py` 仅作**应急还原（最后手段）**，非默认回退                                                                                                                                                                               |
| `assemble-incoming-assets.py`                       | 组装 + 归一化`incoming-assets`：**全部 12 状态**原地归一化（从 `incoming-assets` 读 preprocess 写入的透明帧，按 `sourceOccupancy` 缩放 + 居中 + 底部对齐到 `sourceCanvas` 写回）；`idle/blink` 为 lockedBody，额外做**帧间尺寸对齐**（首帧尺寸为参考）消除 `SCALE_DRIFT`。阈值唯一权威来自 `pet-spec.json` 的 `assetPipeline.source*`（`sourceCanvas`/`sourceMargin`/`sourceOccupancy`/`sourcePad`） |
| `rename-assets.py`                                  | 重命名工具：数字缺口顺移、x.5 过渡帧收拢为连续整数（默认 dry-run，`--apply` 执行）                                                                                                                                                                                                                                                                                                                                                     |
| `repair-src-for-qa.py`                              | 按`qa/assets-report.json` 自动修复失败帧（SCALE_DRIFT / OCCUPANCY_TOO_LARGE / GROUND_RESIDUE / SUBJECT_TOUCHES_BORDER），`--dry-run` 可预览                                                                                                                                                                                                                                                                                          |
| `make-tray-icon.py`                                 | 从`core-ip.png` 头部裁剪生成 `taozi-pet/src/assets/tray/tray-icon.png`（32×32 透明 PNG）。**与动画帧流水线解耦**：core-ip.png 是母版不会变，idle 等动画帧改了不会影响托盘头像；想换头像只需换 core-ip.png 后跑一次本脚本。缩放采用 **alpha 预乘的 LANCZOS**（premultiply → resize → unpremultiply）防止透明区域残留的浅色 RGB 在缩放插值时混进角色边缘产生黑斑；默认满画布（不留内边距）                                                                                                                                                                                                      |
| `tools/process-assets.mjs`                          | 把`incoming-assets` 渲染为 `src/assets/pet/`（在 `taozi-pet/` 内运行）                                                                                                                                                                                                                                                                                                                                                             |
| `tools/validate-spec.mjs` / `tools/qa-assets.mjs` | 校验 pet-spec 与素材，目标`PASS (144/144)`                                                                                                                                                                                                                                                                                                                                                                                             |

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
<node> tools/qa-assets.mjs               # 期望输出 PASS (144/144)

# 4) 重命名帧（可选）：把某目录某状态的帧号收拢为连续整数
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
C:\PYTHON312\python.exe rename-assets.py --dir taozi-pet/incoming-assets --prefix walk --apply

# 5) QA 兜底（可选）：qa 报错时按报告自动修复
C:\PYTHON312\python.exe repair-src-for-qa.py --dry-run
```

### 更新托盘头像

托盘图标（`taozi-pet/src/assets/tray/tray-icon.png`，32×32 透明 PNG）由 `make-tray-icon.py` 独立从 **`core-ip.png` 头部**裁剪生成，与动画帧流水线解耦。

```bash
# 默认：从仓库根的 core-ip.png 裁剪头部（横向居中取 1/2、纵向取前 40%），白底转透明
cd D:\Documents\Doubao\chats\2026-08-12\new-chat
C:\PYTHON312\python.exe make-tray-icon.py

# 自定义裁剪区域（原图坐标，x1,y1,x2,y2）
C:\PYTHON312\python.exe make-tray-icon.py --crop 384,64,1152,820

# 自定义源图 / 输出 / 阈值
C:\PYTHON312\python.exe make-tray-icon.py --core my-source.png --out tray-new.png --white-threshold 240

# 想留 2px 内边距（把内容缩到 28×28 再居中贴到 32×32 画布）
C:\PYTHON312\python.exe make-tray-icon.py --inner 28
```

**何时跑**：

- 换了 `core-ip.png`（例如新立绘），跑一次即可更新托盘；
- 改了 `idle` / `happy` 等动画帧，**不需要**重新生成托盘——它跟动画无关；
- `--crop` 用来调整头部区域；脚本的默认值针对 1536×2048 的 `core-ip.png` 调好，其他分辨率会按比例自动重算。

**为什么走 core-ip.png 而不是 idle-01**：母版源图是"角色的真相"，不会再变；动画帧可能改但不该影响托盘形象。把托盘从 idle 解耦后，UI 的标识稳定可预期。

### 关键约定

- **素材共 144 张 base 帧（12 状态 × 12 帧），无 `-r2`**。非循环状态的「播两遍」通过 `pet-spec.json` 的 frames 重复引用 base 文件名实现。
- **`pet-spec.json`（`taozi-pet/pet-spec.json`）是帧清单唯一权威**：新增帧时在 spec 的 frames 里加文件名即可。
- **资产阈值唯一权威**：归一化/边距/占用率等参数统一收敛到 `pet-spec.json` 的 `assetPipeline`——`targetOccupancy`/`safeMargin`（`process-assets.mjs` 输出层），以及 `sourceCanvas`/`sourceMargin`/`sourceOccupancy`/`sourcePad`（py 上游预处理层）。所有脚本（py + mjs）读取同一份配置，改一处即全局生效，避免阈值漂移。
- **GPU 抠图为默认全量**（`preprocess-v7 -gpu.py` 不加 `--states` 即处理全部 12 状态）。GPU 图若触发 QA 问题优先由下流解决：扩展 `assemble` 归一化覆盖范围、对 idle/blink 做帧间尺寸对齐（消除 `SCALE_DRIFT`），而非退回 `CPU` 版——CPU 版仅作最后手段。

### 启动与打包

```bash
cd taozi-pet
npm run dev              # 开发运行
npm run package:win      # 打包
npm run portable:win     # 便携版
```
