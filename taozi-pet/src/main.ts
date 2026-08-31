import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import specData from '../pet-spec.json';
import type { DashboardView, InteractionResult, PetSpec, PetStats, Reminder, RuntimeFailureReport, RuntimeReadyReport, Settings, StateActivity, TypingStatus } from './shared/contracts';
import { assertInteractionId, assertReminderInput, assertRuntimeFailureReport, assertRuntimeReadyReport, assertSettingsPatch, assertStringArray } from './shared/contracts';
import { draggedBounds, snapBounds, type Point, type Rect } from './main/drag';
import { JsonLogger } from './main/logger';
import { atomicWriteJson, uniqueDestination } from './main/persistence';
import { TypingListener } from './main/typing-listener';
import { localDateKey, nextReminderDelay, parsePersistedStats, parseQuotes, parseReminders, parseSettings, type PersistedStats } from './main/data-validation';
import { readValidatedJson } from './main/persistence';
import trayIconPath from './assets/tray/tray-icon.png';

const spec = specData as PetSpec;
type Role = 'pet' | 'dashboard';

// 语录种子：全部语录文本统一定义在 pet-spec.json（experience.quotes 状态语录 +
// interactions[].feedback 互动语录）。首次启动据此生成 userData/quotes.json，
// 之后语录页与桌宠都只读写这份运行时文件，编辑即同步。
function initialQuotes(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, group] of Object.entries(spec.experience.quotes ?? {})) {
    if (group.quotes.length) out[key] = [...group.quotes];
  }
  for (const interaction of spec.experience.interactions ?? []) {
    if (interaction.feedback.length) out[interaction.id] = [...interaction.feedback];
  }
  return out;
}

let petWindow: BrowserWindow | undefined;
let dashboardWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let logger: JsonLogger | undefined;
let settings: Settings;
let reminders: Reminder[] = [];
let quotes: Record<string, string[]> = {};
let stats: PersistedStats;
let sessionStartedAt = Date.now();
let typingStatus: TypingStatus = { enabled: false, reason: 'not-started' };
let isQuitting = false;
let dragSession: { bounds: Rect; cursor: Point } | undefined;
let moodDecayTimer: ReturnType<typeof setInterval> | undefined;
let randomWalkTimer: ReturnType<typeof setTimeout> | undefined;
let randomWalkAnimTimer: ReturnType<typeof setInterval> | undefined;
let randomWalkCenter: { x: number; y: number } | undefined;
const RANDOM_WALK_SPEED = 2; // 每帧移动像素（匀速）
const RANDOM_WALK_FRAME_MS = 16; // 约60fps
// 随机行走挡位配置（索引=挡位）：0 木头人(关闭) / 1 散步 / 2 正常 / 3 活泼 / 4 多动症
// range=移动范围，interval=两次游走间隔，distance=单次位移；挡位越高走得越频、越远
const RANDOM_WALK_LEVELS: Array<{ range: number; intervalMin: number; intervalMax: number; distMin: number; distMax: number } | null> = [
  null,
  { range: 220, intervalMin: 14000, intervalMax: 30000, distMin: 60, distMax: 140 }, // 1 散步
  { range: 320, intervalMin: 8000, intervalMax: 25000, distMin: 120, distMax: 260 }, // 2 正常
  { range: 420, intervalMin: 4500, intervalMax: 14000, distMin: 200, distMax: 340 }, // 3 活泼
  { range: 520, intervalMin: 2500, intervalMax: 7500, distMin: 300, distMax: 440 },  // 4 多动症
];
const SLEEP_TRIGGER_MS = 3 * 60 * 1000; // 3分钟无互动触发睡觉
const MOOD_SAD_THRESHOLD = 25; // 心情低于25触发sad
const PET_BUBBLE_ZONE = 110; // 顶部气泡区高度（px）：气泡固定在此区内，换行也不会遮住精灵动画
const PET_BUBBLE_ZONE_WIDTH = 240; // 气泡区最小宽度（px）：保证小尺寸桌宠时气泡也不会被窗口宽度压缩

function petSize(): number { return Math.round(spec.experience.petSizing.baseWindowPx * settings.petScale); }

// 桌宠窗口 = 精灵正方形(高) + 顶部气泡区(高)；宽度取「精灵宽 与 气泡区最小宽度」较大者，使气泡尺寸不随桌宠大小变化
function petWindowSize(): { width: number; height: number } {
  const size = petSize();
  return { width: Math.max(size, PET_BUBBLE_ZONE_WIDTH), height: size + PET_BUBBLE_ZONE };
}

let sleepTimer: ReturnType<typeof setTimeout> | undefined;
let lastActivityTime = Date.now();
let currentStateId = 'idle';
let runtimeRendererReport: RuntimeReadyReport | undefined;
const runtimeReadyRenderers = new Set<Role>();
let runtimeWindowReady = false;
let runtimeCommitted = false;
let fatalExitStarted = false;
let quitPersisting = false;
const roles = new Map<number, Role>();
const reminderTimers = new Map<string, ReturnType<typeof setTimeout>>();
// 已到点、等待用户逐个消费的提醒队列（按到点先后排队：旧→新）。
// 队首正在播报（notify 持续循环+气泡）；用户点击消费队首后，等打断动画播完再播报下一条。
// 不做一次性清空，保证多条提醒按先后顺序逐个展示。
let pendingReminderQueue: Reminder[] = [];
// 消费队首后延时播报下一条的定时器（连续消费时需取消旧的，防止残留定时器重复播报）
let nextAnnounceReminderTimer: ReturnType<typeof setTimeout> | null = null;
const typingListener = new TypingListener();
const expectedRuntimeAssets = new Set([spec.character.coreAsset, ...spec.states.flatMap((state) => state.frames)]);
const runtimeReadyFile = path.join(process.cwd(), '.build', 'runtime-ready.json');
const runtimeFailureFile = path.join(process.cwd(), '.build', 'runtime-failed.json');
const runtimeEvidenceEnabled = !app.isPackaged || process.env.PET_PREVIEW_MODE === '1';
const e2eMode = process.env.PET_E2E === '1';

if (process.env.PET_E2E_USER_DATA) app.setPath('userData', path.resolve(process.env.PET_E2E_USER_DATA));

const defaultSettings: Settings = {
  edgeSnap: spec.features.edgeSnap,
  alwaysOnTop: true,
  typingReaction: spec.features.typingReaction,
  clickThrough: false,
  petScale: spec.experience.petSizing.defaultScale,
  autoStart: true,
  // 默认已初始化：新用户默认开机自启（首次启动即写入系统自启动项）
  autoStartInit: true,
  randomWalk: 2,
};

const defaultStats: PersistedStats = {
  affection: 0,
  mood: 20,
  todayInteractions: 0,
  totalCompanionMs: 0,
  lastInteractionDate: localDateKey(),
  dailyInteractionDates: {},
  lastMoodDecayMs: Date.now(),
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (process.env.PET_E2E === '1') {
  (globalThis as typeof globalThis & {
    __PET_E2E__?: {
      snapshot: () => {
        tray: boolean;
        roles: Array<{ role: Role; visible: boolean; destroyed: boolean }>;
        quitting: boolean;
      };
      quit: () => void;
    };
  }).__PET_E2E__ = {
    snapshot: () => ({
      tray: Boolean(tray && !tray.isDestroyed()),
      roles: [petWindow, dashboardWindow].map((window, index) => ({
        role: (['pet', 'dashboard'] as const)[index]!,
        visible: Boolean(window?.isVisible()),
        destroyed: Boolean(window?.isDestroyed()),
      })),
      quitting: isQuitting,
    }),
    quit: () => {
      isQuitting = true;
      app.quit();
    },
  };
}

function userFile(name: string): string { return path.join(app.getPath('userData'), name); }
function filePocket(): string { return path.join(app.getPath('documents'), spec.app.name); }
function stateForTrigger(trigger: string) { return spec.states.find((state) => state.triggers.includes(trigger)); }

async function writeRuntimeFile(file: string, value: unknown): Promise<void> {
  if (runtimeEvidenceEnabled) await atomicWriteJson(file, value);
}

async function commitRuntimeReady(): Promise<void> {
  if (
    runtimeCommitted
    || !runtimeWindowReady
    || !runtimeRendererReport
    || runtimeReadyRenderers.size !== 2
    || !petWindow
    || petWindow.isDestroyed()
  ) return;
  const report = {
    ...runtimeRendererReport,
    status: 'ready',
    expectedAssetCount: expectedRuntimeAssets.size,
    windowCount: BrowserWindow.getAllWindows().length,
    petVisible: petWindow.isVisible(),
    ipcReady: true,
    renderers: {
      pet: runtimeReadyRenderers.has('pet'),
      dashboard: runtimeReadyRenderers.has('dashboard'),
    },
    appName: spec.app.name,
    version: spec.app.version,
    timestamp: new Date().toISOString(),
  };
  if (report.windowCount !== 2 || !report.petVisible) throw new Error(`Runtime window gate failed: windows=${report.windowCount}, visible=${report.petVisible}`);
  await logger?.write('info', 'runtime-ready', report);
  await writeRuntimeFile(runtimeReadyFile, report);
  runtimeCommitted = true;
}

async function fatalExit(event: string, error: unknown, details: Record<string, unknown> = {}): Promise<void> {
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  const message = error instanceof Error ? error.message : String(error);
  const report = { status: 'failed', event, message, ...details, timestamp: new Date().toISOString() };
  console.error(event, error);
  try { await writeRuntimeFile(runtimeFailureFile, report); }
  catch (fileError) { console.error('runtime-failure-file-write-failed', fileError); }
  try { await logger?.write('error', event, { message, ...details }); }
  catch (logError) { console.error('structured-log-write-failed', logError); }
  app.exit(1);
}

function assertSender(event: IpcMainInvokeEvent, allowed: Role[]): Role {
  const role = roles.get(event.sender.id);
  if (!role || !allowed.includes(role) || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized IPC sender');
  return role;
}

function registerWindow(window: BrowserWindow, role: Role): BrowserWindow {
  const webContentsId = window.webContents.id;
  roles.set(webContentsId, role);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('did-fail-load', (_event, code, description) => {
    void fatalExit(`${role}-window-load-failed`, new Error(description), { code, role });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') {
      void logger?.write('warn', `${role}-renderer-stopped`, { role, reason: details.reason, exitCode: details.exitCode });
      return;
    }
    if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
      void fatalExit(`${role}-renderer-gone`, new Error(details.reason), { role, exitCode: details.exitCode });
      return;
    }
    void logger?.write('warn', `${role}-renderer-gone`, { role, reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('console-message', (details, level, legacyMessage) => {
    const message = details.message || legacyMessage;
    const currentLevel = details.level === 'error' ? 3 : level;
    const fatalMessage = /Content Security Policy|unsafe-eval|Refused to evaluate|Uncaught|Unhandled/i.test(message);
    if (fatalMessage || (!runtimeCommitted && currentLevel >= 3)) {
      void fatalExit(`${role}-renderer-console-error`, new Error(message), { role });
    } else if (currentLevel >= 3) {
      void logger?.write('error', `${role}-renderer-console-error`, { role, message: message.slice(0, 2000) });
    }
  });
  window.on('closed', () => roles.delete(webContentsId));
  return window;
}

function secureWindow(options: Electron.BrowserWindowConstructorOptions, role: Role, preload: string): BrowserWindow {
  return registerWindow(new BrowserWindow({
    ...options,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  }), role);
}

function applyPetSettings(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const { width, height } = petWindowSize();
  petWindow.setSize(width, height, true);
  petWindow.setAlwaysOnTop(settings.alwaysOnTop);
  petWindow.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
}

function applyAutoStart(): void {
  // 仅当 autoStartInit 为 true 时写入/移除系统自启动项；
  // autoStartInit=false（如旧数据损坏回退且未固化选择）时不动注册表，防止意外自启。
  if (!settings.autoStartInit) return;
  app.setLoginItemSettings({
    openAtLogin: settings.autoStart,
    openAsHidden: true,
  });
}

function decayMood(): void {
  const now = Date.now();
  const elapsed = now - stats.lastMoodDecayMs;
  // 每2分钟衰减1点心情
  const accrued = Math.floor(elapsed / 120_000);
  // 封顶单次结算点数，避免长期静置/休眠唤醒后一次性暴跌（心情"突然跃变"）
  const decayPoints = Math.min(6, accrued);
  if (decayPoints > 0 && stats.mood > 0) {
    stats.mood = Math.max(0, stats.mood - decayPoints);
    stats.lastMoodDecayMs = now;
    broadcastStats();
    checkMoodState();
  } else if (decayPoints === 0) {
    // 静置不足一个结算周期：时间前进，纯粹提前刷新参考点，防止累积瞬间扣分
    stats.lastMoodDecayMs = now;
  }
}

function checkMoodState(): void {
  if (stats.mood < MOOD_SAD_THRESHOLD && currentStateId !== 'sad') {
    sendActivity({ kind: 'ambient', stateId: 'sad' });
  } else if (stats.mood >= MOOD_SAD_THRESHOLD && currentStateId === 'sad') {
    sendActivity({ kind: 'ambient', stateId: 'idle' });
  }
}

function startMoodDecay(): void {
  if (moodDecayTimer) clearInterval(moodDecayTimer);
  moodDecayTimer = setInterval(() => {
    decayMood();
    void persistStats().catch(() => {});
  }, 60_000); // 每分钟检查一次
}

function stopMoodDecay(): void {
  if (moodDecayTimer) {
    clearInterval(moodDecayTimer);
    moodDecayTimer = undefined;
  }
}

function randomWalkStep(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (isDraggingActive()) return;
  if (randomWalkAnimTimer) return; // 正在移动中，不触发新的移动
  const cfg = RANDOM_WALK_LEVELS[settings.randomWalk];
  if (!cfg) return; // 0 木头人（关闭）
  if (!randomWalkCenter) {
    const b = petWindow.getBounds();
    randomWalkCenter = { x: b.x, y: b.y };
  }
  const bounds = petWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;

  // 随机选择方向：0=上, 1=下, 2=左, 3=右
  const direction = Math.floor(Math.random() * 4);
  const distance = cfg.distMin + Math.random() * (cfg.distMax - cfg.distMin);

  let targetX = bounds.x;
  let targetY = bounds.y;
  switch (direction) {
    case 0: targetY -= Math.round(distance); break; // 上
    case 1: targetY += Math.round(distance); break; // 下
    case 2: targetX -= Math.round(distance); break; // 左
    case 3: targetX += Math.round(distance); break; // 右
  }

  // 限制在以中心为圆心的范围内
  const dx = targetX - randomWalkCenter.x;
  const dy = targetY - randomWalkCenter.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > cfg.range) {
    const scale = cfg.range / dist;
    targetX = randomWalkCenter.x + Math.round(dx * scale);
    targetY = randomWalkCenter.y + Math.round(dy * scale);
  }

  // 限制在屏幕工作区内（用窗口实际宽高，窗口含顶部气泡区）
  targetX = Math.max(workArea.x, Math.min(workArea.x + workArea.width - bounds.width, targetX));
  targetY = Math.max(workArea.y, Math.min(workArea.y + workArea.height - bounds.height, targetY));

  // 匀速移动
  const startX = bounds.x;
  const startY = bounds.y;
  const totalDx = targetX - startX;
  const totalDy = targetY - startY;
  const totalSteps = Math.max(1, Math.ceil(Math.max(Math.abs(totalDx), Math.abs(totalDy)) / RANDOM_WALK_SPEED));
  let step = 0;

  // 触发 walk 动画：向右或向下移动时左右镜像
  const walkMirror = direction === 1 || direction === 3; // 下或右
  sendActivity({ kind: 'ambient', stateId: 'walk', mirror: walkMirror });
  resetActivityTimer();

  randomWalkAnimTimer = setInterval(() => {
    step++;
    if (step >= totalSteps || !petWindow || petWindow.isDestroyed() || isDraggingActive()) {
      if (randomWalkAnimTimer) {
        clearInterval(randomWalkAnimTimer);
        randomWalkAnimTimer = undefined;
      }
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.setPosition(targetX, targetY, false);
      }
      // 移动结束，回到 idle
      sendActivity({ kind: 'ambient', stateId: 'idle' });
      return;
    }
    const curX = Math.round(startX + (totalDx * step / totalSteps));
    const curY = Math.round(startY + (totalDy * step / totalSteps));
    petWindow.setPosition(curX, curY, false);
  }, RANDOM_WALK_FRAME_MS);
}

function isDraggingActive(): boolean {
  return dragSession !== undefined;
}

function scheduleNextRandomWalk(): void {
  if (randomWalkTimer) clearTimeout(randomWalkTimer);
  const cfg = RANDOM_WALK_LEVELS[settings.randomWalk];
  if (!cfg) return; // 0 木头人（关闭）
  const delay = cfg.intervalMin + Math.random() * (cfg.intervalMax - cfg.intervalMin);
  randomWalkTimer = setTimeout(() => {
    randomWalkStep();
    scheduleNextRandomWalk();
  }, delay);
}

function startRandomWalk(): void {
  if (randomWalkTimer) clearTimeout(randomWalkTimer);
  if (randomWalkAnimTimer) {
    clearInterval(randomWalkAnimTimer);
    randomWalkAnimTimer = undefined;
  }
  if (!RANDOM_WALK_LEVELS[settings.randomWalk]) return;
  scheduleNextRandomWalk();
}

function stopRandomWalk(): void {
  if (randomWalkTimer) {
    clearTimeout(randomWalkTimer);
    randomWalkTimer = undefined;
  }
  if (randomWalkAnimTimer) {
    clearInterval(randomWalkAnimTimer);
    randomWalkAnimTimer = undefined;
  }
}

function resetActivityTimer(): void {
  lastActivityTime = Date.now();
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = undefined;
  }
  scheduleSleep();
}

function scheduleSleep(): void {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => {
    const elapsed = Date.now() - lastActivityTime;
    if (elapsed >= SLEEP_TRIGGER_MS && !isDraggingActive() && !randomWalkAnimTimer) {
      sendActivity({ kind: 'ambient', stateId: 'sleep' });
    } else {
      scheduleSleep();
    }
  }, SLEEP_TRIGGER_MS);
}

function createWindows(): void {
  const { width, height } = petWindowSize();
  petWindow = secureWindow({
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    opacity: e2eMode ? 0 : 1,
  }, 'pet', PET_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void petWindow.loadURL(PET_WINDOW_WEBPACK_ENTRY);
  petWindow.once('ready-to-show', () => {
    applyPetSettings();
    petWindow?.center();
    if (e2eMode) petWindow?.showInactive();
    else petWindow?.show();
    runtimeWindowReady = Boolean(petWindow?.isVisible());
    void commitRuntimeReady().catch((error) => fatalExit('runtime-ready-failed', error));
  });

  dashboardWindow = secureWindow({
    width: 520,
    height: 700,
    minWidth: 480,
    minHeight: 620,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: true,
    hasShadow: true,
    title: `${spec.character.displayName}的小屋`,
    opacity: e2eMode ? 0 : 1,
  }, 'dashboard', DASHBOARD_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void dashboardWindow.loadURL(DASHBOARD_WINDOW_WEBPACK_ENTRY);
  dashboardWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); dashboardWindow?.hide(); }
  });
}

function publicStats(): PetStats {
  const liveMs = stats.totalCompanionMs + Math.max(0, Date.now() - sessionStartedAt);
  return {
    affection: stats.affection,
    mood: stats.mood,
    todayInteractions: stats.todayInteractions,
    companionMinutes: Math.floor(liveMs / 60_000),
    lastInteractionDate: stats.lastInteractionDate,
  };
}

function normalizeStatsDay(): void {
  const today = localDateKey();
  if (stats.lastInteractionDate !== today) {
    stats.todayInteractions = 0;
    stats.lastInteractionDate = today;
  }
}

async function persistStats(): Promise<void> {
  stats.totalCompanionMs += Math.max(0, Date.now() - sessionStartedAt);
  sessionStartedAt = Date.now();
  await atomicWriteJson(userFile('pet-stats.json'), stats);
}

function broadcastStats(): void {
  const value = publicStats();
  for (const window of [petWindow, dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('pet:stats', value);
  }
}

function broadcastRemindersUpdated(): void {
  for (const window of [petWindow, dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('reminders:updated');
  }
}

function sendActivity(activity: StateActivity): void {
  if (activity.stateId) currentStateId = activity.stateId;
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('state:activity', activity);
}

function activityForTrigger(trigger: string, kind: string, feedback?: string, durationMs?: number): StateActivity {
  const state = stateForTrigger(trigger);
  return { kind, stateId: state?.id, durationMs, feedback };
}

async function triggerInteraction(id: string): Promise<InteractionResult> {
  const interaction = spec.experience.interactions.find((item) => item.id === id);
  if (!interaction || !spec.features.interactions) throw new Error(`Unknown or disabled interaction: ${id}`);
  resetActivityTimer();
  normalizeStatsDay();
  const today = localDateKey();
  const alreadyToday = stats.dailyInteractionDates[id] === today;
  if (!alreadyToday) {
    stats.affection = Math.min(100, stats.affection + interaction.affectionGain);
    stats.dailyInteractionDates[id] = today;
  }
  stats.mood = Math.min(100, stats.mood + Math.max(1, Math.ceil(interaction.affectionGain / 2)));
  stats.todayInteractions += 1;
  // 互动语录以运行时语录（userData/quotes.json，与语录页编辑同步）为准
  const customList = quotes[interaction.id];
  const list = customList && customList.length > 0 ? customList : interaction.feedback;
  const feedback = list[Math.floor(Math.random() * list.length)] ?? interaction.label;
  await persistStats();
  const result: InteractionResult = { interaction, feedback, stats: publicStats() };
  // 用户触发互动即消费当前待处理的队首提醒；等本互动播完再播放下一条
  ackPendingReminder(interaction.durationMs);
  sendActivity({ kind: 'interaction', stateId: interaction.stateId, durationMs: interaction.durationMs, feedback });
  broadcastStats();
  // 互动结束后检查心情，若仍低于阈值则回到sad
  setTimeout(() => checkMoodState(), interaction.durationMs + 200);
  return result;
}

function showDashboard(view: DashboardView = 'status'): void {
  if (!spec.features.dashboard || !dashboardWindow) return;
  dashboardWindow.center();
  if (e2eMode) dashboardWindow.showInactive();
  else {
    dashboardWindow.show();
    dashboardWindow.focus();
  }
  broadcastStats();
  dashboardWindow.webContents.send('dashboard:view', view);
}

function buildPetMenu(): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (spec.features.interactions) {
    for (const interaction of spec.experience.interactions) {
      items.push({ label: `${interaction.emoji} ${interaction.label}`, click: () => void triggerInteraction(interaction.id) });
    }
    if (spec.experience.interactions.length) items.push({ type: 'separator' });
  }
  if (spec.features.dashboard) {
    items.push({ label: '🏠 状态', click: () => showDashboard('status') });
    items.push({ label: '💬 语录', click: () => showDashboard('quotes') });
  }
  if (spec.features.reminders) items.push({ label: '⏰ 提醒', click: () => showDashboard('reminders') });
  if (spec.features.filePocket) items.push({ label: '📁 打开文件口袋', click: () => void openPocket() });
  items.push({ type: 'separator' });
  items.push({ label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) });
  items.push({ label: '🙈 隐藏桌宠', click: () => petWindow?.hide() });
  return items;
}

function trayMenuItems(): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  items.push({ label: `🐾 显示${spec.character.displayName}`, click: () => petWindow?.show() });
  if (spec.features.dashboard) {
    items.push({ label: '🏠 状态', click: () => showDashboard('status') });
    items.push({ label: '💬 语录', click: () => showDashboard('quotes') });
  }
  if (spec.features.reminders) items.push({ label: '⏰ 提醒', click: () => showDashboard('reminders') });
  items.push({ label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) });
  items.push({ type: 'separator' });
  items.push({ label: '🚪 退出', click: () => { isQuitting = true; app.quit(); } });
  return items;
}

function createTray(): void {
  if (!spec.features.tray) return;
  const resolvedTrayIconPath = path.resolve(__dirname, trayIconPath);
  const trayImage = nativeImage.createFromPath(resolvedTrayIconPath);
  if (trayImage.isEmpty()) throw new Error(`Tray icon is empty: ${resolvedTrayIconPath}`);
  tray = new Tray(trayImage.resize({ width: 32, height: 32, quality: 'best' }));
  tray.setToolTip(spec.app.name);
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuItems()));
  tray.on('click', () => petWindow?.isVisible() ? petWindow.hide() : petWindow?.show());
}

async function saveSettings(next: Settings): Promise<Settings> {
  settings = next;
  await atomicWriteJson(userFile('settings.json'), settings);
  applyPetSettings();
  applyAutoStart();
  restartTypingListener();
  if (settings.randomWalk) startRandomWalk(); else stopRandomWalk();
  createTrayMenuRefresh();
  return settings;
}

function createTrayMenuRefresh(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuItems()));
}

function broadcastTypingStatus(): void {
  for (const window of [petWindow, dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('typing:status', typingStatus);
  }
}

function restartTypingListener(): void {
  typingListener.stop();
  typingStatus = typingListener.start(settings.typingReaction, () => {
    const state = stateForTrigger('typing:activity');
    sendActivity({ kind: 'typing', stateId: state?.id, durationMs: 500 });
  });
  broadcastTypingStatus();
  void logger?.write(typingStatus.enabled ? 'info' : 'warn', 'typing-listener-status', typingStatus as unknown as Record<string, unknown>);
}

function clearReminderTimer(id: string): void {
  const timer = reminderTimers.get(id);
  if (timer) clearTimeout(timer);
  reminderTimers.delete(id);
}

function scheduleReminder(reminder: Reminder): void {
  clearReminderTimer(reminder.id);
  const delay = nextReminderDelay(reminder.dueAt);
  reminderTimers.set(reminder.id, setTimeout(() => {
    reminderTimers.delete(reminder.id);
    if (Date.parse(reminder.dueAt) > Date.now()) {
      scheduleReminder(reminder);
      return;
    }
    // 到点入队：队首正在播报时，后续到点的仅排队等待，不打断当前播报（保证旧→新顺序）
    const wasIdle = pendingReminderQueue.length === 0;
    pendingReminderQueue.push(reminder);
    if (wasIdle) announceReminder(reminder);
  }, delay));
}

// 播放一条提醒：notify 动作 + 气泡持续循环显示
function announceReminder(reminder: Reminder): void {
  const state = stateForTrigger('reminder:due');
  sendActivity({ kind: 'notify', stateId: state?.id, durationMs: 0, feedback: reminder.text });
}

// 用户点击桌宠或触发其他动作时，消费旧→新队列里的队首一条；
// 若仍待消费，则等打断动画播完（afterMs）再播放下一条，避免一次性全部清空。
function ackPendingReminder(afterMs = 0): boolean {
  const consumed = pendingReminderQueue.shift();
  if (!consumed) return false;
  reminders = reminders.filter((item) => item.id !== consumed.id);
  clearReminderTimer(consumed.id);
  if (nextAnnounceReminderTimer !== null) {
    clearTimeout(nextAnnounceReminderTimer);
    nextAnnounceReminderTimer = null;
  }
  if (pendingReminderQueue.length > 0) {
    const next = pendingReminderQueue[0]!;
    nextAnnounceReminderTimer = setTimeout(() => {
      nextAnnounceReminderTimer = null;
      announceReminder(next);
    }, Math.max(0, afterMs));
  }
  void persistReminders();
  broadcastRemindersUpdated();
  return true;
}

async function persistReminders(): Promise<void> {
  await atomicWriteJson(userFile('reminders.json'), reminders);
}

async function openPocket(): Promise<void> {
  if (!spec.features.filePocket) throw new Error('File pocket is disabled');
  const directory = filePocket();
  await mkdir(directory, { recursive: true });
  const failure = await shell.openPath(directory);
  if (failure) throw new Error(failure);
}

function registerIpc(): void {
  if (process.env.PET_E2E === '1') {
    ipcMain.handle('runtime:e2e-snapshot', (event) => {
      assertSender(event, ['pet', 'dashboard']);
      return (globalThis as typeof globalThis & {
        __PET_E2E__?: { snapshot: () => unknown };
      }).__PET_E2E__?.snapshot();
    });
    ipcMain.handle('runtime:e2e-quit', (event) => {
      assertSender(event, ['pet', 'dashboard']);
      setTimeout(() => {
        isQuitting = true;
        app.quit();
      }, 0);
    });
  }
  ipcMain.handle('runtime:renderer-ready', async (event, payload: unknown) => {
    const role = assertSender(event, ['pet', 'dashboard']);
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
    runtimeReadyRenderers.add(role);
    await commitRuntimeReady();
  });
  ipcMain.handle('runtime:renderer-failed', async (event, payload: unknown) => {
    const role = assertSender(event, ['pet', 'dashboard']);
    const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message.slice(0, 2000)
      : 'Unknown renderer bootstrap failure';
    await fatalExit(`${role}-renderer-bootstrap-failed`, new Error(message), { role });
  });
  ipcMain.handle('runtime:ready', async (event, report: unknown) => {
    assertSender(event, ['pet']);
    assertRuntimeReadyReport(report);
    const state = spec.states.find((item) => item.id === report.stateId);
    if (!state || !state.frames.includes(report.frame)) throw new Error('Runtime report references an unknown state/frame pair');
    if (report.assetCount !== expectedRuntimeAssets.size) throw new Error(`Runtime asset count mismatch: ${report.assetCount}/${expectedRuntimeAssets.size}`);
    if (report.naturalWidth !== 512 || report.naturalHeight !== 512) throw new Error(`Runtime frame must be 512x512, got ${report.naturalWidth}x${report.naturalHeight}`);
    runtimeRendererReport = report;
    await commitRuntimeReady();
  });
  ipcMain.handle('runtime:fail', async (event, report: unknown) => {
    assertSender(event, ['pet']);
    assertRuntimeFailureReport(report);
    await fatalExit('renderer-runtime-failed', new Error(report.message), report as unknown as Record<string, unknown>);
  });
  ipcMain.handle('settings:get', (event) => { assertSender(event, ['pet', 'dashboard']); return settings; });
  ipcMain.handle('settings:update', async (event, patch: unknown) => {
    assertSender(event, ['dashboard']);
    assertSettingsPatch(patch);
    const next = { ...settings, ...patch };
    // 一旦用户显式操作过开机自启，即固化该选择，之后启动都以此为准（含损坏回退不再复写）
    if ('autoStart' in patch) next.autoStartInit = true;
    return saveSettings(parseSettings(next));
  });
  ipcMain.handle('reminders:list', (event) => { assertSender(event, ['dashboard']); return reminders; });
  ipcMain.handle('reminders:save', async (event, input: unknown) => {
    assertSender(event, ['dashboard']);
    assertReminderInput(input);
    const reminder: Reminder = { id: randomUUID(), text: input.text.trim(), dueAt: new Date(input.dueAt).toISOString(), createdAt: new Date().toISOString() };
    reminders.push(reminder);
    await persistReminders();
    scheduleReminder(reminder);
    broadcastRemindersUpdated();
    return reminder;
  });
  ipcMain.handle('reminders:ack', (event) => {
    assertSender(event, ['pet']);
    // 点击桌宠会打断到 happy，需等它（frames × 帧长）播完再播放下一条提醒
    const interrupt = spec.states.find((s) => s.id === 'happy');
    const afterMs = interrupt ? interrupt.frames.length * interrupt.frameDurationMs : 0;
    return ackPendingReminder(afterMs);
  });
  ipcMain.handle('reminders:remove', async (event, id: unknown) => {
    assertSender(event, ['dashboard']);
    if (typeof id !== 'string' || id.length > 100) throw new TypeError('Invalid reminder id');
    const oldLength = reminders.length;
    reminders = reminders.filter((item) => item.id !== id);
    clearReminderTimer(id);
    pendingReminderQueue = pendingReminderQueue.filter((item) => item.id !== id);
    await persistReminders();
    broadcastRemindersUpdated();
    return oldLength !== reminders.length;
  });
  ipcMain.handle('quotes:get', (event) => { assertSender(event, ['pet', 'dashboard']); return quotes; });
  ipcMain.handle('quotes:save', async (event, input: unknown) => {
    assertSender(event, ['dashboard']);
    const next = parseQuotes(input);
    quotes = next;
    await atomicWriteJson(userFile('quotes.json'), quotes);
    // 通知 pet 与 dashboard 刷新语录缓存（dashboard 为编辑方，自身即时更新）
    for (const w of [petWindow, dashboardWindow]) w?.webContents.send('quotes:changed');
    return undefined;
  });
  // 重置所有运行数据（语录/状态/提醒/设置）到最初默认值
  ipcMain.handle('data:reset', async (event) => {
    assertSender(event, ['dashboard']);
    // 语录 → 依据 pet-spec.json 重新生成种子
    quotes = initialQuotes();
    await atomicWriteJson(userFile('quotes.json'), quotes);
    for (const w of [petWindow, dashboardWindow]) w?.webContents.send('quotes:changed');
    // 状态（心情/好感度等） → 默认值
    stats = { ...defaultStats };
    await persistStats();
    broadcastStats();
    // 提醒 → 清空并清理所有定时器与待处理项
    for (const r of reminders) clearReminderTimer(r.id);
    reminders = [];
    pendingReminderQueue.length = 0;
    if (nextAnnounceReminderTimer !== null) {
      clearTimeout(nextAnnounceReminderTimer);
      nextAnnounceReminderTimer = null;
    }
    await persistReminders();
    broadcastRemindersUpdated();
    // 设置 → 默认值
    await saveSettings({ ...defaultSettings });
    // 重置为未配置状态后 applyAutoStart 不再管注册表，这里显式清除系统自启动项，避免残留仍自启
    app.setLoginItemSettings({ openAtLogin: false, openAsHidden: true });
    return undefined;
  });
  ipcMain.handle('interactions:list', (event) => { assertSender(event, ['pet', 'dashboard']); return spec.experience.interactions; });
  ipcMain.handle('interactions:stats', (event) => { assertSender(event, ['pet', 'dashboard']); normalizeStatsDay(); return publicStats(); });
  ipcMain.handle('interactions:trigger', async (event, id: unknown) => {
    assertSender(event, ['pet', 'dashboard']);
    assertInteractionId(id);
    return triggerInteraction(id);
  });
  ipcMain.handle('files:put', async (event, paths: unknown) => {
    assertSender(event, ['pet']);
    if (!spec.features.filePocket) throw new Error('File pocket is disabled');
    assertStringArray(paths);
    const destination = filePocket();
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
  ipcMain.handle('files:open-pocket', async (event) => { assertSender(event, ['pet', 'dashboard']); await openPocket(); });
  ipcMain.handle('window:drag-begin', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !spec.features.drag) return;
    dragSession = { bounds: petWindow.getBounds(), cursor: screen.getCursorScreenPoint() };
    resetActivityTimer();
  });
  ipcMain.handle('window:drag-update', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !dragSession) return;
    petWindow.setBounds(draggedBounds(dragSession.bounds, dragSession.cursor, screen.getCursorScreenPoint()), false);
  });
  ipcMain.handle('window:drag-end', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !dragSession) return;
    dragSession = undefined;
    if (settings.edgeSnap) {
      const point = screen.getCursorScreenPoint();
      const workArea = screen.getDisplayNearestPoint(point).workArea;
      const snapped = snapBounds(petWindow.getBounds(), workArea);
      petWindow.setBounds(snapped, true);
      const state = stateForTrigger('window:edge-snap');
      // 用 snapBounds 的计算结果判断右侧，避免 setBounds 动画导致 getBounds 延迟
      const isRightSide = snapped.x + snapped.width >= workArea.x + workArea.width - 10;
      sendActivity({ kind: 'edge-snap', stateId: state?.id, durationMs: 900, mirror: isRightSide });
    }
    // 更新随机行走中心为拖动结束位置
    const b = petWindow.getBounds();
    randomWalkCenter = { x: b.x, y: b.y };
  });
  ipcMain.handle('window:show-context-menu', (event) => {
    assertSender(event, ['pet']);
    if (petWindow) Menu.buildFromTemplate(buildPetMenu()).popup({ window: petWindow });
  });
  ipcMain.handle('window:show-dashboard', (event, view?: DashboardView) => { assertSender(event, ['pet']); showDashboard(view); });
  ipcMain.handle('window:hide-dashboard', (event) => { assertSender(event, ['dashboard']); dashboardWindow?.hide(); });
  ipcMain.handle('window:hide-pet', (event) => { assertSender(event, ['pet', 'dashboard']); petWindow?.hide(); });
}

async function initialize(): Promise<void> {
  logger = new JsonLogger(userFile('logs/app.jsonl'));
  settings = await readValidatedJson(userFile('settings.json'), defaultSettings, parseSettings);
  reminders = await readValidatedJson(userFile('reminders.json'), [] as Reminder[], parseReminders);
  quotes = await readValidatedJson(userFile('quotes.json'), initialQuotes(), parseQuotes);
  stats = await readValidatedJson(userFile('pet-stats.json'), defaultStats, parsePersistedStats);
  normalizeStatsDay();
  sessionStartedAt = Date.now();
  registerIpc();
  await logger.write('info', 'main-initializing', { platform: process.platform, arch: process.arch, version: spec.app.version, schemaVersion: spec.schemaVersion });
  createWindows();
  createTray();
  reminders.forEach(scheduleReminder);
  restartTypingListener();
  applyAutoStart();
  startMoodDecay();
  scheduleSleep();
  if (settings.randomWalk) startRandomWalk();
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (e2eMode) petWindow.showInactive();
    else {
      petWindow.show();
      petWindow.focus();
    }
  });
  app.whenReady().then(() => {
    if (e2eMode) app.dock?.hide();
    return initialize();
  }).catch((error) => { void fatalExit('initialize-failed', error); });
} else {
  app.exit(0);
}

app.on('window-all-closed', () => { /* tray app stays alive */ });
app.on('before-quit', (event) => {
  isQuitting = true;
  typingListener.stop();
  stopMoodDecay();
  stopRandomWalk();
  for (const timer of reminderTimers.values()) clearTimeout(timer);
  reminderTimers.clear();
  if (quitPersisting || !stats) return;
  event.preventDefault();
  quitPersisting = true;
  void persistStats()
    .catch((error) => logger?.write('error', 'persist-stats-on-quit-failed', { message: error instanceof Error ? error.message : String(error) }))
    .finally(() => app.exit(0));
});
app.on('render-process-gone', (_event, webContents, details) => {
  if (isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') return;
  if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
    void fatalExit('render-process-gone', new Error(details.reason), { webContentsId: webContents.id, exitCode: details.exitCode });
  } else {
    void logger?.write('warn', 'render-process-gone', { webContentsId: webContents.id, reason: details.reason, exitCode: details.exitCode });
  }
});

process.on('uncaughtException', (error) => {
  void fatalExit('uncaught-exception', error, { stack: error.stack });
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  void fatalExit('unhandled-rejection', error, { stack: error.stack });
});
