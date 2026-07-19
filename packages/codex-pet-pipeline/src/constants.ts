export const PET_CELL_WIDTH = 192;
export const PET_CELL_HEIGHT = 208;
export const PET_ATLAS_COLUMNS = 8;
export const PET_ATLAS_ROWS = 11;
export const PET_ATLAS_WIDTH = PET_CELL_WIDTH * PET_ATLAS_COLUMNS;
export const PET_ATLAS_HEIGHT = PET_CELL_HEIGHT * PET_ATLAS_ROWS;
export const PET_SPRITE_VERSION = 2 as const;

export const STANDARD_PET_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

export type StandardPetState = (typeof STANDARD_PET_STATES)[number];

export interface PetRowSpec {
  readonly row: number;
  readonly state: StandardPetState | "look-a" | "look-b";
  readonly frameCount: number;
  readonly boardColumns: 2 | 3 | 4 | 5;
  readonly boardRows: 1 | 2;
  readonly durations: readonly number[];
}

export const PET_ROW_SPECS: readonly PetRowSpec[] = [
  { row: 0, state: "idle", frameCount: 6, boardColumns: 3, boardRows: 2, durations: [280, 110, 110, 140, 140, 320] },
  { row: 1, state: "running-right", frameCount: 8, boardColumns: 4, boardRows: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { row: 2, state: "running-left", frameCount: 8, boardColumns: 4, boardRows: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { row: 3, state: "waving", frameCount: 4, boardColumns: 2, boardRows: 2, durations: [140, 140, 140, 280] },
  // A single left-to-right row is intentional. Repeated real GPT Image POCs
  // treated the first cell after a 3x2 row wrap as a second peak, while 5x1
  // produced the required ground-rise-peak-descent-ground arc reliably.
  { row: 4, state: "jumping", frameCount: 5, boardColumns: 5, boardRows: 1, durations: [140, 140, 140, 140, 280] },
  { row: 5, state: "failed", frameCount: 8, boardColumns: 4, boardRows: 2, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { row: 6, state: "waiting", frameCount: 6, boardColumns: 3, boardRows: 2, durations: [150, 150, 150, 150, 150, 260] },
  { row: 7, state: "running", frameCount: 6, boardColumns: 3, boardRows: 2, durations: [120, 120, 120, 120, 120, 220] },
  { row: 8, state: "review", frameCount: 6, boardColumns: 3, boardRows: 2, durations: [150, 150, 150, 150, 150, 280] },
  { row: 9, state: "look-a", frameCount: 8, boardColumns: 4, boardRows: 2, durations: [100, 100, 100, 100, 100, 100, 100, 100] },
  { row: 10, state: "look-b", frameCount: 8, boardColumns: 4, boardRows: 2, durations: [100, 100, 100, 100, 100, 100, 100, 100] },
] as const;

export const LOOK_DIRECTIONS = [
  "000", "022.5", "045", "067.5", "090", "112.5", "135", "157.5",
  "180", "202.5", "225", "247.5", "270", "292.5", "315", "337.5",
] as const;

/**
 * Direction boards are generated in a 4×2 serpentine path so frame 4→5 is
 * physically adjacent at the right edge instead of jumping from top-right to
 * bottom-left. Values map chronological frame index to the source board's
 * row-major slot index. Deterministic extraction restores normal clockwise
 * order before QA, registration and atlas assembly.
 */
export const LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT = [0, 1, 2, 3, 7, 6, 5, 4] as const;

export const DEFAULT_CHROMA_CANDIDATES = [
  "#ff00ff",
  "#00ff00",
  "#00ffff",
  "#0000ff",
  "#ffff00",
] as const;

export function petRowSpec(state: PetRowSpec["state"]): PetRowSpec {
  const spec = PET_ROW_SPECS.find((candidate) => candidate.state === state);
  if (!spec) throw new Error(`Unknown pet row: ${state}`);
  return spec;
}
