export interface PetSpec {
  schemaVersion: number;
  app: {
    name: string;
    appId: string;
    version: string;
    language: string;
  };
  character: {
    inputType: string;
    displayName: string;
    archetype: string;
    personality: string[];
    preserveTraits: string[];
    style: string;
    mirrorSafe: boolean;
  };
  assetPipeline: {
    backgroundMode: string;
    generationBackground: string;
    backgroundTolerance: number;
    edgeFeather: number;
    safeMargin: number;
    targetOccupancy: number;
    occupancyTolerance: number;
    sourceCanvas: number;
    sourceMargin: number;
    sourceOccupancy: number;
    sourcePad: number;
    sourceScaleAxisCap: number;
    processMaxCorrection: number;
    qaMaxScaleRatio: number;
    qaMaxCenterDrift: number;
    qaMaxBottomDrift: number;
  };
  experience: {
    theme: {
      primary: string;
      accent: string;
      background: string;
      surface: string;
      text: string;
      muted: string;
      cornerRadius: number;
    };
    petSizing: {
      baseWindowPx: number;
      defaultScale: number;
      /** 人物在精灵帧内的横向占比上限：窗口宽度与贴边基准都据此派生（QA 依素材实测校验） */
      contentWidthRatio: number;
    };
    quotes: Record<string, QuoteGroupSpec>;
    interactions: InteractionSpec[];
  };
  motion: {
    breathing: { enabled: boolean; periodMs: number; scaleX: number; scaleY: number };
    squashStretch: { enabled: boolean; durationMs: number; intensity: number };
  };
  /** 待机轮播：待机时按权重随机挑一个动作单轮播放，播完续接下一个 */
  idleRotation: IdleRotationSpec;
  features: {
    transparentWindow: boolean;
    drag: boolean;
    tray: boolean;
    edgeSnap: boolean;
    reminders: boolean;
    interactions: boolean;
    filePocket: boolean;
    dashboard: boolean;
    typingReaction: boolean;
  };
  states: PetState[];
  storage: {
    userData: string;
    filePocket: string;
  };
  maintenance: {
    /** 启动时是否清理可重建缓存：Chromium 派生缓存目录、写入残留、超限日志。 */
    cacheSweepOnStartup: boolean;
    /** Chromium HTTP 磁盘缓存上限（MB），启动时作为 --disk-cache-size 生效。 */
    diskCacheLimitMb: number;
    /** 损坏隔离文件（*.corrupt）保留个数，按修改时间由新到旧计。 */
    keepCorruptFiles: number;
    /** 结构化日志体积上限（KB），超出后按行截断。 */
    logMaxKb: number;
  };
  build: {
    windows: { arch: string; installer: string; portable: string };
    macos: { arch: string; diskImage: string; portable: string };
    timeoutMinutes: number;
    unsigned: boolean;
  };
}

export interface QuoteGroupSpec {
  label: string;
  emoji: string;
  quotes: string[];
}

/**
 * 「回到待机」的调度信号：待机由 idleRotation 池中的动作轮播呈现，没有独立的待机状态，
 * 因此用这个 id 表达「脱离当前动作、回到待机轮播」，不指向任何一个可播放状态。
 */
export const STANDBY_SIGNAL = 'idle';

/**
 * 顶部气泡区高度（px）：气泡固定在此区内浮动，换行也不遮住精灵动画。
 * 主进程据此派生桌宠窗口尺寸，渲染层据此定位气泡与派生精灵高度。
 */
export const PET_BUBBLE_ZONE = 110;

export interface IdleRotationEntrySpec {
  /** 参与待机轮播的状态 id */
  id: string;
  /** 相对权重（正数），决定该动作被随机选中的概率 */
  weight: number;
}

/** 待机间歇长度区间，以呼吸次数计；索引即随机行走挡位（0 木头人 / 1 散步 / 2 正常 / 3 活泼 / 4 多动症） */
export interface IdleRotationGapLevelSpec {
  /** 间歇呼吸次数下限（整数，1 次 = motion.breathing.periodMs） */
  minBreaths: number;
  /** 间歇呼吸次数上限（整数） */
  maxBreaths: number;
}

/** 待机间歇：轮播动作播完后的停顿，期间展示 stateId 指向状态的静态帧 */
export interface IdleRotationGapSpec {
  /** 间歇期展示的状态 id（单帧静态帧，由待机轮播调度进入，无外部触发） */
  stateId: string;
  /** 每档呼吸次数区间，在该挡位区间内随机取一个整数次数 */
  levels: IdleRotationGapLevelSpec[];
}

export interface IdleRotationSpec {
  states: IdleRotationEntrySpec[];
  gap: IdleRotationGapSpec;
}

export interface InteractionSpec {
  id: string;
  emoji: string;
  label: string;
  stateId: string;
  durationMs: number;
  affectionGain: number;
  feedback: string[];
}

export interface PetState {
  id: string;
  triggers: string[];
  frames: string[];
  frameDurationMs: number;
  /** 是否循环播放；待机轮播成员一律单轮播放（每帧只出现一次，播完续接下一个待机动作） */
  loop: boolean;
  /** 本状态可打断（压过）的状态 id 名单；'*' 表示可打断一切；待机轮播动作是抢占基底，默认可被任意状态打断，无需列入 */
  canInterrupt: string[];
  interrupt: string;
  cooldownMs: number;
  direction: string;
  anchor: { x: number; y: number };
  mirrorSafe: boolean;
}

/**
 * 目标状态能否压过当前状态：看目标的在案打断名单（'*' 表示可打断一切）。
 * 渲染层状态机与主进程发 activity 前的预判共用这一份判据，避免两侧规则漂移。
 */
export function stateCanInterrupt(next: PetState, activeId: string): boolean {
  return next.canInterrupt.includes('*') || next.canInterrupt.includes(activeId);
}

/**
 * 该状态是否属于待机表现：idleRotation 的轮播池成员，或轮播之间的间歇。
 * 待机没有独立状态，由池内动作与间歇交替呈现，故判据落在 idleRotation 上。
 * 渲染层状态机（进入待机的抢占基底判定）与主进程（能否随机行走）共用这一份判据。
 * STANDBY_SIGNAL 视同待机：它是「回到待机」的调度信号本身，主进程在收到首次回报前也以它表示待机。
 */
export function isIdlePresentation(rotation: IdleRotationSpec, stateId: string): boolean {
  if (stateId === STANDBY_SIGNAL) return true;
  if (rotation.gap && stateId === rotation.gap.stateId) return true;
  return rotation.states.some((entry) => entry.id === stateId);
}

export interface PetStats {
  affection: number;
  mood: number;
  todayInteractions: number;
  companionMinutes: number;
  lastInteractionDate: string;
}

export interface Settings {
  edgeSnap: boolean;
  alwaysOnTop: boolean;
  typingReaction: boolean;
  clickThrough: boolean;
  petScale: number;
  autoStart: boolean;
  /** 是否用户已显式设置过开机自启；false 表示从未配置（首次/损坏回退），此时不写入系统自启动项 */
  autoStartInit: boolean;
  /** 随机行走挡位 0–4：0 木头人(关闭) / 1 散步 / 2 正常 / 3 活泼 / 4 多动症 */
  randomWalk: number;
  /** 开发者模式是否开启（版本号连点 6 次进入，持久化到 settings.json） */
  devMode: boolean;
}

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  createdAt: string;
}

export interface StateActivity {
  kind: string;
  stateId?: string;
  durationMs?: number;
  feedback?: string;
  mirror?: boolean;
}

export interface RuntimeReadyReport {
  status: string;
  stateId: string;
  frame: string;
  assetCount: number;
  expectedAssetCount: number;
  naturalWidth: number;
  naturalHeight: number;
  petVisible: boolean;
  ipcReady: boolean;
  renderers?: {
    pet: boolean;
    dashboard: boolean;
  };
}

export interface RuntimeFailureReport {
  message: string;
}

export interface InteractionResult {
  interaction: InteractionSpec;
  feedback: string;
  stats: PetStats;
}

export interface TypingStatus {
  enabled: boolean;
  reason: string;
}

// 小屋面板的视图：状态 / 语录 / 提醒，由桌宠右键或托盘右键三个选项分别进入
export type DashboardView = 'status' | 'quotes' | 'reminders';

/** 一次缓存清理的释放量明细，供数据管理页提示用户。 */
export interface CacheSweepSummary {
  freedBytes: number;
  cacheBytes: number;
  cacheFiles: number;
  residueBytes: number;
  residueFiles: number;
  logTrimmedBytes: number;
}

export interface PetAPI {
  settings: {
    get: () => Promise<Settings>;
    update: (patch: Partial<Settings>) => Promise<Settings>;
  };
  reminders: {
    list: () => Promise<Reminder[]>;
    save: (input: { text: string; dueAt: string }) => Promise<Reminder>;
    remove: (id: string) => Promise<boolean>;
    ack: () => Promise<boolean>;
  };
  quotes: {
    get: () => Promise<Record<string, string[]>>;
    save: (quotes: Record<string, string[]>) => Promise<void>;
  };
  data: {
    reset: () => Promise<void>;
    /** 清理可重建的缓存，返回各类释放量；失败时返回 undefined。 */
    clearCache: () => Promise<CacheSweepSummary | undefined>;
  };
  dev: {
    triggerSleep: () => Promise<void>;
    triggerWalk: () => Promise<void>;
    triggerWalkOnce: () => Promise<void>;
    setMood: (value: number) => Promise<PetStats>;
  };
  interactions: {
    list: () => Promise<InteractionSpec[]>;
    trigger: (id: string) => Promise<InteractionResult>;
    stats: () => Promise<PetStats>;
  };
  files: {
    getPathForFile: (file: File) => string;
    put: (paths: string[]) => Promise<{ copied: string[]; failed: Array<{ source: string; reason: string }> }>;
    openPocket: () => Promise<void>;
  };
  window: {
    beginDrag: () => Promise<void>;
    updateDrag: () => Promise<void>;
    endDrag: () => Promise<void>;
    showContextMenu: () => Promise<void>;
    showDashboard: (view?: DashboardView) => Promise<void>;
    hideDashboard: () => Promise<void>;
    hidePet: () => Promise<void>;
  };
  runtime: {
    ready: (report: RuntimeReadyReport) => Promise<void>;
    fail: (report: RuntimeFailureReport) => Promise<void>;
  };
  state: {
    get: () => Promise<string>;
    /**
     * 上报桌宠窗口实际在播的状态。渲染层是状态与时序的真源（帧推进、轮播选择、间歇长度都在那里），
     * 每次状态落地即回报，主进程据此镜像事实状态，不再靠「自己发过什么」推断。
     */
    report: (stateId: string) => Promise<void>;
  };
  events: {
    onStateActivity: (listener: (activity: StateActivity) => void) => () => void;
    onStateChanged: (listener: (stateId: string) => void) => () => void;
    onRemindersUpdated: (listener: () => void) => () => void;
    onQuotesChanged: (listener: () => void) => () => void;
    onDashboardView: (listener: (view: DashboardView) => void) => () => void;
    onStats: (listener: (stats: PetStats) => void) => () => void;
    onTypingStatus: (listener: (status: TypingStatus) => void) => () => void;
    onPetSizeApplied: (listener: () => void) => () => void;
    /** 设置变更广播：供桌宠窗口同步依赖设置的呈现（如随机行走挡位决定待机间歇时长） */
    onSettingsChanged: (listener: (settings: Settings) => void) => () => void;
  };
}

declare global {
  interface Window {
    petAPI?: PetAPI;
    __petE2E?: {
      snapshot: () => Promise<{
        tray: boolean;
        roles: Array<{ role: 'pet' | 'dashboard'; visible: boolean; destroyed: boolean }>;
        quitting: boolean;
      }>;
      quit: () => Promise<void>;
    };
  }
}

export function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError('Expected string array');
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError('Expected string array');
  }
}

export function assertInteractionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 100) {
    throw new TypeError('Invalid interaction id');
  }
}

export function assertSettingsPatch(value: unknown): asserts value is Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid settings patch');
  }
  const obj = value as Record<string, unknown>;
  const booleanKeys = new Set(['edgeSnap', 'alwaysOnTop', 'typingReaction', 'clickThrough', 'autoStart', 'devMode']);
  const allowedKeys = new Set([...booleanKeys, 'petScale', 'randomWalk']);
  for (const [key, item] of Object.entries(obj)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unknown settings field: ${key}`);
    if (booleanKeys.has(key) && typeof item !== 'boolean') throw new TypeError(`Invalid settings field: ${key}`);
    if (key === 'petScale' && (typeof item !== 'number' || !Number.isFinite(item) || item < 0.5 || item > 1.5)) {
      throw new TypeError('Invalid settings field: petScale');
    }
    if (key === 'randomWalk' && (!Number.isInteger(item) || (item as number) < 0 || (item as number) > 4)) {
      throw new TypeError('Invalid settings field: randomWalk');
    }
  }
}

export function assertReminderInput(value: unknown): asserts value is { text: string; dueAt: string } {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid reminder input');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== 'string' || obj.text.length > 500) {
    throw new TypeError('Invalid reminder text');
  }
  if (typeof obj.dueAt !== 'string' || isNaN(Date.parse(obj.dueAt))) {
    throw new TypeError('Invalid reminder dueAt');
  }
}

export function assertRuntimeReadyReport(value: unknown): asserts value is RuntimeReadyReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime ready report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.stateId !== 'string') throw new TypeError('Invalid stateId');
  if (typeof obj.frame !== 'string') throw new TypeError('Invalid frame');
  if (typeof obj.assetCount !== 'number') throw new TypeError('Invalid assetCount');
  if (typeof obj.naturalWidth !== 'number') throw new TypeError('Invalid naturalWidth');
  if (typeof obj.naturalHeight !== 'number') throw new TypeError('Invalid naturalHeight');
}

export function assertRuntimeFailureReport(value: unknown): asserts value is RuntimeFailureReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime failure report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.message !== 'string') throw new TypeError('Invalid message');
}
