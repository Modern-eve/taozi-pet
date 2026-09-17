import { app, BrowserWindow, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DashboardView, PetState, StateActivity } from '../shared/contracts';
import { PET_BUBBLE_ZONE } from '../shared/contracts';
import type { MainContext, Role } from './context';
import { commitRuntimeReady, fatalExit } from './runtime';
import { broadcastStats } from './stats';

/** 气泡区最小宽度（px）：保证小尺寸桌宠时气泡也不会被窗口宽度压缩 */
export const PET_BUBBLE_ZONE_WIDTH = 240;

export function petSize(ctx: MainContext): number {
  return Math.round(ctx.spec.experience.petSizing.baseWindowPx * ctx.settings.petScale);
}

/** 人物的横向可见宽度：素材帧里人物只占中间一条，两侧是透明留白（占比见 spec.petSizing.contentWidthRatio，由 qa-ui 依实测校验）。 */
export function petCharacterWidth(ctx: MainContext): number {
  return Math.round(petSize(ctx) * ctx.spec.experience.petSizing.contentWidthRatio);
}

// 桌宠窗口 = 精灵(高) + 顶部气泡区(高)。
// 宽度取「人物横向可见宽度 与 气泡区最小宽度」较大者：精灵帧两侧的透明留白由窗口裁掉，
// 窗口不会随正方形精灵一起变宽，横向"看似透明却吃鼠标"的死区因此只由气泡区所需宽度决定。
export function petWindowSize(ctx: MainContext): { width: number; height: number } {
  const size = petSize(ctx);
  return { width: Math.max(petCharacterWidth(ctx), PET_BUBBLE_ZONE_WIDTH), height: size + PET_BUBBLE_ZONE };
}

// 程序化移动桌宠：位置与尺寸一并下发。
// frameless + transparent + resizable:false 的窗口在 Windows 上程序化移动会发生尺寸被动漂移
// （跨不同缩放的显示器时尤甚），且漂移会逐次累积，表现为随机行走"越走越大"。
// 这里每帧都用 petWindowSize()（spec 基准 × petScale 纯计算，不读取当前窗口）钉住尺寸，
// 任何一次漂移都会在下一帧被纠正，杜绝累积放大。
export function movePetWindow(ctx: MainContext, x: number, y: number): void {
  if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
  ctx.petWindow.setBounds({ x, y, ...petWindowSize(ctx) }, false);
}

export function filePocket(ctx: MainContext): string {
  return path.join(app.getPath('documents'), ctx.spec.app.name);
}

export function stateForTrigger(ctx: MainContext, trigger: string): PetState | undefined {
  return ctx.spec.states.find((state) => state.triggers.includes(trigger));
}

/** 下发一次状态活动到桌宠窗口（只负责下发，不改写 currentStateId）。 */
export function sendActivity(ctx: MainContext, activity: StateActivity): void {
  if (ctx.petWindow && !ctx.petWindow.isDestroyed()) ctx.petWindow.webContents.send('state:activity', activity);
}

export function registerWindow(ctx: MainContext, window: BrowserWindow, role: Role): BrowserWindow {
  const webContentsId = window.webContents.id;
  ctx.roles.set(webContentsId, role);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('did-fail-load', (_event, code, description) => {
    void fatalExit(ctx, `${role}-window-load-failed`, new Error(description), { code, role });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (ctx.isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') {
      void ctx.logger?.write('warn', `${role}-renderer-stopped`, { role, reason: details.reason, exitCode: details.exitCode });
      return;
    }
    if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
      void fatalExit(ctx, `${role}-renderer-gone`, new Error(details.reason), { role, exitCode: details.exitCode });
      return;
    }
    void ctx.logger?.write('warn', `${role}-renderer-gone`, { role, reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('console-message', (details, level, legacyMessage) => {
    const message = details.message || legacyMessage;
    const currentLevel = details.level === 'error' ? 3 : level;
    const fatalMessage = /Content Security Policy|unsafe-eval|Refused to evaluate|Uncaught|Unhandled/i.test(message);
    if (fatalMessage || (!ctx.runtimeCommitted && currentLevel >= 3)) {
      void fatalExit(ctx, `${role}-renderer-console-error`, new Error(message), { role });
    } else if (currentLevel >= 3) {
      void ctx.logger?.write('error', `${role}-renderer-console-error`, { role, message: message.slice(0, 2000) });
    }
  });
  window.on('closed', () => ctx.roles.delete(webContentsId));
  return window;
}

export function secureWindow(ctx: MainContext, options: Electron.BrowserWindowConstructorOptions, role: Role, preload: string): BrowserWindow {
  return registerWindow(ctx, new BrowserWindow({
    ...options,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  }), role);
}

export function applyPetSettings(ctx: MainContext): void {
  if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
  const { width, height } = petWindowSize(ctx);
  // 用 setBounds 而非 setSize：resizable:false 的透明窗口中 setSize 缩小常不生效（需重启），
  // setBounds 保留原位即时缩放；通知宠物端主动刷新精灵尺寸（双保险，不依赖 resize 事件是否触发）
  const bounds = ctx.petWindow.getBounds();
  ctx.petWindow.setBounds({ ...bounds, width, height }, false);
  ctx.petWindow.webContents.send('pet:size-applied');
  ctx.petWindow.setAlwaysOnTop(ctx.settings.alwaysOnTop);
  ctx.petWindow.setIgnoreMouseEvents(ctx.settings.clickThrough, { forward: true });
}

export function applyAutoStart(ctx: MainContext): void {
  // 仅当 autoStartInit 为 true 时写入/移除系统自启动项；
  // autoStartInit=false（如旧数据损坏回退且未固化选择）时不动注册表，防止意外自启。
  if (!ctx.settings.autoStartInit) return;
  app.setLoginItemSettings({
    openAtLogin: ctx.settings.autoStart,
    openAsHidden: true,
  });
}

export function showDashboard(ctx: MainContext, view: DashboardView = 'status'): void {
  if (!ctx.spec.features.dashboard || !ctx.dashboardWindow) return;
  ctx.dashboardWindow.center();
  if (ctx.e2eMode) ctx.dashboardWindow.showInactive();
  else {
    ctx.dashboardWindow.show();
    ctx.dashboardWindow.focus();
  }
  broadcastStats(ctx);
  ctx.dashboardWindow.webContents.send('dashboard:view', view);
}

export async function openPocket(ctx: MainContext): Promise<void> {
  if (!ctx.spec.features.filePocket) throw new Error('File pocket is disabled');
  const directory = filePocket(ctx);
  await mkdir(directory, { recursive: true });
  const failure = await shell.openPath(directory);
  if (failure) throw new Error(failure);
}

export function createWindows(ctx: MainContext): void {
  const { width, height } = petWindowSize(ctx);
  ctx.petWindow = secureWindow(ctx, {
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: ctx.settings.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    opacity: ctx.e2eMode ? 0 : 1,
  }, 'pet', PET_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void ctx.petWindow.loadURL(PET_WINDOW_WEBPACK_ENTRY);
  ctx.petWindow.once('ready-to-show', () => {
    applyPetSettings(ctx);
    ctx.petWindow?.center();
    if (ctx.e2eMode) ctx.petWindow?.showInactive();
    else ctx.petWindow?.show();
    ctx.runtimeWindowReady = Boolean(ctx.petWindow?.isVisible());
    void commitRuntimeReady(ctx).catch((error) => fatalExit(ctx, 'runtime-ready-failed', error));
  });

  ctx.dashboardWindow = secureWindow(ctx, {
    width: 520,
    height: 700,
    minWidth: 480,
    minHeight: 620,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: true,
    hasShadow: true,
    title: `${ctx.spec.character.displayName}的小屋`,
    opacity: ctx.e2eMode ? 0 : 1,
  }, 'dashboard', DASHBOARD_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void ctx.dashboardWindow.loadURL(DASHBOARD_WINDOW_WEBPACK_ENTRY);
  ctx.dashboardWindow.on('close', (event) => {
    if (!ctx.isQuitting) { event.preventDefault(); ctx.dashboardWindow?.hide(); }
  });
}
