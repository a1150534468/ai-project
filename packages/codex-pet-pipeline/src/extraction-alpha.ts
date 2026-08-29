/**
 * 逐帧 alpha 分析:整条抽取链**唯一逐像素读图**的地方。产出 `AlphaAnalysis` 这一份"事实",
 * 不做任何 strict/tolerant 评级(评级在 extraction-findings.ts)。这条分工是刻意的:同一份事实
 * 要同时喂给 extractPoseBoard 和 inspectFrame 两个入口,评级规则却只归一处调。
 *
 * `AlphaAnalysis` 字段的语义有几处只在这里成立:
 *  - `cleanedImage` 只有**真的删掉了像素**时才非 null,调用方一律写成 `cleanedImage ?? 原图`。
 *    永远返回一张图会让每个 slot 多一次 PNG 编码。
 *  - `removedBleedComponentCount` 是被擦掉的 sliver 的**唯一痕迹** —— 它们已经从 bounds、
 *    opaquePixels、components 里全部消失,调用方只能靠这个计数报 finding。
 *  - `bounds` 为 null 表示这一帧没有前景。
 *
 * 两个早退点(`rawOpaquePixels === 0` 和过滤后的 `opaquePixels === 0`)**都**必须返回
 * `emptyAlphaAnalysis()`。少一个,后面按 bounds 求比例的地方会拿到 null 或 0 除数,得到 NaN 比例,
 * 然后 NaN 与阈值的比较恒为 false —— 表现是"空帧静默通过"。
 *
 * `dropNeighbourBleed` 只对**原始 slot** 有意义:slot 边界是与相邻姿态共享的算术分割线,没有印刷
 * 间隙。归一化后的 cell 四周有 padding,那里碰到边界的东西是真实溢出,该由安全边距检查报错。在 cell
 * 上打开这个开关,等于把真实缺陷当渗色擦掉。
 *
 * `measureBorderContactRuns` 按 **label** 而不是合并 mask 测量。原因写在函数注释里:一条压在边界上的
 * 邻格 sliver 会让合并 mask 报出一段长 run,把组件规则刚降级掉的边界错误又抬回来。别"优化"成对
 * 合并 mask 求最长 run。
 *
 * 过滤顺序不能动:候选 → 残留谓词(line/speck/partial-duplicate/layout-guide/duplicate-fragment)
 * → 渗色擦除 → 辅助组件契约校验。辅助校验必须发生在擦除**之后**,否则一条注定被擦掉的 sliver 会
 * 先把 auxiliary 计数顶爆。
 *
 * 依赖方向:types + components。types → components → **alpha** → findings → extraction.ts。
 */

import sharp from "sharp";
import type {
  BorderContactRuns,
  EnclosedRegionDiagnostics,
  ForegroundComponentDiagnostics,
  PixelBounds,
} from "./extraction-types.js";
import {
  axisGap,
  detachedDuplicateFragmentLabels,
  indexOf,
  isDetachedLayoutGuideResidue,
  isDetachedLineResidue,
  isDetachedPartialDuplicateResidue,
  isDetachedSpeckResidue,
  looksLikeNeighbourBleed,
  type AlphaComponent,
} from "./extraction-components.js";

export interface AlphaAnalysis {
  readonly bounds: PixelBounds | null;
  readonly opaquePixels: number;
  readonly edgePixels: number;
  readonly componentCount: number;
  readonly internalTransparentPixels: number;
  readonly borderContactRuns: BorderContactRuns;
  readonly enclosedRegions: readonly EnclosedRegionDiagnostics[];
  readonly components: readonly ForegroundComponentDiagnostics[];
  /**
   * Neighbour-bleed slivers erased under `dropNeighbourBleed`. They are gone
   * from every other field, so the caller reports the finding from this count.
   */
  readonly removedBleedComponentCount: number;
  /** Hard failures raised by the bounded auxiliary-component contract. */
  readonly auxiliaryComponentErrors: readonly string[];
  /** Source image with only proven detached generation residue removed. */
  readonly cleanedImage: Buffer | null;
}

const NO_BORDER_CONTACT: BorderContactRuns = { left: 0, right: 0, top: 0, bottom: 0 };

function emptyAlphaAnalysis(): AlphaAnalysis {
  return {
    bounds: null,
    opaquePixels: 0,
    edgePixels: 0,
    componentCount: 0,
    internalTransparentPixels: 0,
    borderContactRuns: NO_BORDER_CONTACT,
    enclosedRegions: [],
    components: [],
    removedBleedComponentCount: 0,
    auxiliaryComponentErrors: [],
    cleanedImage: null,
  };
}

/** Longest run of set mask values along one border walk. */
function longestRun(length: number, isSet: (offset: number) => boolean): number {
  let longest = 0;
  let current = 0;
  for (let offset = 0; offset < length; offset += 1) {
    current = isSet(offset) ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/**
 * Longest border contact run of the primary subject. Measured per label rather
 * than on the merged mask: a neighbour-bleed sliver sitting on a border would
 * otherwise report a long run and re-raise the edge error that the component
 * rule just demoted, failing the frame for pixels nobody objects to.
 */
function measureBorderContactRuns(
  labels: Int32Array,
  primaryLabel: number,
  width: number,
  height: number,
): BorderContactRuns {
  const belongs = (index: number) => labels[index] === primaryLabel;
  return {
    left: longestRun(height, (y) => belongs(indexOf(0, y, width))),
    right: longestRun(height, (y) => belongs(indexOf(width - 1, y, width))),
    top: longestRun(width, (x) => belongs(indexOf(x, 0, width))),
    bottom: longestRun(width, (x) => belongs(indexOf(x, height - 1, width))),
  };
}

export interface AnalyzeAlphaOptions {
  readonly minAlpha?: number;
  readonly allowAuxiliaryForegroundComponents?: boolean;
  /**
   * Erase shallow neighbour-bleed slivers instead of merely retaining them.
   *
   * Only meaningful for a raw board slot, where the slot border is an arithmetic
   * division shared with the adjacent pose. A retained sliver would otherwise
   * widen `bounds`, skew the row's shared scale and survive into the atlas cell,
   * where — now sitting away from the cell border — it no longer matches the
   * bleed signature and re-raises as a hard error on the assembled sheet.
   */
  readonly dropNeighbourBleed?: boolean;
}

function validateAuxiliaryComponents(
  components: readonly AlphaComponent[],
  primary: AlphaComponent,
  canvasWidth: number,
  canvasHeight: number,
): readonly string[] {
  const auxiliary = components.filter((component) => component.label !== primary.label);
  if (auxiliary.length === 0) return [];
  const errors = new Set<string>();
  if (auxiliary.length > 4) errors.add("auxiliary-component-count-exceeded");
  const maximumGap = Math.max(
    Math.min(canvasWidth, canvasHeight) * 0.2,
    Math.min(primary.bounds.width, primary.bounds.height) * 0.35,
  );
  const totalPixels = auxiliary.reduce((total, component) => total + component.pixels, 0);
  if (totalPixels > primary.pixels * 0.65) errors.add("auxiliary-components-too-large");

  for (const component of auxiliary) {
    if (component.edgePixels > 0) errors.add("auxiliary-component-touches-edge");
    if (component.pixels > primary.pixels * 0.45
      || component.bounds.width > primary.bounds.width * 1.25
      || component.bounds.height > primary.bounds.height * 0.65) {
      errors.add("auxiliary-component-too-large");
    }
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
    if (Math.hypot(horizontalGap, verticalGap) > maximumGap) {
      errors.add("auxiliary-component-too-far");
    }
    if (isDetachedPartialDuplicateResidue(component, primary, canvasWidth, canvasHeight)) {
      errors.add("auxiliary-component-resembles-partial-subject");
    }
  }
  return [...errors];
}

export async function analyzeAlpha(input: Buffer, options: AnalyzeAlphaOptions = {}): Promise<AlphaAnalysis> {
  const minAlpha = options.minAlpha ?? 24;
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const mask = new Uint8Array(width * height);
  let rawOpaquePixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(indexOf(x, y, width) * info.channels) + 3]!;
      if (alpha < minAlpha) continue;
      mask[indexOf(x, y, width)] = 1;
      rawOpaquePixels += 1;
    }
  }
  if (rawOpaquePixels === 0) return emptyAlphaAnalysis();

  const visited = new Uint8Array(mask.length);
  const labels = new Int32Array(mask.length);
  const retainedMask = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const componentFloor = Math.max(12, Math.floor(rawOpaquePixels * 0.001));
  const components: AlphaComponent[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const seed = indexOf(x, y, width);
      if (!mask[seed] || visited[seed]) continue;
      let head = 0;
      let tail = 0;
      let componentLeft = width;
      let componentRight = -1;
      let componentTop = height;
      let componentBottom = -1;
      let componentEdgePixels = 0;
      const label = components.length + 1;
      queue[tail++] = seed;
      visited[seed] = 1;
      labels[seed] = label;
      while (head < tail) {
        const current = queue[head++]!;
        const cx = current % width;
        const cy = Math.floor(current / width);
        componentLeft = Math.min(componentLeft, cx);
        componentRight = Math.max(componentRight, cx);
        componentTop = Math.min(componentTop, cy);
        componentBottom = Math.max(componentBottom, cy);
        if (cx === 0 || cy === 0 || cx === width - 1 || cy === height - 1) componentEdgePixels += 1;
        const neighbors = [
          cx > 0 ? current - 1 : -1,
          cx + 1 < width ? current + 1 : -1,
          cy > 0 ? current - width : -1,
          cy + 1 < height ? current + width : -1,
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || visited[neighbor] || !mask[neighbor]) continue;
          visited[neighbor] = 1;
          labels[neighbor] = label;
          queue[tail++] = neighbor;
        }
      }
      components.push({
        label,
        pixels: tail,
        bounds: {
          left: componentLeft,
          top: componentTop,
          right: componentRight,
          bottom: componentBottom,
          width: componentRight - componentLeft + 1,
          height: componentBottom - componentTop + 1,
        },
        edgePixels: componentEdgePixels,
      });
    }
  }

  const eligibleComponents = components.filter((component) => component.pixels >= componentFloor);
  const primary = eligibleComponents.reduce<AlphaComponent | null>(
    (largest, component) => !largest || component.pixels > largest.pixels ? component : largest,
    null,
  );
  const preserveAuxiliary = options.allowAuxiliaryForegroundComponents === true;
  const duplicateFragmentLabels = primary && !preserveAuxiliary
    ? detachedDuplicateFragmentLabels(eligibleComponents, primary, width)
    : new Set<number>();
  const survivingComponents = primary
    ? eligibleComponents.filter((component) => (
        (preserveAuxiliary || (!isDetachedLineResidue(component, primary, width, height)
        && !isDetachedSpeckResidue(component, primary, width, height)
        && !isDetachedPartialDuplicateResidue(component, primary, width, height)))
        && !isDetachedLayoutGuideResidue(component, primary, width, height)
        && !duplicateFragmentLabels.has(component.label)
      ))
    : [];
  const bleedComponents = options.dropNeighbourBleed && primary
    ? survivingComponents.filter((component) => (
        component.label !== primary.label
        && looksLikeNeighbourBleed(component, primary, width, height)
      ))
    : [];
  const bleedLabels = new Set(bleedComponents.map((component) => component.label));
  const retainedComponents = survivingComponents.filter((component) => !bleedLabels.has(component.label));
  const removedBleedComponentCount = bleedComponents.length;
  const auxiliaryComponentErrors = preserveAuxiliary && primary
    ? validateAuxiliaryComponents(retainedComponents, primary, width, height)
    : [];
  const retainedLabels = new Set(retainedComponents.map((component) => component.label));
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  const opaquePixels = retainedComponents.reduce((total, component) => total + component.pixels, 0);
  const edgePixels = retainedComponents.reduce((total, component) => total + component.edgePixels, 0);
  const componentCount = retainedComponents.length;
  for (const component of retainedComponents) {
    left = Math.min(left, component.bounds.left);
    right = Math.max(right, component.bounds.right);
    top = Math.min(top, component.bounds.top);
    bottom = Math.max(bottom, component.bounds.bottom);
  }
  let removedComponentPixels = 0;
  for (let pixelIndex = 0; pixelIndex < mask.length; pixelIndex += 1) {
    if (!mask[pixelIndex]) continue;
    if (retainedLabels.has(labels[pixelIndex]!)) {
      retainedMask[pixelIndex] = 1;
      continue;
    }
    removedComponentPixels += 1;
    const offset = pixelIndex * info.channels;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    data[offset + 3] = 0;
  }
  if (opaquePixels === 0) return emptyAlphaAnalysis();

  // Flood transparent pixels from the foreground bounding-box edge; remaining transparent pixels are holes.
  const transparentVisited = new Uint8Array(mask.length);
  let head = 0;
  let tail = 0;
  const pushTransparent = (x: number, y: number) => {
    const index = indexOf(x, y, width);
    if (retainedMask[index] || transparentVisited[index]) return;
    transparentVisited[index] = 1;
    queue[tail++] = index;
  };
  for (let x = left; x <= right; x += 1) {
    pushTransparent(x, top);
    pushTransparent(x, bottom);
  }
  for (let y = top; y <= bottom; y += 1) {
    pushTransparent(left, y);
    pushTransparent(right, y);
  }
  while (head < tail) {
    const current = queue[head++]!;
    const cx = current % width;
    const cy = Math.floor(current / width);
    const neighbors = [
      cx > left ? current - 1 : -1,
      cx < right ? current + 1 : -1,
      cy > top ? current - width : -1,
      cy < bottom ? current + width : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || transparentVisited[neighbor] || retainedMask[neighbor]) continue;
      transparentVisited[neighbor] = 1;
      queue[tail++] = neighbor;
    }
  }
  // Group the enclosed transparent pixels into regions. The total alone cannot
  // tell one wide slice through a filled body from several small anatomical
  // gaps, and those two cases deserve opposite verdicts.
  const boundsWidth = right - left + 1;
  const boundsHeight = bottom - top + 1;
  const shorterBoundsSide = Math.max(1, Math.min(boundsWidth, boundsHeight));
  const regionVisited = new Uint8Array(mask.length);
  const enclosedRegions: EnclosedRegionDiagnostics[] = [];
  let internalTransparentPixels = 0;
  const isEnclosed = (index: number): boolean => !retainedMask[index] && !transparentVisited[index];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const seed = indexOf(x, y, width);
      if (!isEnclosed(seed) || regionVisited[seed]) continue;
      let head = 0;
      let tail = 0;
      let sumX = 0;
      let sumY = 0;
      queue[tail++] = seed;
      regionVisited[seed] = 1;
      while (head < tail) {
        const current = queue[head++]!;
        const cx = current % width;
        const cy = Math.floor(current / width);
        sumX += cx;
        sumY += cy;
        const neighbors = [
          cx > left ? current - 1 : -1,
          cx < right ? current + 1 : -1,
          cy > top ? current - width : -1,
          cy < bottom ? current + width : -1,
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || regionVisited[neighbor] || !isEnclosed(neighbor)) continue;
          regionVisited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
      internalTransparentPixels += tail;
      const centroidX = sumX / tail;
      const centroidY = sumY / tail;
      const insetPixels = Math.min(centroidX - left, right - centroidX, centroidY - top, bottom - centroidY);
      enclosedRegions.push({ pixels: tail, insetRatio: insetPixels / shorterBoundsSide });
    }
  }
  enclosedRegions.sort((a, b) => b.pixels - a.pixels);
  return {
    bounds: { left, top, right, bottom, width: boundsWidth, height: boundsHeight },
    opaquePixels,
    edgePixels,
    componentCount,
    internalTransparentPixels,
    borderContactRuns: measureBorderContactRuns(
      labels,
      retainedComponents.reduce((best, component) => (
        !best || component.pixels > best.pixels ? component : best
      ), null as AlphaComponent | null)?.label ?? -1,
      width,
      height,
    ),
    enclosedRegions,
    components: retainedComponents.map((component) => ({
      pixels: component.pixels,
      bounds: component.bounds,
      edgePixels: component.edgePixels,
    })),
    removedBleedComponentCount,
    auxiliaryComponentErrors,
    cleanedImage: removedComponentPixels > 0
      ? await sharp(data, { raw: { width, height, channels: info.channels } }).png().toBuffer()
      : null,
  };
}
