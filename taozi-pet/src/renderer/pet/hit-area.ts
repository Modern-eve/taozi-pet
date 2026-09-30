import { PET_BUBBLE_ZONE } from '../../shared/contracts';

/** 归一化矩形（均相对精灵帧边长，原点为帧左上角）。 */
export interface ZoneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 精灵帧内某个位置是否落在指定区域。
 * clientX / clientY 相对精灵可见范围的左上角，frameSize 为精灵边长；
 * 区域按帧边长归一化存放，因此窗口缩放、人物大小变更都不影响命中。
 */
export function inZone(
  clientX: number,
  clientY: number,
  zone: ZoneRect,
  frameSize: { left: number; top: number; size: number },
): boolean {
  if (frameSize.size <= 0) return false;
  const nx = (clientX - frameSize.left) / frameSize.size;
  const ny = (clientY - frameSize.top) / frameSize.size;
  return nx >= zone.x && nx <= zone.x + zone.width && ny >= zone.y && ny <= zone.y + zone.height;
}

/** 顶部气泡区（0 ~ PET_BUBBLE_ZONE）是留给气泡的透明留白：真实用户点那里不触发桌宠互动。
 * 程序化 click 事件的 isTrusted 为 false，不受此限制，e2e 探针仍可正常点击桌宠。 */
export function inBubbleZone(clientY: number, isTrusted: boolean, zone: number = PET_BUBBLE_ZONE): boolean {
  return isTrusted && clientY < zone;
}
