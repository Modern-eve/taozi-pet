import { screen } from 'electron';
import { isIdlePresentation, STANDBY_SIGNAL } from '../shared/contracts';
import type { MainContext } from './context';
import { isDraggingActive } from './sleep';
import { movePetWindow, sendActivity, setSnapSide } from './windows';

export function randomWalkStep(ctx: MainContext): void {
  if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
  if (isDraggingActive(ctx)) return;
  if (ctx.randomWalkAnimTimer) return; // 正在移动中，不触发新的移动
  // 仅在待机时走动：常驻状态（sleep/sad 等）既不移动，也避免收尾的待机信号把常驻状态打断
  if (!isIdlePresentation(ctx.spec.idleRotation, ctx.currentStateId)) return;
  const cfg = ctx.walk.levels[ctx.settings.randomWalk];
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
  const totalSteps = Math.max(1, Math.ceil(Math.max(Math.abs(totalDx), Math.abs(totalDy)) / ctx.walk.speed));
  let step = 0;

  // 贴边偏移在窗口移走后不再成立，先复位再起步
  setSnapSide(ctx, null);
  // 触发 walk 动画：按钳制后的实际水平位移镜像（素材默认朝左；纯上下与贴屏边被钳成零位移时不镜像）
  const walkMirror = targetX > bounds.x;
  // durationMs:0 = 无限循环（见 PetStateMachine.durationFor），使动画在物理移动结束前持续循环，而非只播一轮就静止
  sendActivity(ctx, { kind: 'ambient', stateId: 'walk', mirror: walkMirror, durationMs: 0 });
  // 不调 resetActivityTimer()：入睡计时只被用户主动动作重置（互动 / 拖动 / 开发者面板），随机行走是自动行为

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
      // 移动结束回待机，但仅当期间没被互动 / 提醒 / 贴边接管：无条件广播会把主进程门控冲回待机，而渲染层还在播互动
      if (ctx.currentStateId === 'walk') {
        sendActivity(ctx, { kind: 'ambient', stateId: STANDBY_SIGNAL });
      }
      return;
    }
    const curX = Math.round(startX + (totalDx * step / totalSteps));
    const curY = Math.round(startY + (totalDy * step / totalSteps));
    movePetWindow(ctx, curX, curY);
  }, ctx.walk.frameMs);
}

export function scheduleNextRandomWalk(ctx: MainContext): void {
  if (ctx.randomWalkTimer) clearTimeout(ctx.randomWalkTimer);
  const cfg = ctx.walk.levels[ctx.settings.randomWalk];
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
  if (!ctx.walk.levels[ctx.settings.randomWalk]) return;
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
