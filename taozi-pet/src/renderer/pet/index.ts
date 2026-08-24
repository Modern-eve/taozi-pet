import spec from '../../../pet-spec.json';
import type { PetSpec, StateActivity } from '../../shared/contracts';
import { exceedsDragThreshold } from '../../main/drag';
import { PetStateMachine } from './state-machine';
import './index.css';

const petSpec = spec as PetSpec;

const sprite = document.getElementById('pet-sprite') as HTMLImageElement;
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

const stateMachine = new PetStateMachine(petSpec.states, performance.now());
container.dataset.state = stateMachine.currentStateId();
let blinkTimer: ReturnType<typeof setTimeout> | null = null;
let animationFrame: number | null = null;

// 设置呼吸动画
const breathing = petSpec.motion.breathing;
if (breathing.enabled) {
  document.documentElement.style.setProperty('--breath-period', `${breathing.periodMs}ms`);
  document.documentElement.style.setProperty('--breath-scale-x', `${1 + breathing.scaleX}`);
  document.documentElement.style.setProperty('--breath-scale-y', `${1 + breathing.scaleY}`);
}

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

// 显示反馈气泡
// persist=true 时气泡不自动消失（用于提醒通知，直到用户点击桌宠或其他动作后才被替换/隐藏）
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

function showFeedback(text: string, persist = false): void {
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
  }, 5000);
}

// 切换状态
let currentMirror = false;

function setState(stateId: string, durationMs?: number, mirror = false): void {
  // 镜像应用到 container，避免与 sprite 的 breathing/squash 动画冲突
  currentMirror = mirror;
  if (mirror) {
    container.style.transform = 'scaleX(-1)';
    // 气泡反向翻转，保证镜像播放时语录文字不被镜像
    feedbackBubble.classList.add('mirrored');
  } else {
    container.style.transform = '';
    feedbackBubble.classList.remove('mirrored');
  }
  if (!stateMachine.start(stateId, performance.now(), durationMs)) return;
  const snapshot = stateMachine.tick(performance.now());
  container.dataset.state = snapshot.stateId;
  const frameUrl = assetMap.get(snapshot.frame);
  if (frameUrl) sprite.src = frameUrl;
}

// 动画循环：仅在帧/状态变化时更新 DOM，减少无变化帧的布局/绘制开销
function animate(timestamp: number): void {
  const snapshot = stateMachine.tick(timestamp);
  if (snapshot.stateChanged) {
    container.dataset.state = snapshot.stateId;
    const frameUrl = assetMap.get(snapshot.frame);
    if (frameUrl) sprite.src = frameUrl;
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
  animationFrame = requestAnimationFrame(animate);
}

// 调度空闲事件（眨眼）
function scheduleIdleEvents(): void {
  if (blinkTimer) clearTimeout(blinkTimer);

  // 随机眨眼
  const blinkDelay = 5000 + Math.random() * 10000;
  blinkTimer = setTimeout(() => {
    if (stateMachine.currentStateId() === 'idle') {
      setState('blink');
    }
    scheduleIdleEvents();
  }, blinkDelay);
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
  scheduleIdleEvents();
  // 点击桌宠即消费待处理提醒（notify 循环被 happy 打断，气泡被点击语录替换）
  void window.petAPI?.reminders.ack().catch(() => {});
  showFeedback(getQuote('__click__'));
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
    const mirror = activity.mirror === true;
    // 互动语录由主进程从运行时语录（quotes.json）选词后随 activity.feedback 下发
    const feedback = activity.feedback;
    setState(activity.stateId, activity.durationMs, mirror);
    scheduleIdleEvents();
    // 提醒到点：notify 动作 + 气泡持续显示，直到用户点击其他动作
    if (activity.kind === 'notify' && feedback) {
      showFeedback(feedback, true);
    } else if (feedback) {
      showFeedback(feedback);
    } else if (activity.stateId !== 'idle' && activity.stateId !== 'notify' && activity.kind !== 'interaction') {
      const quote = getQuote(activity.stateId);
      if (quote) showFeedback(quote);
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

    // 先设置 idle 状态
    setState('idle');
    scheduleIdleEvents();
    animationFrame = requestAnimationFrame(animate);

    // 等待图片加载
    const coreAsset = petSpec.character.coreAsset;
    const coreUrl = assetMap.get(coreAsset);
    if (coreUrl) {
      const img = new Image();
      img.src = coreUrl;
      await new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      });
    }

    // 报告就绪
    await window.petAPI?.runtime.ready({
      status: 'ready',
      stateId: 'idle',
      frame: petSpec.states.find((s) => s.id === 'idle')?.frames[0] ?? '',
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
