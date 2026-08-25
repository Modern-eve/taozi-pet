import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
try {
  const installedVersion = (await readFile(path.join(electronDist, 'version'), 'utf8')).trim().replace(/^v/, '');
  await access(path.join(electronDist, electronRuntimeProbe));
  if (installedVersion !== electronPackage.version) throw new Error('version mismatch');
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
