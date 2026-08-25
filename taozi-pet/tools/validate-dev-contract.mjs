import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeCheck, runChecks, PROJECT_ROOT } from './qa-common.mjs';

const requiredFiles = [
  'src/main.ts',
  'src/preload.ts',
  'src/shared/contracts.ts',
  'src/renderer/pet/index.html',
  'src/renderer/pet/index.ts',
  'src/renderer/dashboard/index.html',
  'src/renderer/dashboard/index.ts',
  'tools/run-dev.mjs',
  'tools/dev-smoke-client.mjs',
];

async function readOptional(relative) {
  try {
    return await readFile(path.join(PROJECT_ROOT, relative), 'utf8');
  } catch {
    return null;
  }
}

const contents = await Promise.all(requiredFiles.map(async (file) => [file, await readOptional(file)]));
const byFile = new Map(contents);
const packageText = (await readOptional('package.json')) ?? '';
const rendererConfig = (await readOptional('webpack.renderer.config.js')) ?? '';
const forgeConfig = (await readOptional('forge.config.js')) ?? '';

let packageJson = {};
try {
  packageJson = JSON.parse(packageText);
} catch {
  /* 缺失或非法 package.json 由下方 check 报告 */
}

const apply = (problems, require, pattern, source, file, message) => {
  const hit = pattern.test(source);
  if (require && !hit) problems.push(`${file}: ${message}`);
  if (!require && hit) problems.push(`${file}: ${message}`);
};

const checks = [];

checks.push(makeCheck({
  id: 'missing-required-files',
  gate: 'contract',
  describe: '开发契约要求的核心文件存在且 package.json 可解析',
  run: () => {
    const problems = [];
    for (const [file, content] of byFile) if (content === null) problems.push(`${file} 缺失`);
    if (packageText && !packageJson) problems.push('package.json 非法 JSON');
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : '核心文件齐全' };
  },
}));

checks.push(makeCheck({
  id: 'source-dev',
  gate: 'contract',
  describe: 'dev 脚本受控：走 run-dev.mjs、禁止打包、smoke/doctor/inspect 指向正确工具',
  run: () => {
    const problems = [];
    const dev = packageJson.scripts?.dev || '';
    const smoke = packageJson.scripts?.['test:dev-smoke'] || '';
    const doctor = packageJson.scripts?.doctor || '';
    const inspect = packageJson.scripts?.['inspect:assets'] || '';
    apply(problems, true, /node\s+tools\/run-dev\.mjs/, dev, 'package.json', 'dev 必须使用 tools/run-dev.mjs');
    apply(problems, false, /\b(?:package|make)(?::|\b)/, dev, 'package.json', 'dev 不得打包或构建应用');
    apply(problems, true, /run-dev\.mjs\s+--smoke/, smoke, 'package.json', 'test:dev-smoke 必须使用隔离 smoke 模式');
    apply(problems, true, /tools\/doctor\.mjs/, doctor, 'package.json', 'doctor 必须使用 tools/doctor.mjs');
    apply(problems, true, /tools\/inspect-assets\.mjs/, inspect, 'package.json', 'inspect:assets 必须使用 tools/inspect-assets.mjs');
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : 'dev 链路受控' };
  },
}));

checks.push(makeCheck({
  id: 'forge-ports',
  gate: 'contract',
  describe: 'webpack dev/logger 端口必须由受控启动器选择',
  run: () => {
    const problems = [];
    apply(problems, true, /port:\s*devPort/, forgeConfig, 'forge.config.js', 'webpack dev 端口必须由受控启动器选择');
    apply(problems, true, /loggerPort/, forgeConfig, 'forge.config.js', 'webpack logger 端口必须由受控启动器选择');
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : '端口受控' };
  },
}));

checks.push(makeCheck({
  id: 'renderer-devtools',
  gate: 'contract',
  describe: '渲染进程 devtool 必须为 source-map，禁止 eval',
  run: () => {
    const problems = [];
    apply(problems, true, /devtool\s*:\s*['"]source-map['"]/, rendererConfig, 'webpack.renderer.config.js', '渲染 devtool 必须为 source-map');
    apply(problems, false, /devtool\s*:\s*['"][^'"]*eval[^'"]*['"]/, rendererConfig, 'webpack.renderer.config.js', 'eval 渲染 devtool 与严格 CSP 不兼容');
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : 'devtools 安全' };
  },
}));

checks.push(makeCheck({
  id: 'strict-csp',
  gate: 'contract',
  describe: 'pet/dashboard 渲染进程 HTML 使用严格 CSP（script-src self，禁 unsafe-eval）',
  run: () => {
    const problems = [];
    for (const role of ['pet', 'dashboard']) {
      const html = byFile.get(`src/renderer/${role}/index.html`) ?? '';
      apply(problems, true, /Content-Security-Policy/i, html, `src/renderer/${role}/index.html`, '渲染进程需要 CSP');
      apply(problems, true, /script-src\s+'self'/i, html, `src/renderer/${role}/index.html`, 'script-src 必须使用 self');
      apply(problems, false, /unsafe-eval/i, html, `src/renderer/${role}/index.html`, '渲染进程不得允许 unsafe-eval');
    }
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : 'CSP 严格' };
  },
}));

checks.push(makeCheck({
  id: 'forge-renderer-entry',
  gate: 'contract',
  describe: 'forge 存在 pet/dashboard 两个渲染入口',
  run: () => {
    const problems = [];
    for (const role of ['pet', 'dashboard']) {
      apply(problems, true, new RegExp(`name:\\s*['"]${role}_window['"]`), forgeConfig, 'forge.config.js', `缺少 ${role} 渲染入口`);
    }
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : '入口齐全' };
  },
}));

checks.push(makeCheck({
  id: 'renderer-gate',
  gate: 'contract',
  describe: '主进程/预加载收集渲染就绪并拦截 CSP/错误',
  run: () => {
    const problems = [];
    const preload = byFile.get('src/preload.ts') ?? '';
    const main = byFile.get('src/main.ts') ?? '';
    apply(problems, true, /runtime:renderer-ready/, main, 'src/main.ts', '主进程必须收集渲染就绪');
    apply(problems, true, /console-message/, main, 'src/main.ts', '主进程必须拦截渲染 CSP/启动 console 错误');
    apply(problems, true, /runtime:renderer-ready/, preload, 'src/preload.ts', '预加载必须上报渲染就绪');
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : '渲染门控齐全' };
  },
}));

const ok = await runChecks({ name: 'Development Contract', reportFile: 'dev-contract-report.json', checks });
if (!ok) process.exit(1);