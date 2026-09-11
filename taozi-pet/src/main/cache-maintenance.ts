import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * userData 目录的缓存治理。
 *
 * 治理三类内容，全部可从零重建，删除不影响任何业务数据：
 *   1. Chromium 派生缓存目录（Cache / Code Cache / GPUCache / Dawn* / Shared Dictionary / blob_storage）
 *   2. 原子写入残留（`atomicWriteJson` 中断留下的 *.tmp）与校验隔离出的损坏文件（*.corrupt）
 *   3. 结构化日志（logs/app.jsonl）超限时按行截断
 *
 * 业务数据 settings.json / pet-stats.json / quotes.json / reminders.json /
 * Local State / Preferences / Local Storage / Session Storage / Network 不在治理范围内。
 */

/** Chromium 派生缓存目录名：内容可由浏览器按需重建。 */
export const CHROMIUM_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Shared Dictionary',
  'blob_storage',
] as const;

export interface SweepResult {
  files: number;
  bytes: number;
}

export interface CacheMaintenanceReport {
  caches: SweepResult;
  tempFiles: SweepResult;
  corruptFiles: SweepResult;
  logTrimmedBytes: number;
}

export interface CacheMaintenanceOptions {
  userDataDir: string;
  logFile: string;
  /** 损坏隔离文件（*.corrupt）的保留个数，按修改时间由新到旧计。 */
  keepCorruptFiles: number;
  /** 结构化日志的体积上限，超出后按行截断到不超过该值。 */
  logMaxBytes: number;
}

/** 递归统计目录下的文件数与总字节数；目录不存在时返回全零。 */
export async function measureDirectory(dir: string): Promise<SweepResult> {
  const result: SweepResult = { files: 0, bytes: 0 };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await measureDirectory(full);
      result.files += sub.files;
      result.bytes += sub.bytes;
    } else if (entry.isFile()) {
      try {
        result.bytes += (await stat(full)).size;
        result.files += 1;
      } catch {
        // 统计过程中文件被移除，忽略该项
      }
    }
  }
  return result;
}

/** 删除 Chromium 派生缓存目录，返回释放的文件数与字节数。被占用而删不掉的目录留待下次启动。 */
export async function purgeChromiumCaches(userDataDir: string): Promise<SweepResult> {
  const total: SweepResult = { files: 0, bytes: 0 };
  for (const name of CHROMIUM_CACHE_DIRS) {
    const dir = path.join(userDataDir, name);
    const before = await measureDirectory(dir);
    if (!before.files) continue;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
      total.files += before.files;
      total.bytes += before.bytes;
    } catch {
      // 目录正被 Chromium 占用：跳过，下次启动再清
    }
  }
  return total;
}

/**
 * 清理 userData 顶层的写入残留。
 *
 * *.tmp 是原子写入的中转文件，正常路径下写完即被 rename 消费；跨次启动仍存在的必然是
 * 上次写入中断的产物。*.corrupt 是校验失败后被隔离的旧文件，按修改时间只保留最近若干个。
 */
export async function sweepWriteResidue(
  userDataDir: string,
  keepCorruptFiles: number
): Promise<{ tempFiles: SweepResult; corruptFiles: SweepResult }> {
  const tempFiles: SweepResult = { files: 0, bytes: 0 };
  const corruptFiles: SweepResult = { files: 0, bytes: 0 };
  let entries;
  try {
    entries = await readdir(userDataDir, { withFileTypes: true });
  } catch {
    return { tempFiles, corruptFiles };
  }

  const staleTemp: Array<{ full: string; size: number }> = [];
  const isolated: Array<{ full: string; size: number; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(userDataDir, entry.name);
    const isTemp = entry.name.endsWith('.tmp');
    const isCorrupt = entry.name.endsWith('.corrupt');
    if (!isTemp && !isCorrupt) continue;
    try {
      const info = await stat(full);
      if (isTemp) staleTemp.push({ full, size: info.size });
      else isolated.push({ full, size: info.size, mtime: info.mtimeMs });
    } catch {
      // 文件已被移除，忽略
    }
  }

  for (const item of staleTemp) {
    try {
      await rm(item.full, { force: true });
      tempFiles.files += 1;
      tempFiles.bytes += item.size;
    } catch {
      // 删除失败时保留，下次启动重试
    }
  }

  isolated.sort((a, b) => b.mtime - a.mtime);
  for (const item of isolated.slice(Math.max(0, keepCorruptFiles))) {
    try {
      await rm(item.full, { force: true });
      corruptFiles.files += 1;
      corruptFiles.bytes += item.size;
    } catch {
      // 删除失败时保留，下次启动重试
    }
  }

  return { tempFiles, corruptFiles };
}

/** 日志超过上限时按行截断，保留能装进上限的最近若干条完整记录；返回释放的字节数。 */
export async function trimLogFile(file: string, maxBytes: number): Promise<number> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return 0;
  }
  if (size <= maxBytes) return 0;
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return 0;
  }
  const lines = content.split('\n').filter((line) => line.length > 0);
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (used + cost > maxBytes) break;
    kept.push(line);
    used += cost;
  }
  kept.reverse();
  const next = kept.length ? `${kept.join('\n')}\n` : '';
  try {
    await writeFile(file, next, 'utf8');
  } catch {
    return 0;
  }
  return Math.max(0, size - Buffer.byteLength(next, 'utf8'));
}

/** 依次执行三类清理，返回各自的释放量。任一步失败都不影响其余步骤。 */
export async function runCacheMaintenance(options: CacheMaintenanceOptions): Promise<CacheMaintenanceReport> {
  const caches = await purgeChromiumCaches(options.userDataDir);
  const residue = await sweepWriteResidue(options.userDataDir, options.keepCorruptFiles);
  const logTrimmedBytes = await trimLogFile(options.logFile, options.logMaxBytes);
  return {
    caches,
    tempFiles: residue.tempFiles,
    corruptFiles: residue.corruptFiles,
    logTrimmedBytes,
  };
}

/** 报告总释放量，用于日志与界面提示。 */
export function reportTotalBytes(report: CacheMaintenanceReport): number {
  return report.caches.bytes + report.tempFiles.bytes + report.corruptFiles.bytes + report.logTrimmedBytes;
}

/** 人类可读的体积文本，用于托盘提示与日志。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
