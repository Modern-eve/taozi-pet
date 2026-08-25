import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { makeCheck, blockDecl, hasProps, runChecks, loadSpec, PROJECT_ROOT } from './qa-common.mjs';

const spec = await loadSpec();
const files = {
  main: await readFile(path.join(PROJECT_ROOT, 'src', 'main.ts'), 'utf8'),
  dashboardCss: await readFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'dashboard', 'index.css'), 'utf8'),
  dashboardHtml: await readFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'dashboard', 'index.html'), 'utf8'),
  petCss: await readFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'pet', 'index.css'), 'utf8'),
};

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
  describe: 'CSS 气泡区高度与主进程 PET_BUBBLE_ZONE 一致',
  run: () => {
    const cssMatch = files.petCss.match(/--pet-bubble-zone:\s*(\d+)px/);
    const mainMatch = files.main.match(/PET_BUBBLE_ZONE\s*=\s*(\d+)/);
    const ok = Boolean(cssMatch && mainMatch) && cssMatch[1] === mainMatch[1] && cssMatch[1] === '110';
    return { passed: ok, detail: ok ? `CSS=${cssMatch[1]}px 主进程=${mainMatch[1]}` : `CSS=${cssMatch?.[1]}px 主进程=${mainMatch?.[1]}px 不一致` };
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

// ---- tray ----
checks.push(makeCheck({
  id: 'png-tray-runtime',
  gate: 'src',
  describe: '托盘加载打包 PNG、拒绝空图',
  run: () => {
    const ok = files.main.includes('path.resolve(__dirname, trayIconPath)') && files.main.includes('nativeImage.createFromPath') && files.main.includes('.isEmpty()') && !files.main.includes('createFromDataURL');
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
    const systemEmojis = ['⏰', '🏠', '🖱️', '🙈', '🐾', '🚪'].every((emoji) => files.main.includes(emoji));
    const interactionEmojis = (spec.experience?.interactions ?? []).every((it) => typeof it.emoji === 'string' && it.emoji.length > 0);
    const ok = systemEmojis && interactionEmojis;
    return { passed: ok, detail: ok ? '菜单 emoji 齐全' : '缺少系统或互动菜单 emoji' };
  },
}));

const ok = await runChecks({ name: 'UI QA', reportFile: 'ui-report.json', checks });
if (!ok) process.exit(1);