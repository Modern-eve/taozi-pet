import type { IdleRotationGapLevelSpec, IdleRotationSpec, PetState } from '../../shared/contracts';

export interface StateFrame {
  stateId: string;
  frameIndex: number;
  frame: string;
  stateChanged: boolean;
}

interface ActiveState {
  state: PetState;
  frameIndex: number;
  startedAt: number;
  durationMs: number;
}

interface RotationEntry {
  state: PetState;
  weight: number;
}

/**
 * 状态机。待机不是单一状态，而是 idleRotation 池中若干动作的随机轮播，动作之间插入一段间歇：
 * - 池成员一律单轮播放（每帧只出现一次），播完进入 idleRotation.gap 指定的静态帧，停顿若干次呼吸后再按权重续接下一个动作（允许连续两次是同一个动作）；
 * - 间歇长度以呼吸次数计（见 setWalkLevel）：挡位越高越活跃，呼吸次数越少；
 * - 池成员与间歇都能被任意其它状态抢占；池成员之间互不打断，动作之间的切换由 tick 的完成分支推进；
 * - 一次性状态（互动 / 提醒 / 行走等）播完后不进入间歇，直接续接下一个待机动作。
 */
export class PetStateMachine {
  private readonly states: Map<string, PetState>;
  private readonly rotation: RotationEntry[];
  private readonly rotationIds: Set<string>;
  private readonly gapState: PetState | undefined;
  private readonly gapLevels: IdleRotationGapLevelSpec[];
  private readonly breathPeriodMs: number;
  private walkLevel = 0;
  private active: ActiveState;
  private readonly completedAt = new Map<string, number>();

  constructor(states: PetState[], rotation: IdleRotationSpec, now = 0, breathPeriodMs = 0) {
    this.states = new Map(states.map((state) => [state.id, state]));
    const entries: RotationEntry[] = [];
    for (const entry of rotation.states ?? []) {
      const state = this.states.get(entry.id);
      if (!state || !(entry.weight > 0)) continue;
      entries.push({ state, weight: entry.weight });
    }
    if (!entries.length) throw new Error('idleRotation 至少需要一个有效状态');
    this.rotation = entries;
    this.rotationIds = new Set(entries.map((entry) => entry.state.id));
    this.gapState = rotation.gap ? this.states.get(rotation.gap.stateId) : undefined;
    this.gapLevels = rotation.gap?.levels ?? [];
    this.breathPeriodMs = Number.isFinite(breathPeriodMs) && breathPeriodMs > 0 ? breathPeriodMs : 0;
    this.active = this.makeActive(this.pick(), now);
  }

  /** 随机行走挡位（0–4）：决定待机间歇的呼吸次数，挡位越高呼吸次数越少 */
  setWalkLevel(level: number): void {
    this.walkLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  }

  private pick(): PetState {
    const total = this.rotation.reduce((sum, entry) => sum + entry.weight, 0);
    let cursor = Math.random() * total;
    for (const entry of this.rotation) {
      cursor -= entry.weight;
      if (cursor < 0) return entry.state;
    }
    return this.rotation[this.rotation.length - 1]!.state;
  }

  private isRotation(stateId: string): boolean {
    return this.rotationIds.has(stateId);
  }

  /** 当前是否处于待机（轮播动作或间歇）。待机是抢占基底，任何状态都能打断它。 */
  isStandby(): boolean {
    return this.isRotation(this.active.state.id) || this.gapState?.id === this.active.state.id;
  }

  /**
   * 按当前挡位摇出间歇时长 = 呼吸次数 × 呼吸周期。
   * 用整数次呼吸而非毫秒，是为了让间歇与呼吸同起同落：间歇结束的那一刻呼吸正好走完整数个周期、
   * 回到缩放 1 的相位，摘下呼吸动画时不会出现半相位回落。
   * 挡位超出配置范围时退回第 0 档（呼吸次数最多、间歇最长）；未提供呼吸周期时无间歇。
   */
  private gapDurationMs(): number {
    const level = this.gapLevels[this.walkLevel] ?? this.gapLevels[0];
    if (!level || this.breathPeriodMs <= 0) return 0;
    const min = Math.max(1, Math.floor(Math.min(level.minBreaths, level.maxBreaths)));
    const max = Math.max(min, Math.floor(level.maxBreaths));
    const breaths = min + Math.floor(Math.random() * (max - min + 1));
    return breaths * this.breathPeriodMs;
  }

  private durationFor(state: PetState, requested?: number): number {
    // 显式 0 时长 = 无限循环（用于 notify 提醒，直到被更高优先级动作打断）
    if (requested !== undefined && Number.isFinite(requested) && requested === 0) return 0;
    if (requested !== undefined && Number.isFinite(requested) && requested > 0) return requested;
    // 未指定时长：播放一轮全部帧，每帧只出现一次
    return Math.max(1, state.frames.length * state.frameDurationMs);
  }

  private makeActive(state: PetState, now: number, durationMs?: number): ActiveState {
    return {
      state,
      frameIndex: 0,
      startedAt: now,
      durationMs: this.durationFor(state, durationMs),
    };
  }

  start(stateId: string, now: number, durationMs?: number): boolean {
    const next = this.states.get(stateId);
    if (!next) return false;
    const activeId = this.active.state.id;
    if (next.id === activeId) {
      // 同状态重入由 interrupt 类型决定：resume 拒绝，restart 允许
      if (next.interrupt === 'resume') return false;
    } else {
      // 池内互斥：待机轮播动作之间互不打断，动作之间的切换由 tick 的完成分支推进
      if (this.isRotation(next.id) && this.isRotation(activeId)) return false;
      // 待机（轮播动作或间歇）是抢占基底：任何状态都能打断它
      if (!this.isStandby() && !this.canInterrupt(next, activeId)) return false;
    }
    const lastCompleted = this.completedAt.get(next.id);
    if (lastCompleted !== undefined && now - lastCompleted < next.cooldownMs) return false;
    this.active = this.makeActive(next, now, durationMs);
    return true;
  }

  /** 进入待机：按权重随机挑一个待机动作开播，返回被选中的状态 id。 */
  startStandby(now: number): string {
    const state = this.pick();
    this.active = this.makeActive(state, now);
    return state.id;
  }

  /** 目标状态能否压过当前状态：看目标的在案名单是否包含当前状态 */
  private canInterrupt(next: PetState, activeId: string): boolean {
    const allowed = next.canInterrupt;
    return allowed.includes('*') || allowed.includes(activeId);
  }

  tick(now: number): StateFrame {
    let stateChanged = false;
    let elapsed = Math.max(0, now - this.active.startedAt);
    if (this.active.durationMs > 0 && elapsed >= this.active.durationMs) {
      const completedId = this.active.state.id;
      this.completedAt.set(completedId, now);
      // 轮播动作播完先进入间歇（呼吸次数按挡位随机）；间歇结束或一次性状态播完则续接下一个待机动作
      const gapMs = this.gapState && this.isRotation(completedId) ? this.gapDurationMs() : 0;
      this.active = gapMs > 0 && this.gapState
        ? this.makeActive(this.gapState, now, gapMs)
        : this.makeActive(this.pick(), now);
      elapsed = 0;
      stateChanged = true;
    }

    const { state } = this.active;
    const frameCount = Math.max(1, state.frames.length);
    const rawIndex = Math.floor(elapsed / Math.max(1, state.frameDurationMs));
    const frameIndex = state.loop
      ? rawIndex % frameCount
      : Math.min(frameCount - 1, rawIndex);
    const frameChanged = frameIndex !== this.active.frameIndex;
    this.active.frameIndex = frameIndex;

    return {
      stateId: state.id,
      frameIndex,
      frame: state.frames[frameIndex] ?? state.frames[0] ?? '',
      stateChanged: stateChanged || frameChanged,
    };
  }

  currentStateId(): string {
    return this.active.state.id;
  }
}
