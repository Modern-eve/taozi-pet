import spec from '../../../pet-spec.json';
import type { PetSpec, PetStats, Settings, Reminder } from '../../shared/contracts';
import './index.css';

// 引入头像图片
const avatarContext = require.context('./assets', false, /avatar\.png$/i);
const avatarUrl = avatarContext('./avatar.png');

// 用于 asset link 检查的占位符（实际不需要导入所有图片）
// require.context('../../assets/pet', true, /\.png$/);

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
if (avatarEl) avatarEl.src = avatarUrl;

const closeBtn = document.getElementById('close-btn') as HTMLButtonElement;
const affectionEl = document.getElementById('affection') as HTMLDivElement;
const moodEl = document.getElementById('mood') as HTMLDivElement;
const todayInteractionsEl = document.getElementById('today-interactions') as HTMLDivElement;
const companionMinutesEl = document.getElementById('companion-minutes') as HTMLDivElement;
const toggleAlwaysOnTop = document.getElementById('toggle-always-on-top') as HTMLDivElement;
const toggleClickThrough = document.getElementById('toggle-click-through') as HTMLDivElement;
const toggleAutoStart = document.getElementById('toggle-auto-start') as HTMLDivElement;
const toggleRandomWalk = document.getElementById('toggle-random-walk') as HTMLDivElement;
const scaleSlider = document.getElementById('scale-slider') as HTMLInputElement;
const scaleValue = document.getElementById('scale-value') as HTMLSpanElement;

// === 视图切换：状态 / 语录 / 提醒（由桌宠右键或托盘右键分别进入）===
const viewTabs = document.querySelectorAll<HTMLButtonElement>('.view-tab');
const viewSections = new Map<string, HTMLElement>();
for (const section of document.querySelectorAll<HTMLElement>('.view')) {
  viewSections.set(section.id.replace('view-', ''), section);
}

function switchView(view: 'status' | 'quotes' | 'reminders'): void {
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

// === 语录管理（单一数据源：userData/quotes.json，与 pet-spec.json 中的文本同步）===
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
  // 状态语录（来自 pet-spec.json experience.quotes）
  const statusQuotes = petSpec.experience.quotes ?? {};
  for (const [key, group] of Object.entries(statusQuotes)) {
    renderQuoteGroup(key, group.label, group.emoji, group.quotes);
  }
  // 互动语录（来自 pet-spec.json experience.interactions[].feedback）
  for (const interaction of petSpec.experience.interactions) {
    renderQuoteGroup(interaction.id, interaction.label, interaction.emoji, interaction.feedback || []);
  }
}

// === 提醒列表 ===
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

    if (settings.randomWalk) {
      toggleRandomWalk.classList.add('active');
    } else {
      toggleRandomWalk.classList.remove('active');
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

// 随机行走开关
toggleRandomWalk.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.randomWalk;
  try {
    await window.petAPI?.settings.update({ randomWalk: newVal });
    currentSettings.randomWalk = newVal;
    if (newVal) {
      toggleRandomWalk.classList.add('active');
    } else {
      toggleRandomWalk.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

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

// 重置所有数据 → 恢复到最初默认值
const resetDataBtn = document.getElementById('reset-data-btn') as HTMLButtonElement;
resetDataBtn.addEventListener('click', async () => {
  if (!window.confirm('确定重置所有数据吗？语录、状态、提醒、设置将恢复到最初默认值，此操作不可撤销。')) return;
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
  } catch (error) {
    console.error('Failed to reset data:', error);
  } finally {
    resetDataBtn.disabled = false;
  }
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
  await loadSettings();
  await loadStats();
  await loadQuotes();
  renderQuotes();
  await loadReminders();
}

init();
