import type { PetSpec } from '../../shared/contracts';

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
