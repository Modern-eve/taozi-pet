import { app, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import trayIconPath from '../assets/tray/tray-icon.png';
import { triggerInteraction } from './activity';
import type { MainContext } from './context';
import { saveSettings } from './settings';
import { openPocket, showDashboard } from './windows';

export function buildPetMenu(ctx: MainContext): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (ctx.spec.features.interactions) {
    for (const interaction of ctx.spec.experience.interactions) {
      items.push({ label: `${interaction.emoji} ${interaction.label}`, click: () => void triggerInteraction(ctx, interaction.id) });
    }
    if (ctx.spec.experience.interactions.length) items.push({ type: 'separator' });
  }
  if (ctx.spec.features.dashboard) {
    items.push({ label: '🏠 状态', click: () => showDashboard(ctx, 'status') });
    items.push({ label: '💬 语录', click: () => showDashboard(ctx, 'quotes') });
  }
  if (ctx.spec.features.reminders) items.push({ label: '⏰ 提醒', click: () => showDashboard(ctx, 'reminders') });
  if (ctx.spec.features.filePocket) items.push({ label: '📁 打开文件口袋', click: () => void openPocket(ctx) });
  items.push({ type: 'separator' });
  items.push({ label: ctx.settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings(ctx, { ...ctx.settings, clickThrough: !ctx.settings.clickThrough }) });
  items.push({ label: '🙈 隐藏桌宠', click: () => ctx.petWindow?.hide() });
  return items;
}

export function trayMenuItems(ctx: MainContext): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  items.push({ label: `🐾 显示${ctx.spec.character.displayName}`, click: () => ctx.petWindow?.show() });
  if (ctx.spec.features.dashboard) {
    items.push({ label: '🏠 状态', click: () => showDashboard(ctx, 'status') });
    items.push({ label: '💬 语录', click: () => showDashboard(ctx, 'quotes') });
  }
  if (ctx.spec.features.reminders) items.push({ label: '⏰ 提醒', click: () => showDashboard(ctx, 'reminders') });
  items.push({ label: ctx.settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings(ctx, { ...ctx.settings, clickThrough: !ctx.settings.clickThrough }) });
  items.push({ type: 'separator' });
  items.push({ label: '🚪 退出', click: () => { ctx.isQuitting = true; app.quit(); } });
  return items;
}

/** 设置变更后重建托盘菜单（穿透项文案依赖设置）。 */
export function refreshTrayMenu(ctx: MainContext): void {
  if (!ctx.tray) return;
  ctx.tray.setContextMenu(Menu.buildFromTemplate(trayMenuItems(ctx)));
}

export function createTray(ctx: MainContext): void {
  if (!ctx.spec.features.tray) return;
  const resolvedTrayIconPath = path.resolve(__dirname, trayIconPath);
  const trayImage = nativeImage.createFromPath(resolvedTrayIconPath);
  if (trayImage.isEmpty()) throw new Error(`Tray icon is empty: ${resolvedTrayIconPath}`);
  ctx.tray = new Tray(trayImage.resize({ width: 32, height: 32, quality: 'best' }));
  ctx.tray.setToolTip(ctx.spec.app.name);
  ctx.tray.setContextMenu(Menu.buildFromTemplate(trayMenuItems(ctx)));
  ctx.tray.on('click', () => ctx.petWindow?.isVisible() ? ctx.petWindow.hide() : ctx.petWindow?.show());
}
