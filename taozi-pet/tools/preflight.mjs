import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const required = [
  'node_modules/@electron-forge/cli/dist/electron-forge.js',
  'node_modules/electron/package.json',
  'node_modules/sharp/package.json',
  'node_modules/typescript/package.json',
];
const missing = [];
for (const relative of required) {
  try { await access(path.join(root, relative)); }
  catch { missing.push(relative); }
}
if (missing.length) {
  console.error(`Dependency preflight failed. Run exactly "npm ci" once, then retry. Missing:\n${missing.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
const electronPackage = JSON.parse(await readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
const electronExecutable = process.platform === 'darwin'
  ? 'Electron.app/Contents/MacOS/Electron'
  : process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronDirectory = path.join(root, 'node_modules', 'electron');
const electronDist = path.join(electronDirectory, 'dist');
const electronRuntimeProbe = process.platform === 'darwin'
  ? path.join('Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')
  : electronExecutable;

/**
 * 由可执行文件头判定它编译的目标架构（PE / Mach-O / ELF 三种容器）。
 * 认不出的格式返回 undefined，让调用方跳过校验而不是误判为损坏。
 */
async function runtimeArch(file) {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < 64) return undefined;
    if (head.readUInt16LE(0) === 0x5a4d) {
      const machine = head.readUInt16LE(head.readUInt32LE(0x3c) + 4);
      return { 0x8664: 'x64', 0x14c: 'ia32', 0xaa64: 'arm64' }[machine];
    }
    if (head.readUInt32BE(0) === 0xfeedfacf) {
      const cpu = head.readUInt32LE(4);
      return { 0x01000007: 'x64', 0x0100000c: 'arm64' }[cpu];
    }
    if (head.readUInt32BE(0) === 0x7f454c46) {
      return { 0x3e: 'x64', 0x03: 'ia32', 0xb7: 'arm64' }[head.readUInt16LE(0x12)];
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

try {
  const installedVersion = (await readFile(path.join(electronDist, 'version'), 'utf8')).trim().replace(/^v/, '');
  const executable = path.join(electronDist, electronRuntimeProbe);
  await access(executable);
  if (installedVersion !== electronPackage.version) throw new Error('version mismatch');
  // 架构必须与当前 Node 一致：原生模块（如 uiohook-napi）只随包分发 win32-x64 等特定架构的预编译产物，
  // 架构不符时 require 会失败并让依赖它的功能静默退回「不可用」。
  const installedArch = await runtimeArch(executable);
  if (installedArch && installedArch !== process.arch) throw new Error('arch mismatch');
} catch {
  const staging = path.join(electronDirectory, `.dist-staging-${process.pid}`);
  try {
    const electronRequire = createRequire(path.join(electronDirectory, 'install.js'));
    const { downloadArtifact } = electronRequire('@electron/get');
    const extract = electronRequire('extract-zip');
    const zip = await downloadArtifact({
      version: electronPackage.version,
      artifactName: 'electron',
      platform: process.platform,
      arch: process.arch,
      checksums: JSON.parse(await readFile(path.join(electronDirectory, 'checksums.json'), 'utf8')),
    });
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await extract(zip, { dir: staging });
    await access(path.join(staging, electronRuntimeProbe));
    await rm(electronDist, { recursive: true, force: true });
    await rename(staging, electronDist);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    console.error(`Dependency preflight failed: Electron runtime could not be restored: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
await writeFile(path.join(electronDirectory, 'path.txt'), electronExecutable, 'utf8');
console.log('Dependency preflight: PASS (locked toolchain present).');
