import { app, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import type { PetSpec } from '../shared/contracts';
import { reportTotalBytes, runCacheMaintenance, type CacheMaintenanceReport } from './cache-maintenance';
import type { MainContext, Role } from './context';
import { atomicWriteJson } from './persistence';

export function userFile(name: string): string { return path.join(app.getPath('userData'), name); }

/** 缓存治理的输入：路径取自运行时，阈值取自 pet-spec.json。 */
export function cacheMaintenancePaths(spec: PetSpec) {
  return {
    userDataDir: app.getPath('userData'),
    logFile: userFile('logs/app.jsonl'),
    keepCorruptFiles: spec.maintenance.keepCorruptFiles,
    logMaxBytes: spec.maintenance.logMaxKb * 1024,
  };
}

/** 把一次治理的释放量写入结构化日志。 */
export async function logCacheReport(ctx: MainContext, context: string, report: CacheMaintenanceReport): Promise<void> {
  await ctx.logger?.write('info', 'cache-swept', {
    context,
    freedBytes: reportTotalBytes(report),
    caches: report.caches,
    tempFiles: report.tempFiles,
    corruptFiles: report.corruptFiles,
    logTrimmedBytes: report.logTrimmedBytes,
  });
}

/** 执行一次缓存治理并记录结果；失败只写日志，不影响主流程。 */
export async function sweepCaches(ctx: MainContext, context: string): Promise<CacheMaintenanceReport | undefined> {
  try {
    const report = await runCacheMaintenance(cacheMaintenancePaths(ctx.spec));
    await logCacheReport(ctx, context, report);
    return report;
  } catch (error) {
    await ctx.logger?.write('warn', 'cache-sweep-failed', { context, message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/** 运行时证据文件只在本机开发/预览与 e2e 下写出 */
export async function writeRuntimeFile(ctx: MainContext, file: string, value: unknown): Promise<void> {
  if (ctx.runtimeEvidenceEnabled) await atomicWriteJson(file, value);
}

/**
 * 提交「运行时就绪」：两个渲染层都报到、桌宠窗口可见才算数。
 * 报告同时写日志与 .build/runtime-ready.json，供启动链与 e2e 断言。
 */
export async function commitRuntimeReady(ctx: MainContext): Promise<void> {
  if (
    ctx.runtimeCommitted
    || !ctx.runtimeWindowReady
    || !ctx.runtimeRendererReport
    || ctx.runtimeReadyRenderers.size !== 2
    || !ctx.petWindow
    || ctx.petWindow.isDestroyed()
  ) return;
  const report = {
    ...ctx.runtimeRendererReport,
    status: 'ready',
    expectedAssetCount: ctx.expectedRuntimeAssets.size,
    windowCount: BrowserWindow.getAllWindows().length,
    petVisible: ctx.petWindow.isVisible(),
    ipcReady: true,
    renderers: {
      pet: ctx.runtimeReadyRenderers.has('pet'),
      dashboard: ctx.runtimeReadyRenderers.has('dashboard'),
    },
    appName: ctx.spec.app.name,
    version: ctx.spec.app.version,
    timestamp: new Date().toISOString(),
  };
  if (report.windowCount !== 2 || !report.petVisible) throw new Error(`Runtime window gate failed: windows=${report.windowCount}, visible=${report.petVisible}`);
  await ctx.logger?.write('info', 'runtime-ready', report);
  await writeRuntimeFile(ctx, ctx.runtimeReadyFile, report);
  ctx.runtimeCommitted = true;
}

/** 致命错误：写失败证据 + 日志后退出（只走一次）。 */
export async function fatalExit(ctx: MainContext, event: string, error: unknown, details: Record<string, unknown> = {}): Promise<void> {
  if (ctx.fatalExitStarted) return;
  ctx.fatalExitStarted = true;
  const message = error instanceof Error ? error.message : String(error);
  const report = { status: 'failed', event, message, ...details, timestamp: new Date().toISOString() };
  console.error(event, error);
  try { await writeRuntimeFile(ctx, ctx.runtimeFailureFile, report); }
  catch (fileError) { console.error('runtime-failure-file-write-failed', fileError); }
  try { await ctx.logger?.write('error', event, { message, ...details }); }
  catch (logError) { console.error('structured-log-write-failed', logError); }
  app.exit(1);
}

/** IPC 来源校验：只有已注册的窗口、且在允许名单内、且来自主框架的消息才放行。 */
export function assertSender(ctx: MainContext, event: IpcMainInvokeEvent, allowed: Role[]): Role {
  const role = ctx.roles.get(event.sender.id);
  if (!role || !allowed.includes(role) || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized IPC sender');
  return role;
}
