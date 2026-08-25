# QA 指南

本文档说明本项目在 `tools/` 下的 QA 与校验体系：它们各自检什么、怎么跑、输出在哪、如何扩展。

## 一、一句话总览

一条命令跑完所有静态检查与素材质量检测：

```bash
npm run check
```

等价于依次执行 `tsc --noEmit` + 4 个契约/结构校验 + 3 个 QA。**全部通过才返回退出码 0。**

## 二、检查项全景

| 脚本 | 命令 | 关卡 | 检查什么 |
|---|---|---|---|
| validate-dev-contract.mjs | 随 `check` | contract | 开发契约：核心文件存在、dev 脚本受控、webpack devtool/端口受控、渲染 CSP 严格、渲染就绪门控 |
| validate-spec.mjs | 随 `check` | spec-contract | pet-spec 结构契约：元信息一致、素材管线/尺寸/build 配置合法、状态机结构、帧数产能区间、互动动作连通 |
| validate-asset-links.mjs | 随 `check` | asset-links | spec 引用 ↔ 磁盘文件完全对应（缺失/孤儿/大小写冲突），渲染进程递归导入素材 |
| qa-ui.mjs | `npm run qa:ui` | 见下 | 渲染 / 部署层检查 |
| qa-experience.mjs | `npm run qa:experience` | 见下 | 行为 / 体验语义检查 |
| qa-assets.mjs | `npm run qa:assets` | 像素级 | 素材 PNG 逐帧像素质检 |

> 各脚本可单独运行；`check` 只是把它们串起来。

## 三、三个 QA 详解

### qa-ui.mjs（13 项）

| 关卡 | 检查 | 说明 |
|---|---|---|
| window | dashboard/pet-transparent-root | html/body 透明 + 页面级 overflow hidden |
| window | dashboard-hidden-scrollbar | 内部滚动不露系统滚动条 |
| window | native-control-reset | 原生控件重置系统外观 |
| window | drag-bar-full | 拖拽条 `-webkit-app-region:drag`，碰撞区内可点元素 `no-drag` |
| src+spec | scale-slider-range | 桌宠缩放滑块范围 50%–150% |
| window | bubble-fixed-size | 气泡用固定 px，不随桌宠缩放 |
| window | bubble-zone-height | CSS 气泡区高度与主进程 `PET_BUBBLE_ZONE` 一致 |
| spec | default-pet-size | 默认可见主体 120–175px |
| spec | minimum-pet-size | 最小可见主体 ≤150px |
| src | png-tray-runtime | 托盘加载打包 PNG、拒绝空图 |
| asset | tray-icon-file | 托盘图标 32×32、可见率 ≥8% |
| src | menu-emoji | 系统与互动菜单使用语义 emoji |

### qa-experience.mjs（8 项，纯体验语义）

> 结构类（trigger 唯一、每状态有 trigger、素材未用/缺失等）**不在此重复维护**，已收敛到 validate-spec / validate-asset-links。本文件只负责运行时体验正确性，避免同规则多处漂移。

| 关卡 | 检查 | 说明 |
|---|---|---|
| interrupt-matrix | caninterrupt-id-exists | canInterrupt 引用的 id 必须存在 |
| interrupt-matrix | caninterrupt-live-lock ⚠ | loop + 全通配(*) 的永久卡死态（如 notify），warning |
| interrupt-matrix | caninterrupt-idle-redundant ⚠ | 名单含 idle 属冗余（idle 本可被任意抢占），warning |
| interrupt-matrix | caninterrupt-covering ⚠ | 每个非 idle 状态至少被一个其它状态可打断 |
| interaction | interaction-connected | 菜单 trigger 与互动状态 stateId 运行时连通 |
| motion | interaction-frames-min | 互动状态去重帧数 ≥6 |
| motion | motion-procedural | breathing / squashStretch 至少启用一项 |
| quotes | quote-sync | 状态语录与互动反馈语录均非空 |

⚠ = warning，仅提示不阻断。

### qa-assets.mjs（素材管道，独立）

在 512×512 PNG 上做**逐帧像素级算法质检**，与前面静态检查不同，是重型管道，不适配 runChecks：

- **单帧**：尺寸/透明/贴边/锚点漂移/占用率
- **地面残留**：连通域悬空地面、贴地均匀色带、饱和色带
- **跨帧稳定**：同一状态内主体缩放/中心/底基线漂移
- **重复帧**：sha256 去重，复制帧不算动画
- **回归基线**：`qa/asset-hashes.json` 记录每帧哈希，检测 PNG 静默漂移
- 产物：`qa/contact-sheet.png` + `qa/assets-report.json`

支持参数：`--state=<id>`（单测某状态）、`--assets=<dir>`、`--qa=<dir>`。

## 四、共性框架 qa-common.mjs

QA 与校验共享一个极小的框架，保证所有脚本输出/报告/退出码一致：

- **makeCheck**：把每个检查归一为 `{ id, gate, severity, describe, run }`，`run()` 返回 `{ passed, detail }`
- **runChecks**：逐个执行并收集，分级输出（`severity: 'error'` 阻断 / `'warning'` 提示），写入 `qa/*-report.json`，设置退出码
- **blockDecl / hasProps**：轻量 CSS 解析，按选择器定位声明、顺序无关匹配（替代脆弱正则）
- **loadJson / loadSpec / PROJECT_ROOT**：从项目根统一读取配置，与运行 cwd 解耦
- **parseArgv**：统一 CLI 解析（`--flag value`，末位无值静默忽略，含越界保护）
- **assetSetsFromSpec**：统一「spec 定义了哪些 PNG」

## 五、产物

QA 报告统一落在 `qa/`：

| 文件 | 来源 |
|---|---|
| ui-report.json | qa-ui（runChecks） |
| experience-report.json | qa-experience（runChecks） |
| spec-validation-report.json | validate-spec（runChecks） |
| dev-contract-report.json | validate-dev-contract（runChecks） |
| asset-links-report.json | validate-asset-links（runChecks） |
| assets-report.json / contact-sheet.png | qa-assets |
| asset-hashes.json | qa-assets 回归基线 |

`manual-checklist.md` 为人工复核清单，非自动生成。

## 六、职责边界（防漂移的核心约定）

| 层面 | 归属 |
|---|---|
| spec 结构契约 / spec↔package/forge | validate-spec |
| spec ↔ 磁盘文件存在性 | validate-asset-links |
| 素材文件像素质量 | qa-assets |
| 运行时体验语义（打断矩阵/动画/语录/连通） | qa-experience |

**每个规则只在一个文件维护。** 新增检查时先判断它属于上述哪一层，避免与既有脚本重复。

## 七、如何新增一个检查

```js
import { makeCheck, runChecks, loadSpec } from './qa-common.mjs';

const spec = await loadSpec();
const checks = [
  makeCheck({
    id: 'my-new-rule',
    gate: 'some-gate',
    describe: '这条规则检查什么',
    run: () => {
      const ok = /* 判断逻辑 */;
      return { passed: ok, detail: ok ? '通过' : '失败原因' };
    },
  }),
];
const ok = await runChecks({ name: 'My QA', reportFile: 'my-report.json', checks });
if (!ok) process.exit(1);
```

需要「只提示不阻断」时，把 `severity` 设为 `'warning'`。