import type { BubbleBox, ClickZoneBox, ClickZoneSpec, DebugOverlayPayload, SnapSide } from '../shared/contracts';
import { PET_BUBBLE_ZONE } from '../shared/contracts';
import type { Point, Rect } from './drag';

/**
 * 调试叠加层的绘制数据入参：几何、判定带、行走范围都由主进程算好，
 * 这里只做屏幕坐标换算（不碰 Electron，便于单测）。
 */
export interface DebugOverlayInput {
  visible: boolean;
  workArea: Rect;
  pet: Rect;
  /** 桌宠缩放档位（settings.petScale） */
  scale: number;
  /** 人物可见宽度 = petSize × petSizing.contentWidthRatio */
  characterWidth: number;
  /** 贴边基准框宽度 = max(人物可见宽度, 本次贴边将要播报的语录气泡宽度)，见 petSnapWidth */
  snapWidth: number;
  /** 气泡实际盒子（桌宠窗口内坐标）；未显示气泡时为 null */
  bubble: BubbleBox | null;
  /** 点击热点区声明（spec.experience.clickZone），坐标相对精灵方框归一化 */
  clickZones: Record<string, ClickZoneSpec>;
  snapEnabled: boolean;
  snapSide: SnapSide;
  snapBand: number;
  cursorBand: number;
  walkEnabled: boolean;
  walkLevel: number;
  walkRadius: number | null;
  /** 随机行走的中心锚点（窗口左上角的坐标，与 random-walk.ts 的判定一致） */
  walkAnchor: Point;
}

export function debugOverlayLayout(input: DebugOverlayInput): DebugOverlayPayload {
  const characterLeft = characterLeftOf(input);
  const sprite = spriteFrameOf(input.pet);
  return {
    visible: input.visible,
    workArea: input.workArea,
    pet: input.pet,
    scale: input.scale,
    character: { left: characterLeft, width: input.characterWidth },
    sprite,
    clickZones: clickZoneBoxes(input.clickZones, sprite),
    // 气泡盒子上报的是窗口内坐标，叠加层画在屏幕上要加上窗口原点
    bubble: input.bubble
      ? {
        left: input.pet.x + input.bubble.left,
        top: input.pet.y + input.bubble.top,
        width: input.bubble.width,
        height: input.bubble.height,
      }
      : null,
    snap: {
      enabled: input.snapEnabled,
      side: input.snapSide,
      band: input.snapBand,
      cursorBand: input.cursorBand,
    },
    walk: {
      enabled: input.walkEnabled,
      level: input.walkLevel,
      radius: input.walkRadius,
      // 锚点约束的是窗口左上角；画在桌宠身体中心上，圆圈与桌宠的相对关系才与实际观感一致
      center: bodyCenter(input.pet, characterLeft, input.characterWidth),
    },
  };
}

/**
 * 人物可见范围的左缘：未贴边时居中于窗口；贴边时基准框压在屏幕边缘，人物再按「基准框宽于人物」的内缩量落在框内。
 */
function characterLeftOf(input: DebugOverlayInput): number {
  const inset = Math.round((input.snapWidth - input.characterWidth) / 2);
  if (input.snapSide === 'left') return input.workArea.x + inset;
  if (input.snapSide === 'right') {
    return input.workArea.x + input.workArea.width - input.characterWidth - inset;
  }
  return Math.round(input.pet.x + (input.pet.width - input.characterWidth) / 2);
}

/** 桌宠身体（精灵，不含顶部气泡区）的中心：横向用人物可见范围的中心，纵向取窗口底部的方形区域。 */
function bodyCenter(pet: Rect, characterLeft: number, characterWidth: number): Point {
  const spriteSize = Math.max(0, pet.height - PET_BUBBLE_ZONE);
  return {
    x: Math.round(characterLeft + characterWidth / 2),
    y: Math.round(pet.y + pet.height - spriteSize / 2),
  };
}

/**
 * 精灵方框：贴底的正方形，边长 = 窗口高 - 气泡区高。
 * 横向由 CSS 的居中裁剪决定，与窗口宽无关——精灵宽于窗口时两侧对称溢出。
 */
function spriteFrameOf(pet: Rect): DebugOverlayPayload['sprite'] {
  const size = Math.max(0, pet.height - PET_BUBBLE_ZONE);
  return { left: pet.x + (pet.width - size) / 2, top: pet.y + PET_BUBBLE_ZONE, size };
}

/** 把每个热点区的归一化坐标乘到精灵方框上，得到叠加层直接可画的屏幕矩形。 */
function clickZoneBoxes(
  zones: Record<string, ClickZoneSpec>,
  sprite: DebugOverlayPayload['sprite'],
): ClickZoneBox[] {
  return Object.entries(zones).map(([id, zone]) => ({
    id,
    stateId: zone.stateId,
    rect: {
      left: sprite.left + zone.x * sprite.size,
      top: sprite.top + zone.y * sprite.size,
      width: zone.width * sprite.size,
      height: zone.height * sprite.size,
    },
  }));
}
