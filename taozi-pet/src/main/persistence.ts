import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmpFile = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmpFile, file);
}

/** 一次「损坏回退」的事实：源文件、隔离备份、触发原因。回退是数据丢弃，需由调用方留痕。 */
export interface CorruptFallbackNotice {
  /** 读取失败的源文件 */
  file: string;
  /** 隔离后的备份路径；文件在读取与隔离之间消失时为 undefined */
  corruptFile?: string;
  /** 触发回退的原因（JSON 解析或 parse 校验抛出的信息） */
  reason: string;
}

/**
 * 读取并按 parse 校验 JSON；ENOENT 视为「尚未写入」直接返回默认值，
 * 其余任何失败（解析错误 / 字段类型不符 / 读取被占用）都把原文件隔离为
 * `*.corrupt` 后返回默认值，并通过 onCorrupt 上报这次回退。
 */
export async function readValidatedJson<T>(
  file: string,
  defaultValue: T,
  parse: (value: unknown) => T,
  onCorrupt?: (notice: CorruptFallbackNotice) => void,
): Promise<T> {
  try {
    return parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultValue;
    const corruptFile = `${file}.${new Date().toISOString().replaceAll(':', '-')}.corrupt`;
    let isolated = false;
    try {
      await rename(file, corruptFile);
      isolated = true;
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
    }
    onCorrupt?.({
      file,
      corruptFile: isolated ? corruptFile : undefined,
      reason: error instanceof Error ? error.message : String(error),
    });
    return defaultValue;
  }
}

export async function uniqueDestination(directory: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(directory, filename);
  let counter = 2;

  while (true) {
    try {
      await readFile(candidate);
      // Windows 重名规则：name (2).ext、name (3).ext …
      candidate = path.join(directory, `${base} (${counter})${ext}`);
      counter += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return candidate;
      }
      throw error;
    }
  }
}
