import type { PetSpec } from './contracts';

/**
 * 语录组：状态语录与互动语录在 spec 里同表存放（`experience.quotes`，键即状态 id），
 * 互动动作自身的 `id` 与其状态 id 相同，所以互动语录就是它那个状态的语录组。
 */
export interface QuoteGroup {
  /** 键名，即状态 id（互动动作取 `interactions[].id`） */
  key: string;
  label: string;
  emoji: string;
  quotes: string[];
}

/** 全部语录组，顺序即 pet-spec.json 中的声明顺序（语录页按此渲染分组）。 */
export function allQuoteGroups(spec: PetSpec): QuoteGroup[] {
  return Object.entries(spec.experience.quotes ?? {}).map(([key, group]) => ({
    key,
    label: group.label,
    emoji: group.emoji,
    quotes: group.quotes ?? [],
  }));
}

/**
 * 语录选取：优先用户自定义（userData/quotes.json，与语录页编辑同步），
 * 否则回落到 spec.experience.quotes 的内置语录；两处都没有则返回空串，调用方据此不显示气泡。
 * random 可注入，便于测试固定选取结果。
 */
export function pickQuote(
  spec: PetSpec,
  custom: Record<string, string[]> | null,
  stateId: string,
  random: () => number = Math.random,
): string {
  const customList = custom?.[stateId];
  if (Array.isArray(customList) && customList.length > 0) {
    const pick = customList[Math.floor(random() * customList.length)];
    if (pick) return pick;
  }
  const defaults = spec.experience.quotes?.[stateId]?.quotes;
  if (defaults && defaults.length > 0) {
    return defaults[Math.floor(random() * defaults.length)] || '';
  }
  return '';
}
