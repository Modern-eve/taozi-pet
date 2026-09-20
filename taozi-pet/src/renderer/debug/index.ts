import type { DebugOverlayPayload } from '../../shared/contracts';
import { PET_BUBBLE_ZONE } from '../../shared/contracts';
import './index.css';

/**
 * 调试叠加层：把主进程算好的 DebugOverlayPayload 画成屏幕坐标下的辅助线。
 * 窗口本身就等于工作区，因此绘制坐标 = 屏幕坐标 - 工作区原点。
 * 只读取主进程推来的数据，不发起任何 IPC（窗口不注册角色，只负责显示）。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const overlay = document.getElementById('overlay') as unknown as SVGSVGElement;

const COLORS = {
  petWindow: 'rgba(255, 255, 255, 0.55)',
  character: '#34d399',
  characterFill: 'rgba(52, 211, 153, 0.14)',
  bubbleZone: 'rgba(251, 191, 36, 0.5)',
  bubble: '#fbbf24',
  snapFill: 'rgba(56, 189, 248, 0.10)',
  snapLine: '#38bdf8',
  cursorLine: '#f59e0b',
  walkLine: '#a78bfa',
  walkFill: 'rgba(167, 139, 250, 0.07)',
};

function make(tag: keyof SVGElementTagNameMap, attrs: Record<string, string | number>, text?: string): void {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  overlay.appendChild(node);
}

function label(x: number, y: number, text: string, anchor: 'start' | 'end' | 'middle' = 'start', color = '#ffffff'): void {
  make('text', { x: Math.round(x), y: Math.round(y), 'text-anchor': anchor, class: 'overlay-label', fill: color }, text);
}

/** 左右两侧的吸附判定带：实线 = 窗口缘判定线，虚线 = 松手光标判定线（两条都随桌宠尺寸正比）。 */
function drawSnapBands(payload: DebugOverlayPayload, width: number, height: number): void {
  const { enabled, band, cursorBand } = payload.snap;
  if (!enabled) {
    label(14, 26, '边缘吸附：已关闭');
    return;
  }
  for (const side of ['left', 'right'] as const) {
    const start = side === 'left' ? 0 : width - band;
    const bandEdge = side === 'left' ? band : width - band;
    const cursorEdge = side === 'left' ? cursorBand : width - cursorBand;
    const textAnchor = side === 'left' ? 'start' : 'end';
    make('rect', { x: start, y: 0, width: band, height, fill: COLORS.snapFill });
    make('line', { x1: bandEdge, y1: 0, x2: bandEdge, y2: height, stroke: COLORS.snapLine, 'stroke-width': 2 });
    label(side === 'left' ? bandEdge + 8 : bandEdge - 8, 26, `窗口缘判定 ${band}px`, textAnchor);
    make('line', {
      x1: cursorEdge, y1: 0, x2: cursorEdge, y2: height,
      stroke: COLORS.cursorLine, 'stroke-width': 1.5, 'stroke-dasharray': '6 5',
    });
    label(side === 'left' ? cursorEdge + 8 : cursorEdge - 8, 46, `光标判定 ${cursorBand}px`, textAnchor);
  }
}

/** 随机行走范围：圆心为行走中心（画在桌宠身体中心上），半径取当前挡位的 range。 */
function drawWalkRange(payload: DebugOverlayPayload, origin: { x: number; y: number }): void {
  const { enabled, level, radius, center } = payload.walk;
  if (!enabled || !radius) {
    label(14, 66, `随机行走范围：无（挡位 ${level}）`);
    return;
  }
  const cx = center.x - origin.x;
  const cy = center.y - origin.y;
  make('circle', {
    cx, cy, r: radius,
    fill: COLORS.walkFill, stroke: COLORS.walkLine, 'stroke-width': 1.5, 'stroke-dasharray': '8 6',
  });
  make('line', { x1: cx - 10, y1: cy, x2: cx + 10, y2: cy, stroke: COLORS.walkLine, 'stroke-width': 1.5 });
  make('line', { x1: cx, y1: cy - 10, x2: cx, y2: cy + 10, stroke: COLORS.walkLine, 'stroke-width': 1.5 });
  label(cx + 12, cy - 10, `行走范围 半径 ${radius}px（挡位 ${level}）`, 'start', COLORS.walkLine);
}

/**
 * 尺寸标注：桌宠窗口、气泡区、人物可见范围、气泡实际盒子。
 * 桌宠大小与气泡大小都写成数值，方便直接读出来核对布局。
 */
function drawSizes(payload: DebugOverlayPayload, origin: { x: number; y: number }): void {
  const petX = payload.pet.x - origin.x;
  const petY = payload.pet.y - origin.y;
  const petSize = payload.pet.height - PET_BUBBLE_ZONE;
  make('rect', {
    x: petX, y: petY, width: payload.pet.width, height: payload.pet.height,
    fill: 'none', stroke: COLORS.petWindow, 'stroke-width': 1, 'stroke-dasharray': '4 4',
  });
  // 气泡区：窗口顶部预留的固定高度，气泡无论多长都长在这一条里
  make('rect', {
    x: petX, y: petY, width: payload.pet.width, height: PET_BUBBLE_ZONE,
    fill: 'none', stroke: COLORS.bubbleZone, 'stroke-width': 1, 'stroke-dasharray': '4 4',
  });
  const characterX = payload.character.left - origin.x;
  make('rect', {
    x: characterX, y: petY, width: payload.character.width, height: payload.pet.height,
    fill: COLORS.characterFill, stroke: COLORS.character, 'stroke-width': 1,
  });
  label(characterX, petY - 30, `人物 ${payload.character.width}px`, 'start', COLORS.character);
  const bubble = payload.bubble;
  if (!bubble) {
    label(petX, petY + PET_BUBBLE_ZONE / 2, '气泡：未显示', 'start', COLORS.bubble);
    return;
  }
  make('rect', {
    x: bubble.left - origin.x, y: bubble.top - origin.y, width: bubble.width, height: bubble.height,
    fill: 'rgba(251, 191, 36, 0.12)', stroke: COLORS.bubble, 'stroke-width': 2,
  });
  label(
    bubble.left - origin.x,
    bubble.top - origin.y - 8,
    `气泡 ${Math.round(bubble.width)}×${Math.round(bubble.height)}px`,
    'start',
    COLORS.bubble,
  );
}

function render(payload: DebugOverlayPayload): void {
  const { workArea } = payload;
  overlay.replaceChildren(); // 节点少，整体重画比逐点更新更简单可靠
  overlay.setAttribute('viewBox', `0 0 ${workArea.width} ${workArea.height}`);
  if (!payload.visible) return;
  const origin = { x: workArea.x, y: workArea.y };
  drawSnapBands(payload, workArea.width, workArea.height);
  drawWalkRange(payload, origin);
  drawSizes(payload, origin);
  const petSize = payload.pet.height - PET_BUBBLE_ZONE;
  const scale = `${Math.round(payload.scale * 100)}%`;
  label(
    workArea.width / 2,
    26,
    `桌宠 ${petSize}px（缩放 ${scale}）｜ 气泡区 ${payload.pet.width}×${PET_BUBBLE_ZONE}px ｜ 贴边：${payload.snap.side ?? '未贴边'}`,
    'middle',
  );
}

window.petAPI?.events.onDebugOverlay(render);
