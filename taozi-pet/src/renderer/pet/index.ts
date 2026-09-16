import spec from '../../../pet-spec.json';
import type { PetSpec, StateActivity } from '../../shared/contracts';
import { STANDBY_SIGNAL } from '../../shared/contracts';
import { exceedsDragThreshold } from '../../main/drag';
import { PetStateMachine } from './state-machine';
import type { StateFrame } from './state-machine';
import './index.css';

const petSpec = spec as PetSpec;

const sprite = document.getElementById('pet-sprite') as HTMLImageElement;
const spriteFrame = document.getElementById('pet-sprite-frame') as HTMLDivElement;
const container = document.getElementById('pet-container') as HTMLDivElement;
const feedbackBubble = document.getElementById('feedback-bubble') as HTMLDivElement;

// 与主进程保持一致：顶部气泡区高度(px)。精灵贴底为正方形，高度 = 100vh - 气泡区高（见 CSS），
// 气泡固定在该区内浮动；精灵尺寸由 CSS 100vh 自动随窗口同步，缩小/放大均稳定生效，且不影响气泡尺寸。
const PET_BUBBLE_ZONE = 110;

// Chromium 会默认把 img 当作可拖拽内容；桌宠只允许窗口拖拽。
container.addEventListener('dragstart', (event) => event.preventDefault());

// Webpack 在构建时递归收集当前 spec 对应的素材，不硬编码角色或动作名。
const assetMap = new Map<string, string>();
const assetFrames = new Map<string, string[]>();
const assetContext = require.context('../../assets/pet', true, /\.png$/i);
for (const key of assetContext.keys()) {
  assetMap.set(key.replace(/^\.\//, ''), assetContext(key));
}

// 构建状态帧映射
for (const state of petSpec.states) {
  assetFrames.set(state.id, state.frames);
}

// 待机轮播池成员（含间歇期的 standby-gap）由 spec 的 idleRotation 声明，
// 是否处于待机统一问状态机（轮播动作与间歇都算待机）。
// 间歇长度以呼吸次数计，故把呼吸周期一并交给状态机换算（单一来源 spec.motion.breathing）。
const stateMachine = new PetStateMachine(
  petSpec.states,
  petSpec.idleRotation,
  performance.now(),
  petSpec.motion.breathing.periodMs,
);
container.dataset.state = stateMachine.currentStateId();
let animationFrame: number | null = null;

// 呼吸动效：只服务待机间歇（单帧静态母版），间歇期间的全部动感来自这层缓慢缩放。
// 动画挂在帧容器上、挤压回弹挂在精灵自身，两层元素各持一个 transform，互不覆盖，
// 因此点击的挤压播完后不会顶掉呼吸，下一次进入间歇照常呼吸。
const breathing = petSpec.motion.breathing;
const breathStateId = petSpec.idleRotation.gap.stateId;
if (breathing.enabled) {
  document.documentElement.style.setProperty('--breath-period', `${breathing.periodMs}ms`);
  document.documentElement.style.setProperty('--breath-scale-x', `${1 + breathing.scaleX}`);
  document.documentElement.style.setProperty('--breath-scale-y', `${1 + breathing.scaleY}`);
}
let breathingActive = false;

function applyBreathing(stateId: string): void {
  const on = breathing.enabled && stateId === breathStateId;
  if (on === breathingActive) return; // 状态未变则不重挂，避免动画反复重头播放
  breathingActive = on;
  spriteFrame.classList.toggle('breathing', on);
}

applyBreathing(container.dataset.state ?? '');

// 挤压回弹
function playSquash(): void {
  if (!petSpec.motion.squashStretch.enabled) return;
  const squash = petSpec.motion.squashStretch;
  document.documentElement.style.setProperty('--squash-duration', `${squash.durationMs}ms`);
  document.documentElement.style.setProperty('--squash-intensity', `${squash.intensity}`);
  sprite.classList.remove('squash');
  void sprite.offsetWidth; // 触发重绘
  sprite.classList.add('squash');
}

// 精灵尺寸锚定：显式用窗口高度派生精灵高度（正方形），而非只依赖 CSS 100vh——
// 后者在窗口缩小/放大时不一定触发重排，尺寸会滞后。resize 触发即为窗口最终尺寸，即时生效。
function applySpriteSize(): void {
  const height = Math.max(0, window.innerHeight - PET_BUBBLE_ZONE);
  sprite.style.height = `${height}px`;
}
window.addEventListener('resize', applySpriteSize);
applySpriteSize();

// 显示反馈气泡
// persist=true 时气泡不自动消失（用于提醒通知，直到用户点击桌宠或其他动作后才被替换/隐藏）
// durationMs 为自动消失时长（默认 5s；peek 用 3s）
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

// 气泡定位：短文本贴近桌宠（气泡区底部、精灵上方），长文本固定在气泡区顶部换行/滚动，始终不遮动画
function positionBubble(): void {
  const zoneHeight = PET_BUBBLE_ZONE; // 顶部气泡区高度(px)，固定不变
  const margin = 10;
  const contentHeight = feedbackBubble.scrollHeight; // 内容自然高度（不受 max-height 截断影响）
  const available = zoneHeight - margin * 2;
  feedbackBubble.style.top = contentHeight <= available
    ? `${zoneHeight - contentHeight - margin}px` // 短文本：贴住精灵上方
    : `${margin}px`; // 长文本：固定在气泡区顶部，max-height 内滚动
}

function showFeedback(text: string, persist = false, hideAfterMs = 5000): void {
  feedbackBubble.textContent = text;
  positionBubble();
  feedbackBubble.classList.add('show');
  if (feedbackTimer) clearTimeout(feedbackTimer); // 防止多次点击堆叠 timer
  if (persist) {
    feedbackTimer = null;
    return;
  }
  feedbackTimer = setTimeout(() => {
    feedbackBubble.classList.remove('show');
  }, hideAfterMs);
}

// 切换状态
let currentMirror = false;

// 镜像应用到 container，避免与帧容器的呼吸、精灵的挤压回弹争用 transform；
// 气泡同步翻转，保证镜像播放时语录文字不被镜像
function applyMirror(mirror: boolean): void {
  currentMirror = mirror;
  if (mirror) {
    container.style.transform = 'scaleX(-1)';
    feedbackBubble.classList.add('mirrored');
  } else {
    container.style.transform = '';
    feedbackBubble.classList.remove('mirrored');
  }
}

function showFrame(snapshot: StateFrame): void {
  container.dataset.state = snapshot.stateId;
  const frameUrl = assetMap.get(snapshot.frame);
  if (frameUrl) sprite.src = frameUrl;
}

function setState(stateId: string, durationMs?: number, mirror = false): void {
  applyMirror(mirror);
  if (!stateMachine.start(stateId, performance.now(), durationMs)) return;
  showFrame(stateMachine.tick(performance.now()));
}

// 进入待机：'idle' 是调度信号而非可播放状态，实际播放哪个动作由状态机按权重随机决定
function enterStandby(): void {
  applyMirror(false);
  stateMachine.startStandby(performance.now());
  showFrame(stateMachine.tick(performance.now()));
}

// 动画循环：仅在帧/状态变化时更新 DOM，减少无变化帧的布局/绘制开销
function animate(timestamp: number): void {
  const snapshot = stateMachine.tick(timestamp);
  if (snapshot.stateChanged) {
    showFrame(snapshot);
    // peek 和 walk 状态保持镜像，切回其他状态时重置
    if (snapshot.stateId !== 'peek' && snapshot.stateId !== 'walk') {
      container.style.transform = '';
      feedbackBubble.classList.remove('mirrored');
      currentMirror = false;
    } else if (currentMirror) {
      container.style.transform = 'scaleX(-1)';
      feedbackBubble.classList.add('mirrored');
    }
  }
  ensureSleepQuoteTimer();
  announceStandbyQuote(snapshot.stateId);
  animationFrame = requestAnimationFrame(animate);
}

// ---- 睡眠常驻时随机补弹睡觉语录 ----
// sleep 常驻（durationMs 0）期间没有新的 activity 触发，动画循环只换帧不弹气泡；
// 这里用一个自循环随机定时器，在入睡期间每隔 12~30s 随机补一句睡觉语录，离开 sleep 即停止。
let sleepQuoteTimer: ReturnType<typeof setTimeout> | null = null;

function ensureSleepQuoteTimer(): void {
  const isSleeping = stateMachine.currentStateId() === 'sleep';
  if (isSleeping && sleepQuoteTimer === null) {
    scheduleSleepQuote();
  } else if (!isSleeping && sleepQuoteTimer !== null) {
    clearTimeout(sleepQuoteTimer);
    sleepQuoteTimer = null;
  }
}

function scheduleSleepQuote(): void {
  const delay = 12000 + Math.random() * 18000; // 12~30s 随机
  sleepQuoteTimer = setTimeout(() => {
    sleepQuoteTimer = null;
    if (stateMachine.currentStateId() === 'sleep') {
      const quote = getQuote('sleep');
      if (quote) showFeedback(quote);
      ensureSleepQuoteTimer();
    }
  }, delay);
}

// ---- 待机语录：进入待机动作时播报 ----
// 间歇期间不发声；等挡位对应的间歇走完、进入下一个待机动作时，随机取该动作的一句语录，气泡 3s。
// 播报节奏因此天然跟着随机行走挡位走（挡位越高间歇越短、说话越勤），无需独立定时器。
const rotationStateIds = petSpec.idleRotation.states.map((entry) => entry.id);
const STANDBY_QUOTE_HIDE_MS = 3000;
let lastAnnouncedStateId = stateMachine.currentStateId();

function announceStandbyQuote(stateId: string): void {
  if (stateId === lastAnnouncedStateId) return;
  lastAnnouncedStateId = stateId;
  if (!rotationStateIds.includes(stateId)) return; // 间歇与其它状态不发声
  const quote = getQuote(stateId);
  if (quote) showFeedback(quote, false, STANDBY_QUOTE_HIDE_MS);
}

// 点击语录
// 全部语录文本统一定义在 pet-spec.json，运行时持久化到 userData/quotes.json；
// 本窗口通过 IPC 拉取并缓存（init 时加载，dashboard 修改后经 quotes:changed 事件刷新）。
let customQuotesCache: Record<string, string[]> | null = null;
function loadCustomQuotes(): Record<string, string[]> {
  if (customQuotesCache) return customQuotesCache;
  return {};
}

function getQuote(stateId: string): string {
  try {
    const custom = loadCustomQuotes();
    if (Array.isArray(custom[stateId]) && custom[stateId].length > 0) {
      const quotes = custom[stateId] as string[];
      const pick = quotes[Math.floor(Math.random() * quotes.length)];
      if (pick) return pick;
    }
  } catch { /* ignore */ }
  const defaults = petSpec.experience.quotes?.[stateId]?.quotes;
  if (defaults && defaults.length > 0) {
    return defaults[Math.floor(Math.random() * defaults.length)] || '';
  }
  return '';
}

// 点击事件
// 顶部气泡区（0 ~ PET_BUBBLE_ZONE）是留给气泡的透明留白：真实用户点那里不触发桌宠互动
// （程序化 click 事件 isTrusted=false，不在此限制内，e2e 测试仍可正常点击）
function inBubbleZone(event: MouseEvent | PointerEvent): boolean {
  return event.isTrusted && event.clientY < PET_BUBBLE_ZONE;
}

container.addEventListener('click', (event) => {
  if (inBubbleZone(event)) return;
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  playSquash();
  setState('happy');
  // 点击桌宠即消费待处理提醒（notify 循环被 happy 打断，气泡被点击语录替换）
  void window.petAPI?.reminders.ack().catch(() => {});
  // 沮丧状态下 happy 压不过 sad（动画不切，仍是沮丧），点击不该弹兴奋语录——
  // 此时改弹沮丧安抚语录，语气与心情一致
  const quote = stateMachine.currentStateId() === 'sad'
    ? (getQuote('sad') || getQuote('__click__'))
    : getQuote('__click__');
  showFeedback(quote);
});

// 拖拽
let isDragging = false;
let pointerStart = { x: 0, y: 0 };
let activePointerId: number | undefined;
let dragUpdatePending = false;
let suppressNextClick = false;
let dragBegin: Promise<void> | undefined;

container.addEventListener('pointerdown', (event) => {
  if (inBubbleZone(event)) return;
  if (event.button !== 0 || activePointerId !== undefined) return;
  activePointerId = event.pointerId;
  pointerStart = { x: event.clientX, y: event.clientY };
  container.setPointerCapture(event.pointerId);
});

container.addEventListener('pointermove', (event) => {
  if (event.pointerId !== activePointerId) return;
  if (!isDragging && exceedsDragThreshold(pointerStart, { x: event.clientX, y: event.clientY })) {
    isDragging = true;
    dragBegin = window.petAPI?.window.beginDrag() ?? Promise.resolve();
  }
  if (!isDragging) return;
  if (dragUpdatePending) return;
  dragUpdatePending = true;
  requestAnimationFrame(() => {
    void (dragBegin ?? Promise.resolve())
      .then(() => window.petAPI?.window.updateDrag())
      .catch(() => {})
      .finally(() => { dragUpdatePending = false; });
  });
});

function finishPointer(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;
  if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
  activePointerId = undefined;
  const dragged = isDragging;
  isDragging = false;
  dragUpdatePending = false;
  if (dragged) {
    suppressNextClick = true;
    void (dragBegin ?? Promise.resolve())
      .then(() => window.petAPI?.window.endDrag())
      .catch(() => {});
  }
  dragBegin = undefined;
}

container.addEventListener('pointerup', finishPointer);
container.addEventListener('pointercancel', finishPointer);

// 右键菜单
container.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI?.window.showContextMenu().catch(() => {});
});

// 监听状态活动
window.petAPI?.events.onStateActivity((activity: StateActivity) => {
  if (activity.stateId) {
    // 互动语录由主进程从运行时语录（quotes.json）选词后随 activity.feedback 下发
    const feedback = activity.feedback;
    // 待机信号：由状态机随机挑一个待机动作播放，而不是切到某个固定状态
    if (activity.stateId === STANDBY_SIGNAL) enterStandby();
    else setState(activity.stateId, activity.durationMs, activity.mirror === true);
    // 提醒到点：notify 动作 + 气泡持续显示，直到用户点击其他动作
    if (activity.kind === 'notify' && feedback) {
      showFeedback(feedback, true);
    } else if (feedback) {
      showFeedback(feedback);
    } else if (activity.stateId !== STANDBY_SIGNAL && activity.stateId !== 'notify' && activity.kind !== 'interaction') {
      const quote = getQuote(activity.stateId);
      if (quote) showFeedback(quote, false, activity.stateId === 'peek' ? 3000 : 5000);
    }
  } else if (activity.feedback) {
    showFeedback(activity.feedback);
  }
});

// 初始化
async function init(): Promise<void> {
  try {
    // 从主进程加载语录数据（单一数据源 userData/quotes.json）
    customQuotesCache = (await window.petAPI?.quotes.get()) ?? {};
    // dashboard 修改语录后刷新本窗口缓存
    window.petAPI?.events.onQuotesChanged(() => {
      void window.petAPI?.quotes.get().then((q) => { customQuotesCache = q; });
    });
    // 主进程调整完桌宠窗口尺寸后主动刷新精灵尺寸（双保险，setBounds 后 resize 事件不稳定时仍生效）
    window.petAPI?.events.onPetSizeApplied(() => {
      applySpriteSize();
    });

    // 待机间歇时长由随机行走挡位决定（单一来源 userData/settings.json），改动后实时同步
    stateMachine.setWalkLevel((await window.petAPI?.settings.get())?.randomWalk ?? 0);
    window.petAPI?.events.onSettingsChanged((next) => stateMachine.setWalkLevel(next.randomWalk));

    // 进入待机（由状态机按权重随机挑一个待机动作开播）
    enterStandby();
    animationFrame = requestAnimationFrame(animate);

    // 预热待机轮播的全部帧：轮播每 1.5~1.8s 换一个动作、动作之间夹着间歇，
    // 未预热的帧首次出现会闪白，故间歇期的静态帧一并预热。
    const standbyFrames = new Set([
      ...petSpec.idleRotation.states.flatMap((entry) =>
        petSpec.states.find((s) => s.id === entry.id)?.frames ?? []),
      ...(petSpec.states.find((s) => s.id === petSpec.idleRotation.gap.stateId)?.frames ?? []),
    ]);
    await Promise.all([...standbyFrames].map((frame) => {
      const url = assetMap.get(frame);
      if (!url) return Promise.resolve();
      const img = new Image();
      img.src = url;
      return new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      });
    }));

    // 报告就绪（stateId/frame 取当前实际播放的待机动作，主进程据此校验状态与帧的归属）
    const currentStateId = stateMachine.currentStateId();
    await window.petAPI?.runtime.ready({
      status: 'ready',
      stateId: currentStateId,
      frame: petSpec.states.find((s) => s.id === currentStateId)?.frames[0] ?? '',
      assetCount: assetMap.size,
      expectedAssetCount: assetMap.size,
      naturalWidth: 512,
      naturalHeight: 512,
      petVisible: true,
      ipcReady: true,
    });
  } catch (error) {
    window.petAPI?.runtime.fail({
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  }
}

init();
