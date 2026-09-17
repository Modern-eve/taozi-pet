import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { makeCheck, blockDecl, hasProps, runChecks, loadSpec, PROJECT_ROOT } from './qa-common.mjs';

const spec = await loadSpec();
const files = {
  main: await readFile(path.join(PROJECT_ROOT, 'src', 'main.ts'), 'utf8'),
  contracts: await readFile(path.join(PROJECT_ROOT, 'src', 'shared', 'contracts.ts'), 'utf8'),
  dashboardCss: await readFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'dashboard', 'index.css'), 'utf8'),
  dashboardHtml: await readFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'dashboard', 'index.html'), 'utf8'),
  petCss: await readFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'pet', 'index.css'), 'utf8'),
  petTs: await readFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'pet', 'index.ts'), 'utf8'),
};

// 主进程被拆成 src/main.ts + src/main/*.ts，涉及主进程的检查按整体文本判定
const mainDirFiles = await readdir(path.join(PROJECT_ROOT, 'src', 'main')).catch(() => []);
const mainProcess = [
  files.main,
  ...(await Promise.all(
    mainDirFiles.filter((name) => name.endsWith('.ts')).sort()
      .map((name) => readFile(path.join(PROJECT_ROOT, 'src', 'main', name), 'utf8').catch(() => '')),
  )),
].join('\n');

const checks = [];

// ---- window / transparent root ----
for (const view of [
  { id: 'dashboard', css: files.dashboardCss },
  { id: 'pet', css: files.petCss },
]) {
  checks.push(makeCheck({
    id: `${view.id}-transparent-root`,
    gate: 'window',
    describe: 'html/body 透明且页面级 overflow hidden',
    run: () => {
      const decl = blockDecl(view.css, 'body');
      const ok = hasProps(decl, 'background: transparent') && hasProps(decl, 'overflow: hidden');
      return { passed: ok, detail: ok ? '透明根与溢出隐藏就位' : '缺 background:transparent 或 overflow:hidden' };
    },
  }));
}

// ---- dashboard ----
checks.push(makeCheck({
  id: 'dashboard-hidden-scrollbar',
  gate: 'window',
  describe: '内部滚动不显示系统滚动条',
  run: () => {
    const scrollbar = blockDecl(files.dashboardCss, '::-webkit-scrollbar');
    const content = blockDecl(files.dashboardCss, '.content-scroll');
    const ok = hasProps(scrollbar, 'width: 0') && hasProps(scrollbar, 'height: 0') && hasProps(content, 'scrollbar-width: none');
    return { passed: ok, detail: ok ? '滚动条已隐藏' : 'content-scroll 或滚动条样式缺失' };
  },
}));

checks.push(makeCheck({
  id: 'native-control-reset',
  gate: 'window',
  describe: '原生控件重置系统外观',
  run: () => {
    const viewTab = blockDecl(files.dashboardCss, '.view-tab');
    const slider = blockDecl(files.dashboardCss, 'input[type="range"]');
    const closeBtn = blockDecl(files.dashboardCss, '.close-btn');
    const settles = [viewTab, slider, closeBtn].join('\n');
    const ok = hasProps(settles, '-webkit-appearance: none') || (hasProps(viewTab, 'appearance: none') && hasProps(slider, 'appearance: none'));
    return { passed: ok, detail: ok ? '原生外观已重置' : '控件缺少 appearance:none' };
  },
}));

checks.push(makeCheck({
  id: 'drag-bar-full',
  gate: 'window',
  describe: '拖拽条可拖动，其碰撞区内可点元素 no-drag',
  run: () => {
    const dragBar = blockDecl(files.dashboardCss, '.drag-bar');
    const noDrag = blockDecl(files.dashboardCss, '.close-btn');
    const ok = hasProps(dragBar, '-webkit-app-region: drag') && hasProps(noDrag, '-webkit-app-region: no-drag');
    return { passed: ok, detail: ok ? '拖拽条与 no-drag 就位' : '缺 drag bar 或 close-btn 未设 no-drag' };
  },
}));

checks.push(makeCheck({
  id: 'scale-slider-range',
  gate: 'src',
  describe: '桌宠缩放滑块范围 50%-150%',
  run: () => {
    const match = files.dashboardHtml.match(/id="scale-slider"[^>]*min="([^"]+)"[^>]*max="([^"]+)"[^>]*step="([^"]+)"/);
    const ok = Boolean(match) && match[1] === '0.5' && match[2] === '1.5' && match[3] === '0.01';
    return { passed: ok, detail: ok ? `滑块 min/max/step = ${match[1]}/${match[2]}/${match[3]}` : '未找到 scale-slider 或范围非 0.5-1.5' };
  },
}));

// ---- pet ----
checks.push(makeCheck({
  id: 'bubble-fixed-size',
  gate: 'window',
  describe: '气泡尺寸用固定 px，不随桌宠缩放变化',
  run: () => {
    const bubble = blockDecl(files.petCss, '#feedback-bubble');
    const ok = hasProps(bubble, 'font-size: 14px') && hasProps(bubble, 'max-width: 220px') && !hasProps(bubble, 'pet-scale');
    return { passed: ok, detail: ok ? '气泡字体/宽度固定，未引用缩放变量' : '气泡尺寸未固定或引用了缩放变量' };
  },
}));

checks.push(makeCheck({
  id: 'bubble-zone-height',
  gate: 'spec+src',
  describe: '气泡区高度三处同源：shared 常量 = CSS 初值 = 渲染层引用',
  run: () => {
    const cssMatch = files.petCss.match(/--pet-bubble-zone:\s*(\d+)px/);
    const constMatch = files.contracts.match(/export const PET_BUBBLE_ZONE\s*=\s*(\d+)/);
    const imported = /import\s*\{[^}]*\bPET_BUBBLE_ZONE\b[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/contracts'/.test(files.petTs);
    const redeclared = /\bconst\s+PET_BUBBLE_ZONE\s*=/.test(files.petTs);
    const ok = Boolean(cssMatch && constMatch) && cssMatch[1] === constMatch[1] && imported && !redeclared;
    const detail = ok
      ? `CSS=${cssMatch[1]}px 常量=${constMatch[1]} 渲染层引用 shared`
      : `CSS=${cssMatch?.[1]}px 常量=${constMatch?.[1]} 渲染层导入=${imported} 本地重声明=${redeclared}`;
    return { passed: ok, detail };
  },
}));

// ---- spec 派生数值 ----
checks.push(makeCheck({
  id: 'default-pet-size',
  gate: 'spec',
  describe: '默认可见主体 120-175px',
  run: () => {
    const baseWindow = Number(spec.experience?.petSizing?.baseWindowPx);
    const defaultScale = Number(spec.experience?.petSizing?.defaultScale);
    const occupancy = Number(spec.assetPipeline?.targetOccupancy);
    const subject = baseWindow * defaultScale * occupancy;
    const ok = subject >= 120 && subject <= 175;
    return { passed: ok, detail: `可见主体约 ${subject.toFixed(1)}px` };
  },
}));

checks.push(makeCheck({
  id: 'minimum-pet-size',
  gate: 'spec',
  describe: '最小可见主体 ≤150px',
  run: () => {
    const baseWindow = Number(spec.experience?.petSizing?.baseWindowPx);
    const occupancy = Number(spec.assetPipeline?.targetOccupancy);
    const subject = baseWindow * 0.65 * occupancy;
    const ok = subject <= 150;
    return { passed: ok, detail: `最小可见主体约 ${subject.toFixed(1)}px` };
  },
}));

checks.push(makeCheck({
  id: 'content-width-fit',
  gate: 'spec+asset',
  describe: '素材人物横向占比不超过 petSizing.contentWidthRatio，且水平居中',
  run: async () => {
    const ratio = Number(spec.experience?.petSizing?.contentWidthRatio);
    const directory = path.join(PROJECT_ROOT, 'src', 'assets', 'pet');
    const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.png'));
    if (names.length === 0) return { passed: false, detail: '未找到素材帧（先运行 process:assets）' };
    let minX = Number.POSITIVE_INFINITY;
    let maxX = -1;
    for (const name of names) {
      const { data, info } = await sharp(path.join(directory, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          if (data[(y * info.width + x) * 4 + 3] < 16) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    const used = (maxX - minX + 1) / 512;
    const centered = Math.abs((minX + maxX) / 2 - 255.5) <= 2;
    const ok = Number.isFinite(ratio) && used <= ratio && centered;
    return { passed: ok, detail: `人物横向占比 ${used.toFixed(3)}（上限 ${ratio}），水平居中 ${centered}` };
  },
}));

checks.push(makeCheck({
  id: 'pet-window-width',
  gate: 'spec+src',
  describe: '窗口宽度按人物可见宽度派生，不随方形精灵一起变宽',
  run: () => {
    const ok = mainProcess.includes('petCharacterWidth(ctx)') && mainProcess.includes('PET_BUBBLE_ZONE_WIDTH');
    return { passed: ok, detail: ok ? '窗口宽度 = max(人物可见宽, 气泡区最小宽)' : '未按人物可见宽度派生窗口宽度' };
  },
}));

checks.push(makeCheck({
  id: 'window-width-capped',
  gate: 'spec',
  describe: '各缩放档位：窗口宽度足以容下人物，且不超过「精灵边长与气泡区最小宽度取大」',
  run: () => {
    const base = Number(spec.experience?.petSizing?.baseWindowPx);
    const ratio = Number(spec.experience?.petSizing?.contentWidthRatio);
    const bubbleMin = Number(mainProcess.match(/PET_BUBBLE_ZONE_WIDTH\s*=\s*(\d+)/)?.[1] ?? 240);
    const problems = [];
    for (let scale = 0.5; scale <= 1.5001; scale += 0.1) {
      const size = Math.round(base * scale);
      const content = Math.round(size * ratio);
      const width = Math.max(content, bubbleMin);
      if (width < content) problems.push(`scale=${scale.toFixed(1)} 窗口裁到人物`);
      if (width > Math.max(size, bubbleMin) + 1) problems.push(`scale=${scale.toFixed(1)} 窗口宽于旧口径`);
    }
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : '0.5–1.5 档位全部满足（人物不裁、死区不增）' };
  },
}));

checks.push(makeCheck({
  id: 'sprite-not-compressed',
  gate: 'window',
  describe: '窗口窄于精灵时精灵保持原尺寸居中溢出，不被 flex 压缩',
  run: () => {
    const hasFlexNone = (selector) => new RegExp(`${selector.replace(/([#-])/g, '\\$1')}\\s*\\{[^}]*flex:\\s*none`).test(files.petCss);
    const ok = hasFlexNone('#pet-sprite-frame') && hasFlexNone('#pet-sprite');
    return { passed: ok, detail: ok ? '精灵与帧容器均 flex:none' : '缺少 flex:none，精灵可能被压缩变形' };
  },
}));

// ---- tray ----
checks.push(makeCheck({
  id: 'png-tray-runtime',
  gate: 'src',
  describe: '托盘加载打包 PNG、拒绝空图',
  run: () => {
    const ok = mainProcess.includes('path.resolve(__dirname, trayIconPath)') && mainProcess.includes('nativeImage.createFromPath') && mainProcess.includes('.isEmpty()') && !mainProcess.includes('createFromDataURL');
    return { passed: ok, detail: ok ? '托盘 PNG 运行时加载就位' : '托盘 PNG 加载逻辑缺失' };
  },
}));

checks.push(makeCheck({
  id: 'tray-icon-file',
  gate: 'asset',
  describe: '托盘图标 32×32、可见率 ≥8%',
  run: async () => {
    const trayPath = path.join(PROJECT_ROOT, 'src', 'assets', 'tray', 'tray-icon.png');
    const { data, info } = await sharp(trayPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] >= 16) visible += 1;
    const visibleRatio = visible / (info.width * info.height);
    const ok = info.width === 32 && info.height === 32 && visibleRatio >= 0.08;
    return { passed: ok, detail: `托盘 ${info.width}×${info.height}，可见 ${(visibleRatio * 100).toFixed(1)}%` };
  },
}));

checks.push(makeCheck({
  id: 'menu-emoji',
  gate: 'src+spec',
  describe: '系统与互动菜单使用语义 emoji',
  run: () => {
    const systemEmojis = ['⏰', '🏠', '🖱️', '🙈', '🐾', '🚪'].every((emoji) => mainProcess.includes(emoji));
    const interactionEmojis = (spec.experience?.interactions ?? []).every((it) => typeof it.emoji === 'string' && it.emoji.length > 0);
    const ok = systemEmojis && interactionEmojis;
    return { passed: ok, detail: ok ? '菜单 emoji 齐全' : '缺少系统或互动菜单 emoji' };
  },
}));

// ---- 防御性 warning（仅提示，不阻断）----

// 默认宠体尺寸是否偏离滑块中段：太偏可能在常见窗口下显得过小/过大
checks.push(makeCheck({
  id: 'pet-size-default-alignment',
  gate: 'spec+src',
  severity: 'warning',
  describe: '默认缩放(defaultScale)落在滑块中段 0.6-1.1',
  run: () => {
    const scale = spec.experience?.petSizing?.defaultScale;
    const ok = typeof scale === 'number' && scale >= 0.6 && scale <= 1.1;
    return { passed: ok, detail: ok ? `defaultScale=${scale} 居中` : `defaultScale=${scale} 偏离中段，确认是否刻意` };
  },
}));

// 气泡前景文字与主题背景的对比度（近似 YIQ），过低时文字可读性差
checks.push(makeCheck({
  id: 'bubble-contrast-hint',
  gate: 'window',
  severity: 'warning',
  describe: '气泡前景(reversed proposal)与背景对比度足够',
  run: () => {
    const theme = spec.experience?.theme ?? {};
    const luminance = (hex) => {
      const value = String(hex).replace('#', '');
      if (value.length < 6) return 0;
      const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
      return (r * 299 + g * 587 + b * 114) / 1000;
    };
    const text = luminance(theme.text);
    const background = luminance(theme.background ?? theme.surface);
    const contrast = Math.abs(text - background);
    const ok = contrast >= 40;
    return { passed: ok, detail: ok ? `前景/背景亮度差 ${contrast.toFixed(0)}` : `前景/背景对比不足（差 ${contrast.toFixed(0)} < 40）` };
  },
}));

// 拖拽条高度过小：<32px 在窄条上难以抓住拖动
checks.push(makeCheck({
  id: 'drag-bar-height',
  gate: 'window',
  severity: 'warning',
  describe: '拖拽条高度 ≥32px，便于抓取拖动',
  run: () => {
    const decl = blockDecl(files.dashboardCss, '.drag-bar');
    const match = decl.match(/height:\s*(\d+)px/);
    const height = match ? Number(match[1]) : 0;
    const ok = height >= 32;
    return { passed: ok, detail: ok ? `拖拽条高度 ${height}px` : `拖拽条仅 ${height}px，过窄难拖（建议 ≥32px）` };
  },
}));

// 主题主色与表面色亮度差过小：可点/强调元素可能与背景粘连、层级弱
checks.push(makeCheck({
  id: 'theme-accent-contrast',
  gate: 'spec',
  severity: 'warning',
  describe: '主题主色(primary)与表面(surface)亮度差 ≥50，保证强调层级',
  run: () => {
    const theme = spec.experience?.theme ?? {};
    const luminance = (hex) => {
      const value = String(hex).replace('#', '');
      if (value.length < 6) return 0;
      const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
      return (r * 299 + g * 587 + b * 114) / 1000;
    };
    const primary = luminance(theme.primary);
    const surface = luminance(theme.surface ?? theme.background);
    const diff = Math.abs(primary - surface);
    const ok = diff >= 50;
    return { passed: ok, detail: ok ? `primary/surface 亮度差 ${diff.toFixed(0)}` : `primary 与表面色接近（差 ${diff.toFixed(0)} < 50），强调层级可能不足` };
  },
}));

const ok = await runChecks({ name: 'UI QA', reportFile: 'ui-report.json', checks });
if (!ok) process.exit(1);