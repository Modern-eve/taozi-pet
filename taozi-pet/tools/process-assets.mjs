import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

function argsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index].replace(/^--/, '')] = argv[index + 1];
  return result;
}

const args = argsOf(process.argv.slice(2));
const inputDir = path.resolve(args.input ?? 'incoming-assets');
const outputDir = path.resolve(args.output ?? path.join('src', 'assets', 'pet'));
const specPath = path.resolve(args.spec ?? 'pet-spec.json');
const spec = JSON.parse(await readFile(specPath, 'utf8'));
const threshold = Number(spec.assetPipeline?.backgroundTolerance);
const feather = Number(spec.assetPipeline?.edgeFeather);
const safeMargin = Number(spec.assetPipeline?.safeMargin);
const targetOccupancy = Number(spec.assetPipeline?.targetOccupancy);
const generationBackground = spec.assetPipeline?.generationBackground;
if (spec.assetPipeline?.backgroundMode !== 'adaptive-flood') throw new Error('pet-spec assetPipeline.backgroundMode must be adaptive-flood');
if (!['transparent-grid', 'solid-chroma'].includes(generationBackground)) throw new Error('pet-spec generationBackground must be transparent-grid or solid-chroma');
if (![threshold, feather, safeMargin, targetOccupancy].every(Number.isFinite)) throw new Error('pet-spec assetPipeline values must be numbers');

const selectedStateId = args.state;
const states = selectedStateId ? spec.states.filter((state) => state.id === selectedStateId) : spec.states;
if (selectedStateId && states.length !== 1) throw new Error(`Unknown asset state: ${selectedStateId}`);
const names = new Set(states.flatMap((state) => state.frames));
await mkdir(outputDir, { recursive: true });

const reports = [];
const failures = [];
const extracted = new Map();
const colorDistance = (data, offset, color) => Math.hypot(data[offset] - color[0], data[offset + 1] - color[1], data[offset + 2] - color[2]);
const colorDistanceRgb = (left, right) => Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
const REPAIRS = {
  SUBJECT_TOUCHES_BORDER: 'Regenerate this frame with generous clear padding on all four sides.',
  BACKGROUND_UNSTABLE: 'Regenerate with real transparency or one stable light simulated-transparency grid; do not change backgroundTolerance.',
  FOREGROUND_EMPTY: 'Regenerate from the confirmed core IP with a clearly separated complete subject.',
  NORMALIZATION_TOO_LARGE: 'Regenerate this state from the same core IP with a fixed camera, body scale, and foot baseline.',
  NORMALIZATION_OVERFLOW: 'Regenerate with consistent framing and more clear margin; do not shrink unrelated states.',
  ASSET_READ_FAILED: 'Restore the referenced source PNG or correct its exact case-sensitive path.',
  ASSET_PROCESSING_FAILED: 'Inspect the source frame and regenerate only this failed state if deterministic correction is unsafe.',
};

function diagnosticFrom(error) {
  const message = error instanceof Error ? error.message : String(error);
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const explicitCode = typeof rawCode === 'string' && REPAIRS[rawCode] ? rawCode : undefined;
  let code = explicitCode || 'ASSET_PROCESSING_FAILED';
  if (!explicitCode && rawCode === 'ENOENT') code = 'ASSET_READ_FAILED';
  if (!explicitCode && /touches the source border/i.test(message)) code = 'SUBJECT_TOUCHES_BORDER';
  else if (!explicitCode && /border palette|background|gradient|color clusters|coverage/i.test(message)) code = 'BACKGROUND_UNSTABLE';
  else if (!explicitCode && /foreground is empty|subject is empty/i.test(message)) code = 'FOREGROUND_EMPTY';
  else if (!explicitCode && /normalized frame exceeds canvas/i.test(message)) code = 'NORMALIZATION_OVERFLOW';
  return { code, message, repair: REPAIRS[code] || REPAIRS.ASSET_PROCESSING_FAILED };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function borderIndexes(width, height) {
  const result = [];
  for (let x = 0; x < width; x += 1) {
    result.push(x);
    if (height > 1) result.push((height - 1) * width + x);
  }
  for (let y = 1; y + 1 < height; y += 1) {
    result.push(y * width);
    if (width > 1) result.push(y * width + width - 1);
  }
  return result;
}

function detectBorderPalette(data, width, height, name) {
  const indexes = borderIndexes(width, height);
  const transparentCount = indexes.reduce((total, index) => total + (data[index * 4 + 3] < 16 ? 1 : 0), 0);
  if (transparentCount / indexes.length >= 0.9) return { transparentInput: true, palette: [], coverage: 1, clusterCount: 0 };

  const bins = new Map();
  for (const index of indexes) {
    const offset = index * 4;
    if (data[offset + 3] < 16) continue;
    const key = `${Math.floor(data[offset] / 16)}:${Math.floor(data[offset + 1] / 16)}:${Math.floor(data[offset + 2] / 16)}`;
    const item = bins.get(key) ?? { count: 0, sum: [0, 0, 0] };
    item.count += 1;
    item.sum[0] += data[offset]; item.sum[1] += data[offset + 1]; item.sum[2] += data[offset + 2];
    bins.set(key, item);
  }
  const opaqueCount = [...bins.values()].reduce((total, item) => total + item.count, 0);
  const sorted = [...bins.values()].sort((left, right) => right.count - left.count);
  const selected = [];
  let covered = 0;
  for (const item of sorted) {
    selected.push(item);
    covered += item.count;
    if (covered / Math.max(1, opaqueCount) >= 0.92) break;
    if (selected.length === 4) break;
  }
  const coverage = covered / Math.max(1, opaqueCount);
  if (coverage < 0.92 || selected.length > 3) {
    throw new Error(`${name}: border needs ${selected.length > 3 ? 'more than 3' : 'too many'} color clusters (${(coverage * 100).toFixed(1)}% coverage); regenerate without gradient or scene background`);
  }
  const palette = selected.map((item) => item.sum.map((value) => Math.round(value / item.count)));
  if (generationBackground === 'transparent-grid') {
    const invalid = palette.some((color) => {
      const luminance = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
      const saturation = Math.max(...color) - Math.min(...color);
      return luminance < 210 || saturation > 42;
    });
    if (invalid) throw new Error(`${name}: background is not a light neutral transparency grid; regenerate as an isolated transparent PNG without ground or shadow`);
    if (palette.length > 1) {
      const widest = Math.max(...palette.flatMap((color, index) => palette.slice(index + 1).map((other) => colorDistanceRgb(color, other))), 0);
      if (widest > 72) throw new Error(`${name}: transparency-grid colors drift too far apart; regenerate a neutral checkerboard`);
    }
  } else if (palette.length > 2 || coverage < 0.95) {
    throw new Error(`${name}: solid-chroma background is not a stable flat color; regenerate without gradient`);
  }
  return { transparentInput: false, palette, coverage, clusterCount: palette.length };
}

async function extractForeground(name) {
  const source = path.join(inputDir, name);
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (width < 64 || height < 64) throw new Error(`${name}: source is too small`);
  const pixelCount = width * height;
  const detected = detectBorderPalette(data, width, height, name);
  const background = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const eligible = (index) => {
    const offset = index * 4;
    if (data[offset + 3] < 16) return true;
    return !detected.transparentInput && detected.palette.some((color) => colorDistance(data, offset, color) <= threshold);
  };
  for (const index of borderIndexes(width, height)) {
    if (!background[index] && eligible(index)) { background[index] = 1; queue[tail++] = index; }
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    const neighbors = [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1];
    for (const next of neighbors) if (next >= 0 && !background[next] && eligible(next)) { background[next] = 1; queue[tail++] = next; }
  }

  const output = Buffer.from(data);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let foregroundPixels = 0;
  let backgroundLikeForeground = 0;
  let touchesBorder = false;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    if (background[index]) { output[offset + 3] = 0; continue; }
    const x = index % width;
    const y = Math.floor(index / width);
    const adjacentBackground = (x > 0 && background[index - 1]) || (x + 1 < width && background[index + 1]) || (y > 0 && background[index - width]) || (y + 1 < height && background[index + width]);
    let alphaFactor = 1;
    if (adjacentBackground && !detected.transparentInput && detected.palette.length) {
      const nearest = detected.palette.reduce((best, color) => colorDistance(data, offset, color) < colorDistance(data, offset, best) ? color : best, detected.palette[0]);
      const distance = colorDistance(data, offset, nearest);
      alphaFactor = Math.max(0.08, Math.min(1, (distance - threshold) / Math.max(1, feather)));
      // RGB 反推保护：alphaFactor 过低时 (data - bg*(1-a)) / a 会除法爆炸，
      // 把接近背景的半透明边缘反推成纯白像素（曾导致双腿间白底）。
      // 此时直接保留原始 RGB，只靠 alpha 衰减羽化，不再反推。
      if (alphaFactor >= 0.5) {
        for (let channel = 0; channel < 3; channel += 1) {
          const foreground = (data[offset + channel] - (1 - alphaFactor) * nearest[channel]) / alphaFactor;
          output[offset + channel] = Math.max(0, Math.min(255, Math.round(foreground)));
        }
      }
    }
    output[offset + 3] = Math.round(data[offset + 3] * alphaFactor);
    if (output[offset + 3] >= 16) {
      if (!detected.transparentInput && detected.palette.some((color) => colorDistance(data, offset, color) <= threshold)) backgroundLikeForeground += 1;
      foregroundPixels += 1;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
    }
  }
  if (foregroundPixels / pixelCount < 0.01) throw new Error(`${name}: foreground is empty or background conflicts with subject`);
  if (touchesBorder) throw new Error(`${name}: subject touches the source border; regenerate with more margin`);
  return {
    name, data: output, width, height, minX, minY, maxX, maxY,
    cropWidth: maxX - minX + 1,
    cropHeight: maxY - minY + 1,
    detected,
    foregroundRatio: foregroundPixels / pixelCount,
    backgroundLikeForegroundRatio: backgroundLikeForeground / pixelCount,
  };
}

// 并行处理 272 帧（sharp decode/encode 异步，Promise.all 分 8 路并发提速）
const PARALLEL = 8;
const nameList = [...names];
for (let start = 0; start < nameList.length; start += PARALLEL) {
  const batch = nameList.slice(start, start + PARALLEL);
  const results = await Promise.allSettled(batch.map((name) => extractForeground(name)));
  for (let i = 0; i < batch.length; i += 1) {
    const name = batch[i];
    const result = results[i];
    if (result.status === 'fulfilled') extracted.set(name, result.value);
    else failures.push({ ok: false, name, ...diagnosticFrom(result.reason) });
  }
}

const maximum = Math.min(512 - safeMargin * 2, Math.floor(512 * targetOccupancy));
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function visibleBounds(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width; let minY = info.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    if (data[(y * info.width + x) * 4 + 3] < 16) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error('normalized subject is empty');
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

if (!failures.length) {
  for (const state of states) {
    const stateAssets = state.frames.map((frame) => extracted.get(frame));
    if (stateAssets.some((asset) => !asset)) { failures.push({ ok: false, name: state.id, error: `${state.id}: missing extracted frame` }); continue; }
    const groupWidth = Math.max(...stateAssets.map((asset) => asset.cropWidth));
    const groupHeight = Math.max(...stateAssets.map((asset) => asset.cropHeight));
    const sharedScale = Math.min(maximum / groupWidth, maximum / groupHeight, 1);
    const prepared = [];
    for (const asset of stateAssets) {
      try {
        const initialWidth = Math.max(1, Math.round(asset.cropWidth * sharedScale));
        const initialHeight = Math.max(1, Math.round(asset.cropHeight * sharedScale));
        const initial = await sharp(asset.data, { raw: { width: asset.width, height: asset.height, channels: 4 } })
          .extract({ left: asset.minX, top: asset.minY, width: asset.cropWidth, height: asset.cropHeight })
          .resize(initialWidth, initialHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
          .png().toBuffer();
        const bounds = await visibleBounds(initial);
        const visible = await sharp(initial).extract({ left: bounds.minX, top: bounds.minY, width: bounds.width, height: bounds.height }).png().toBuffer();
        prepared.push({ asset, visible, bounds });
      } catch (error) {
        failures.push({ ok: false, name: asset.name, ...diagnosticFrom(error) });
      }
    }
    if (prepared.length !== stateAssets.length) continue;
    const referenceWidth = median(prepared.map((item) => item.bounds.width));
    const referenceHeight = median(prepared.map((item) => item.bounds.height));
    for (const item of prepared) {
      const { asset } = item;
      try {
        const correction = Math.sqrt((referenceWidth * referenceHeight) / (item.bounds.width * item.bounds.height));
        const lockedBody = state.id === 'idle' || state.triggers.includes('ambient:blink');
        const maximumCorrection = lockedBody ? 1.08 : 1.12;
        if (correction < 1 / maximumCorrection || correction > maximumCorrection) {
          throw codedError(
            'NORMALIZATION_TOO_LARGE',
            `${asset.name}: required scale correction ${correction.toFixed(3)} exceeds the safe ${maximumCorrection.toFixed(2)} limit`,
          );
        }
        const correctedWidth = Math.max(1, Math.round(item.bounds.width * correction));
        const correctedHeight = Math.max(1, Math.round(item.bounds.height * correction));
        const corrected = await sharp(item.visible)
          .resize(correctedWidth, correctedHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
          .png().toBuffer();
        const correctedBounds = await visibleBounds(corrected);
        const cropped = await sharp(corrected).extract({
          left: correctedBounds.minX,
          top: correctedBounds.minY,
          width: correctedBounds.width,
          height: correctedBounds.height,
        }).png().toBuffer();
        const targetWidth = correctedBounds.width;
        const targetHeight = correctedBounds.height;
        const anchorX = Math.round(state.anchor.x * 511);
        const anchorY = Math.round(state.anchor.y * 511);
        const left = Math.round(anchorX - targetWidth / 2);
        const top = Math.round(anchorY - targetHeight);
        if (left < 0 || top < 0 || left + targetWidth > 512 || top + targetHeight > 512) throw new Error(`${asset.name}: normalized frame exceeds canvas; regenerate with consistent framing`);
        const destination = path.join(outputDir, asset.name);
        await mkdir(path.dirname(destination), { recursive: true });
        await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .composite([{ input: cropped, left, top }]).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(destination);
        reports.push({
          ok: true,
          name: asset.name,
          state: state.id,
          backgroundInput: asset.detected.transparentInput ? 'real-alpha' : generationBackground,
          backgroundPalette: asset.detected.palette.map((color) => `#${color.map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`),
          borderCoverage: asset.detected.coverage,
          sourceSize: [asset.width, asset.height],
          foregroundRatio: asset.foregroundRatio,
          backgroundLikeForegroundRatio: asset.backgroundLikeForegroundRatio,
          sourceBounds: [asset.minX, asset.minY, asset.maxX, asset.maxY],
          sharedScale,
          normalizationCorrection: correction,
          referenceVisibleSize: [referenceWidth, referenceHeight],
          groupSourceMaximum: [groupWidth, groupHeight],
          outputBounds: [left, top, left + targetWidth - 1, top + targetHeight - 1],
        });
      } catch (error) {
        failures.push({ ok: false, name: asset.name, ...diagnosticFrom(error) });
      }
    }
  }
}

console.log(`Processed ${reports.length}/${names.size} assets.`);
if (failures.length) {
  for (const failure of failures) console.error(`[${failure.code}] ${failure.message}\n  repair: ${failure.repair}`);
  process.exit(1);
}
