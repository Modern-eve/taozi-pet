import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 极小的 QA 共用框架：
 * - makeCheck 把每个检查归一为 { id, gate, severity, describe, run }，run() 返回 { passed, detail }
 * - check 框架统一收集结果、分级输出（error 阻断 / warning 提示）、写 report.json
 * - blockDecl 轻量解析 CSS 规则块，按选择器片段定位声明，顺序无关（替代整文件正则）
 */

export function makeCheck({ id, gate, severity = 'error', describe, run }) {
  return { id, gate, severity, describe, run };
}

/** 解析 CSS 为 [{ selector, body }]；处理注释/字符串/嵌套括号，@keyframes 等也当作块 */
export function blocksDecl(css) {
  const blocks = [];
  let pos = 0;
  const len = css.length;
  while (pos < len) {
    const open = css.indexOf('{', pos);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    let inStr = false;
    let quote = '';
    let comment = false;
    while (j < len && depth > 0) {
      const ch = css[j];
      const next = css[j + 1];
      if (comment) {
        if (ch === '*' && next === '/') { comment = false; j += 2; continue; }
        j += 1; continue;
      }
      if (!inStr && ch === '/' && next === '*') { comment = true; j += 2; continue; }
      if (inStr) {
        if (ch === '\\') { j += 2; continue; }
        if (ch === quote) inStr = false;
        j += 1; continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; quote = ch; j += 1; continue; }
      if (ch === '{') { depth += 1; } else if (ch === '}') { depth -= 1; }
      if (depth === 0) {
        blocks.push({ selector: css.slice(pos, open).trim(), body: css.slice(open + 1, j).trim() });
        pos = j + 1;
        break;
      }
      j += 1;
    }
    if (depth !== 0) break; // 括号不配对，放弃后续解析
  }
  return blocks;
}

/** 取所有选择器包含 selFragment 的块声明合并文本 */
export function blockDecl(css, selFragment) {
  return blocksDecl(css)
    .filter((block) => block.selector.includes(selFragment))
    .map((block) => block.body)
    .join('\n');
}

export function normalize(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

/** 声明文本是否完整包含一组属性（顺序无关；props 可为字符串或数组） */
export function hasProps(decl, props) {
  const normalized = normalize(decl);
  const list = Array.isArray(props) ? props : [props];
  return list.every((prop) => normalized.includes(prop));
}

/** 统一收集、分级输出、写报告并设置退出码 */
export async function runChecks({ name, reportFile, checks }) {
  const results = [];
  for (const check of checks) {
    try {
      const outcome = await check.run();
      results.push({ id: check.id, gate: check.gate, severity: check.severity, passed: Boolean(outcome?.passed), detail: outcome?.detail ?? '' });
    } catch (error) {
      results.push({ id: check.id, gate: check.gate, severity: check.severity, passed: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const passedChecks = results.filter((result) => result.passed).length;
  const errors = results.filter((result) => !result.passed && result.severity === 'error');
  const warnings = results.filter((result) => !result.passed && result.severity === 'warning');
  const passed = errors.length === 0;

  const qaDirectory = path.join(process.cwd(), 'qa');
  await mkdir(qaDirectory, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    passed,
    summary: { total: results.length, passed: passedChecks, errors: errors.length, warnings: warnings.length },
    checks: results,
  };
  await writeFile(path.join(qaDirectory, reportFile), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`${name}: ${passed ? 'PASS' : 'FAIL'} (${passedChecks}/${results.length}${warnings.length ? `, ${warnings.length} warning(s)` : ''})`);
  if (!passed) {
    for (const result of [...errors, ...warnings]) {
      console.error(`- [${result.gate}/${result.severity}] ${result.id}: ${result.detail}`);
    }
    return false;
  }
  if (warnings.length) {
    for (const result of warnings) console.warn(`  [${result.gate}/warning] ${result.id}: ${result.detail}`);
  }
  return true;
}

// ---- 配置读取 / 路径解析（所有 check 脚本统一从项目根定位） ----

/** 项目根目录 = 本工具目录的上一级（tools/ -> 项目根），与运行时的 cwd 解耦 */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读取并解析项目根下的 JSON（spec、package.json 等），统一路径与报错 */
export async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(PROJECT_ROOT, relativePath), 'utf8'));
}

export function loadSpec() {
  // spec 同步被多个纯字面量解析使用，这里返回对象；读取失败会让调用方拿到异常，行为与之前一致
  return loadJson('pet-spec.json');
}

// ---- CLI 参数解析（成对取参 + 越界保护，末位 flag 无值时静默忽略） ----

export function parseArgv(argv = process.argv) {
  const map = {};
  for (let index = 2; index + 1 < argv.length; index += 2) map[argv[index].replace(/^--/, '')] = argv[index + 1];
  return map;
}

// ---- 素材引用集合（spec 定义了哪些 PNG；供 validate-asset-links 与素材管道复用） ----

export function assetSetsFromSpec(spec) {
  const stateFrames = new Set(spec.states?.flatMap((state) => state.frames ?? []) ?? []);
  // coreAsset 已移除；运行时帧集合即为 states.frames 的并集。
  return { referenced: stateFrames, stateFrames };
}