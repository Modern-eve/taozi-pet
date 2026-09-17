import type { BrowserWindow, Tray } from 'electron';
import type { PetSpec, Reminder, RuntimeReadyReport, Settings, TypingStatus } from '../shared/contracts';
import { STANDBY_SIGNAL } from '../shared/contracts';
import type { CacheMaintenanceReport } from './cache-maintenance';
import { runCacheMaintenance } from './cache-maintenance';
import type { Point, Rect } from './drag';
import type { PersistedStats } from './data-validation';
import type { JsonLogger } from './logger';
import { TypingListener } from './typing-listener';

export type Role = 'pet' | 'dashboard';

/**
 * 主进程的共享运行时状态。
 *
 * 所有可变状态集中在这一个对象上，各模块从参数拿到它，从而不必互相 import——
 * 模块间只存在单向依赖（见 main.ts 的装配顺序），不会出现循环引用。
 * 约定：可变量一律写成 ctx.xxx 的读写，不要在新模块里另起模块级 let。
 */
export interface MainContext {
  readonly spec: PetSpec;
  readonly e2eMode: boolean;
  /** 是否写出 .build 下的运行时证据文件（打包后默认关闭，预览模式与 e2e 打开） */
  readonly runtimeEvidenceEnabled: boolean;
  readonly runtimeReadyFile: string;
  readonly runtimeFailureFile: string;
  /** 运行时素材集合 = spec 中各状态 frames 的并集（非循环状态重复引用 base 帧，不产生额外文件） */
  readonly expectedRuntimeAssets: Set<string>;
  readonly typingListener: TypingListener;
  readonly roles: Map<number, Role>;
  readonly runtimeReadyRenderers: Set<Role>;
  readonly reminderTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** 启动期缓存治理（在 ready 之前发起，此时 Chromium 尚未打开缓存目录） */
  readonly startupCacheSweep: Promise<CacheMaintenanceReport | undefined>;

  defaultSettings: Settings;
  defaultStats: PersistedStats;
  petWindow?: BrowserWindow;
  dashboardWindow?: BrowserWindow;
  tray?: Tray;
  logger?: JsonLogger;
  settings: Settings;
  reminders: Reminder[];
  quotes: Record<string, string[]>;
  stats: PersistedStats;
  /** 统计文件是否已从磁盘载入：退出时据此决定能否落盘，避免用默认值覆盖已有统计 */
  statsReady: boolean;
  sessionStartedAt: number;
  typingStatus: TypingStatus;
  isQuitting: boolean;
  dragSession?: { bounds: Rect; cursor: Point };
  moodDecayTimer?: ReturnType<typeof setInterval>;
  randomWalkTimer?: ReturnType<typeof setTimeout>;
  randomWalkAnimTimer?: ReturnType<typeof setInterval>;
  randomWalkCenter?: { x: number; y: number };
  sleepTimer?: ReturnType<typeof setTimeout>;
  lastActivityTime: number;
  /** 当前实际在播的状态：由桌宠窗口回报驱动（见 activity.ts 的 applyReportedState） */
  currentStateId: string;
  runtimeRendererReport?: RuntimeReadyReport;
  runtimeWindowReady: boolean;
  runtimeCommitted: boolean;
  fatalExitStarted: boolean;
  quitPersisting: boolean;
  /** 已到点、等待用户逐个消费的提醒队列（按到点先后排队：旧→新） */
  pendingReminderQueue: Reminder[];
  nextAnnounceReminderTimer: ReturnType<typeof setTimeout> | null;
  /** 打字反应的节流锚点 */
  lastTypingReactionAt: number;
  /** 由装配方（main.ts）注入的回调，用于打破模块间本会形成的循环依赖 */
  hooks: { refreshTrayMenu?: () => void };
}

/** 建一个主进程共享上下文的默认值骨架；路径与开关由调用方（main.ts）补齐。 */
export function createMainContext(options: {
  spec: PetSpec;
  e2eMode: boolean;
  runtimeEvidenceEnabled: boolean;
  runtimeReadyFile: string;
  runtimeFailureFile: string;
  defaultSettings: Settings;
  defaultStats: PersistedStats;
  cacheSweepOnStartup: boolean;
  cacheOptions: () => Parameters<typeof runCacheMaintenance>[0];
}): MainContext {
  const { spec } = options;
  const ctx: MainContext = {
    spec,
    e2eMode: options.e2eMode,
    runtimeEvidenceEnabled: options.runtimeEvidenceEnabled,
    runtimeReadyFile: options.runtimeReadyFile,
    runtimeFailureFile: options.runtimeFailureFile,
    expectedRuntimeAssets: new Set(spec.states.flatMap((state) => state.frames)),
    typingListener: new TypingListener(),
    roles: new Map(),
    runtimeReadyRenderers: new Set(),
    reminderTimers: new Map(),
    startupCacheSweep: options.cacheSweepOnStartup
      ? runCacheMaintenance(options.cacheOptions()).catch(() => undefined)
      : Promise.resolve(undefined),
    defaultSettings: options.defaultSettings,
    defaultStats: options.defaultStats,
    settings: options.defaultSettings,
    reminders: [],
    quotes: {},
    stats: { ...options.defaultStats },
    statsReady: false,
    sessionStartedAt: Date.now(),
    typingStatus: { enabled: false, reason: 'not-started' },
    isQuitting: false,
    lastActivityTime: Date.now(),
    // 尚未收到首次回报时按待机处理
    currentStateId: STANDBY_SIGNAL,
    runtimeWindowReady: false,
    runtimeCommitted: false,
    fatalExitStarted: false,
    quitPersisting: false,
    pendingReminderQueue: [],
    nextAnnounceReminderTimer: null,
    lastTypingReactionAt: 0,
    hooks: {},
  };
  return ctx;
}
