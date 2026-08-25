import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { loadSpec, parseArgv, PROJECT_ROOT } from './qa-common.mjs';

const argumentsMap = parseArgv();
const spec = await loadSpec();
const assetDir = path.resolve(PROJECT_ROOT, argumentsMap.assets ?? path.join('src', 'assets', 'pet'));
const qaDir = path.resolve(PROJECT_ROOT, argumentsMap.qa ?? 'qa');
await mkdir(qaDir, { recursive: true });
const records = [];
const regressionFixture = await readFile(path.join(PROJECT_ROOT, 'REGRESSION_FIXTURE_ONLY.txt'), 'utf8').then(() => true, () => false);
const targetOccupancy = Number(spec.assetPipeline?.targetOccupancy ?? 0.78);
const selectedStateId = argumentsMap.state;
const states = selectedStateId ? spec.states.filter((state) => state.id === selectedStateId) : spec.states;
if (selectedStateId && states.length !== 1) throw new Error(`Unknown asset state: ${selectedStateId}`);

const REPAIRS = {
  INVALID_DIMENSIONS: 'Run process:assets for this state; delivered frames must be 512x512 RGBA.',
  NO_TRANSPARENCY: 'Regenerate with real alpha or a stable light simulated-transparency grid.',
  EMPTY_FOREGROUND: 'Regenerate from the confirmed core IP with a visible complete subject.',
  SUBJECT_TOUCHES_BORDER: 'Regenerate this frame with generous clear padding on all four sides.',
  ANCHOR_DRIFT: 'Regenerate the state with a fixed horizontal center and foot baseline.',
  OCCUPANCY_TOO_LARGE: 'Regenerate with more margin; do not lower the QA threshold.',
  GROUND_RESIDUE: 'Regenerate without ground, platform, cast shadow, or contact shadow.',
  GROUND_RESIDUE_REVIEW: 'Inspect the evidence in the contact sheet; if it is not character anatomy, regenerate the state.',
  SCALE_DRIFT: 'Regenerate only this state from the same core IP with fixed camera and body scale.',
  DUPLICATE_FRAME: 'Create a real intermediate pose; copied pixels do not count as animation.',
  ASSET_READ_FAILED: 'Restore the referenced PNG or correct its exact case-sensitive path.',
};

function addDiagnostic(errors, diagnostics, code, message, confidence = 'high', blocking = true) {
  const repair = REPAIRS[code] || 'Inspect and repair only the affected state.';
  if (blocking) errors.push(`[${code}] ${message}`);
  diagnostics.push({ code, message, repair, confidence, blocking });
}

function flatGroundEvidence(data, width, bounds) {
  if (!bounds) return undefined;
  const [minX, minY, maxX, maxY] = bounds;
  const subjectWidth = maxX - minX + 1;
  const subjectHeight = maxY - minY + 1;
  const startY = Math.max(minY, maxY - Math.ceil(subjectHeight * 0.14));
  let best;
  for (let y = startY; y <= maxY; y += 1) {
    let runStart = -1;
    for (let x = minX; x <= maxX + 1; x += 1) {
      const visible = x <= maxX && data[(y * width + x) * 4 + 3] >= 32;
      if (visible && runStart < 0) runStart = x;
      if ((!visible || x === maxX + 1) && runStart >= 0) {
        const runEnd = x - 1;
        const runLength = runEnd - runStart + 1;
        if (runLength / subjectWidth >= 0.68) {
          const samples = [];
          for (let sampleX = runStart; sampleX <= runEnd; sampleX += Math.max(1, Math.floor(runLength / 64))) {
            const offset = (y * width + sampleX) * 4;
            samples.push([data[offset], data[offset + 1], data[offset + 2]]);
          }
          const means = [0, 1, 2].map((channel) => samples.reduce((total, color) => total + color[channel], 0) / samples.length);
          const deviation = Math.sqrt(samples.reduce((total, color) => total + color.reduce((sum, value, channel) => sum + (value - means[channel]) ** 2, 0), 0) / (samples.length * 3));
          const evidence = { y, runRatio: runLength / subjectWidth, colorDeviation: deviation };
          if (!best || evidence.runRatio > best.runRatio) best = evidence;
        }
        runStart = -1;
      }
    }
  }
  return best && best.colorDeviation < 32 ? best : undefined;
}

function coloredGroundEvidence(data, width, height, bounds, mainPixels) {
  if (!bounds) return undefined;
  const [minX, minY, maxX, maxY] = bounds;
  const subjectWidth = maxX - minX + 1;
  const subjectHeight = maxY - minY + 1;
  const startY = Math.max(minY, maxY - Math.ceil(subjectHeight * 0.18));
  const bins = new Map();
  const upperBins = new Map();
  for (let y = minY; y < startY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    const offset = (y * width + x) * 4;
    if (data[offset + 3] < 32) continue;
    const red = data[offset]; const green = data[offset + 1]; const blue = data[offset + 2];
    if (Math.max(red, green, blue) - Math.min(red, green, blue) < 48) continue;
    const key = `${Math.floor(red / 20)}:${Math.floor(green / 20)}:${Math.floor(blue / 20)}`;
    upperBins.set(key, (upperBins.get(key) ?? 0) + 1);
  }
  for (let y = startY; y <= maxY && y < height; y += 1) for (let x = minX; x <= maxX; x += 1) {
    const offset = (y * width + x) * 4;
    if (data[offset + 3] < 32) continue;
    const red = data[offset]; const green = data[offset + 1]; const blue = data[offset + 2];
    if (Math.max(red, green, blue) - Math.min(red, green, blue) < 48) continue;
    const key = `${Math.floor(red / 20)}:${Math.floor(green / 20)}:${Math.floor(blue / 20)}`;
    const item = bins.get(key) ?? { pixels: 0, minX: x, minY: y, maxX: x, maxY: y };
    item.pixels += 1;
    item.minX = Math.min(item.minX, x); item.maxX = Math.max(item.maxX, x);
    item.minY = Math.min(item.minY, y); item.maxY = Math.max(item.maxY, y);
    bins.set(key, item);
  }
  return [...bins.entries()].map(([colorBin, item]) => ({ colorBin, ...item })).find((item) => {
    const spanWidth = item.maxX - item.minX + 1;
    const spanHeight = item.maxY - item.minY + 1;
    return item.pixels >= Math.max(80, mainPixels * 0.003)
      && spanWidth >= subjectWidth * 0.45
      && spanHeight <= subjectHeight * 0.08
      && spanWidth / Math.max(1, spanHeight) >= 5.5
      && (upperBins.get(item.colorBin) ?? 0) < Math.max(12, item.pixels * 0.08);
  });
}

for (const state of states) {
  const checkedFiles = new Set(); // 双播状态下同一帧名重复引用两次，物理文件只有一份，只检测一次
  for (const frame of state.frames) {
    if (checkedFiles.has(frame)) continue;
    checkedFiles.add(frame);
    const errors = [];
    const diagnostics = [];
    const file = path.join(assetDir, frame);
    try {
      const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== 512 || info.height !== 512 || info.channels !== 4) addDiagnostic(errors, diagnostics, 'INVALID_DIMENSIONS', 'must be 512x512 RGBA');
      // 单遍全图扫描：透明/不透明统计与连通域 BFS 合并，每像素只访问一次。
      // 连通阈值 32 与 opaque 阈值 16 不同——16..31 的像素计入 opaque 但不属于任何组件。
      const visited = new Uint8Array(info.width * info.height);
      const queue = new Int32Array(info.width * info.height);
      const components = [];
      let transparent = 0;
      let opaque = 0;
      let minX = info.width;
      let minY = info.height;
      let maxX = -1;
      let maxY = -1;
      let borderPixels = 0;
      for (let y = 0; y < info.height; y += 1) {
        const rowBase = y * info.width;
        for (let x = 0; x < info.width; x += 1) {
          const index = rowBase + x;
          const alpha = data[index * 4 + 3];
          if (alpha === 0) { transparent += 1; continue; }
          if (alpha >= 16) {
            opaque += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1) borderPixels += 1;
          }
          // 连通域 BFS 就地启动（BFS 只做可达性标记，不重复统计；visited 共享数组防二次遍历）
          if (alpha >= 32 && !visited[index]) {
            let head = 0; let tail = 0; let pixels = 0;
            let compMinX = info.width; let compMinY = info.height; let compMaxX = -1; let compMaxY = -1;
            queue[tail++] = index; visited[index] = 1;
            while (head < tail) {
              const current = queue[head++];
              const currentX = current % info.width; const currentY = Math.floor(current / info.width);
              pixels += 1;
              if (currentX < compMinX) compMinX = currentX;
              if (currentX > compMaxX) compMaxX = currentX;
              if (currentY < compMinY) compMinY = currentY;
              if (currentY > compMaxY) compMaxY = currentY;
              // 内联 4 邻域，避免每次分配 neighbors 数组（272 帧 × 数十万像素的 GC 压力）
              if (currentX > 0) { const next = current - 1; if (!visited[next] && data[next * 4 + 3] >= 32) { visited[next] = 1; queue[tail++] = next; } }
              if (currentX + 1 < info.width) { const next = current + 1; if (!visited[next] && data[next * 4 + 3] >= 32) { visited[next] = 1; queue[tail++] = next; } }
              if (currentY > 0) { const next = current - info.width; if (!visited[next] && data[next * 4 + 3] >= 32) { visited[next] = 1; queue[tail++] = next; } }
              if (currentY + 1 < info.height) { const next = current + info.width; if (!visited[next] && data[next * 4 + 3] >= 32) { visited[next] = 1; queue[tail++] = next; } }
            }
            components.push({ pixels, bounds: [compMinX, compMinY, compMaxX, compMaxY] });
          }
        }
      }
      components.sort((left, right) => right.pixels - left.pixels);
      if (transparent === 0) addDiagnostic(errors, diagnostics, 'NO_TRANSPARENCY', 'no transparent pixels');
      if (opaque === 0) addDiagnostic(errors, diagnostics, 'EMPTY_FOREGROUND', 'no visible foreground');
      if (borderPixels > 0) addDiagnostic(errors, diagnostics, 'SUBJECT_TOUCHES_BORDER', `foreground touches canvas border (${borderPixels} pixels)`);
      if (opaque > 0) {
        const centerX = ((minX + maxX) / 2) / 511;
        const bottomY = maxY / 511;
        if (Math.abs(centerX - state.anchor.x) > 0.04) addDiagnostic(errors, diagnostics, 'ANCHOR_DRIFT', `horizontal anchor drift: ${centerX.toFixed(3)}`);
        if (Math.abs(bottomY - state.anchor.y) > 0.02) addDiagnostic(errors, diagnostics, 'ANCHOR_DRIFT', `bottom anchor drift: ${bottomY.toFixed(3)}`);
        const occupancy = Math.max(maxX - minX + 1, maxY - minY + 1) / 512;
        if (occupancy > targetOccupancy + 0.025) addDiagnostic(errors, diagnostics, 'OCCUPANCY_TOO_LARGE', `visible subject exceeds target occupancy: ${occupancy.toFixed(3)}`);
      }
      const bounds = opaque ? [minX, minY, maxX, maxY] : null;
      const main = components[0];
      const detachedGround = main && components.slice(1).find((component) => {
        const width = component.bounds[2] - component.bounds[0] + 1;
        const height = component.bounds[3] - component.bounds[1] + 1;
        const mainWidth = main.bounds[2] - main.bounds[0] + 1;
        const mainHeight = main.bounds[3] - main.bounds[1] + 1;
        return component.pixels >= Math.max(96, main.pixels * 0.006) && width > mainWidth * 0.35 && height < mainHeight * 0.18 && component.bounds[3] >= main.bounds[3] - mainHeight * 0.12;
      });
      const warnings = [];
      if (detachedGround) {
        const message = `detached ground/shadow component remains: ${detachedGround.bounds.join(',')}`;
        regressionFixture ? warnings.push(message) : addDiagnostic(errors, diagnostics, 'GROUND_RESIDUE', message);
      }
      const flatGround = flatGroundEvidence(data, info.width, bounds);
      if (flatGround) {
        const message = `wide flat ground/shadow remains near y=${flatGround.y} (run ${(flatGround.runRatio * 100).toFixed(1)}%)`;
        if (regressionFixture) warnings.push(message);
        else if (flatGround.runRatio >= 0.8 && flatGround.colorDeviation < 18) addDiagnostic(errors, diagnostics, 'GROUND_RESIDUE', message);
        else addDiagnostic(errors, diagnostics, 'GROUND_RESIDUE_REVIEW', message, 'medium', false); // review 级不阻塞，记录供人工查看
      }
      const coloredGround = coloredGroundEvidence(data, info.width, info.height, bounds, main?.pixels ?? opaque);
      if (coloredGround) {
        const message = `wide saturated ground/background residue remains near the anchor (${coloredGround.colorBin})`;
        regressionFixture ? warnings.push(message) : addDiagnostic(errors, diagnostics, 'GROUND_RESIDUE', message);
      }
      records.push({ state: state.id, frame, ok: errors.length === 0, errors, diagnostics, warnings, sha256: createHash('sha256').update(data).digest('hex'), transparentRatio: transparent / (info.width * info.height), bounds, componentCount: components.length, flatGround, coloredGround });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      records.push({
        state: state.id,
        frame,
        ok: false,
        errors: [`[ASSET_READ_FAILED] ${message}`],
        diagnostics: [{ code: 'ASSET_READ_FAILED', message, repair: REPAIRS.ASSET_READ_FAILED, confidence: 'high', blocking: true }],
        warnings: [],
        sha256: '', // 读取失败无哈希：既避免污染基线，也不参与 DUPLICATE_FRAME 去重
        bounds: null,
        transparentRatio: 0,
        componentCount: 0,
        flatGround: undefined,
        coloredGround: undefined,
      });
    }
  }
}

for (const state of states) {
  const stateRecords = records.filter((record) => record.state === state.id && record.bounds);
  const widths = stateRecords.map((record) => record.bounds[2] - record.bounds[0] + 1);
  const heights = stateRecords.map((record) => record.bounds[3] - record.bounds[1] + 1);
  const equivalentScales = widths.map((width, index) => Math.sqrt(width * heights[index]));
  const centers = stateRecords.map((record) => (record.bounds[0] + record.bounds[2]) / 2 / 511);
  const bottoms = stateRecords.map((record) => record.bounds[3] / 511);
  const lockedBody = state.id === 'idle' || state.triggers.includes('ambient:blink');
  const maximumScaleRatio = lockedBody ? 1.025 : 1.08;
  const maximumCenterDrift = lockedBody ? 0.015 : 0.035;
  const maximumBottomDrift = lockedBody ? 0.01 : 0.018;
  const scaleDrifts = lockedBody
    ? Math.max(...widths) / Math.min(...widths) > maximumScaleRatio || Math.max(...heights) / Math.min(...heights) > maximumScaleRatio
    : Math.max(...equivalentScales) / Math.min(...equivalentScales) > maximumScaleRatio;
  if (widths.length > 1 && scaleDrifts) {
    const message = `visible subject scale drifts too much within ${state.id} (limit ${((maximumScaleRatio - 1) * 100).toFixed(1)}%)`;
    for (const record of stateRecords) {
      if (regressionFixture) record.warnings.push(message);
      else addDiagnostic(record.errors, record.diagnostics, 'SCALE_DRIFT', message);
    }
  }
  if (centers.length > 1 && Math.max(...centers) - Math.min(...centers) > maximumCenterDrift) {
    const message = `horizontal center drifts too much within ${state.id}`;
    for (const record of stateRecords) {
      if (regressionFixture) record.warnings.push(message);
      else addDiagnostic(record.errors, record.diagnostics, 'ANCHOR_DRIFT', message);
    }
  }
  if (bottoms.length > 1 && Math.max(...bottoms) - Math.min(...bottoms) > maximumBottomDrift) {
    const message = `bottom anchor drifts too much within ${state.id}`;
    for (const record of stateRecords) {
      if (regressionFixture) record.warnings.push(message);
      else addDiagnostic(record.errors, record.diagnostics, 'ANCHOR_DRIFT', message);
    }
  }
  // DUPLICATE_FRAME 检查：帧序列 sha256 去重。状态帧已按文件名去重（双播的重复引用
  // 只检测一次），这里检查的是"不同文件名的帧内容相同"——walk-03/04 类复制错误仍会被拦截。
  const checkRecords = stateRecords;

  const seen = new Map();
  for (let index = 0; index < checkRecords.length; index += 1) {
    const record = checkRecords[index];
    if (!record.sha256) continue; // 读取失败/无哈希的记录不参与重复帧判定，避免多张失败帧互判重复
    const previous = seen.get(record.sha256);
    const allowedBlinkClosure = state.id === 'blink' && previous === 0 && index === checkRecords.length - 1 && checkRecords.length >= 3;
    if (previous !== undefined && !allowedBlinkClosure) {
      const message = `duplicate pixels do not create a real animation frame: ${record.frame}`;
      if (regressionFixture) record.warnings.push(message);
      else addDiagnostic(record.errors, record.diagnostics, 'DUPLICATE_FRAME', message);
    }
    seen.set(record.sha256, index);
  }
  for (const record of stateRecords) record.ok = record.errors.length === 0;
}

const tiles = [];
const columns = 4;
const tileWidth = 220;
const tileHeight = 250;
// 缩略图并行生成（272 帧串行 sharp → Promise.all，contact sheet 生成提速）
await Promise.all(records.map(async (record, index) => {
  if (!record || !record.frame) return;
  try {
    const thumb = await sharp(path.join(assetDir, record.frame)).resize(190, 190, { fit: 'contain' }).png().toBuffer();
    const size = record.bounds ? `${record.bounds[2] - record.bounds[0] + 1}×${record.bounds[3] - record.bounds[1] + 1}` : 'missing';
    const code = record.diagnostics?.[0]?.code;
    const labelText = `${record.state} · ${record.frame} · ${size}${code ? ` · ${code}` : ''}`.replaceAll('&','&amp;').replaceAll('<','&lt;');
    const label = Buffer.from(`<svg width="220" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="220" height="40" fill="${code ? '#fff0f0' : '#fff'}"/><text x="110" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="${code ? '#a21b1b' : '#20242c'}">${labelText}</text></svg>`);
    tiles.push({ input: thumb, left: (index % columns) * tileWidth + 15, top: Math.floor(index / columns) * tileHeight + 10 });
    tiles.push({ input: label, left: (index % columns) * tileWidth, top: Math.floor(index / columns) * tileHeight + 205 });
  } catch { /* missing file is already in the JSON report */ }
}));
// 回归基准对比：记录每帧 sha256，下次 QA 检测"帧内容静默变化"（防 process-assets 改版/PNG 编码漂移）
const baselinePath = path.join(qaDir, 'asset-hashes.json');
const currentHashes = Object.fromEntries(records.map((record) => [record.frame, record.sha256]));
let driftCount = 0;
let baselineSaved = false;
try {
  const previous = JSON.parse(await readFile(baselinePath, 'utf8'));
  const drifted = Object.entries(currentHashes).filter(([frame, hash]) => previous[frame] && previous[frame] !== hash);
  driftCount = drifted.length;
  if (driftCount) {
    const sample = drifted.slice(0, 5).map(([frame]) => frame).join(', ');
    console.warn(`Asset QA baseline drift: ${driftCount} frame(s) changed since last run (${sample}${driftCount > 5 ? ', …' : ''}); verify the pipeline did not unintentionally alter assets.`);
  }
  baselineSaved = true;
} catch (error) {
  if (error && error.code !== 'ENOENT') console.warn(`Asset QA baseline: could not read ${baselinePath}: ${error.message}`);
}
try {
  await writeFile(baselinePath, `${JSON.stringify(currentHashes, null, 0)}\n`, 'utf8');
} catch (error) {
  console.warn(`Asset QA baseline: could not write ${baselinePath}: ${error.message}`);
}

const rows = Math.max(1, Math.ceil(records.length / columns));
await sharp({ create: { width: columns * tileWidth, height: rows * tileHeight, channels: 4, background: '#f1f3f5' } }).composite(tiles).png().toFile(path.join(qaDir, 'contact-sheet.png'));
const report = { generatedAt: new Date().toISOString(), scope: selectedStateId || 'all', passed: records.every((item) => item.ok), regressionFixture, warningCount: records.reduce((total, item) => total + item.warnings.length + item.diagnostics.filter((d) => !d.blocking).length, 0), baselineDrift: driftCount, assets: records };
await writeFile(path.join(qaDir, 'assets-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Asset QA: ${report.passed ? 'PASS' : 'FAIL'} (${records.filter((item) => item.ok).length}/${records.length})`);
if (report.warningCount) console.warn(`Asset QA warnings: ${report.warningCount}; inspect the contact sheet before delivery.`);
if (!report.passed) process.exit(1);
