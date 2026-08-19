import spec from '../../../pet-spec.json';
import type { PetSpec, PetStats, Settings, InteractionSpec, Reminder } from '../../shared/contracts';
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
const interactionsList = document.getElementById('interactions-list') as HTMLDivElement;
const toggleAlwaysOnTop = document.getElementById('toggle-always-on-top') as HTMLDivElement;
const toggleClickThrough = document.getElementById('toggle-click-through') as HTMLDivElement;
const toggleAutoStart = document.getElementById('toggle-auto-start') as HTMLDivElement;
const toggleRandomWalk = document.getElementById('toggle-random-walk') as HTMLDivElement;
const sizeSelector = document.getElementById('size-selector') as HTMLDivElement;

let currentSettings: Settings | null = null;

// === 语录管理 ===
const QUOTES_KEY = 'pet-custom-quotes-v1';
const quotesContainer = document.getElementById('quotes-container') as HTMLDivElement;

function loadCustomQuotes(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(QUOTES_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCustomQuotes(quotes: Record<string, string[]>): void {
  localStorage.setItem(QUOTES_KEY, JSON.stringify(quotes));
}

function getQuotesForInteraction(interaction: InteractionSpec): string[] {
  const custom = loadCustomQuotes();
  const c = custom[interaction.id];
  if (c && c.length > 0) {
    return c;
  }
  return [...(interaction.feedback || [])];
}

// 所有状态默认语录（需与 pet/index.ts 中 DEFAULT_QUOTES 保持一致）
const STATE_DEFAULT_QUOTES: Record<string, { label: string; emoji: string; quotes: string[] }> = {
  __click__: { label: '点击', emoji: '👆', quotes: [
    '嘿嘿，被你发现啦~', '怎么啦怎么啦？', '戳我干嘛呀~', '哇！吓我一跳！',
    '嗯？在叫我吗？', '今天也要开开心心哦！', '你的手好温暖呀~', '再戳一下嘛~',
    '我在呢我在呢！', '嘻嘻，好痒呀~',
  ]},
  blink: { label: '眨眼', emoji: '😉', quotes: [
    '眨眼~', '困困的...', '眼睛有点酸', '呼~', '（眨眨眼）',
  ]},
  peek: { label: '贴边窥视', emoji: '👀', quotes: [
    '嘿嘿，被你发现了~', '我在偷看你哦', '躲在这里...', '嘘~别告诉别人我在这', '被发现了！',
  ]},
  walk: { label: '走路', emoji: '🚶', quotes: [
    '散步去~', '走走走', '今天也要运动运动', '溜达溜达~', '这边看看，那边看看',
  ]},
  sleep: { label: '睡觉', emoji: '😴', quotes: [
    '呼...呼...', 'Zzz...', '好困呀...', '晚安~', '（睡着了）', '不要吵醒我哦...',
  ]},
  sad: { label: '沮丧', emoji: '😢', quotes: [
    '呜...不开心', '心情有点低落...', '好想被摸摸头', '今天好难过呀', '...', '可以陪陪我吗？',
  ]},
};

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
  quotesContainer.replaceChildren();
  // 点击语录
  renderQuoteGroup('__click__', '点击', '👆', STATE_DEFAULT_QUOTES.__click__?.quotes || []);
  // 自动触发状态语录
  const autoStates = ['blink', 'peek', 'walk', 'sleep', 'sad'];
  for (const stateId of autoStates) {
    const s = STATE_DEFAULT_QUOTES[stateId];
    if (s) renderQuoteGroup(stateId, s.label, s.emoji, s.quotes);
  }
  // 互动语录
  for (const interaction of petSpec.experience.interactions) {
    renderQuoteGroup(interaction.id, interaction.label, interaction.emoji, interaction.feedback || []);
  }
}

// === 提醒列表 ===
const remindersContainer = document.getElementById('reminders-container') as HTMLDivElement;

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
      empty.textContent = '暂无提醒，右键桌宠可添加';
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

// 加载互动列表
async function loadInteractions(): Promise<void> {
  try {
    const interactions = await window.petAPI?.interactions.list();
    if (!interactions) return;

    interactionsList.replaceChildren();
    for (const interaction of interactions) {
      const btn = document.createElement('button');
      btn.className = 'interaction-btn';
      const emoji = document.createElement('span');
      emoji.textContent = interaction.emoji;
      const label = document.createElement('span');
      label.textContent = interaction.label;
      btn.append(emoji, label);
      btn.addEventListener('click', async () => {
        try {
          await window.petAPI?.interactions.trigger(interaction.id);
        } catch (error) {
          console.error('Failed to trigger interaction:', error);
        }
      });
      interactionsList.appendChild(btn);
    }
  } catch (error) {
    console.error('Failed to load interactions:', error);
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
  await loadInteractions();
  await loadSettings();
  await loadStats();
  renderQuotes();
  await loadReminders();
}

init();
