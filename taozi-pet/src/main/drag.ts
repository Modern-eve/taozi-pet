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

export function snapBounds(bounds: Rect, workArea: Rect): Rect {
  const snapThreshold = 20;
  let { x } = bounds;
  const { y } = bounds;

  // 左边贴边
  if (Math.abs(bounds.x - workArea.x) < snapThreshold) {
    x = workArea.x;
  }
  // 右边贴边
  if (Math.abs(bounds.x + bounds.width - (workArea.x + workArea.width)) < snapThreshold) {
    x = workArea.x + workArea.width - bounds.width;
  }
  // 上下边缘不吸附，仅左右

  return { x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height };
}
