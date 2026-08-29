/**
 * 评级层:把 `AlphaAnalysis` 里的事实按 strict / tolerant 判成 findings。**这是"整板误拒"唯一的
 * 调参入口**,单独成文件就是为了让它成为显式的变更磁铁 —— 历史上失败整板的三条装饰性规则都在这里。
 *
 * `severity: "error"` 会让整板 `ok === false`(板结论是逐帧合取),`"warning"` 只上报。tolerant 的
 * 全部意义就是把"证据不足的装饰性残留"从 error 降为 warning,同时保留会真正破坏 atlas 的硬错误
 * (空帧、姿态被切、chroma 异常、几何不可用)。
 *
 * `analysis` 形参刻意收窄成 `Pick<AlphaAnalysis, ...9 个字段>` 而不是整个 `AlphaAnalysis`:
 * 两个调用点里 `inspectFrame` 传的是自己现拼的对象,不持有 `cleanedImage` 这类只属于 slot 流程的
 * 字段。放宽成整型会逼 inspectFrame 造假字段,收得更窄又会挡住 extractPoseBoard 直接传 analysis。
 * 两个调用点:extractPoseBoard(板内逐帧)与 inspectFrame(单帧复检)。
 *
 * `looksLikeNeighbourBleed` 从 extraction-components.js 导入而不是在这里重写:擦除决策与评级判据
 * 必须是同一份代码,见该文件头。
 *
 * 依赖方向:types + components + alpha。types → components → alpha → **findings** → extraction.ts。
 */

import { FRAME_TOLERANCE } from "./extraction-types.js";
import type { ForegroundComponentDiagnostics, FrameStrictness } from "./extraction-types.js";
import { looksLikeNeighbourBleed } from "./extraction-components.js";
import type { AlphaAnalysis } from "./extraction-alpha.js";

export interface FrameFinding {
  readonly code: string;
  readonly severity: "error" | "warning";
}

/**
 * Grade the three cosmetic findings that historically failed whole boards.
 *
 * `strict` reproduces the original zero-tolerance behaviour. `tolerant` keeps
 * the same detectors but demands evidence proportional to the cost of a false
 * positive: one rejected frame discards seven good ones and bills another full
 * board.
 */
export function classifyFrameFindings(
  analysis: Pick<AlphaAnalysis, "opaquePixels" | "edgePixels" | "componentCount" | "internalTransparentPixels" | "borderContactRuns" | "enclosedRegions" | "components" | "removedBleedComponentCount" | "auxiliaryComponentErrors">,
  slotWidth: number,
  slotHeight: number,
  options: {
    readonly strictness: FrameStrictness;
    readonly allowMultipleForegroundComponents?: boolean;
    readonly allowAuxiliaryForegroundComponents?: boolean;
    readonly allowTransparentHoles?: boolean;
    readonly edgeContactCode: string;
  },
): readonly FrameFinding[] {
  const findings: FrameFinding[] = [];
  const strict = options.strictness === "strict";

  findings.push(...analysis.auxiliaryComponentErrors.map((code) => ({ code, severity: "error" as const })));

  if (analysis.edgePixels > 0) {
    const runs = analysis.borderContactRuns;
    const longestVerticalRun = Math.max(runs.left, runs.right);
    const longestHorizontalRun = Math.max(runs.top, runs.bottom);
    const clipped = longestVerticalRun > slotHeight * FRAME_TOLERANCE.maxBorderRunFraction
      || longestHorizontalRun > slotWidth * FRAME_TOLERANCE.maxBorderRunFraction
      || analysis.edgePixels > analysis.opaquePixels * FRAME_TOLERANCE.maxBorderContactFraction;
    findings.push({ code: options.edgeContactCode, severity: strict || clipped ? "error" : "warning" });
  }

  if (analysis.componentCount > 1) {
    const primary = analysis.components.reduce<ForegroundComponentDiagnostics | null>(
      (largest, component) => !largest || component.pixels > largest.pixels ? component : largest,
      null,
    );
    const onlyNeighbourBleed = !strict
      && Boolean(primary)
      && analysis.components.every((component) => (
        component === primary || looksLikeNeighbourBleed(component, primary!, slotWidth, slotHeight)
      ));
    findings.push({
      code: "multiple-foreground-components",
      severity: options.allowMultipleForegroundComponents
        || options.allowAuxiliaryForegroundComponents
        || onlyNeighbourBleed
        ? "warning"
        : "error",
    });
  } else if (analysis.removedBleedComponentCount > 0) {
    // The sliver is already erased, so nothing downstream can see it. Report it
    // anyway: silently dropping pixels is exactly the failure mode that made
    // this pipeline hard to debug.
    findings.push({ code: "multiple-foreground-components", severity: "warning" });
  }

  if (analysis.internalTransparentPixels > Math.max(16, analysis.opaquePixels * 0.02)) {
    const slicedBody = analysis.internalTransparentPixels
      > analysis.opaquePixels * FRAME_TOLERANCE.maxTotalEnclosedFraction;
    findings.push({
      code: "possible-transparent-holes",
      severity: options.allowTransparentHoles ? "warning" : strict || slicedBody ? "error" : "warning",
    });
  }

  return findings;
}
