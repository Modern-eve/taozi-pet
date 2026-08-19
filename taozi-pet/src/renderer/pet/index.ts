import spec from '../../../pet-spec.json';
import type { PetSpec, StateActivity } from '../../shared/contracts';
import { exceedsDragThreshold } from '../../main/drag';
import { PetStateMachine } from './state-machine';
import './index.css';

const petSpec = spec as PetSpec;

const sprite = document.getElementById('pet-sprite') as HTMLImageElement;
const container = document.getElementById('pet-container') as HTMLDivElement;
const feedbackBubble = document.getElementById('feedback-bubble') as HTMLDivElement;

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
let idleTimer: ReturnType<typeof setTimeout> | null = null;
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
function showFeedback(text: string): void {
  feedbackBubble.textContent = text;
  feedbackBubble.classList.add('show');
  setTimeout(() => {
    feedbackBubble.classList.remove('show');
  }, 2000);
}

// 切换状态
let currentMirror = false;

function setState(stateId: string, durationMs?: number, mirror = false): void {
  // 镜像应用到 container，避免与 sprite 的 breathing/squash 动画冲突
  currentMirror = mirror;
  if (mirror) {
    container.style.transform = 'scaleX(-1)';
  } else {
    container.style.transform = '';
  }
  if (!stateMachine.start(stateId, performance.now(), durationMs)) return;
  const snapshot = stateMachine.tick(performance.now());
  container.dataset.state = snapshot.stateId;
  const frameUrl = assetMap.get(snapshot.frame);
  if (frameUrl) sprite.src = frameUrl;
}

// 动画循环
function animate(timestamp: number): void {
  const snapshot = stateMachine.tick(timestamp);
  container.dataset.state = snapshot.stateId;
  if (snapshot.stateChanged) {
    const frameUrl = assetMap.get(snapshot.frame);
    if (frameUrl) sprite.src = frameUrl;
    // peek 和 walk 状态保持镜像，切回其他状态时重置
    if (snapshot.stateId !== 'peek' && snapshot.stateId !== 'walk') {
      container.style.transform = '';
      currentMirror = false;
    } else if (currentMirror) {
      container.style.transform = 'scaleX(-1)';
    }
  }
  animationFrame = requestAnimationFrame(animate);
}

// 调度空闲事件（眨眼、随机动作）
function scheduleIdleEvents(): void {
  if (blinkTimer) clearTimeout(blinkTimer);
  if (idleTimer) clearTimeout(idleTimer);

  // 随机眨眼
  const blinkDelay = 5000 + Math.random() * 10000;
  blinkTimer = setTimeout(() => {
    if (stateMachine.currentStateId() === 'idle') {
      setState('blink');
    }
    scheduleIdleEvents();
  }, blinkDelay);

  // 随机空闲动作
  const idleMin = petSpec.motion.idleIntervalMs.min;
  const idleMax = petSpec.motion.idleIntervalMs.max;
  const idleDelay = idleMin + Math.random() * (idleMax - idleMin);
  idleTimer = setTimeout(() => {
    // 暂时不实现随机动作，保持 idle
    scheduleIdleEvents();
  }, idleDelay);
}

// 点击语录
// 所有状态默认语录
const DEFAULT_QUOTES: Record<string, string[]> = {
  __click__: [
    '嘿嘿，被你发现啦~',
    '怎么啦怎么啦？',
    '戳我干嘛呀~',
    '哇！吓我一跳！',
    '嗯？在叫我吗？',
    '今天也要开开心心哦！',
    '你的手好温暖呀~',
    '再戳一下嘛~',
    '我在呢我在呢！',
    '嘻嘻，好痒呀~',
  ],
  blink: [
    '眨眼~',
    '困困的...',
    '眼睛有点酸',
    '呼~',
    '（眨眨眼）',
  ],
  peek: [
    '嘿嘿，被你发现了~',
    '我在偷看你哦',
    '躲在这里...',
    '嘘~别告诉别人我在这',
    '被发现了！',
  ],
  walk: [
    '散步去~',
    '走走走',
    '今天也要运动运动',
    '溜达溜达~',
    '这边看看，那边看看',
  ],
  sleep: [
    '呼...呼...',
    'Zzz...',
    '好困呀...',
    '晚安~',
    '（睡着了）',
    '不要吵醒我哦...',
  ],
  sad: [
    '呜...不开心',
    '心情有点低落...',
    '好想被摸摸头',
    '今天好难过呀',
    '...',
    '可以陪陪我吗？',
  ],
};

function getQuote(stateId: string): string {
  try {
    const custom = JSON.parse(localStorage.getItem('pet-custom-quotes-v1') || '{}');
    if (custom[stateId] && Array.isArray(custom[stateId]) && custom[stateId].length > 0) {
      const quotes = custom[stateId] as string[];
      const pick = quotes[Math.floor(Math.random() * quotes.length)];
      if (pick) return pick;
    }
  } catch { /* ignore */ }
  const defaults = DEFAULT_QUOTES[stateId];
  if (defaults && defaults.length > 0) {
    return defaults[Math.floor(Math.random() * defaults.length)] || '';
  }
  return '';
}

// 点击事件
container.addEventListener('click', () => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  playSquash();
  setState('happy');
  scheduleIdleEvents();
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
    let feedback = activity.feedback;
    // 互动语录：优先使用自定义
    if (activity.kind === 'interaction' && activity.stateId) {
      const interaction = petSpec.experience.interactions.find((i) => i.stateId === activity.stateId);
      if (interaction) {
        try {
          const custom = JSON.parse(localStorage.getItem('pet-custom-quotes-v1') || '{}');
          if (custom[interaction.id] && custom[interaction.id].length > 0) {
            const quotes = custom[interaction.id] as string[];
            feedback = quotes[Math.floor(Math.random() * quotes.length)];
          }
        } catch { /* ignore */ }
      }
    }
    setState(activity.stateId, activity.durationMs, mirror);
    scheduleIdleEvents();
    // 显示语录：互动有feedback则显示，自动触发状态（除idle和notify）有默认语录则显示
    if (feedback) {
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
