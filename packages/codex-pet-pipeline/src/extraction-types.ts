/**
 * 桌宠姿态板抽取的**公开契约层**:调用方能读到的每一个字段,以及 tolerant 判据的阈值表。
 * 原 extraction.ts 1398 行里的 199 行,按依赖方向搬到这里,它是整条链的最底层叶子。
 *
 * **这个文件不进 index.ts。** 包的公开面是 `index.ts` 的 `export * from "./extraction.js"`,
 * 这里的名字全部由 extraction.ts 原样转出。所以在本文件新增一个 export **不会**自动进入包的公开
 * 面 —— 要对外可见得同时在 extraction.ts 的 re-export 里加名字,这是有意的一道闸。
 *
 * **必须保持不依赖 sharp。** 只有两个 type-only import(chroma / jumping)。一旦这里 import 了
 * sharp,任何只想拿一个类型的模块都会把 native binding 拖进去。
 *
 * `FRAME_TOLERANCE` 的五个数字是**实测标定值,不是手感**:注释里记着 `老鼠猫` 那次事故的 84 帧
 * 真实数据(44 帧碰到 slot 边界、中位数只占自身像素 0.065%、无可见缺陷;而真的被切掉的姿态沿边界
 * 跑 50-61%)。改动其中任何一个之前先看注释里的测量区间,凑整会直接把两个分布之间的空带填掉。
 *
 * `DEFAULT_FRAME_STRICTNESS = "tolerant"` 同样不是保守选择:整板结论是逐帧合取,8 帧板只有 8 帧
 * 全过才过,一条 3% 假阳率的规则就会误拒 ~22% 本该通过的板,而每次误拒都是一次真实付费重生成。
 * 想把默认值翻回 "strict" 等于选择"用钱换零容忍",要有明确理由。
 *
 * `EnclosedRegionDiagnostics.insetRatio` 是**只报不判**的字段:它被评估过、被证明分不开"正常缝隙"
 * 和"身体被切开"(两者都落在 0.20-0.29),所以没有任何规则读它。它留着是为了离线复盘。
 *
 * 依赖方向:本文件是叶子。types → components → alpha → findings → extraction.ts。
 */

import type { ChromaRemovalResult } from "./chroma.js";
import type { JumpingArcDiagnostics } from "./jumping.js";

export interface PixelBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

/** Longest uninterrupted foreground run along each slot border, in pixels. */
export interface BorderContactRuns {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** One enclosed transparent region fully surrounded by retained foreground. */
export interface EnclosedRegionDiagnostics {
  readonly pixels: number;
  /**
   * Centroid distance to the nearest silhouette bounding-box side, as a fraction
   * of the smaller bounding-box dimension. Reported for offline triage only: it
   * was evaluated as a way to tell a normal gap from a slice through the body and
   * does not separate them (both land at 0.20-0.29 on real boards), so no rule
   * reads it.
   */
  readonly insetRatio: number;
}

export interface ForegroundComponentDiagnostics {
  readonly pixels: number;
  readonly bounds: PixelBounds;
  readonly edgePixels: number;
}

export interface FrameDiagnostics {
  readonly index: number;
  readonly sourceBounds: PixelBounds | null;
  readonly opaquePixels: number;
  readonly edgePixels: number;
  readonly componentCount: number;
  readonly internalTransparentPixels: number;
  /** Fraction of the source slot removed (or softened) as the requested chroma key. */
  readonly chromaCoverage: number | null;
  readonly normalizedBounds: PixelBounds | null;
  /** Per-border contact detail. `edgePixels` alone cannot separate a real
   * clipped pose from a few pixels of neighbouring-slot bleed. */
  readonly borderContactRuns: BorderContactRuns;
  readonly enclosedRegions: readonly EnclosedRegionDiagnostics[];
  readonly foregroundComponents: readonly ForegroundComponentDiagnostics[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ExtractPoseBoardOptions {
  readonly columns: number;
  readonly rows: number;
  readonly frameCount: number;
  /** Chronological output index -> physical row-major source slot index. */
  readonly frameOrder?: readonly number[];
  readonly chromaKey: string;
  readonly chromaThreshold?: number;
  readonly chromaFeather?: number;
  /** Minimum keyed-background coverage required for every used source slot. */
  readonly minChromaCoverage?: number;
  /** Maximum keyed-background coverage allowed for every used source slot. */
  readonly maxChromaCoverage?: number;
  readonly cellWidth?: number;
  readonly cellHeight?: number;
  readonly padding?: number;
  readonly requireUnusedSlotsEmpty?: boolean;
  /** Jumping opts into preserving source-board travel; ordinary poses are centred and grounded. */
  readonly allowVerticalTravel?: boolean;
  /**
   * Maximum normalized pose height for jumping. When provided, all frames use
   * one raster scale and source-board travel is compressed into the available
   * 18-24px arc instead of shrinking the character to fit the raw travel span.
   */
  readonly jumpingTargetHeight?: number;
  /** Opt-in five-frame semantic geometry gate; callers should enable it only for jumping. */
  readonly requireJumpingArc?: boolean;
  readonly maxHeightRatio?: number;
  readonly maxWidthRatio?: number;
  readonly maxBaselineSpreadPixels?: number;
  readonly maxCenterSpreadPixels?: number;
  /** Deliberate opt-in for character designs whose sprite has separate opaque islands. */
  readonly allowMultipleForegroundComponents?: boolean;
  /**
   * Preserve and validate a small bounded set of detached foreground elements,
   * such as user-requested ZZZ text or an action prop. Unlike the broad
   * `allowMultipleForegroundComponents` escape hatch, this still rejects
   * distant, oversized, edge-touching, or duplicate-subject-like islands.
   */
  readonly allowAuxiliaryForegroundComponents?: boolean;
  /** Deliberate opt-in for designs with intentional enclosed negative space, such as a ring body. */
  readonly allowTransparentHoles?: boolean;
  /**
   * How aggressively per-frame cosmetic findings fail the whole board.
   *
   * A board verdict is the conjunction of every frame, so an 8-frame board only
   * passes when all 8 pass. A rule with a 3% per-frame false-positive rate
   * therefore fails ~22% of boards it should have accepted, and each rejection
   * costs a full paid regeneration of all 8 poses. `tolerant` keeps hard errors
   * for defects that provably break the atlas (empty frame, clipped pose, bad
   * chroma, unusable geometry) and reports cosmetic residue as warnings.
   */
  readonly frameStrictness?: FrameStrictness;
}

/**
 * `strict` fails a frame on any border contact, any extra opaque island and any
 * enclosed transparent area over 2% of the sprite. Useful for regression tests
 * and for re-auditing a board offline, but too brittle to gate paid generation.
 */
export type FrameStrictness = "strict" | "tolerant";

export const DEFAULT_FRAME_STRICTNESS: FrameStrictness = "tolerant";

/**
 * Tolerant-mode thresholds. Calibrated against 84 real frames from the
 * `老鼠猫` incident, where 44 frames touched a slot border with a median of
 * 0.065% of the sprite's own pixel count and no visible defect, while a
 * genuinely clipped pose contacts a border along tens of percent of its length.
 */
export const FRAME_TOLERANCE = {
  /**
   * Border contact fails only past this fraction of that border's length.
   * Measured: benign contact (a paw resting on the baseline) peaks at 12.1% of
   * the border, while a deliberately clipped pose runs 50-61%. 30% sits in the
   * empty band between the two.
   */
  maxBorderRunFraction: 0.3,
  /** ...or past this fraction of the sprite's own pixel count, whichever hits first. */
  maxBorderContactFraction: 0.006,
  /** An extra island this small relative to the sprite may be neighbour bleed... */
  maxBleedComponentFraction: 0.03,
  /** ...if it also stays within this fraction of the slot, measured inward from
   * the border it touches. Slot boundaries are pure arithmetic divisions with no
   * printed gutter, so an adjacent pose routinely spills a few pixels across. */
  maxBleedComponentDepthFraction: 0.08,
  /**
   * Total enclosed transparent area above this fraction of the sprite is a hard
   * error. Measured: anatomically normal gaps in a running quadruped (the arch
   * under an extended stride, the loop of a curled tail) reach 4.1% of the
   * sprite, while a sliced-open body leaves 19%. Region inset was tried as a
   * second discriminator and dropped: normal gaps and suspicious ones both sit
   * at 0.20-0.29, so it separates nothing.
   */
  maxTotalEnclosedFraction: 0.08,
} as const;

export interface FrameInspectionOptions {
  readonly allowMultipleForegroundComponents?: boolean;
  readonly allowAuxiliaryForegroundComponents?: boolean;
  readonly allowTransparentHoles?: boolean;
  readonly frameStrictness?: FrameStrictness;
}

export interface PoseBoardGeometryDiagnostics {
  readonly heightRatio: number | null;
  readonly widthRatio: number | null;
  readonly baselineSpreadPixels: number | null;
  readonly centerSpreadPixels: number | null;
  readonly warnings: readonly string[];
}

export interface ExtractPoseBoardResult {
  readonly frames: readonly Buffer[];
  readonly diagnostics: readonly FrameDiagnostics[];
  readonly unusedSlotOpaquePixels: readonly number[];
  readonly chroma: readonly Omit<ChromaRemovalResult, "image">[];
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly sharedScale: number;
  readonly geometry: PoseBoardGeometryDiagnostics;
  readonly jumpingArc: JumpingArcDiagnostics | null;
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface FullPoseBoardRegistrationInput {
  readonly input: Buffer;
  readonly columns: number;
  readonly rows: number;
  /** Shared registration is intentionally limited to full boards. */
  readonly frameCount: number;
}

export interface SharedPoseBoardRegistrationResult {
  readonly framesByBoard: readonly (readonly Buffer[])[];
  readonly diagnosticsByBoard: readonly (readonly FrameDiagnostics[])[];
  readonly sourceBoardSizes: readonly { readonly width: number; readonly height: number }[];
  readonly sharedScale: number;
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}
