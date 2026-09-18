import type { WalkConfig, WalkLevel, WalkTuningSnapshot } from '../shared/contracts';
import type { MainContext } from './context';
import { atomicWriteJson, readValidatedJson, type CorruptFallbackNotice } from './persistence';
import { userFile } from './runtime';

/** 运行时调参文件：目前只放随机行走，后续可调项按同样的分组追加 */
const TUNING_FILE = 'tuning.json';

const LIMITS = {
  speed: { min: 1, max: 20 },
  frameMs: { min: 8, max: 100 },
  intervalMin: { min: 1_000, max: 3_600_000 },
  intervalMax: { min: 1_000, max: 3_600_000 },
  distMin: { min: 1, max: 2_000 },
  distMax: { min: 1, max: 2_000 },
  range: { min: 1, max: 2_000 },
};

function assertNumber(value: unknown, key: keyof typeof LIMITS, label: string): number {
  const { min, max } = LIMITS[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`Invalid walk tuning: ${label} must be a number in ${min}..${max}`);
  }
  return value;
}

function parseWalkLevel(value: unknown, index: number): WalkLevel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid walk tuning: levels[${index}]`);
  const level = value as Record<string, unknown>;
  const parsed: WalkLevel = {
    range: assertNumber(level.range, 'range', `levels[${index}].range`),
    intervalMin: assertNumber(level.intervalMin, 'intervalMin', `levels[${index}].intervalMin`),
    intervalMax: assertNumber(level.intervalMax, 'intervalMax', `levels[${index}].intervalMax`),
    distMin: assertNumber(level.distMin, 'distMin', `levels[${index}].distMin`),
    distMax: assertNumber(level.distMax, 'distMax', `levels[${index}].distMax`),
  };
  if (parsed.intervalMin > parsed.intervalMax) throw new TypeError(`Invalid walk tuning: levels[${index}] intervalMin > intervalMax`);
  if (parsed.distMin > parsed.distMax) throw new TypeError(`Invalid walk tuning: levels[${index}] distMin > distMax`);
  // 单次位移不该超过游走半径：超过也会被主进程夹到圆内，属于写错了参数
  if (parsed.distMax > parsed.range) throw new TypeError(`Invalid walk tuning: levels[${index}] distMax > range`);
  return parsed;
}

/**
 * 校验一份完整的随机行走配置。
 * 挡位表整体覆盖（不做逐字段深合并），避免出现「一半新值一半旧值」的中间状态。
 * levels[0] 固定为木头人（null），其余挡位都必须给全。
 */
export function parseWalkConfig(value: unknown, label = 'walk'): WalkConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label} config`);
  const config = value as Record<string, unknown>;
  const levels = config.levels;
  if (!Array.isArray(levels) || levels.length !== 5) throw new TypeError(`Invalid ${label} config: levels must have 5 entries`);
  if (levels[0] !== null) throw new TypeError(`Invalid ${label} config: levels[0] (木头人) must be null`);
  return {
    speed: assertNumber(config.speed, 'speed', `${label}.speed`),
    frameMs: assertNumber(config.frameMs, 'frameMs', `${label}.frameMs`),
    levels: [null, ...[1, 2, 3, 4].map((index) => parseWalkLevel(levels[index], index))],
  };
}

/** tuning.json 里随机行走那一组的解析入口；文件缺失或只有别组时返回 undefined。 */
export function parseTuningWalk(value: unknown): WalkConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid tuning file');
  const walk = (value as Record<string, unknown>).walk;
  if (walk === undefined) return undefined;
  return parseWalkConfig(walk, 'tuning.walk');
}

/** 读取覆盖层：文件缺失或只有别组时返回 undefined（表示不覆盖）；损坏回退经 onCorrupt 上报。 */
export async function loadWalkOverride(
  onCorrupt?: (notice: CorruptFallbackNotice) => void,
): Promise<WalkConfig | undefined> {
  return readValidatedJson<WalkConfig | undefined>(userFile(TUNING_FILE), undefined, parseTuningWalk, onCorrupt);
}

function snapshot(ctx: MainContext): WalkTuningSnapshot {
  return { config: ctx.walk, defaults: ctx.spec.motion.walk, overridden: ctx.walkOverridden };
}

/** 用一份新配置整体覆盖（写 tuning.json 并立即生效）。 */
export async function saveWalkOverride(ctx: MainContext, config: WalkConfig): Promise<WalkTuningSnapshot> {
  const parsed = parseWalkConfig(config, 'walk');
  await atomicWriteJson(userFile(TUNING_FILE), { walk: parsed });
  ctx.walk = parsed;
  ctx.walkOverridden = true;
  return snapshot(ctx);
}

/** 清掉覆盖，回到 spec 默认值。 */
export async function resetWalkOverride(ctx: MainContext): Promise<WalkTuningSnapshot> {
  await atomicWriteJson(userFile(TUNING_FILE), {});
  ctx.walk = ctx.spec.motion.walk;
  ctx.walkOverridden = false;
  return snapshot(ctx);
}

export function walkTuningSnapshot(ctx: MainContext): WalkTuningSnapshot {
  return snapshot(ctx);
}
