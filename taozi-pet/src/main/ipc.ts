import { app, ipcMain, Menu, screen } from 'electron';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CacheSweepSummary, DashboardView, Reminder } from '../shared/contracts';
import {
  assertInteractionId,
  assertReminderInput,
  assertRuntimeFailureReport,
  assertRuntimeReadyReport,
  assertSettingsPatch,
  assertStringArray,
} from '../shared/contracts';
import { applyReportedState, canTakeOver, triggerInteraction } from './activity';
import type { MainContext } from './context';
import { parseQuotes, parseSettings } from './data-validation';
import { draggedBounds, snapBounds } from './drag';
import { checkMoodState } from './mood';
import { publicStats, broadcastStats, normalizeStatsDay, persistStats } from './stats';
import { initialQuotes, notifyQuotesChanged, persistQuotes } from './quotes';
import { randomWalkStep } from './random-walk';
import { ackPendingReminder, broadcastRemindersUpdated, clearAllReminders, clearReminderTimer, persistReminders, scheduleReminder } from './reminders';
import { assertSender, commitRuntimeReady, fatalExit, sweepCaches } from './runtime';
import { reportTotalBytes } from './cache-maintenance';
import { saveSettings } from './settings';
import { resetActivityTimer } from './sleep';
import { buildPetMenu } from './tray';
import { filePocket, openPocket, petCharacterWidth, sendActivity, showDashboard, stateForTrigger } from './windows';
import { uniqueDestination } from './persistence';

/** 运行时报到的精灵帧自然尺寸（素材流水线的产物边长，见 tools/process-assets.mjs） */
const PET_FRAME_SIZE = 512;

/** 组装全部 IPC 处理器。每个 handler 先校验发送方角色，再落业务。 */
export function registerIpc(ctx: MainContext): void {
  const spec = ctx.spec;

  if (process.env.PET_E2E === '1') {
    ipcMain.handle('runtime:e2e-snapshot', (event) => {
      assertSender(ctx, event, ['pet', 'dashboard']);
      return (globalThis as typeof globalThis & {
        __PET_E2E__?: { snapshot: () => unknown };
      }).__PET_E2E__?.snapshot();
    });
    ipcMain.handle('runtime:e2e-quit', (event) => {
      assertSender(ctx, event, ['pet', 'dashboard']);
      setTimeout(() => {
        ctx.isQuitting = true;
        app.quit();
      }, 0);
    });
  }
  ipcMain.handle('runtime:renderer-ready', async (event, payload: unknown) => {
    const role = assertSender(ctx, event, ['pet', 'dashboard']);
    if (
      !payload
      || typeof payload !== 'object'
      || !('role' in payload)
      || payload.role !== role
      || !('bootstrapComplete' in payload)
      || payload.bootstrapComplete !== true
    ) {
      throw new TypeError('Invalid renderer-ready report');
    }
    ctx.runtimeReadyRenderers.add(role);
    await commitRuntimeReady(ctx);
  });
  ipcMain.handle('runtime:renderer-failed', async (event, payload: unknown) => {
    const role = assertSender(ctx, event, ['pet', 'dashboard']);
    const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message.slice(0, 2000)
      : 'Unknown renderer bootstrap failure';
    await fatalExit(ctx, `${role}-renderer-bootstrap-failed`, new Error(message), { role });
  });
  ipcMain.handle('runtime:ready', async (event, report: unknown) => {
    assertSender(ctx, event, ['pet']);
    assertRuntimeReadyReport(report);
    const state = spec.states.find((item) => item.id === report.stateId);
    if (!state || !state.frames.includes(report.frame)) throw new Error('Runtime report references an unknown state/frame pair');
    if (report.assetCount !== ctx.expectedRuntimeAssets.size) throw new Error(`Runtime asset count mismatch: ${report.assetCount}/${ctx.expectedRuntimeAssets.size}`);
    if (report.naturalWidth !== PET_FRAME_SIZE || report.naturalHeight !== PET_FRAME_SIZE) {
      throw new Error(`Runtime frame must be ${PET_FRAME_SIZE}x${PET_FRAME_SIZE}, got ${report.naturalWidth}x${report.naturalHeight}`);
    }
    ctx.runtimeRendererReport = report;
    await commitRuntimeReady(ctx);
  });
  ipcMain.handle('runtime:fail', async (event, report: unknown) => {
    assertSender(ctx, event, ['pet']);
    assertRuntimeFailureReport(report);
    await fatalExit(ctx, 'renderer-runtime-failed', new Error(report.message), report as unknown as Record<string, unknown>);
  });
  ipcMain.handle('settings:get', (event) => { assertSender(ctx, event, ['pet', 'dashboard']); return ctx.settings; });
  ipcMain.handle('settings:update', async (event, patch: unknown) => {
    assertSender(ctx, event, ['dashboard']);
    assertSettingsPatch(patch);
    const next = { ...ctx.settings, ...patch };
    // 一旦用户显式操作过开机自启，即固化该选择，之后启动都以此为准（含损坏回退不再复写）
    if ('autoStart' in patch) next.autoStartInit = true;
    return saveSettings(ctx, parseSettings(next));
  });
  ipcMain.handle('reminders:list', (event) => { assertSender(ctx, event, ['dashboard']); return ctx.reminders; });
  ipcMain.handle('reminders:save', async (event, input: unknown) => {
    assertSender(ctx, event, ['dashboard']);
    assertReminderInput(input);
    const reminder: Reminder = { id: randomUUID(), text: input.text.trim(), dueAt: new Date(input.dueAt).toISOString(), createdAt: new Date().toISOString() };
    ctx.reminders.push(reminder);
    await persistReminders(ctx);
    scheduleReminder(ctx, reminder);
    broadcastRemindersUpdated(ctx);
    return reminder;
  });
  ipcMain.handle('reminders:ack', (event) => {
    assertSender(ctx, event, ['pet']);
    // 点击桌宠会打断到 happy，需等它（frames × 帧长）播完再播放下一条提醒
    const interrupt = spec.states.find((s) => s.id === 'happy');
    const afterMs = interrupt ? interrupt.frames.length * interrupt.frameDurationMs : 0;
    return ackPendingReminder(ctx, afterMs);
  });
  ipcMain.handle('reminders:remove', async (event, id: unknown) => {
    assertSender(ctx, event, ['dashboard']);
    if (typeof id !== 'string' || id.length > 100) throw new TypeError('Invalid reminder id');
    const oldLength = ctx.reminders.length;
    ctx.reminders = ctx.reminders.filter((item) => item.id !== id);
    clearReminderTimer(ctx, id);
    ctx.pendingReminderQueue = ctx.pendingReminderQueue.filter((item) => item.id !== id);
    await persistReminders(ctx);
    broadcastRemindersUpdated(ctx);
    return oldLength !== ctx.reminders.length;
  });
  ipcMain.handle('quotes:get', (event) => { assertSender(ctx, event, ['pet', 'dashboard']); return ctx.quotes; });
  ipcMain.handle('quotes:save', async (event, input: unknown) => {
    assertSender(ctx, event, ['dashboard']);
    ctx.quotes = parseQuotes(input);
    await persistQuotes(ctx);
    notifyQuotesChanged(ctx);
    return undefined;
  });
  // 重置所有运行数据（语录/状态/提醒/设置）到最初默认值
  ipcMain.handle('data:reset', async (event) => {
    assertSender(ctx, event, ['dashboard']);
    // 语录 → 依据 pet-spec.json 重新生成种子
    ctx.quotes = initialQuotes(ctx);
    await persistQuotes(ctx);
    notifyQuotesChanged(ctx);
    // 状态（心情/好感度等） → 默认值
    ctx.stats = { ...ctx.defaultStats };
    await persistStats(ctx);
    broadcastStats(ctx);
    // 提醒 → 清空并清理所有定时器与待处理项
    clearAllReminders(ctx);
    await persistReminders(ctx);
    broadcastRemindersUpdated(ctx);
    // 设置 → 默认值
    await saveSettings(ctx, { ...ctx.defaultSettings });
    // 重置为未配置状态后 applyAutoStart 不再管注册表，这里显式清除系统自启动项，避免残留仍自启
    app.setLoginItemSettings({ openAtLogin: false, openAsHidden: true });
    return undefined;
  });
  // 清理可重建的缓存（Chromium 派生目录 / 写入残留 / 日志超限），返回释放量供界面提示
  ipcMain.handle('data:clear-cache', async (event): Promise<CacheSweepSummary | undefined> => {
    assertSender(ctx, event, ['dashboard']);
    const report = await sweepCaches(ctx, 'dashboard');
    if (!report) return undefined;
    return {
      freedBytes: reportTotalBytes(report),
      cacheBytes: report.caches.bytes,
      cacheFiles: report.caches.files,
      residueBytes: report.tempFiles.bytes + report.corruptFiles.bytes,
      residueFiles: report.tempFiles.files + report.corruptFiles.files,
      logTrimmedBytes: report.logTrimmedBytes,
    };
  });
  // 查询当前状态供小屋状态页头像切换（首次进入时兜底，后续靠 state:changed 实时同步）
  ipcMain.handle('state:get', (event) => { assertSender(ctx, event, ['dashboard', 'pet']); return ctx.currentStateId; });
  // 桌宠窗口回报实际在播状态，仅在状态真正切换时到达；currentStateId 的唯一更新源
  ipcMain.handle('state:actual', (event, value: unknown) => {
    assertSender(ctx, event, ['pet']);
    if (typeof value === 'string') applyReportedState(ctx, value);
    return undefined;
  });
  // 开发者模式：喂安眠药 —— 立即进入睡觉，但遵守打断逻辑（由 pet 端 start() 判定能否压过当前状态）
  ipcMain.handle('dev:trigger-sleep', (event) => {
    assertSender(ctx, event, ['dashboard']);
    resetActivityTimer(ctx);
    // durationMs:0 = 常驻（如同 notify），保持入睡直到被开心/互动/通知打断
    sendActivity(ctx, { kind: 'ambient', stateId: 'sleep', durationMs: 0 });
    return undefined;
  });
  // 开发者模式：触发走路「一直抽」——不产生实际位移，纯循环播放 walk 动画 + walk 语录（符合打断规则）
  ipcMain.handle('dev:trigger-walk', (event) => {
    assertSender(ctx, event, ['dashboard']);
    resetActivityTimer(ctx);
    sendActivity(ctx, { kind: 'ambient', stateId: 'walk', durationMs: 0 });
    return undefined;
  });
  // 开发者模式：触发走路「抽一次」——按当前随机行走挡位立即走一趟（含实际位移，符合打断规则）
  ipcMain.handle('dev:trigger-walk-once', (event) => {
    assertSender(ctx, event, ['dashboard']);
    if (ctx.settings.randomWalk === 0) throw new Error('随机行走为「木头人」，无法走动');
    randomWalkStep(ctx);
    return undefined;
  });
  // 开发者模式：直接设置心情值（0/100），会随之触发 sad / 回待机的状态切换
  ipcMain.handle('dev:set-mood', async (event, value: unknown) => {
    assertSender(ctx, event, ['dashboard']);
    const mood = value as number;
    if (!Number.isInteger(mood) || mood < 0 || mood > 100) throw new TypeError('Invalid mood value');
    ctx.stats.mood = mood;
    ctx.stats.lastMoodDecayMs = Date.now();
    await persistStats(ctx);
    broadcastStats(ctx);
    checkMoodState(ctx);
    return publicStats(ctx);
  });
  ipcMain.handle('interactions:list', (event) => { assertSender(ctx, event, ['pet', 'dashboard']); return spec.experience.interactions; });
  ipcMain.handle('interactions:stats', (event) => { assertSender(ctx, event, ['pet', 'dashboard']); normalizeStatsDay(ctx); return publicStats(ctx); });
  ipcMain.handle('interactions:trigger', async (event, id: unknown) => {
    assertSender(ctx, event, ['pet', 'dashboard']);
    assertInteractionId(id);
    return triggerInteraction(ctx, id);
  });
  ipcMain.handle('files:put', async (event, paths: unknown) => {
    assertSender(ctx, event, ['pet']);
    if (!spec.features.filePocket) throw new Error('File pocket is disabled');
    assertStringArray(paths);
    const destination = filePocket(ctx);
    await mkdir(destination, { recursive: true });
    const result = { copied: [] as string[], failed: [] as Array<{ source: string; reason: string }> };
    for (const source of paths) {
      try {
        if (!(await lstat(source)).isFile()) throw new Error('Only regular files are accepted');
        const target = await uniqueDestination(destination, path.basename(source));
        await copyFile(source, target);
        result.copied.push(target);
      } catch (error) {
        result.failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  });
  ipcMain.handle('files:open-pocket', async (event) => { assertSender(ctx, event, ['pet', 'dashboard']); await openPocket(ctx); });
  ipcMain.handle('window:drag-begin', (event) => {
    assertSender(ctx, event, ['pet']);
    if (!ctx.petWindow || !spec.features.drag) return;
    ctx.dragSession = { bounds: ctx.petWindow.getBounds(), cursor: screen.getCursorScreenPoint() };
    resetActivityTimer(ctx);
  });
  ipcMain.handle('window:drag-update', (event) => {
    assertSender(ctx, event, ['pet']);
    if (!ctx.petWindow || !ctx.dragSession) return;
    ctx.petWindow.setBounds(draggedBounds(ctx.dragSession.bounds, ctx.dragSession.cursor, screen.getCursorScreenPoint()), false);
  });
  ipcMain.handle('window:drag-end', (event) => {
    assertSender(ctx, event, ['pet']);
    if (!ctx.petWindow || !ctx.dragSession) return;
    ctx.dragSession = undefined;
    const original = ctx.petWindow.getBounds();
    // 用桌宠中心（而非松手光标）选显示器/工作区，避免 drag-end 时光标跨屏边界导致选错 workArea
    const center = { x: original.x + original.width / 2, y: original.y + original.height / 2 };
    const workArea = screen.getDisplayNearestPoint(center).workArea;
    // 边缘判定：用户把桌宠拖到屏幕左右边缘松手即触发 peek。
    // 抓取点常在角色中心，光标顶到屏边时窗口会过冲约半个身位（悬在屏外，bounds.x 为负或右缘超出屏缘），
    // 因此用「窗口左右缘到达/越过屏缘」的方向性判断 + 「松手光标距屏缘 ≤50px」双重信号，
    // 而不是比较窗口缘与屏缘的绝对差值（窗口过冲时差值会很大，导致左右都不触发）。
    const cursor = screen.getCursorScreenPoint();
    const SNAP_THRESHOLD = 20;
    const CURSOR_EDGE_BAND = 50;
    const atLeft = original.x <= workArea.x + SNAP_THRESHOLD
      || cursor.x <= workArea.x + CURSOR_EDGE_BAND;
    const atRight = original.x + original.width >= workArea.x + workArea.width - SNAP_THRESHOLD
      || cursor.x >= workArea.x + workArea.width - CURSOR_EDGE_BAND;
    const atEdge = atLeft || atRight;
    if (ctx.settings.edgeSnap && atEdge) {
      // 以「人物可见范围」为基准贴边：人物在窗口内水平居中，窗口比人物宽（气泡区最小宽度兜底）时
      // 须扣除居中偏移 contentInset，否则吸附后人物仍停在离屏边 (windowWidth - contentWidth)/2 处。
      const contentWidth = petCharacterWidth(ctx);
      const contentInset = (original.width - contentWidth) / 2;
      const snapped = snapBounds(original, workArea, contentInset, contentWidth);
      ctx.petWindow.setBounds(snapped, true);
      const state = stateForTrigger(ctx, 'window:edge-snap');
      // 用 snapBounds 的计算结果判断右侧，避免 setBounds 动画导致 getBounds 延迟
      const isRightSide = snapped.x + snapped.width >= workArea.x + workArea.width - 10;
      // 贴边恒生效；peek 动画只在当前状态允许被它接管时才播。
      // sleep / sad 等常驻状态的打断名单不含 peek，渲染层会拒绝这次切换；预判可省掉注定无效的下发。
      if (state && canTakeOver(ctx, state, ctx.currentStateId)) {
        // 不指定 durationMs：由渲染层按 spec 的 frames.length × frameDurationMs 播完整一轮，素材加帧/减帧自动适配
        sendActivity(ctx, { kind: 'edge-snap', stateId: state.id, mirror: isRightSide });
      }
    }
    // 更新随机行走中心为拖动结束位置
    const b = ctx.petWindow.getBounds();
    ctx.randomWalkCenter = { x: b.x, y: b.y };
  });
  ipcMain.handle('window:show-context-menu', (event) => {
    assertSender(ctx, event, ['pet']);
    if (ctx.petWindow) Menu.buildFromTemplate(buildPetMenu(ctx)).popup({ window: ctx.petWindow });
  });
  ipcMain.handle('window:show-dashboard', (event, view?: DashboardView) => { assertSender(ctx, event, ['pet']); showDashboard(ctx, view); });
  ipcMain.handle('window:hide-dashboard', (event) => { assertSender(ctx, event, ['dashboard']); ctx.dashboardWindow?.hide(); });
  ipcMain.handle('window:hide-pet', (event) => { assertSender(ctx, event, ['pet', 'dashboard']); ctx.petWindow?.hide(); });
}
