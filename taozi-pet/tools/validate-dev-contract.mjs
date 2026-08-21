import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const issues = [];

async function text(relative) {
  try {
    return await readFile(path.join(root, relative), 'utf8');
  } catch {
    issues.push({ rule: 'missing-required-file', file: relative, message: 'required development-contract file is missing' });
    return '';
  }
}

function requireMatch(source, pattern, file, rule, message) {
  if (!pattern.test(source)) issues.push({ rule, file, message });
}

function forbidMatch(source, pattern, file, rule, message) {
  if (pattern.test(source)) issues.push({ rule, file, message });
}

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
const requiredContents = Object.fromEntries(await Promise.all(requiredFiles.map(async (file) => [file, await text(file)])));
const packageJsonText = await text('package.json');
const rendererConfig = await text('webpack.renderer.config.js');
const forgeConfig = await text('forge.config.js');

let packageJson = {};
try {
  packageJson = JSON.parse(packageJsonText);
} catch {
  issues.push({ rule: 'invalid-package-json', file: 'package.json', message: 'package.json is not valid JSON' });
}

const devScript = packageJson.scripts?.dev || '';
const smokeScript = packageJson.scripts?.['test:dev-smoke'] || '';
const doctorScript = packageJson.scripts?.doctor || '';
const inspectAssetsScript = packageJson.scripts?.['inspect:assets'] || '';
requireMatch(devScript, /node\s+tools\/run-dev\.mjs/, 'package.json', 'uncontrolled-dev-script', 'dev must use tools/run-dev.mjs');
forbidMatch(devScript, /\b(?:package|make)(?::|\b)/, 'package.json', 'packaging-in-dev', 'dev must not package or make an application');
requireMatch(smokeScript, /run-dev\.mjs\s+--smoke/, 'package.json', 'missing-dev-smoke', 'test:dev-smoke must use isolated smoke mode');
requireMatch(doctorScript, /tools\/doctor\.mjs/, 'package.json', 'missing-doctor', 'doctor must use tools/doctor.mjs');
requireMatch(inspectAssetsScript, /tools\/inspect-assets\.mjs/, 'package.json', 'missing-asset-inspector', 'inspect:assets must use tools/inspect-assets.mjs');
requireMatch(forgeConfig, /port:\s*devPort/, 'forge.config.js', 'missing-configurable-dev-port', 'webpack dev port must be selected by the controlled launcher');
requireMatch(forgeConfig, /loggerPort/, 'forge.config.js', 'missing-configurable-logger-port', 'webpack logger port must be selected by the controlled launcher');

requireMatch(rendererConfig, /devtool\s*:\s*['"]source-map['"]/, 'webpack.renderer.config.js', 'unsafe-renderer-devtool', 'renderer devtool must be source-map');
forbidMatch(rendererConfig, /devtool\s*:\s*['"][^'"]*eval[^'"]*['"]/, 'webpack.renderer.config.js', 'eval-renderer-devtool', 'eval-based renderer devtools are incompatible with strict CSP');

for (const role of ['pet', 'dashboard']) {
  requireMatch(forgeConfig, new RegExp(`name:\\s*['"]${role}_window['"]`), 'forge.config.js', 'missing-renderer-entry', `missing ${role} renderer entry`);
  const html = requiredContents[`src/renderer/${role}/index.html`];
  requireMatch(html, /Content-Security-Policy/i, `src/renderer/${role}/index.html`, 'missing-csp', `${role} renderer needs CSP`);
  requireMatch(html, /script-src\s+'self'/i, `src/renderer/${role}/index.html`, 'weak-script-csp', `${role} renderer script-src must use self`);
  forbidMatch(html, /unsafe-eval/i, `src/renderer/${role}/index.html`, 'unsafe-eval-csp', `${role} renderer must not allow unsafe-eval`);
}

requireMatch(requiredContents['src/main.ts'], /runtime:renderer-ready/, 'src/main.ts', 'missing-renderer-gate', 'main process must collect renderer bootstrap readiness');
requireMatch(requiredContents['src/main.ts'], /console-message/, 'src/main.ts', 'missing-renderer-error-gate', 'main process must fail on renderer CSP/bootstrap console errors');
requireMatch(requiredContents['src/preload.ts'], /runtime:renderer-ready/, 'src/preload.ts', 'missing-renderer-ready-signal', 'preload must report renderer bootstrap readiness');

const report = {
  generatedAt: new Date().toISOString(),
  passed: issues.length === 0,
  checks: {
    sourceDev: true,
    strictCsp: true,
    nonEvalSourceMap: true,
    rendererGate: true,
    isolatedSmoke: true,
  },
  issues,
};
await mkdir(path.join(root, 'qa'), { recursive: true });
await writeFile(path.join(root, 'qa', 'dev-contract-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Development contract: ${report.passed ? 'PASS' : 'FAIL'} (${issues.length} issue(s))`);
if (!report.passed) {
  for (const issue of issues) console.error(`- [${issue.rule}] ${issue.file}: ${issue.message}`);
  process.exit(1);
}
