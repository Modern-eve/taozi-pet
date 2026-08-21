// 语录的统一数据源（localStorage）。
// 初次运行时会把 DEFAULT_QUOTE_GROUPS 中的默认语录落盘到 localStorage，
// 此后 pet 与 dashboard 一律从 localStorage 读取（含默认与自定义），代码中不再各自维护默认语录镜像。

export interface QuoteGroup {
  label: string;
  emoji: string;
  quotes: string[];
}

export interface InteractionQuoteInput {
  id: string;
  feedback: string[];
}

export const QUOTES_KEY = 'pet-custom-quotes-v1';

// 全状态默认语录种子：唯一的数据来源（原 pet/index.ts 的 DEFAULT_QUOTES +
// dashboard/index.ts 的 STATE_DEFAULT_QUOTES 合并而来）。
export const DEFAULT_QUOTE_GROUPS: Record<string, QuoteGroup> = {
  __click__: {
    label: '点击',
    emoji: '👆',
    quotes: [
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
  },
  blink: {
    label: '眨眼',
    emoji: '😉',
    quotes: [
      '眨眼~',
      '困困的...',
      '眼睛有点酸',
      '呼~',
      '（眨眨眼）',
    ],
  },
  peek: {
    label: '贴边窥视',
    emoji: '👀',
    quotes: [
      '嘿嘿，被你发现了~',
      '我在偷看你哦',
      '躲在这里...',
      '嘘~别告诉别人我在这',
      '被发现了！',
    ],
  },
  walk: {
    label: '走路',
    emoji: '🚶',
    quotes: [
      '散步去~',
      '走走走',
      '今天也要运动运动',
      '溜达溜达~',
      '这边看看，那边看看',
    ],
  },
  sleep: {
    label: '睡觉',
    emoji: '😴',
    quotes: [
      '呼...呼...',
      'Zzz...',
      '好困呀...',
      '晚安~',
      '（睡着了）',
      '不要吵醒我哦...',
    ],
  },
  sad: {
    label: '沮丧',
    emoji: '😢',
    quotes: [
      '呜...不开心',
      '心情有点低落...',
      '好想被摸摸头',
      '今天好难过呀',
      '...',
      '可以陪陪我吗？',
    ],
  },
};

export function loadAllQuotes(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(QUOTES_KEY) || '{}') as Record<string, string[]>;
  } catch {
    return {};
  }
}

export function saveAllQuotes(quotes: Record<string, string[]>): void {
  localStorage.setItem(QUOTES_KEY, JSON.stringify(quotes));
}

// 幂等补全：仅把尚未存在的键写入默认语录（不覆盖已有自定义），
// 使 localStorage 成为含默认值的完整数据源。interactions 提供互动动作的默认反馈。
export function ensureQuotesSeeded(interactions?: InteractionQuoteInput[]): void {
  const all = loadAllQuotes();
  const seed: Record<string, string[]> = {};
  for (const key of Object.keys(DEFAULT_QUOTE_GROUPS)) {
    seed[key] = DEFAULT_QUOTE_GROUPS[key]!.quotes;
  }
  if (interactions) {
    for (const it of interactions) {
      if (!it.id) continue;
      seed[it.id] = it.feedback;
    }
  }
  let changed = false;
  for (const key of Object.keys(seed)) {
    if (all[key] === undefined) {
      all[key] = seed[key]!;
      changed = true;
    }
  }
  if (changed) saveAllQuotes(all);
}

// 取某状态/互动的可编辑语录（本地都存于 localStorage；缺失时用种子兜底）
export function getQuoteList(key: string): string[] {
  const all = loadAllQuotes();
  const list = all[key];
  if (list && list.length) return list;
  return DEFAULT_QUOTE_GROUPS[key]?.quotes ?? [];
}