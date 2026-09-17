import { PET_BUBBLE_ZONE } from '../../shared/contracts';

/**
 * 顶部气泡区（0 ~ PET_BUBBLE_ZONE）是留给气泡的透明留白：真实用户点那里不触发桌宠互动。
 * 程序化 click 事件的 isTrusted 为 false，不受此限制，e2e 探针仍可正常点击桌宠。
 */
export function inBubbleZone(clientY: number, isTrusted: boolean, zone: number = PET_BUBBLE_ZONE): boolean {
  return isTrusted && clientY < zone;
}
