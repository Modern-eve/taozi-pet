import { app, BrowserWindow, screen } from 'electron';
import type { DebugOverlayPayload } from '../shared/contracts';
import type { MainContext } from './context';
import { debugOverlayLayout } from './overlay-layout';
import { CURSOR_BAND_PX, SNAP_BAND_PX } from './drag';
import { petCharacterWidth, petWindowSize } from './windows';

/** 两次下发绘制数据的最小间隔（ms）：桌宠移动逐帧触发同步，这里限频，只影响调试叠加层的刷新率。 */
const SYNC_INTERVAL_MS = 50;

/** 叠加层的绘制数据：窗口与工作区取自运行时，判定带与行走范围取自 spec 与当前挡位。 */
export function debugOverlayPayload(ctx: MainContext): DebugOverlayPayload {
  const pet = ctx.petWindow && !ctx.petWindow.isDestroyed()
    ? ctx.petWindow.getBounds()
    : { x: 0, y: 0, ...petWindowSize(ctx) };
  const level = ctx.walk.levels[ctx.settings.randomWalk];
  return debugOverlayLayout({
    visible: ctx.debugOverlayVisible,
    workArea: overlayBounds(ctx),
    pet,
    scale: ctx.settings.petScale,
    characterWidth: petCharacterWidth(ctx),
    // 用上次贴边实际采用的基准框宽度：叠加层画的是人物此刻的真实横向位置
    snapWidth: ctx.snapWidth,
    bubble: ctx.bubbleBox,
    snapEnabled: ctx.settings.edgeSnap,
    snapSide: ctx.snapSide,
    snapBand: SNAP_BAND_PX,
    cursorBand: CURSOR_BAND_PX,
    walkEnabled: Boolean(level),
    walkLevel: ctx.settings.randomWalk,
    walkRadius: level ? level.range : null,
    // 尚未走过一趟时还没有中心锚点，此时以桌宠当前位置为准
    walkAnchor: ctx.randomWalkCenter ?? { x: pet.x, y: pet.y },
  });
}

/** 叠加层覆盖桌宠所在屏幕的工作区；桌宠被拖到另一块屏幕后随之下移。 */
function overlayBounds(ctx: MainContext): Electron.Rectangle {
  const pet = ctx.petWindow && !ctx.petWindow.isDestroyed() ? ctx.petWindow.getBounds() : undefined;
  return pet ? screen.getDisplayMatching(pet).workArea : screen.getPrimaryDisplay().workArea;
}

/** 按需创建叠加层窗口：只在开发者模式打开可视化时存在，隐藏后复用。 */
function ensureOverlayWindow(ctx: MainContext): BrowserWindow {
  if (ctx.debugOverlayWindow && !ctx.debugOverlayWindow.isDestroyed()) return ctx.debugOverlayWindow;
  const window = new BrowserWindow({
    ...overlayBounds(ctx),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: DEBUG_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  // 叠加层只负责显示：点击穿透、不抢焦点，底下的桌宠与桌面照常可用
  window.setIgnoreMouseEvents(true);
  window.setAlwaysOnTop(true, 'floating');
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', (details, _level, legacyMessage) => {
    void ctx.logger?.write('warn', 'debug-overlay-console', { message: (details.message || legacyMessage).slice(0, 500) });
  });
  // 页面脚本执行完才可能有监听者，首帧数据在 did-finish-load 之后再发，避免早发丢失
  window.webContents.on('did-finish-load', () => {
    if (!ctx.debugOverlayVisible || window.isDestroyed()) return;
    window.showInactive();
    syncDebugOverlay(ctx, true);
  });
  window.on('closed', () => { ctx.debugOverlayWindow = undefined; });
  void window.loadURL(DEBUG_WINDOW_WEBPACK_ENTRY);
  ctx.debugOverlayWindow = window;
  // 桌宠移动/缩放都会改变叠加层要画的内容（窗口位置、贴边与否、尺寸决定的判定带）
  ctx.petWindow?.on('move', () => syncDebugOverlay(ctx));
  ctx.petWindow?.on('resize', () => syncDebugOverlay(ctx));
  return window;
}

/** 重画叠加层：不可见时是空操作，开发者模式关闭时自动撤下。 */
export function syncDebugOverlay(ctx: MainContext, force = false): void {
  if (!ctx.debugOverlayVisible) return;
  if (!ctx.settings.devMode) {
    setDebugOverlayVisible(ctx, false);
    return;
  }
  const window = ctx.debugOverlayWindow;
  if (!window || window.isDestroyed()) return;
  const now = Date.now();
  if (!force && now - ctx.debugOverlaySyncedAt < SYNC_INTERVAL_MS) return;
  ctx.debugOverlaySyncedAt = now;
  const bounds = overlayBounds(ctx);
  const current = window.getBounds();
  if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) {
    window.setBounds(bounds, false);
  }
  window.webContents.send('debug:overlay-push', debugOverlayPayload(ctx));
}

/** 显示 / 隐藏叠加层并返回最新绘制数据；开启需要开发者模式。 */
export function setDebugOverlayVisible(ctx: MainContext, visible: boolean): DebugOverlayPayload {
  if (visible && !ctx.settings.devMode) throw new Error('Debug overlay requires developer mode');
  ctx.debugOverlayVisible = visible;
  ctx.debugOverlaySyncedAt = 0;
  if (visible) {
    const window = ensureOverlayWindow(ctx);
    // 加载只在创建时发生一次，首次由 did-finish-load 负责显示；隐藏过的窗口不会再收到加载事件，需在此重新拉起
    if (!window.isDestroyed() && !window.webContents.isLoading()) window.showInactive();
    syncDebugOverlay(ctx, true);
  } else if (ctx.debugOverlayWindow && !ctx.debugOverlayWindow.isDestroyed()) {
    ctx.debugOverlayWindow.hide();
  }
  return debugOverlayPayload(ctx);
}
