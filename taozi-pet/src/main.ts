import { app } from 'electron';
import path from 'node:path';
import specData from '../pet-spec.json';
import type { PetSpec, Reminder, Settings } from './shared/contracts';
import { createMainContext, type Role } from './main/context';
import { localDateKey, parsePersistedStats, parseQuotes, parseReminders, parseSettings, type PersistedStats } from './main/data-validation';
import { registerIpc } from './main/ipc';
import { JsonLogger } from './main/logger';
import { startMoodDecay, stopMoodDecay } from './main/mood';
import { readValidatedJson } from './main/persistence';
import { initialQuotes } from './main/quotes';
import { startRandomWalk, stopRandomWalk } from './main/random-walk';
import { scheduleReminder } from './main/reminders';
import { cacheMaintenancePaths, fatalExit, logCacheReport, userFile } from './main/runtime';
import { restartTypingListener } from './main/settings';
import { scheduleSleep } from './main/sleep';
import { normalizeStatsDay, persistStats } from './main/stats';
import { createTray, refreshTrayMenu } from './main/tray';
import { applyAutoStart, createWindows } from './main/windows';

const spec = specData as PetSpec;

// Chromium HTTP 磁盘缓存上限：桌宠只加载本地素材，缓存无需长期占用大容量。
app.commandLine.appendSwitch('disk-cache-size', String(spec.maintenance.diskCacheLimitMb * 1024 * 1024));

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
  devMode: false,
};

const defaultStats: PersistedStats = {
  affection: 0,
  mood: 40,
  todayInteractions: 0,
  totalCompanionMs: 0,
  lastInteractionDate: localDateKey(),
  dailyInteractionDates: {},
  lastMoodDecayMs: Date.now(),
};

const ctx = createMainContext({
  spec,
  e2eMode,
  runtimeEvidenceEnabled: !app.isPackaged || process.env.PET_PREVIEW_MODE === '1',
  runtimeReadyFile: path.join(process.cwd(), '.build', 'runtime-ready.json'),
  runtimeFailureFile: path.join(process.cwd(), '.build', 'runtime-failed.json'),
  defaultSettings,
  defaultStats,
  cacheSweepOnStartup: spec.maintenance.cacheSweepOnStartup,
  cacheOptions: () => cacheMaintenancePaths(spec),
});

// 托盘菜单依赖设置文案，设置保存后回建；由装配方注入以保持模块单向依赖
ctx.hooks.refreshTrayMenu = () => refreshTrayMenu(ctx);

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (e2eMode) {
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
      tray: Boolean(ctx.tray && !ctx.tray.isDestroyed()),
      roles: [ctx.petWindow, ctx.dashboardWindow].map((window, index) => ({
        role: (['pet', 'dashboard'] as const)[index]!,
        visible: Boolean(window?.isVisible()),
        destroyed: Boolean(window?.isDestroyed()),
      })),
      quitting: ctx.isQuitting,
    }),
    quit: () => {
      ctx.isQuitting = true;
      app.quit();
    },
  };
}

async function initialize(): Promise<void> {
  ctx.logger = new JsonLogger(userFile('logs/app.jsonl'));
  const startupReport = await ctx.startupCacheSweep;
  if (startupReport) await logCacheReport(ctx, 'startup', startupReport);
  ctx.settings = await readValidatedJson(userFile('settings.json'), defaultSettings, parseSettings);
  ctx.reminders = await readValidatedJson(userFile('reminders.json'), [] as Reminder[], parseReminders);
  ctx.quotes = await readValidatedJson(userFile('quotes.json'), initialQuotes(ctx), parseQuotes);
  ctx.stats = await readValidatedJson(userFile('pet-stats.json'), defaultStats, parsePersistedStats);
  ctx.statsReady = true;
  normalizeStatsDay(ctx);
  ctx.sessionStartedAt = Date.now();
  registerIpc(ctx);
  await ctx.logger.write('info', 'main-initializing', { platform: process.platform, arch: process.arch, version: spec.app.version, schemaVersion: spec.schemaVersion });
  createWindows(ctx);
  createTray(ctx);
  ctx.reminders.forEach((reminder) => scheduleReminder(ctx, reminder));
  restartTypingListener(ctx);
  applyAutoStart(ctx);
  startMoodDecay(ctx);
  scheduleSleep(ctx);
  if (ctx.settings.randomWalk) startRandomWalk(ctx);
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    if (e2eMode) ctx.petWindow.showInactive();
    else {
      ctx.petWindow.show();
      ctx.petWindow.focus();
    }
  });
  app.whenReady().then(() => {
    if (e2eMode) app.dock?.hide();
    return initialize();
  }).catch((error) => { void fatalExit(ctx, 'initialize-failed', error); });
} else {
  app.exit(0);
}

app.on('window-all-closed', () => { /* tray app stays alive */ });
app.on('before-quit', (event) => {
  ctx.isQuitting = true;
  ctx.typingListener.stop();
  stopMoodDecay(ctx);
  stopRandomWalk(ctx);
  for (const timer of ctx.reminderTimers.values()) clearTimeout(timer);
  ctx.reminderTimers.clear();
  if (ctx.quitPersisting || !ctx.statsReady) return;
  event.preventDefault();
  ctx.quitPersisting = true;
  void persistStats(ctx)
    .catch((error) => ctx.logger?.write('error', 'persist-stats-on-quit-failed', { message: error instanceof Error ? error.message : String(error) }))
    .finally(() => app.exit(0));
});
app.on('render-process-gone', (_event, webContents, details) => {
  if (ctx.isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') return;
  if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
    void fatalExit(ctx, 'render-process-gone', new Error(details.reason), { webContentsId: webContents.id, exitCode: details.exitCode });
  } else {
    void ctx.logger?.write('warn', 'render-process-gone', { webContentsId: webContents.id, reason: details.reason, exitCode: details.exitCode });
  }
});

process.on('uncaughtException', (error) => {
  void fatalExit(ctx, 'uncaught-exception', error, { stack: error.stack });
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  void fatalExit(ctx, 'unhandled-rejection', error, { stack: error.stack });
});
