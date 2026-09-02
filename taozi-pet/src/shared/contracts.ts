export interface PetSpec {
  schemaVersion: number;
  app: {
    name: string;
    appId: string;
    version: string;
    language: string;
  };
  targets: {
    windows: { enabled: boolean; arch: string };
    macos: { enabled: boolean; arch: string };
  };
  character: {
    inputType: string;
    coreAsset: string;
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
    };
    quotes: Record<string, QuoteGroupSpec>;
    interactions: InteractionSpec[];
  };
  motion: {
    breathing: { enabled: boolean; periodMs: number; scaleX: number; scaleY: number };
    squashStretch: { enabled: boolean; durationMs: number; intensity: number };
    idleIntervalMs: { min: number; max: number };
  };
  features: {
    transparentWindow: boolean;
    drag: boolean;
    tray: boolean;
    edgeSnap: boolean;
    reminders: boolean;
    interactions: boolean;
    relationship: boolean;
    filePocket: boolean;
    dashboard: boolean;
    typingReaction: boolean;
  };
  states: PetState[];
  storage: {
    userData: string;
    filePocket: string;
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
  loop: boolean;
  /** 本状态可打断（压过）的状态 id 名单；'*' 表示可打断一切；待机(idle)默认可被任意状态打断，无需列入 */
  canInterrupt: string[];
  interrupt: string;
  cooldownMs: number;
  direction: string;
  anchor: { x: number; y: number };
  mirrorSafe: boolean;
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
  };
  dev: {
    triggerSleep: () => Promise<void>;
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
  events: {
    onStateActivity: (listener: (activity: StateActivity) => void) => () => void;
    onRemindersUpdated: (listener: () => void) => () => void;
    onQuotesChanged: (listener: () => void) => () => void;
    onDashboardView: (listener: (view: DashboardView) => void) => () => void;
    onStats: (listener: (stats: PetStats) => void) => () => void;
    onTypingStatus: (listener: (status: TypingStatus) => void) => () => void;
    onPetSizeApplied: (listener: () => void) => () => void;
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
