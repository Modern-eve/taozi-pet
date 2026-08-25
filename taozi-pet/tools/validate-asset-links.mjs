import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { makeCheck, runChecks, loadSpec, assetSetsFromSpec, PROJECT_ROOT } from './qa-common.mjs';

const spec = await loadSpec();
const { referenced } = assetSetsFromSpec(spec);
const assetRoot = path.join(PROJECT_ROOT, 'src', 'assets', 'pet');

async function walk(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) files.push(relative);
  }
  return files;
}

const checks = [];

checks.push(makeCheck({
  id: 'asset-links-integral',
  gate: 'asset-links',
  describe: 'spec 引用的素材与磁盘完全对应（无缺失/无孤儿/无大小写冲突）',
  run: async () => {
    const problems = [];
    for (const name of referenced) {
      if (name.includes('\\')) problems.push(`asset paths must use forward slashes: ${name}`);
    }
    const actual = await walk(assetRoot);
    const actualSet = new Set(actual);
    for (const name of referenced) if (!actualSet.has(name)) problems.push(`missing or case-mismatched runtime asset: ${name}`);
    for (const name of actual) if (!referenced.has(name)) problems.push(`orphan runtime PNG is not referenced by pet-spec.json: ${name}`);
    const folded = new Map();
    for (const name of actual) {
      const key = name.toLocaleLowerCase('en-US');
      const previous = folded.get(key);
      if (previous && previous !== name) problems.push(`case-insensitive asset collision: ${previous} <> ${name}`);
      folded.set(key, name);
    }
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : `${referenced.size} referenced PNGs, no orphans` };
  },
}));

checks.push(makeCheck({
  id: 'renderer-recursive-context',
  gate: 'asset-links',
  describe: 'pet 渲染进程递归导入运行时素材目录（pet 是唯一实际展示宠物帧的窗口）',
  run: async () => {
    const problems = [];
    const recursiveContext = /require\.context\(\s*['"]\.\.\/\.\.\/assets\/pet['"]\s*,\s*true\s*,/u;
    const petSource = await readFile(path.join(PROJECT_ROOT, 'src/renderer/pet/index.ts'), 'utf8');
    if (!recursiveContext.test(petSource)) problems.push('src/renderer/pet/index.ts must recursively import nested runtime assets');
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : 'pet 渲染上下文已递归导入宠物素材' };
  },
}));

const ok = await runChecks({ name: 'Asset Links', reportFile: 'asset-links-report.json', checks });
if (!ok) process.exit(1);