/**
 * 连通域级别的判定谓词:一个额外的不透明"岛"到底是生成残留、邻格渗色,还是真实的第二个主体。
 * 外加两个被整条链共用的几何小工具(`indexOf` / `axisGap`)。
 *
 * `indexOf` 是 `y * width + x`,即**行主序**。mask / labels / raw RGBA 三个数组都按这个下标walk,
 * analyzeAlpha 与 measureBorderContactRuns 也共用它。改这里而不改遍历顺序,得到的是静默错位的
 * 边界统计,而不是报错。
 *
 * `looksLikeNeighbourBleed` 有**两个**调用点:analyzeAlpha 的"擦除决策"和 classifyFrameFindings 的
 * "评级"。所以它落在两者共同的下游,而不是塞进任何一方。复制成两份的后果很具体:slot 里按 A 判据
 * 擦掉的 sliver,到了整张 atlas 上按 B 判据又被算成硬错误,整张图判废。
 *
 * 谓词之间的**豁免范围不一样**,这是 analyzeAlpha 里那对括号的含义,不要在重构中"对齐":
 *  - `allowAuxiliaryForegroundComponents` 只豁免 line / speck / partial-duplicate 三个;
 *  - `isDetachedLayoutGuideResidue` **无条件**过滤(模型画出来的整框布局辅助线,任何配置下都不是主体);
 *  - `detachedDuplicateFragmentLabels` 只在**未**开启 auxiliary 时才计算。
 *
 * 各谓词里的 0.02 / 0.14 / 0.25 / 0.32 / 0.45 / 0.65 都是按真实残留标定的比例,含义写在各自函数里。
 * `detachedDuplicateFragmentLabels` 返回的是 label 集合而不是布尔:它判的是"一组"碎片(≥2 个、
 * 同侧、纵向铺开)整体像被切下来的第二个主体,单个碎片看不出来。
 *
 * 依赖方向:只依赖 extraction-types.js。types → **components** → alpha → findings → extraction.ts。
 */

import { FRAME_TOLERANCE } from "./extraction-types.js";
import type { ForegroundComponentDiagnostics, PixelBounds } from "./extraction-types.js";

export interface AlphaComponent {
  readonly label: number;
  readonly pixels: number;
  readonly bounds: PixelBounds;
  readonly edgePixels: number;
}

export function indexOf(x: number, y: number, width: number): number {
  return y * width + x;
}

export function axisGap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (aEnd < bStart) return bStart - aEnd - 1;
  if (bEnd < aStart) return aStart - bEnd - 1;
  return 0;
}

export function isDetachedLineResidue(
  component: AlphaComponent,
  primary: AlphaComponent,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (component.label === primary.label || component.edgePixels > 0) return false;
  if (component.pixels > primary.pixels * 0.02) return false;

  const shortSide = Math.min(component.bounds.width, component.bounds.height);
  const longSide = Math.max(component.bounds.width, component.bounds.height);
  const canvasShortSide = Math.min(canvasWidth, canvasHeight);
  if (shortSide > Math.max(3, Math.floor(canvasShortSide * 0.025))) return false;
  if (longSide > Math.max(12, Math.floor(canvasShortSide * 0.12))) return false;
  if (longSide / shortSide < 3) return false;

  const horizontalGap = axisGap(
    component.bounds.left,
    component.bounds.right,
    primary.bounds.left,
    primary.bounds.right,
  );
  const verticalGap = axisGap(
    component.bounds.top,
    component.bounds.bottom,
    primary.bounds.top,
    primary.bounds.bottom,
  );
  return Math.max(horizontalGap, verticalGap) >= Math.max(3, Math.floor(canvasShortSide * 0.008));
}

export function isDetachedSpeckResidue(
  component: AlphaComponent,
  primary: AlphaComponent,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (component.label === primary.label || component.edgePixels > 0) return false;
  if (component.pixels > primary.pixels * 0.005) return false;

  const shortSide = Math.min(component.bounds.width, component.bounds.height);
  const longSide = Math.max(component.bounds.width, component.bounds.height);
  const canvasShortSide = Math.min(canvasWidth, canvasHeight);
  const maximumSide = Math.max(8, Math.floor(canvasShortSide * 0.04));
  if (longSide > maximumSide || longSide / shortSide > 2) return false;

  const fillRatio = component.pixels / (component.bounds.width * component.bounds.height);
  if (fillRatio < 0.3) return false;

  const horizontalGap = axisGap(
    component.bounds.left,
    component.bounds.right,
    primary.bounds.left,
    primary.bounds.right,
  );
  const verticalGap = axisGap(
    component.bounds.top,
    component.bounds.bottom,
    primary.bounds.top,
    primary.bounds.bottom,
  );
  return Math.max(horizontalGap, verticalGap) >= Math.max(5, Math.floor(canvasShortSide * 0.025));
}

export function isDetachedPartialDuplicateResidue(
  component: AlphaComponent,
  primary: AlphaComponent,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (component.label === primary.label || component.edgePixels > 0) return false;

  const pixelRatio = component.pixels / primary.pixels;
  const widthRatio = component.bounds.width / primary.bounds.width;
  const heightRatio = component.bounds.height / primary.bounds.height;
  if (pixelRatio < 0.25 || pixelRatio > 0.65
    || widthRatio < 0.75 || widthRatio > 1.2
    || heightRatio < 0.3 || heightRatio > 0.65) {
    return false;
  }

  const primaryCenterX = primary.bounds.left + (primary.bounds.width - 1) / 2;
  const componentCenterX = component.bounds.left + (component.bounds.width - 1) / 2;
  if (Math.abs(primaryCenterX - componentCenterX) > primary.bounds.width * 0.15) return false;

  const horizontalGap = axisGap(
    component.bounds.left,
    component.bounds.right,
    primary.bounds.left,
    primary.bounds.right,
  );
  const verticalGap = axisGap(
    component.bounds.top,
    component.bounds.bottom,
    primary.bounds.top,
    primary.bounds.bottom,
  );
  const canvasShortSide = Math.min(canvasWidth, canvasHeight);
  return horizontalGap === 0
    && verticalGap >= Math.max(5, Math.floor(canvasShortSide * 0.025))
    && verticalGap <= primary.bounds.height * 0.35;
}

export function isDetachedLayoutGuideResidue(
  component: AlphaComponent,
  primary: AlphaComponent,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (component.label === primary.label || component.edgePixels > 0) return false;
  if (component.pixels > primary.pixels * 0.25) return false;
  if (component.bounds.width < canvasWidth * 0.75 || component.bounds.height < canvasHeight * 0.75) return false;
  const fillRatio = component.pixels / (component.bounds.width * component.bounds.height);
  if (fillRatio > 0.08) return false;
  return component.bounds.left < primary.bounds.left
    && component.bounds.right > primary.bounds.right
    && component.bounds.top < primary.bounds.top
    && component.bounds.bottom > primary.bounds.bottom;
}

export function detachedDuplicateFragmentLabels(
  components: readonly AlphaComponent[],
  primary: AlphaComponent,
  canvasWidth: number,
): ReadonlySet<number> {
  const minimumGap = Math.max(
    8,
    Math.floor(canvasWidth * 0.06),
    Math.floor(primary.bounds.width * 0.18),
  );
  const candidates = components.filter((component) => (
    component.label !== primary.label
    && component.edgePixels === 0
    && component.pixels <= primary.pixels * 0.14
    && component.bounds.width <= primary.bounds.width * 0.65
    && component.bounds.height <= primary.bounds.height * 0.45
  ));
  const groups = [
    candidates.filter((component) => component.bounds.left - primary.bounds.right - 1 >= minimumGap),
    candidates.filter((component) => primary.bounds.left - component.bounds.right - 1 >= minimumGap),
  ];
  for (const group of groups) {
    if (group.length < 2) continue;
    const totalPixels = group.reduce((sum, component) => sum + component.pixels, 0);
    if (totalPixels > primary.pixels * 0.32) continue;
    const top = Math.min(...group.map((component) => component.bounds.top));
    const bottom = Math.max(...group.map((component) => component.bounds.bottom));
    if (bottom - top + 1 < primary.bounds.height * 0.28) continue;
    return new Set(group.map((component) => component.label));
  }
  return new Set();
}

/**
 * Does this extra island look like a neighbouring pose bleeding over the slot
 * boundary rather than a defect in this pose?
 *
 * Slot boundaries are arithmetic divisions of the source board with no printed
 * gutter, so a wide adjacent pose commonly leaves a shallow sliver against the
 * shared border. A genuine second subject, a severed limb or a stray effect
 * either sits away from the border or is far too large to qualify.
 *
 * A match is erased from the slot (see `dropNeighbourBleed`), not just demoted:
 * carrying it forward widens the crop and hands the assembled atlas a second
 * component that no longer looks like bleed, which fails the whole sheet.
 */
export function looksLikeNeighbourBleed(
  component: ForegroundComponentDiagnostics,
  primary: ForegroundComponentDiagnostics,
  slotWidth: number,
  slotHeight: number,
): boolean {
  if (component === primary || component.edgePixels === 0 || primary.pixels === 0) return false;
  if (component.pixels > primary.pixels * FRAME_TOLERANCE.maxBleedComponentFraction) return false;
  const depths: number[] = [];
  if (component.bounds.left === 0) depths.push(component.bounds.right + 1);
  if (component.bounds.right === slotWidth - 1) depths.push(slotWidth - component.bounds.left);
  if (component.bounds.top === 0) depths.push(component.bounds.bottom + 1);
  if (component.bounds.bottom === slotHeight - 1) depths.push(slotHeight - component.bounds.top);
  if (depths.length === 0) return false;
  const horizontalLimit = slotWidth * FRAME_TOLERANCE.maxBleedComponentDepthFraction;
  const verticalLimit = slotHeight * FRAME_TOLERANCE.maxBleedComponentDepthFraction;
  return Math.min(...depths) <= Math.max(horizontalLimit, verticalLimit);
}
