import type { SnapSide } from '../shared/contracts';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function exceedsDragThreshold(start: Point, current: Point, threshold = 4): boolean {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  return Math.hypot(dx, dy) >= threshold;
}

export function draggedBounds(startBounds: Rect, startCursor: Point, currentCursor: Point): Rect {
  const dx = currentCursor.x - startCursor.x;
  const dy = currentCursor.y - startCursor.y;
  return {
    x: Math.round(startBounds.x + dx),
    y: Math.round(startBounds.y + dy),
    width: startBounds.width,
    height: startBounds.height,
  };
}

/** 基准框缘判定带（px）：贴边基准框的边缘进入该范围即判定贴边。 */
export const SNAP_BAND_PX = 20;
/** 松手光标判定带（px）：光标进入该范围即视为有贴边意图。 */
export const CURSOR_BAND_PX = 50;

/**
 * 松手时判定贴边侧：以【贴边基准框】为基准——基准框左右缘进入 SNAP_BAND_PX 内，或光标进入 CURSOR_BAND_PX 内。
 * 基准框宽度取人物可见宽度与本次贴边将要播报的语录气泡宽度的宽者（见 petSnapWidth），不拿窗口缘判：
 * 窗口宽度有气泡区最小宽度兜底，随人物缩放变化的成分很小。
 * 光标带补齐意图——抓取点常在角色中心，光标顶到屏边时基准框缘可能还离得很远。
 * 两侧同时命中（判定带比工作区还宽）时视为未贴边，避免贴到随机一侧。
 */
export function classifySnapSide(reference: Rect, workArea: Rect, cursor?: Point): SnapSide {
  const workRight = workArea.x + workArea.width;
  const atLeft = reference.x <= workArea.x + SNAP_BAND_PX
    || (cursor !== undefined && cursor.x <= workArea.x + CURSOR_BAND_PX);
  const atRight = reference.x + reference.width >= workRight - SNAP_BAND_PX
    || (cursor !== undefined && cursor.x >= workRight - CURSOR_BAND_PX);
  if (atLeft === atRight) return null;
  return atLeft ? 'left' : 'right';
}

/**
 * 贴边位置：把窗口向屏外过冲 referenceInset，使【贴边基准框】的左右缘正好落在工作区左右缘。
 * 基准框宽度 referenceWidth 在窗口内水平居中；它宽于人物可见宽度时（见 petSnapWidth），
 * 人物会随之停在离屏边一段距离处——这一段就是留给气泡的，避免气泡被顶出屏幕。
 * 上下边缘不吸附，仅左右。
 */
export function snappedBounds(
  bounds: Rect, workArea: Rect, side: SnapSide, referenceInset = 0, referenceWidth = bounds.width,
): Rect {
  const workRight = workArea.x + workArea.width;
  const x = side === 'left'
    ? workArea.x - referenceInset
    : side === 'right'
      ? workRight - referenceWidth - referenceInset
      : bounds.x;
  return { x: Math.round(x), y: Math.round(bounds.y), width: bounds.width, height: bounds.height };
}
