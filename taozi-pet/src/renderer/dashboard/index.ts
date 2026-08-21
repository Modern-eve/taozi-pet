import spec from '../../../pet-spec.json';
import type { PetSpec, PetStats, Settings, InteractionSpec, Reminder } from '../../shared/contracts';
import { DEFAULT_QUOTE_GROUPS, loadAllQuotes, saveAllQuotes, ensureQuotesSeeded } from '../../shared/quotes';
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
const sizeSelector = document.getElementById('size-selector') as HTMLDivElement;

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

// === 语录管理（统一数据源：localStorage，见 src/shared/quotes.ts）===
const quotesContainer = document.getElementById('quotes-container') as HTMLDivElement;

function loadCustomQuotes(): Record<string, string[]> {
  return loadAllQuotes();
}

function saveCustomQuotes(quotes: Record<string, string[]>): void {
  saveAllQuotes(quotes);
}

function getQuotesForInteraction(interaction: InteractionSpec): string[] {
  const custom = loadCustomQuotes();
  const c = custom[interaction.id];
  if (c && c.length > 0) {
    return c;
  }
  return [...(interaction.feedback || [])];
}

// 默认语录统一来自 src/shared/quotes.ts（DEFAULT_QUOTE_GROUPS），
// pet 与 dashboard 共用 localStorage 作为统一数据源，不再各自维护镜像。

function renderQuoteGroup(key: string, label: string, emoji: string, defaultQuotes: string[]): void {
  const custom = loadCustomQuotes();
  const quotes = custom[key] ?? [...defaultQuotes];
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
      const c = loadCustomQuotes();
      let arr = c[key];
      if (!arr) { arr = [...defaultQuotes]; c[key] = arr; }
      arr[idx] = input.value;
      saveCustomQuotes(c);
    });
    const del = document.createElement('button');
    del.className = 'quote-del-btn';
    del.textContent = '×';
    del.addEventListener('click', () => {
      const c = loadCustomQuotes();
      let arr = c[key];
      if (!arr) { arr = [...defaultQuotes]; c[key] = arr; }
      arr.splice(idx, 1);
      saveCustomQuotes(c);
      renderQuotes();
    });
    item.append(input, del);
    body.appendChild(item);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'quote-add-btn';
  addBtn.textContent = '+ 添加语录';
  addBtn.addEventListener('click', () => {
    const c = loadCustomQuotes();
    let arr = c[key];
    if (!arr) { arr = [...defaultQuotes]; c[key] = arr; }
    arr.push('新语录');
    saveCustomQuotes(c);
    renderQuotes();
  });
  body.appendChild(addBtn);
  group.append(header, body);
  quotesContainer.appendChild(group);
}

function renderQuotes(): void {
  // 确保默认语录已落盘 localStorage（只补缺失键，不覆盖用户自定义）
  ensureQuotesSeeded(petSpec.experience.interactions);
  quotesContainer.replaceChildren();
  // 点击语录
  const click = DEFAULT_QUOTE_GROUPS.__click__!;
  renderQuoteGroup('__click__', click.label, click.emoji, click.quotes);
  // 自动触发状态语录
  const autoStates = ['blink', 'peek', 'walk', 'sleep', 'sad'];
  for (const stateId of autoStates) {
    const s = DEFAULT_QUOTE_GROUPS[stateId];
    if (s) renderQuoteGroup(stateId, s.label, s.emoji, s.quotes);
  }
  // 互动语录
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

    // 更新大小选择
    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => {
      const scale = parseFloat((btn as HTMLElement).dataset.scale || '1');
      if (Math.abs(scale - settings.petScale) < 0.01) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
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

// 大小选择
sizeSelector.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('size-btn')) return;
  if (!currentSettings) return;

  const scale = parseFloat(target.dataset.scale || '1');
  try {
    await window.petAPI?.settings.update({ petScale: scale });
    currentSettings.petScale = scale;

    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => btn.classList.remove('active'));
    target.classList.add('active');
  } catch (error) {
    console.error('Failed to update pet scale:', error);
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
  renderQuotes();
  await loadReminders();
}

init();
