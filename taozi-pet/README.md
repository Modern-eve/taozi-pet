# 套子桌宠

基于 Electron 的跨平台桌面宠物。「套子」是一只活泼俏皮的元气小精灵（蓝紫渐变长发、紫色眼睛、海星羽毛发饰、南瓜包），会驻留在桌面一角，与你互动、说话、提醒你，甚至帮你存文件。

## 特性

- **状态机驱动的拟真动作**：待机 / 眨眼 / 睡觉 / 开心 / 伤心 / 走路 / 贴边窥视 / 提醒等多个状态自由切换，支持呼吸、挤压回弹等程序化动效。
- **4 个角色专属互动**：摸头、掏南瓜包、裙子转圈、海星挥手，触发后播放动画并回复语录、增长好感度。
- **自由尺寸**：气泡区与精灵解耦，桌宠可在 50%–150% 间**滑块自由缩放**，气泡尺寸不随桌宠变化。
- **语录小屋**：状态语录与互动语录均可在线编辑，单一数据源，编辑即生效、重启保留。
- **提醒**：到点后桌宠连续提醒，点击桌宠或其他动作即完成。
- **系统集成**：托盘图标、置顶显示、鼠标穿透、贴边吸附、随机行走、开机自启、右键菜单。
- **文件口袋**：拖拽/放入文件即收纳到 `文档/套子桌宠` 目录。
- **一键重置**：语录、状态、提醒、设置一键恢复到最初默认值。

## 技术架构

- **主进程** `src/main.ts`：窗口/托盘/IPC 控制、数据持久化、状态分发。
- **渲染进程** `src/renderer/`：
  - `pet/`：桌宠窗口，状态机 + 动画 + 气泡 + 拖拽 + 交互。
  - `dashboard/`：小屋面板（状态 / 语录 / 提醒 / 设置）。
- **共享层** `src/shared/contracts.ts`：类型契约、IPC 参数校验。
- **数据**：语录、设置、状态、提醒以 JSON 原子写入 `userData`，损坏自动回退默认值。
- **配置源** `pet-spec.json`：角色、状态机、语录、主题、素材管线等**唯一权威配置**。

```
src/
  main.ts              主进程（IPC、窗口、托盘、状态调度）
  preload.ts           预加载（安全暴露 petAPI，CSP 严格）
  shared/contracts.ts  类型契约与数据校验
  main/
    data-validation.ts  settings/quotes/stats/reminders 数据解析与阈值
    persistence.ts      原子化 JSON 读写
    drag.ts             拖拽阈值、吸附计算
    logger.ts           JSON 结构化日志
    typing-listener.ts  输入监听（占位，需原生库）
  renderer/
    pet/                桌宠窗口（状态机、动画、气泡、拖拽、互动）
    dashboard/          小屋面板（状态、语录、提醒、设置、重置）
  assets/
    pet/                运行时精灵 PNG（512×512 逐帧）
    tray/               托盘图标
pet-spec.json           角色 / 状态机 / 语录 / 主题 / 素材管线的唯一配置源
tools/                  QA、校验、素材管线、启动/打包脚本（见 tools/README.md）
tests/                  单元 + e2e + 冒烟测试
```

## 快速开始

```bash
# 安装依赖（锁定工具链，务必用 npm ci，勿直接 npm install）
npm ci

# 开发运行（含快速 QA、实时热重载）
npm run dev

# Windows 也可以直接双击 启动桌宠.bat
```

> 首次运行会自动执行 `check:quick`（亚秒级）。启动后无命令行黑窗的**正式打包版**请用下面的打包命令。

## 常用命令

```bash
npm run dev / start    # 开发运行（自动跑 check:quick）
npm run check:quick    # 快速 QA（tsc + 4 契约/结构校验 + ui + experience，亚秒级）
npm run check          # 全量 QA（快速 QA + 素材像素级质检）
npm run test           # 单元测试
npm run test:e2e       # 端到端测试（自动打包 host）
npm run test:dev-smoke # 开发冒烟测试（隔离 userData）
npm run qa:*           # 单项 QA（qa:ui / qa:experience / qa:assets）
npm run process:assets # 素材处理（incoming-assets/ -> src/assets/pet/）
npm run inspect:assets # 查看素材处理报告
npm run doctor         # 环境诊断
npm run package:win / make:win / portable:win   # 打包 / 安装包 / 绿色版
```

## 配置（pet-spec.json）

项目几乎所有行为都由 `pet-spec.json` 驱动，改配置通常不需要改代码：

- `character`：显示名、个性、核心素材帧。
- `states`：12 个状态，各自 `frames`、`triggers`、`canInterrupt`（可打断名单）、`interrupt`、`cooldownMs`、`anchor` 等。
- `experience.quotes` / `interactions[].feedback`：状态语录与互动语录**默认文本**；运行时以 `userData/quotes.json` 为唯一数据源。
- `experience.theme`：主题色（小屋面板）。
- `assetPipeline`：素材处理阈值（背景抠除、占用率、画布等唯一权威配置）。

> 全部语录的默认文本来自这里，首次启动据此生成 `userData/quotes.json`，之后语录页与桌宠都读写这份运行时文件。

## 数据持久化

运行时数据以 JSON 原子写入 Electron 的 `userData` 目录（写临时文件后 rename，防写坏）：

| 文件 | 内容 |
|---|---|
| `quotes.json` | 语录（编辑后的唯一数据源） |
| `settings.json` | 设置（含 `autoStartInit` 自启标记） |
| `pet-stats.json` | 状态（好感度 / 心情 / 今日互动 / 陪伴时长） |
| `reminders.json` | 提醒列表 |
| `logs/app.jsonl` | 结构化日志 |

文件口袋目录：`<文档目录>/套子桌宠`。

## QA 体系

QA 与校验脚本统一在 `tools/`（详见 **tools/README.md**）：

- **快速 QA** `check:quick`：`tsc` + validate-dev-contract / validate-spec / validate-asset-links + qa-ui + qa-experience，开发启动时自动运行，亚秒级。
- **全量 QA** `check`：快速 QA + `qa-assets` 逐帧像素质检（尺寸/透明/贴边/锚点/占用率/地面残留/跨帧稳定/重复帧/回归基线）。
- 责任边界：结构契约归 validate-spec，素材引用归 validate-asset-links，像素质检归 qa-assets，运行时体验语义（打断矩阵、动画、语录、连通性）归 qa-experience。**每条规则只在一个文件维护**，防止漂移。

## 状态机行为（帧数 / 帧率 / 打断优先级）

12 个状态每帧 `frameDurationMs: 250ms`（即 **4 FPS**）；非循环动作通常把 12 张独立帧按序**播两遍**（播放帧=24）构成完整单次动画，素材只有 142 张 base 帧、无 `-r2` 副本。

| 状态 | 动作 | 独立帧 | 播放帧 | 类型 | 单周期 | 触发器 | 冷却 |
|---|---|---|---|---|---|---|---|
| idle | 待机 | 12 | 12 | 循环 | 3.0s | app:start / ambient:idle | — |
| blink | 眨眼 | 12 | 24 | 单次 | 6.0s | ambient:blink | 2.5s |
| happy | 开心 | 12 | 24 | 单次 | 6.0s | pointer:tap（单击） | 0.3s |
| notify | 提醒 | 12 | 24 | 循环 | 6.0s | reminder:due | 0.8s |
| peek | 贴边窥视 | 12 | 24 | 单次 | 6.0s | window:edge-snap（吸附） | 1.8s |
| pet-head | 摸头 | 12 | 24 | 单次 | 6.0s（展示 12s） | interaction:pet-head | 0.25s |
| pumpkin-bag | 掏南瓜包 | 12 | 24 | 单次 | 6.0s（展示 12s） | interaction:pumpkin-bag | 0.3s |
| petal-spin | 花瓣转圈 | 12 | 24 | 单次 | 6.0s（展示 12s） | interaction:petal-spin | 0.3s |
| starfish-wave | 海星招手 | 12 | 24 | 单次 | 6.0s（展示 12s） | interaction:starfish-wave | 0.3s |
| walk | 走路 | 12 | 12 | 循环 | 3.0s | state:walk | 0.5s |
| sleep | 睡觉 | 10 | 10 | 循环 | 2.5s | state:sleep | 1.0s |
| sad | 沮丧 | 12 | 12 | 循环 | 3.0s | state:sad（心情↓25） | 1.0s |

> 每个状态还带 `anchor`（锚点）、`mirrorSafe`、`interrupt`（resume/restart）等配置，全部收敛在 `pet-spec.json`。周期 = 播放帧数 × 250ms。

### 打断优先级（canInterrupt 名单）

优先级通过 `canInterrupt`（"可打断名单"）实现：状态机 `start()` 时，只要**当前状态是 idle**，或**新状态可打断名单包含当前状态 id** 就允许切换。名单越宽越"霸道"，层次从高到低：

| 层级 | 状态 | 可打断（canInterrupt） | 会被谁打断 |
|---|---|---|---|
| **1（最高）** | 摸头 / 掏南瓜包 / 转圈 / 海星招手 | `['*']` 可打断一切 | 任何状态下都**不被打断**，彼此互不打断 |
| 2 | happy 开心 | idle、blink、walk、sleep、notify、peek | sad、notify、4 个互动 |
| 3 | notify 提醒 | `['*']`（循环） | happy、4 个互动 |
| 4 | peek 贴边窥视 | idle、blink、walk | happy、sleep、sad、notify、4 个互动 |
| 5 | sleep 睡觉 | idle、blink、walk、peek、sad | happy、notify、4 个互动 |
| 6 | sad 沮丧 | idle、blink、walk、peek、happy | sleep、notify、4 个互动 |
| 7 | walk 走路 | idle、blink | happy、peek、sleep、sad、notify、4 个互动 |
| 8 | blink 眨眼 | idle | happy、peek、walk、sleep、sad、notify、4 个互动 |
| **9（最低）** | idle 待机 | 无（待机被任意状态接管） | 一切 |

> 经验：`canInterrupt` 含自身 id 属冗余；`notify` 为 loop 且名单含 `*` 时存在"进入后无法回 idle"的 live-lock 隐患，QA 以 warning 提示。

## 数值规则

| 数值 | 范围 | 默认 | 规则 |
|---|---|---|---|
| 好感度 affection | 0–100 | 0 | 摸头 +2、掏南瓜包 +3、花瓣转圈 +2、海星招手 +1；**每个互动每天仅首次**加好感（同日重复只加心情与今日互动，防刷）。封顶 100 |
| 心情 mood | 0–100 | 80 | **每 2 分钟 -1**（每分钟检测一次）；**<25 进入「沮丧 sad」**，≥25 回到「待机 idle」。每次互动心情 **+ceil(affectionGain/2)（至少 +1）**，封顶 100 |
| 今日互动 todayInteractions | ≥0 | 0 | 每次互动 +1；跨到新的一天（日期变化）时从 0 起重新累计 |
| 陪伴时长 companionMinutes | ≥0 | 0 | 按实际运行毫秒实时折算为分钟累计 |
| 提醒 reminders | — | 空 | 到点进入 notify 并气泡播报该条文本；**用户触发任意互动即视为完成**（消费当前待处理提醒），每条只提醒一次后自动移除 |

> 数据以 JSON 原子写入 `userData`，损坏自动回退默认值；4 个互动动作 `durationMs=12000ms`，触发互动会顺带消费挂起的提醒。

## 使用说明

- **拖动**：按住桌宠任意拖动，松手自动吸附屏幕边缘（可到面板关闭"随机行走/贴边吸附"）。
- **单击**：桌宠播放「开心」并随机讲一句点击语录。
- **右键桌宠**：弹出菜单——4 个互动动作（💗 摸头 / 🎃 掏南瓜包 / 🌸 花瓣转圈 / 👋 海星招手）、打开状态 / 语录 / 提醒面板、开关鼠标穿透、隐藏桌宠。
- **托盘图标**：显示桌宠、打开状态 / 语录 / 提醒、鼠标穿透开关、设置 / 退出。
- **小屋面板**：
  - **状态页**：查看好感度 / 心情 / 今日互动 / 陪伴时长；开关置顶显示、鼠标穿透、开机自启、随机行走；**滑块自由调整桌宠大小（50%–150%）**；底部**一键重置**（语录 / 状态 / 提醒 / 设置恢复默认）。
  - **语录页**：状态语录与互动语录均可在线编辑，编辑即生效、重启保留（唯一数据源 `userData/quotes.json`）。
  - **提醒页**：新增 / 删除定时提醒，到点由桌宠气泡提醒。
- **数据位置**：运行时数据在 Electron `userData`（`quotes.json` / `settings.json` / `pet-stats.json` / `reminders.json` / `logs/app.jsonl`）。

## 目录约定

- `incoming-assets/`、`assets-processed/`、`qa/` 不纳入 Git 追踪，勿提交。
- 素材源文件经 `tools/process-assets.mjs` 处理为标准 512×512 PNG。