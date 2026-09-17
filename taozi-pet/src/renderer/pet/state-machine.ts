import type { IdleRotationGapLevelSpec, IdleRotationSpec, PetState } from '../../shared/contracts';
import { isIdlePresentation, stateCanInterrupt } from '../../shared/contracts';

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
  /** 播放方向：1 正向 / -1 倒序（文件口袋 feed 专用） */
  direction: 1 | -1;
  /** 倒序播放结束后回到的状态 id（STANDBY_SIGNAL 表示待机轮播） */
  resumeId?: string;
  /** 正向播放中已收到倒放请求：待正向播到末帧后自动转入倒放 */
  pendingReverse?: boolean;
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
  private readonly rotationSpec: IdleRotationSpec;
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
    this.rotationSpec = rotation;
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
    return isIdlePresentation(this.rotationSpec, this.active.state.id);
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
      direction: 1,
    };
  }

  /** 冷却统一规则：显式 cooldownMs（spec 一般为 0）优先；缺省时 happy / peek / 互动动作派生为自身动画周期一半，其余动画无冷却。 */
  private cooldownMsFor(state: PetState): number {
    if (Number.isFinite(state.cooldownMs) && state.cooldownMs > 0) return state.cooldownMs;
    const halfCycle = state.triggers.some((trigger) =>
      trigger.startsWith('interaction:') || trigger === 'pointer:tap' || trigger === 'window:edge-snap');
    return halfCycle ? Math.max(0, Math.round((state.frames.length * state.frameDurationMs) / 2)) : 0;
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
      if (!this.isStandby() && !stateCanInterrupt(next, activeId)) return false;
    }
    const cooldownMs = this.cooldownMsFor(next);
    const lastCompleted = this.completedAt.get(next.id);
    if (lastCompleted !== undefined && now - lastCompleted < cooldownMs) return false;
    this.active = this.makeActive(next, now, durationMs);
    return true;
  }

  /** 进入待机：按权重随机挑一个待机动作开播，返回被选中的状态 id。 */
  startStandby(now: number): string {
    const state = this.pick();
    this.active = this.makeActive(state, now);
    return state.id;
  }

  /**
   * 文件拖入桌宠：进入 feed 正向播放（播放完保持末帧）。
   * - 非 feed 状态 → 从第 0 帧开始正向播放（feed 可打断一切，直接接管）;
   * - 正在倒放中 → 以当前帧为起点转回正向继续；
   * - 已在正向（播放中或保持末帧）→ 保持现状，并撤销已排队的倒放请求（用户重新拖入）。
   */
  feedForward(now: number): boolean {
    const feed = this.states.get('feed');
    if (!feed) return false;
    const active = this.active;
    if (active.state.id === 'feed') {
      if (active.direction === -1) {
        const frameMs = Math.max(1, feed.frameDurationMs);
        this.active = {
          ...active,
          direction: 1,
          startedAt: now - active.frameIndex * frameMs,
          durationMs: 0,
          pendingReverse: false,
          resumeId: undefined,
        };
      } else {
        this.active.pendingReverse = false;
      }
      return true;
    }
    this.active = { ...this.makeActive(feed, now, 0), pendingReverse: false };
    return true;
  }

  /**
   * 放手 / 拖离桌宠：倒序播放 feed，播完（回到第 0 帧）后恢复 resumeId 指定的状态。
   * 若正向播放尚未播完，先继续播完正向（到末帧）再自动转入倒放。
   */
  feedReverse(now: number, resumeId?: string): void {
    const active = this.active;
    if (active.state.id !== 'feed') return;
    if (active.direction === -1) {
      // 已在倒放：更新恢复目标即可
      this.active.resumeId = resumeId;
      return;
    }
    const frameCount = Math.max(1, active.state.frames.length);
    const frameMs = Math.max(1, active.state.frameDurationMs);
    if (this.completedPositive(active, now, frameCount, frameMs)) {
      // 正向已播完、正保持末帧：立即转入倒放
      this.active.direction = -1;
      this.active.startedAt = now;
      this.active.durationMs = frameCount * frameMs;
      this.active.resumeId = resumeId;
      this.active.pendingReverse = false;
      return;
    }
    // 正向未播完：排队，等 tick 推进到末帧（保持末帧）后转倒放
    this.active.pendingReverse = true;
    this.active.resumeId = resumeId;
  }

  private completedPositive(active: ActiveState, now: number, frameCount: number, frameMs: number): boolean {
    return active.frameIndex >= frameCount - 1 && now - active.startedAt >= frameCount * frameMs;
  }

  /** 倒序播放结束后的恢复目标：循环状态（sad/sleep/notify/walk）按常驻无限循环恢复，其余回到待机轮播。 */
  private resumeAfterFeed(resumeId: string | undefined, now: number): ActiveState {
    const state = resumeId ? this.states.get(resumeId) : undefined;
    if (state && state.loop) return this.makeActive(state, now, 0);
    return this.makeActive(this.pick(), now);
  }

  tick(now: number): StateFrame {
    let stateChanged = false;
    let elapsed = Math.max(0, now - this.active.startedAt);

    // 倒序播放完成：回到恢复目标（feed 前被接管的状态或待机轮播）
    if (this.active.direction === -1 && this.active.durationMs > 0 && elapsed >= this.active.durationMs) {
      const resumeId = this.active.resumeId;
      this.active = this.resumeAfterFeed(resumeId, now);
      elapsed = 0;
      stateChanged = true;
    }

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
    const frameMs = Math.max(1, state.frameDurationMs);
    const rawIndex = Math.floor(elapsed / frameMs);
    let frameIndex: number;
    if (this.active.direction === -1) {
      frameIndex = Math.max(0, frameCount - 1 - rawIndex);
    } else {
      frameIndex = state.loop ? rawIndex % frameCount : Math.min(frameCount - 1, rawIndex);
      // 正向播放中收到倒放请求：到达末帧（保持末帧）即转入倒放
      if (this.active.pendingReverse && this.completedPositive(this.active, now, frameCount, frameMs)) {
        this.active.direction = -1;
        this.active.startedAt = now;
        this.active.durationMs = frameCount * frameMs;
        this.active.pendingReverse = false;
        elapsed = 0;
        stateChanged = true;
      }
    }
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
