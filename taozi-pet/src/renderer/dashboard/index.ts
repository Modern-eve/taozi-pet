import spec from '../../../pet-spec.json';
import type { PetSpec, PetStats, Settings, TypingStatus, WalkLevel, WalkTuningSnapshot } from '../../shared/contracts';
import { STANDBY_SIGNAL } from '../../shared/contracts';
import { allQuoteGroups } from '../../shared/quotes';
import './index.css';

// 引入头像图片：正常/伤心/睡觉 三张头部特写，随人物状态切换
const avatarContext = require.context('./assets', false, /avatar-(ip|sad|sleep)\.png$/i);
const avatarUrls = {
  ip: avatarContext('./avatar-ip.png'),
  sad: avatarContext('./avatar-sad.png'),
  sleep: avatarContext('./avatar-sleep.png'),
};
// 状态 → 头像映射：情绪相关状态各自匹配，其余（待机/眨眼/走路/偷看/开心/通知/互动）用正常头像
function avatarForState(stateId: string): string {
  if (stateId === 'sad') return avatarUrls.sad;
  if (stateId === 'sleep') return avatarUrls.sleep;
  return avatarUrls.ip;
}

// 开发者界面「抽鞭子」图标（手工引入的矢量图，与渲染入口同级存放）
const WhipIconUrl = require('./whip.svg');

const petSpec = spec as PetSpec;
document.title = `${petSpec.character.displayName}的小屋`;

// 设置主题色
const theme = petSpec.experience.theme;
document.documentElement.style.setProperty('--primary', theme.primary);
document.documentElement.style.setProperty('--accent', theme.accent);
document.documentElement.style.setProperty('--background', theme.background);
document.documentElement.style.setProperty('--surface', theme.surface);
document.documentElement.style.setProperty('--text', theme.text);
document.documentElement.style.setProperty('--muted', theme.muted);
document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);

// 设置宠物信息
document.getElementById('pet-name')!.textContent = petSpec.character.displayName;
document.getElementById('pet-personality')!.textContent = petSpec.character.personality.join('、');

// 设置头像
const avatarEl = document.getElementById('pet-avatar') as HTMLImageElement;
if (avatarEl) avatarEl.src = avatarUrls.ip;

// 设置开发者界面「抽鞭子」图标
const whipIconEl = document.getElementById('dev-icon-whip') as HTMLImageElement;
if (whipIconEl) whipIconEl.src = WhipIconUrl;

// 应用状态到头像
function applyStateAvatar(stateId: string): void {
  if (avatarEl) avatarEl.src = avatarForState(stateId);
}

const closeBtn = document.getElementById('close-btn') as HTMLButtonElement;
const affectionEl = document.getElementById('affection') as HTMLDivElement;
const moodEl = document.getElementById('mood') as HTMLDivElement;
const todayInteractionsEl = document.getElementById('today-interactions') as HTMLDivElement;
const companionMinutesEl = document.getElementById('companion-minutes') as HTMLDivElement;
const toggleAlwaysOnTop = document.getElementById('toggle-always-on-top') as HTMLDivElement;
const toggleClickThrough = document.getElementById('toggle-click-through') as HTMLDivElement;
const toggleAutoStart = document.getElementById('toggle-auto-start') as HTMLDivElement;
const toggleFilePocket = document.getElementById('toggle-file-pocket') as HTMLDivElement;
const toggleTypingReaction = document.getElementById('toggle-typing-reaction') as HTMLDivElement;
const typingReactionDesc = document.getElementById('typing-reaction-desc') as HTMLDivElement;
const filePocketDirEl = document.getElementById('file-pocket-dir') as HTMLDivElement;
const filePocketChooseBtn = document.getElementById('file-pocket-choose') as HTMLButtonElement;
const filePocketOpenBtn = document.getElementById('file-pocket-open') as HTMLButtonElement;
const randomWalkButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#random-walk-level button[data-level]'));
const scaleSlider = document.getElementById('scale-slider') as HTMLInputElement;
const scaleValue = document.getElementById('scale-value') as HTMLSpanElement;

// ---- 视图切换：状态 / 语录 / 提醒（右键进入）----
const viewTabs = document.querySelectorAll<HTMLButtonElement>('.view-tab');
const viewSections = new Map<string, HTMLElement>();
for (const section of document.querySelectorAll<HTMLElement>('.view')) {
  viewSections.set(section.id.replace('view-', ''), section);
}

function switchView(view: 'status' | 'quotes' | 'reminders' | 'dev'): void {
  viewTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
  viewSections.forEach((section, key) => section.classList.toggle('active', key === view));
}

viewTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const view = tab.dataset.view as 'status' | 'quotes' | 'reminders';
    if (view) switchView(view);
  });
});

window.petAPI?.events.onDashboardView((view) => switchView(view));

let currentSettings: Settings | null = null;

// ---- 语录管理（单一数据源 userData/quotes.json）----
const quotesContainer = document.getElementById('quotes-container') as HTMLDivElement;

// 语录数据内存缓存（init 时从主进程加载；编辑后保存并写回同一份文件）
let quotesData: Record<string, string[]> | null = null;

async function loadQuotes(): Promise<void> {
  quotesData = (await window.petAPI?.quotes.get()) ?? {};
}

function saveQuotes(quotes: Record<string, string[]>): void {
  quotesData = quotes;
  void window.petAPI?.quotes.save(quotes);
}

// 渲染一组语录：展示的即当前运行时文本（quotes.json，与 pet-spec.json 定义一致）
function renderQuoteGroup(key: string, label: string, emoji: string, fallback: string[]): void {
  const quotes = quotesData?.[key] ?? [...fallback];
  const group = document.createElement('div');
  group.className = 'quote-group';
  const header = document.createElement('div');
  header.className = 'quote-header';
  header.innerHTML = `<span>${emoji} ${label}</span><span class="arrow">▼</span>`;
  const body = document.createElement('div');
  body.className = 'quote-body';
  header.addEventListener('click', () => group.classList.toggle('collapsed'));
  quotes.forEach((q, idx) => {
    const item = document.createElement('div');
    item.className = 'quote-item';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = q;
    input.placeholder = '输入语录...';
    input.addEventListener('change', () => {
      const next = { ...(quotesData ?? {}) };
      const arr = [...(next[key] ?? [...fallback])];
      arr[idx] = input.value;
      next[key] = arr;
      saveQuotes(next);
    });
    const del = document.createElement('button');
    del.className = 'quote-del-btn';
    del.textContent = '×';
    del.addEventListener('click', () => {
      const next = { ...(quotesData ?? {}) };
      const arr = [...(next[key] ?? [...fallback])];
      arr.splice(idx, 1);
      next[key] = arr;
      saveQuotes(next);
      renderQuotes();
    });
    item.append(input, del);
    body.appendChild(item);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'quote-add-btn';
  addBtn.textContent = '+ 添加语录';
  addBtn.addEventListener('click', () => {
    const next = { ...(quotesData ?? {}) };
    const arr = [...(next[key] ?? [...fallback])];
    arr.push('新语录');
    next[key] = arr;
    saveQuotes(next);
    renderQuotes();
  });
  body.appendChild(addBtn);
  group.append(header, body);
  quotesContainer.appendChild(group);
}

function renderQuotes(): void {
  quotesContainer.replaceChildren();
  // 语录组同表：状态语录与互动语录都来自 pet-spec.json 的 experience.quotes
  for (const group of allQuoteGroups(petSpec)) {
    renderQuoteGroup(group.key, group.label, group.emoji, group.quotes);
  }
}

// ---- 提醒列表 ----
const remindersContainer = document.getElementById('reminders-container') as HTMLDivElement;
const reminderTextInput = document.getElementById('reminder-text') as HTMLInputElement;
const reminderTimeInput = document.getElementById('reminder-time') as HTMLInputElement;
const reminderAddBtn = document.getElementById('reminder-add-btn') as HTMLButtonElement;
const reminderTimeQuick = document.querySelector('.reminder-time-quick') as HTMLDivElement;
const reminderTimePreview = document.getElementById('reminder-time-preview') as HTMLSpanElement;

// 从 datetime-local 读取时间；无效或为空时退回当前时间
function readReminderDate(): Date {
  const d = new Date(reminderTimeInput.value);
  return isNaN(d.getTime()) ? new Date() : d;
}

// 写入 datetime-local（含日期部分），并同步更新右侧可读预览
function writeReminderDate(d: Date): void {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  reminderTimeInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;
  updateReminderPreview();
}

// 预览文案：与 formatReminderTime 保持一致（今天/明天/具体日期）
function updateReminderPreview(): void {
  const d = readReminderDate();
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  reminderTimePreview.textContent = sameDay ? `今天 ${time}` : isTomorrow ? `明天 ${time}` : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// 默认提醒时间为1小时后
function setDefaultReminderTime(): void {
  const now = new Date();
  now.setHours(now.getHours() + 1);
  writeReminderDate(now);
}

// 快捷调整：按给定小时/分钟增减，日期随之自动联动（跨天自动进位）
reminderTimeQuick.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (!target.classList.contains('quick-btn')) return;
  const d = readReminderDate();
  d.setHours(d.getHours() + Number(target.dataset.hours || 0));
  d.setMinutes(d.getMinutes() + Number(target.dataset.minutes || 0));
  writeReminderDate(d);
});

// 手动编辑 datetime-local 时，预览同步更新
reminderTimeInput.addEventListener('input', updateReminderPreview);

reminderAddBtn.addEventListener('click', async () => {
  const text = reminderTextInput.value.trim();
  const time = reminderTimeInput.value;
  if (!text || !time) return;
  try {
    await window.petAPI?.reminders.save({
      text,
      dueAt: new Date(time).toISOString(),
    });
    reminderTextInput.value = '';
    setDefaultReminderTime();
    await loadReminders();
  } catch (error) {
    console.error('Failed to save reminder:', error);
  }
});

function formatReminderTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `今天 ${time}`;
  if (isTomorrow) return `明天 ${time}`;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function loadReminders(): Promise<void> {
  try {
    const reminders = await window.petAPI?.reminders.list();
    if (!reminders) return;
    remindersContainer.replaceChildren();
    if (reminders.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'reminder-empty';
      empty.textContent = '暂无提醒，在上方添加';
      remindersContainer.appendChild(empty);
      return;
    }
    const sorted = [...reminders].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    for (const r of sorted) {
      const item = document.createElement('div');
      item.className = 'reminder-item';
      const info = document.createElement('div');
      info.className = 'reminder-info';
      const text = document.createElement('div');
      text.className = 'reminder-text';
      text.textContent = r.text;
      const time = document.createElement('div');
      time.className = 'reminder-time';
      time.textContent = formatReminderTime(r.dueAt);
      info.append(text, time);
      const del = document.createElement('button');
      del.className = 'reminder-del-btn';
      del.textContent = '×';
      del.addEventListener('click', async () => {
        try {
          await window.petAPI?.reminders.remove(r.id);
          await loadReminders();
        } catch (error) {
          console.error('Failed to remove reminder:', error);
        }
      });
      item.append(info, del);
      remindersContainer.appendChild(item);
    }
  } catch (error) {
    console.error('Failed to load reminders:', error);
  }
}

function updatePocketDirDisplay(dir: string): void {
  filePocketDirEl.textContent = dir.trim() ? `位置：${dir}` : '默认：文档/taozi-pet';
}

// 加载设置
async function loadSettings(): Promise<void> {
  try {
    const settings = await window.petAPI?.settings.get();
    if (!settings) return;
    currentSettings = settings;

    // 更新开关状态
    if (settings.alwaysOnTop) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }

    if (settings.clickThrough) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }

    if (settings.autoStart) {
      toggleAutoStart.classList.add('active');
    } else {
      toggleAutoStart.classList.remove('active');
    }

    if (settings.filePocket) {
      toggleFilePocket.classList.add('active');
    } else {
      toggleFilePocket.classList.remove('active');
    }
    updatePocketDirDisplay(settings.filePocketDir);

    toggleTypingReaction.classList.toggle('active', settings.typingReaction);
    renderTypingReactionDesc();

    for (const btn of randomWalkButtons) {
      btn.classList.toggle('active', Number(btn.dataset.level) === settings.randomWalk);
    }

    // 更新桌宠大小滑块
    scaleSlider.value = String(settings.petScale);
    scaleValue.textContent = `${Math.round(settings.petScale * 100)}%`;
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// 加载统计数据
async function loadStats(): Promise<void> {
  try {
    const stats = await window.petAPI?.interactions.stats();
    if (!stats) return;
    updateStats(stats);
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

function updateStats(stats: PetStats): void {
  affectionEl.textContent = String(stats.affection);
  moodEl.textContent = String(stats.mood);
  todayInteractionsEl.textContent = String(stats.todayInteractions);
  const unit = document.createElement('small');
  unit.textContent = '分钟';
  companionMinutesEl.replaceChildren(String(stats.companionMinutes), unit);
}

// 关闭按钮
closeBtn.addEventListener('click', async () => {
  await window.petAPI?.window.hideDashboard();
});

// 置顶开关
toggleAlwaysOnTop.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.alwaysOnTop;
  try {
    await window.petAPI?.settings.update({ alwaysOnTop: newVal });
    currentSettings.alwaysOnTop = newVal;
    if (newVal) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 鼠标穿透开关
toggleClickThrough.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.clickThrough;
  try {
    await window.petAPI?.settings.update({ clickThrough: newVal });
    currentSettings.clickThrough = newVal;
    if (newVal) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// ---- 键盘监听（打字反应）----
// 开关是「意图」，钩子有没有真的装上由主进程回报；描述行据此把不可用的原因写出来，
// 免得开关看着是开的、实际什么都没发生。
let typingStatus: TypingStatus | null = null;
const TYPING_REASON_TEXT: Record<string, string> = {
  'not-available': '未装载原生键盘钩子',
  'start-failed': '键盘钩子启动失败',
};

function renderTypingReactionDesc(): void {
  if (!currentSettings?.typingReaction) {
    typingReactionDesc.textContent = '敲字母键时桌宠拍手应和';
    typingReactionDesc.title = '';
    return;
  }
  if (typingStatus?.enabled) {
    typingReactionDesc.textContent = '敲字母键时桌宠拍手应和';
    typingReactionDesc.title = '';
    return;
  }
  typingReactionDesc.textContent = typingStatus
    ? `开关已开，但键盘监听未生效：${TYPING_REASON_TEXT[typingStatus.reason] ?? typingStatus.reason}`
    : '开关已开，等待主进程回报监听状态';
  // 底层原因（原生模块报错首行）可能很长，放悬停提示，不撑破设置行
  typingReactionDesc.title = typingStatus?.detail ?? '';
}

toggleTypingReaction.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.typingReaction;
  try {
    await window.petAPI?.settings.update({ typingReaction: newVal });
    currentSettings.typingReaction = newVal;
    toggleTypingReaction.classList.toggle('active', newVal);
    // 开关落盘后主进程会回报最新的监听状态，描述行等回报到达再刷新
    renderTypingReactionDesc();
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 开机自启开关
toggleAutoStart.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.autoStart;
  try {
    await window.petAPI?.settings.update({ autoStart: newVal });
    currentSettings.autoStart = newVal;
    if (newVal) {
      toggleAutoStart.classList.add('active');
    } else {
      toggleAutoStart.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 文件口袋开关
toggleFilePocket.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.filePocket;
  try {
    await window.petAPI?.settings.update({ filePocket: newVal });
    currentSettings.filePocket = newVal;
    if (newVal) {
      toggleFilePocket.classList.add('active');
    } else {
      toggleFilePocket.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 选择文件口袋目录
filePocketChooseBtn.addEventListener('click', async () => {
  const dir = await window.petAPI?.files.chooseDir();
  if (!dir || !currentSettings) return;
  try {
    await window.petAPI?.settings.update({ filePocketDir: dir });
    currentSettings.filePocketDir = dir;
    updatePocketDirDisplay(dir);
  } catch (error) {
    console.error('Failed to update file pocket dir:', error);
  }
});

// 打开文件口袋目录
filePocketOpenBtn.addEventListener('click', () => {
  void window.petAPI?.files.openPocket().catch((error) => console.error('Failed to open pocket:', error));
});

// 随机行走挡位：0 木头人 / 1 散步 / 2 正常 / 3 活泼 / 4 多动症
for (const btn of randomWalkButtons) {
  btn.addEventListener('click', async () => {
    if (!currentSettings) return;
    const level = Number(btn.dataset.level);
    try {
      await window.petAPI?.settings.update({ randomWalk: level });
      currentSettings.randomWalk = level;
      for (const b of randomWalkButtons) b.classList.toggle('active', Number(b.dataset.level) === level);
    } catch (error) {
      console.error('Failed to update setting:', error);
    }
  });
}

// 桌宠大小滑块：自由调整（实时生效）
scaleSlider.addEventListener('input', async () => {
  if (!currentSettings) return;
  const scale = parseFloat(scaleSlider.value);
  if (Number.isNaN(scale)) return;
  currentSettings.petScale = scale;
  scaleValue.textContent = `${Math.round(scale * 100)}%`;
  try {
    await window.petAPI?.settings.update({ petScale: scale });
  } catch (error) {
    console.error('Failed to update pet scale:', error);
  }
});

// 字节数转可读文本（B / KB / MB / GB）
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

// ---- 通用弹窗：替代原生 alert/confirm，风格与项目卡片一致 ----
const modalOverlay = document.getElementById('modal-overlay') as HTMLDivElement;
const modalTitle = document.getElementById('modal-title') as HTMLDivElement;
const modalMessage = document.getElementById('modal-message') as HTMLDivElement;
const modalCancel = document.getElementById('modal-cancel') as HTMLButtonElement;
const modalOk = document.getElementById('modal-ok') as HTMLButtonElement;

interface ModalOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
}

// 显示弹窗，返回 Promise<boolean>：确认 true、取消 false（无取消按钮时仅确定）
function showModal(options: ModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    modalTitle.textContent = options.title;
    modalMessage.textContent = options.message;
    modalOk.textContent = options.confirmText ?? '确定';
    const hasCancel = options.cancelText !== undefined;
    modalCancel.hidden = !hasCancel;
    if (hasCancel) modalCancel.textContent = options.cancelText!;
    modalOverlay.hidden = false;

    const close = (value: boolean): void => {
      modalOverlay.hidden = true;
      modalOk.onclick = null;
      modalCancel.onclick = null;
      resolve(value);
    };
    modalOk.onclick = () => close(true);
    modalCancel.onclick = () => close(false);
  });
}

// 清理缓存 → 释放浏览器缓存与写入残留，完成后提示释放量
const clearCacheBtn = document.getElementById('clear-cache-btn') as HTMLButtonElement;
clearCacheBtn.addEventListener('click', async () => {
  if (clearCacheBtn.disabled) return;
  clearCacheBtn.disabled = true;
  clearCacheBtn.textContent = '清理中';
  try {
    const summary = await window.petAPI?.data.clearCache();
    if (!summary) {
      await showModal({ title: '清理未完成', message: '缓存清理未完成，详情见日志。' });
      return;
    }
    await showModal({ title: '清理完成', message: `已释放 ${formatBytes(summary.freedBytes)} 空间` });
  } catch (error) {
    console.error('Failed to clear cache:', error);
    await showModal({ title: '清理未完成', message: '缓存清理未完成，详情见日志。' });
  } finally {
    clearCacheBtn.disabled = false;
    clearCacheBtn.textContent = '清理';
  }
});

// 重置所有数据 → 恢复到最初默认值
const resetDataBtn = document.getElementById('reset-data-btn') as HTMLButtonElement;
resetDataBtn.addEventListener('click', async () => {
  const confirmed = await showModal({
    title: '重置所有数据',
    message: '语录、状态、提醒、设置将恢复默认，不可撤销。',
    confirmText: '重置',
    cancelText: '取消',
  });
  if (!confirmed) return;
  if (resetDataBtn.disabled) return;
  resetDataBtn.disabled = true;
  try {
    await window.petAPI?.data.reset();
    // 重置后重新拉取并渲染各页数据（语录/设置/状态/提醒），保证界面即时同步
    await loadQuotes();
    renderQuotes();
    await loadSettings();
    await loadStats();
    await loadReminders();
    // 重置后主进程 devMode 已回默认，同步关闭开发者模式界面
    disableDevMode();
  } catch (error) {
    console.error('Failed to reset data:', error);
  } finally {
    resetDataBtn.disabled = false;
  }
});

// 订阅当前状态 → 切换状态页头像
window.petAPI?.events.onStateChanged((stateId: string) => {
  applyStateAvatar(stateId);
});

// 键盘监听状态回报 → 刷新开关下方的说明
window.petAPI?.events.onTypingStatus((status: TypingStatus) => {
  typingStatus = status;
  renderTypingReactionDesc();
});

// 监听统计数据更新
window.petAPI?.events.onStats((stats: PetStats) => {
  updateStats(stats);
});

// 监听提醒更新
window.petAPI?.events.onRemindersUpdated(() => {
  void loadReminders();
});

// 初始化
async function init(): Promise<void> {
  setDefaultReminderTime();
  switchView('status');
  // 先取一次键盘监听状态，再渲染设置（描述行要据此判断钩子是否真的在监听）
  typingStatus = (await window.petAPI?.typing.status()) ?? null;
  await loadSettings();
  await loadStats();
  // 首次拉取当前状态，让头像从打开瞬间就反映人物情绪
  applyStateAvatar(await window.petAPI?.state.get() ?? STANDBY_SIGNAL);
  await loadQuotes();
  renderQuotes();
  await loadReminders();
  initDevMode();
}

// ---- 开发者模式：版本号连击检测 ----
const DEV_TAP_WINDOW_MS = 2000; // 2 秒内连续点击 6 次
let tapTimestamps: number[] = [];
let devModeActive = false;
const versionLine = document.getElementById('version-line') as HTMLDivElement;
const versionText = document.getElementById('version-text') as HTMLSpanElement;
const devPopup = document.getElementById('dev-popup') as HTMLDivElement;
const devTab = document.querySelector('.dev-tab') as HTMLButtonElement;
const toggleDevMode = document.getElementById('toggle-dev-mode') as HTMLDivElement;
let popupTimer: number | undefined;

// 在版本号上方显示一个自动消失的气泡
function showDevPopup(text: string, durationMs = 2000): void {
  devPopup.textContent = text;
  devPopup.hidden = false;
  devPopup.classList.remove('dev-popup');
  void devPopup.offsetWidth; // 强制 reflow，让 animation 每次都能重新触发
  devPopup.classList.add('dev-popup');
  if (popupTimer !== undefined) window.clearTimeout(popupTimer);
  popupTimer = window.setTimeout(() => {
    devPopup.hidden = true;
    devPopup.classList.remove('dev-popup');
  }, durationMs);
}

// ---- 随机行走调参（开发者模式）----
// 默认值来自 pet-spec.json 的 motion.walk；改这里写的是 userData/tuning.json 的运行时覆盖，
// 不动机库里的 spec。「恢复默认」清掉覆盖。挡位表整体提交，避免半新半旧的中间状态。
const WALK_LEVEL_NAMES = ['木头人', '散步', '正常', '活泼', '多动症'];
const WALK_FIELDS: Array<{ key: keyof WalkLevel; head: string }> = [
  { key: 'range', head: '范围' },
  { key: 'intervalMin', head: '间隔≥' },
  { key: 'intervalMax', head: '间隔≤' },
  { key: 'distMin', head: '位移≥' },
  { key: 'distMax', head: '位移≤' },
];

const walkGrid = document.getElementById('walk-tuning-container') as HTMLDivElement;
const walkHint = document.getElementById('walk-tuning-hint') as HTMLDivElement;
let walkSnapshot: WalkTuningSnapshot | null = null;

function renderWalkTuning(): void {
  if (!walkSnapshot) return;
  walkHint.textContent = walkSnapshot.overridden
    ? '已用运行时覆盖值（userData/tuning.json）；「恢复默认」或重置数据可清除'
    : '当前使用 pet-spec.json 默认值';
  const head = WALK_FIELDS.map((field) => `<div class="walk-head">${field.head}</div>`).join('');
  const rows = [1, 2, 3, 4].map((level) => {
    const values = walkSnapshot?.config.levels[level];
    if (!values) return '';
    const inputs = WALK_FIELDS
      .map((field) => `<input type="number" data-level="${level}" data-key="${field.key}" value="${values[field.key]}">`)
      .join('');
    return `<div class="walk-level">${level} ${WALK_LEVEL_NAMES[level]}</div>${inputs}`;
  }).join('');
  walkGrid.innerHTML = `<div></div>${head}${rows}`;
  for (const input of walkGrid.querySelectorAll('input')) {
    input.addEventListener('change', () => void submitWalkTuning());
  }
}

async function submitWalkTuning(): Promise<void> {
  if (!walkSnapshot) return;
  const levels = walkSnapshot.config.levels.map((level) => (level ? { ...level } : null));
  for (const input of walkGrid.querySelectorAll('input')) {
    const level = Number(input.dataset.level);
    const key = input.dataset.key as keyof WalkLevel | undefined;
    const value = Number(input.value);
    const target = levels[level];
    if (!target || !key || !Number.isFinite(value)) continue;
    target[key] = value;
  }
  try {
    walkSnapshot = (await window.petAPI?.walk.update({ ...walkSnapshot.config, levels })) ?? walkSnapshot;
  } catch (error) {
    // 主进程按范围与单调性校验，非法值在这里提示并回显原值
    showDevPopup(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : '参数不合法', 3500);
  }
  renderWalkTuning();
}

async function refreshWalkTuning(): Promise<void> {
  try {
    walkSnapshot = (await window.petAPI?.walk.get()) ?? null;
  } catch {
    walkSnapshot = null;
  }
  renderWalkTuning();
}

document.getElementById('walk-tuning-reset')?.addEventListener('click', async () => {
  try {
    walkSnapshot = (await window.petAPI?.walk.reset()) ?? walkSnapshot;
    showDevPopup('已恢复默认参数');
  } catch (error) {
    showDevPopup(error instanceof Error ? error.message : '恢复默认失败');
  }
  renderWalkTuning();
});

// ---- 调试叠加层（开发者模式）----
// 叠加层是主进程按需创建的全屏透明窗口：画出左右吸附判定带、随机行走范围，并标注桌宠与气泡尺寸。
// 显示状态由主进程持有，这里每次操作都用返回值回填，避免两边不一致。
const overlayToggle = document.getElementById('debug-overlay-toggle') as HTMLDivElement;
const overlayHint = document.getElementById('debug-overlay-hint') as HTMLDivElement;
let overlayVisible = false;

function renderOverlayToggle(): void {
  overlayToggle.classList.toggle('active', overlayVisible);
  overlayHint.textContent = overlayVisible
    ? '叠加层已画在桌宠所在屏幕上（点击穿透，不挡操作）'
    : '在桌宠所在屏幕上标出边缘吸附判定带与随机行走范围';
}

overlayToggle.addEventListener('click', async () => {
  try {
    const payload = await window.petAPI?.debug.setOverlay(!overlayVisible);
    overlayVisible = payload?.visible ?? !overlayVisible;
  } catch (error) {
    // 主进程要求开发者模式；失败时提示并把开关留在原状态
    showDevPopup(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : '叠加层切换失败');
  }
  renderOverlayToggle();
});

void (async () => {
  try {
    overlayVisible = (await window.petAPI?.debug.overlay())?.visible ?? false;
  } catch {
    overlayVisible = false;
  }
  renderOverlayToggle();
})();

// 关闭开发者模式（退出并隐藏开发者页，回状态页）
function disableDevMode(): void {
  devModeActive = false;
  toggleDevMode.classList.remove('active');
  devTab.hidden = true;
  // 叠加层由主进程在开发者模式关闭时一并撤下，这里同步开关显示
  overlayVisible = false;
  renderOverlayToggle();
  switchView('status');
}

function initDevMode(): void {
  // 设置版本号文本
  versionText.textContent = `v${petSpec.app.version}`;

  // 应用持久化的开发者模式状态（进入开发者模式后不自动切页签，重启仍保持开启）
  if (currentSettings?.devMode) {
    devModeActive = true;
    devTab.hidden = false;
    toggleDevMode.classList.add('active');
  }

  versionLine.addEventListener('click', () => {
    // 每次点击都给出版本号的按压反馈（写入列表以保留窗口逻辑）
    const now = Date.now();
    tapTimestamps = tapTimestamps.filter((t) => now - t < DEV_TAP_WINDOW_MS);
    tapTimestamps.push(now);
    tapTimestamps = tapTimestamps.slice(-6);
    if (devModeActive) return;
    // 第 4、5 下提示倒计时，第 6 下进入开发者模式
    if (tapTimestamps.length >= 6) {
      tapTimestamps = [];
      devModeActive = true;
      devTab.hidden = false;
      toggleDevMode.classList.add('active');
      showDevPopup('已进入开发者模式');
      void window.petAPI?.settings.update({ devMode: true });
    } else if (tapTimestamps.length >= 4) {
      showDevPopup(`还差 ${6 - tapTimestamps.length} 下`);
    }
  });

  // 关闭开发者模式开关
  toggleDevMode.addEventListener('click', () => {
    if (!devModeActive) return;
    disableDevMode();
    void window.petAPI?.settings.update({ devMode: false });
  });

  // 💊 喂安眠药
  document.getElementById('dev-sleep-btn')!.addEventListener('click', async () => {
    try {
      await window.petAPI?.dev.triggerSleep();
    } catch (error) {
      console.error('Dev: trigger sleep failed', error);
    }
  });

  // 🪢 抽鞭子 + 「抽一次 / 一直抽」模式开关
  const devWalkBtn = document.getElementById('dev-walk-btn')!;
  const devWalkToggle = document.getElementById('dev-walk-loop-toggle')!;
  const devWalkDesc = document.getElementById('dev-walk-desc')!;
  // 开关激活 = 「一直抽」（纯动画+语录常驻循环）；关闭 = 「抽一次」（按挡位走一趟）
  let devWalkLoop = false;
  function updateDevWalk(): void {
    devWalkToggle.classList.toggle('active', devWalkLoop);
    devWalkDesc.textContent = devWalkLoop
      ? '一直抽：不产生位移，循环播放走路动画与语录'
      : '抽一次：按随机行走挡位立即走动一次';
  }
  devWalkToggle.addEventListener('click', () => {
    devWalkLoop = !devWalkLoop;
    updateDevWalk();
  });
  updateDevWalk();
  devWalkBtn.addEventListener('click', async () => {
    try {
      if (devWalkLoop) {
        await window.petAPI?.dev.triggerWalk();
      } else {
        await window.petAPI?.dev.triggerWalkOnce();
      }
    } catch (error) {
      console.error('Dev: trigger walk failed', error);
    }
  });

  // 🍃 飞叶子（心情 100）
  document.getElementById('dev-happy-btn')!.addEventListener('click', async () => {
    try {
      const stats = await window.petAPI?.dev.setMood(100);
      if (stats) updateStats(stats);
    } catch (error) {
      console.error('Dev: set mood 100 failed', error);
    }
  });

  // 👊 轻抚脸颊（心情 0）
  document.getElementById('dev-sad-btn')!.addEventListener('click', async () => {
    try {
      const stats = await window.petAPI?.dev.setMood(0);
      if (stats) updateStats(stats);
    } catch (error) {
      console.error('Dev: set mood 0 failed', error);
    }
  });

  // 🚶 随机行走参数（默认值来自 spec，改动写 userData/tuning.json 覆盖）
  void refreshWalkTuning();
}

init();
