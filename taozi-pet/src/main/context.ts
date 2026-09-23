import type { BrowserWindow, Tray } from 'electron';
import type { BubbleBox, PetSpec, Reminder, RuntimeReadyReport, Settings, SnapSide, TypingStatus, WalkConfig } from '../shared/contracts';
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
  /** 调试叠加层窗口（开发者模式按需创建）：全屏透明、点击穿透，只负责画吸附判定带与行走范围 */
  debugOverlayWindow?: BrowserWindow;
  /** 调试叠加层是否处于显示状态（设置变更时据此决定是否重画或撤下） */
  debugOverlayVisible: boolean;
  /** 上一次向叠加层下发绘制数据的时间：桌宠移动逐帧触发同步，据此限频 */
  debugOverlaySyncedAt: number;
  /**
   * 当前正在显示的气泡盒子（桌宠窗口内坐标），由桌宠窗口上报；未显示气泡时为 null。
   * 气泡宽度只有渲染层量得准：贴边基准与调试叠加层的尺寸标注都用它。
   */
  bubbleBox: BubbleBox | null;
  tray?: Tray;
  logger?: JsonLogger;
  settings: Settings;
  /** 当前生效的随机行走配置：默认来自 spec.motion.walk，被 userData/tuning.json 覆盖后取覆盖值 */
  walk: WalkConfig;
  /** 随机行走是否处于运行时覆盖状态（面板据此显示"已覆盖/恢复默认"） */
  walkOverridden: boolean;
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
  /** 桌宠窗口的贴边侧：吸附后置位，拖拽中 / 随机行走 / 尺寸变化时清空（见 windows.ts 的 setSnapSide） */
  snapSide: SnapSide;
  /** 上一次贴边实际采用的基准框宽度（px），0 表示未贴边；调试叠加层据此画出人物的真实横向位置 */
  snapWidth: number;
  /**
   * 拖拽开始时渲染层预告的「贴边将要播报的那条语录」气泡宽度（px），无语录可播时为 null。
   * 贴边位置据此把气泡让出来，避免贴边后弹出的语录气泡被顶出屏幕。
   */
  snapPreviewWidth: number | null;
  sleepTimer?: ReturnType<typeof setTimeout>;
  lastActivityTime: number;
  /** 当前实际在播的状态：由桌宠窗口回报驱动（见 activity.ts 的 applyReportedState） */
  currentStateId: string;
  runtimeRendererReport?: RuntimeReadyReport;
  runtimeWindowReady: boolean;
  runtimeCommitted: boolean;
  /** 每个角色已发起的渲染层重载恢复次数：达到上限后升级为致命错误，避免无限重载 */
  rendererRecoveryAttempts: Map<Role, number>;
  fatalExitStarted: boolean;
  quitPersisting: boolean;
  /** 已到点、等待用户逐个消费的提醒队列（按到点先后排队：旧→新） */
  pendingReminderQueue: Reminder[];
  nextAnnounceReminderTimer: ReturnType<typeof setTimeout> | null;
  /** 键盘反应的回待机定时器：抬起字母键后起算，再次按下即清空 */
  typingIdleTimer: ReturnType<typeof setTimeout> | undefined;
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
    walk: spec.motion.walk,
    walkOverridden: false,
    reminders: [],
    quotes: {},
    stats: { ...options.defaultStats },
    statsReady: false,
    sessionStartedAt: Date.now(),
    typingStatus: { enabled: false, reason: 'not-started' },
    isQuitting: false,
    snapSide: null,
    snapWidth: 0,
    snapPreviewWidth: null,
    debugOverlayVisible: false,
    debugOverlaySyncedAt: 0,
    bubbleBox: null,
    lastActivityTime: Date.now(),
    // 尚未收到首次回报时按待机处理
    currentStateId: STANDBY_SIGNAL,
    runtimeWindowReady: false,
    runtimeCommitted: false,
    rendererRecoveryAttempts: new Map(),
    fatalExitStarted: false,
    quitPersisting: false,
    pendingReminderQueue: [],
    nextAnnounceReminderTimer: null,
    typingIdleTimer: undefined,
    hooks: {},
  };
  return ctx;
}
