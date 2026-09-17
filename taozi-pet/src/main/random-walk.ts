import { screen } from 'electron';
import { isIdlePresentation, STANDBY_SIGNAL } from '../shared/contracts';
import type { MainContext } from './context';
import { isDraggingActive } from './sleep';
import { movePetWindow, sendActivity } from './windows';

/** 每帧移动像素（匀速） */
export const RANDOM_WALK_SPEED = 2;
/** 约 60fps */
export const RANDOM_WALK_FRAME_MS = 16;

// 随机行走挡位配置（索引=挡位）：0 木头人(关闭) / 1 散步 / 2 正常 / 3 活泼 / 4 多动症
// range=移动范围，interval=两次游走间隔，distance=单次位移；挡位越高走得越频、越远
export const RANDOM_WALK_LEVELS: Array<{ range: number; intervalMin: number; intervalMax: number; distMin: number; distMax: number } | null> = [
  null,
  { range: 220, intervalMin: 14000, intervalMax: 30000, distMin: 60, distMax: 140 }, // 1 散步
  { range: 320, intervalMin: 10000, intervalMax: 20000, distMin: 120, distMax: 260 }, // 2 正常
  { range: 400, intervalMin: 6000, intervalMax: 14000, distMin: 200, distMax: 320 },  // 3 活泼
  { range: 480, intervalMin: 4000, intervalMax: 12000, distMin: 300, distMax: 400 },  // 4 多动症
];

export function randomWalkStep(ctx: MainContext): void {
  if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
  if (isDraggingActive(ctx)) return;
  if (ctx.randomWalkAnimTimer) return; // 正在移动中，不触发新的移动
  // 仅在待机时随机行走；sleep/sad 等常驻状态时既不移动也不发 walk 语录，
  // 更避免移动结束的回待机信号把常驻状态打断
  if (!isIdlePresentation(ctx.spec.idleRotation, ctx.currentStateId)) return;
  const cfg = RANDOM_WALK_LEVELS[ctx.settings.randomWalk];
  if (!cfg) return; // 0 木头人（关闭）
  if (!ctx.randomWalkCenter) {
    const b = ctx.petWindow.getBounds();
    ctx.randomWalkCenter = { x: b.x, y: b.y };
  }
  const bounds = ctx.petWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;

  // 随机选择方向：0=上, 1=下, 2=左, 3=右
  const direction = Math.floor(Math.random() * 4);
  const distance = cfg.distMin + Math.random() * (cfg.distMax - cfg.distMin);

  let targetX = bounds.x;
  let targetY = bounds.y;
  switch (direction) {
    case 0: targetY -= Math.round(distance); break; // 上
    case 1: targetY += Math.round(distance); break; // 下
    case 2: targetX -= Math.round(distance); break; // 左
    case 3: targetX += Math.round(distance); break; // 右
  }

  // 限制在以中心为圆心的范围内
  const center = ctx.randomWalkCenter!;
  const dx = targetX - center.x;
  const dy = targetY - center.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > cfg.range) {
    const scale = cfg.range / dist;
    targetX = center.x + Math.round(dx * scale);
    targetY = center.y + Math.round(dy * scale);
  }

  // 限制在屏幕工作区内（用窗口实际宽高，窗口含顶部气泡区）
  targetX = Math.max(workArea.x, Math.min(workArea.x + workArea.width - bounds.width, targetX));
  targetY = Math.max(workArea.y, Math.min(workArea.y + workArea.height - bounds.height, targetY));

  // 匀速移动
  const startX = bounds.x;
  const startY = bounds.y;
  const totalDx = targetX - startX;
  const totalDy = targetY - startY;
  const totalSteps = Math.max(1, Math.ceil(Math.max(Math.abs(totalDx), Math.abs(totalDy)) / RANDOM_WALK_SPEED));
  let step = 0;

  // 触发 walk 动画：向右或向下移动时左右镜像
  const walkMirror = direction === 1 || direction === 3; // 下或右
  // durationMs:0 让渲染层把 walk 视为无限循环状态（见 PetStateMachine.durationFor 的 requested===0 分支），
  // 在物理移动结束前持续循环播放 walk 动画，避免只播一轮（3s）就静止；移动结束时由下方发待机信号收尾。
  sendActivity(ctx, { kind: 'ambient', stateId: 'walk', mirror: walkMirror, durationMs: 0 });
  // 注意：此处【不】调用 resetActivityTimer()。睡觉计时只允许被用户主动动作重置
  // （互动 / 拖动 / 开发者面板点击）；随机行走是自动行为，不应推迟入睡。

  ctx.randomWalkAnimTimer = setInterval(() => {
    step++;
    if (step >= totalSteps || !ctx.petWindow || ctx.petWindow.isDestroyed() || isDraggingActive(ctx)) {
      if (ctx.randomWalkAnimTimer) {
        clearInterval(ctx.randomWalkAnimTimer);
        ctx.randomWalkAnimTimer = undefined;
      }
      if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
        movePetWindow(ctx, targetX, targetY);
      }
      // 移动结束，回到待机。仅当期间未被互动 / 提醒 / 贴边等状态接管时才复位：
      // 无条件广播待机信号会把互动状态从主进程门控里冲掉，导致渲染层仍在播互动而主进程已回待机。
      if (ctx.currentStateId === 'walk') {
        sendActivity(ctx, { kind: 'ambient', stateId: STANDBY_SIGNAL });
      }
      return;
    }
    const curX = Math.round(startX + (totalDx * step / totalSteps));
    const curY = Math.round(startY + (totalDy * step / totalSteps));
    movePetWindow(ctx, curX, curY);
  }, RANDOM_WALK_FRAME_MS);
}

export function scheduleNextRandomWalk(ctx: MainContext): void {
  if (ctx.randomWalkTimer) clearTimeout(ctx.randomWalkTimer);
  const cfg = RANDOM_WALK_LEVELS[ctx.settings.randomWalk];
  if (!cfg) return; // 0 木头人（关闭）
  const delay = cfg.intervalMin + Math.random() * (cfg.intervalMax - cfg.intervalMin);
  ctx.randomWalkTimer = setTimeout(() => {
    randomWalkStep(ctx);
    scheduleNextRandomWalk(ctx);
  }, delay);
}

/**
 * 开始随机行走调度。按边沿启停：由非待机回到待机时才调用一次，
 * 不可按电平反复调用——待机轮播约 1.5s 换一个动作，会把隔 4~30s 才到期的定时器反复重置。
 */
export function startRandomWalk(ctx: MainContext): void {
  if (ctx.randomWalkTimer) clearTimeout(ctx.randomWalkTimer);
  if (ctx.randomWalkAnimTimer) {
    clearInterval(ctx.randomWalkAnimTimer);
    ctx.randomWalkAnimTimer = undefined;
  }
  if (!RANDOM_WALK_LEVELS[ctx.settings.randomWalk]) return;
  scheduleNextRandomWalk(ctx);
}

export function stopRandomWalk(ctx: MainContext): void {
  if (ctx.randomWalkTimer) {
    clearTimeout(ctx.randomWalkTimer);
    ctx.randomWalkTimer = undefined;
  }
  if (ctx.randomWalkAnimTimer) {
    clearInterval(ctx.randomWalkAnimTimer);
    ctx.randomWalkAnimTimer = undefined;
  }
}
