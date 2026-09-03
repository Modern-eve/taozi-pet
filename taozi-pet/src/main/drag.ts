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

export function snapBounds(bounds: Rect, workArea: Rect, spriteInset = 0, spriteWidth = bounds.width): Rect {
  const snapBand = 20;
  let { x } = bounds;
  const { y } = bounds;
  const workRight = workArea.x + workArea.width;

  // 以【精灵】(而非整窗)为基准贴边：窗口比精灵宽时精灵在窗口内水平居中，
  // 精灵左缘相对窗口左缘有 spriteInset 偏移，故吸附目标需把窗口往屏外多移 spriteInset，
  // 让精灵左右缘正好落在 workArea 左右缘（窗口可透明过冲到屏外，不影响显示）。
  // 用方向性判断（≤ / ≥）而非 abs 差值，才能把因拖拽抓取点在角色中心、
  // 光标顶到屏边时过冲到屏外（bounds.x 为负）的窗口正确判定为贴边。
  if (bounds.x <= workArea.x + snapBand) {
    x = workArea.x - spriteInset;
  }
  // 右边贴边：使精灵右缘落在 workArea 右缘
  else if (bounds.x + bounds.width >= workRight - snapBand) {
    x = workRight - spriteWidth - spriteInset;
  }
  // 上下边缘不吸附，仅左右

  return { x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height };
}
