import { describe, expect, it } from "vitest";
import { DOUBAO_IMAGE_MODEL, GPT_IMAGE_MODEL, QWEN_IMAGE_MODEL } from "./image-service.js";
import {
  assertCodexPetVisualQaProvenance,
  atlasValidationErrorsWithoutCellScope,
  codexPetMaxBoardAttempts,
  codexPetRepairGenerationReferences,
  codexPetShouldAttachFailedBoardForRepair,
  loadPoseBoardSalvage,
  poseBoardSalvageMetadata,
  poseBoardSalvageSlots,
  poseBoardSlotHealth,
  preferPoseBoardSalvage,
  repairRowsFromAtlasValidation,
  repairRowsFromDirectionContinuity,
} from "./codex-pet-runner.js";
import { CODEX_PET_GATE_REPAIR_ROWS, codexPetGateRowJobKey } from "./codex-pet-gate-failure.js";

describe("Codex pet runner visual model provenance", () => {
  it("requires every actual visual model to equal the frozen requested model", () => {
    expect(assertCodexPetVisualQaProvenance({
      requestedModel: "qwen3.6-flash",
      actualModels: ["qwen3.6-flash"],
      routes: ["bailian_model_route"],
    }, "qwen3.6-flash", "row-review")).toMatchObject({
      requestedModel: "qwen3.6-flash",
      actualModels: ["qwen3.6-flash"],
      routes: ["bailian_model_route"],
    });

    expect(() => assertCodexPetVisualQaProvenance({
      requestedModel: "qwen3.6-flash",
      actualModels: ["gpt-5.6-sol"],
      routes: ["bailian_model_route"],
    }, "qwen3.6-flash", "row-review")).toThrow("缺少可信的 qwen3.6-flash 模型来源证明");
  });

  it("does not feed a rejected pose board back into Seedream repairs", () => {
    expect(codexPetShouldAttachFailedBoardForRepair(DOUBAO_IMAGE_MODEL)).toBe(false);
    expect(codexPetShouldAttachFailedBoardForRepair(GPT_IMAGE_MODEL)).toBe(true);
    expect(codexPetShouldAttachFailedBoardForRepair(QWEN_IMAGE_MODEL)).toBe(true);

    const canonical = { b64: "canonical", mime: "image/png", filename: "canonical-base.png" } as const;
    const layout = { b64: "layout", mime: "image/png", filename: "running-right-layout.png" } as const;
    const failed = Buffer.from("rejected-board");
    expect(codexPetRepairGenerationReferences(DOUBAO_IMAGE_MODEL, [canonical, layout], failed).map((item) => item.filename))
      .toEqual(["canonical-base.png", "running-right-layout.png"]);
    expect(codexPetRepairGenerationReferences(GPT_IMAGE_MODEL, [canonical, layout], failed).map((item) => item.filename))
      .toEqual(["canonical-base.png", "running-right-layout.png", "previous-failed-pose-board.png"]);
  });

  it("lets a real-verification runtime cap retries without expanding a durable limit", () => {
    expect(codexPetMaxBoardAttempts({}, undefined)).toBe(3);
    expect(codexPetMaxBoardAttempts({ CODEX_PET_MAX_BOARD_ATTEMPTS: "1" }, undefined)).toBe(1);
    expect(codexPetMaxBoardAttempts({ CODEX_PET_MAX_BOARD_ATTEMPTS: "3" }, 1)).toBe(1);
    expect(codexPetMaxBoardAttempts({ CODEX_PET_MAX_BOARD_ATTEMPTS: "invalid" }, 2)).toBe(2);
  });
});

/**
 * A terminal gate rejection used to be a wall: the run died with no scope, and
 * the only exit was copying the project and paying for all fourteen planned calls
 * again. The scope only works if it is honest in both directions — every blamed
 * row must be a job the continuation can actually reset, and an atlas-wide defect
 * that no regeneration could fix must stay fatal.
 */
describe("Codex pet terminal gate repair scope", () => {
  it("blames only the action groups whose own cells failed", () => {
    const rows = repairRowsFromAtlasValidation({
      cells: [
        { state: "idle", errors: ["idle[2]:used-cell-empty"] },
        { state: "waving", errors: [] },
        { state: "look-b", errors: ["look-b[7]:opaque-chroma-pixels:41"] },
      ],
      errors: ["idle[2]:used-cell-empty", "look-b[7]:opaque-chroma-pixels:41"],
    });

    expect([...rows].sort()).toEqual(["idle", "look-b"]);
  });

  it("maps every blamed row to a board job key the continuation can reset", () => {
    // Drift here is the failure mode the shared constant exists to prevent: a row
    // name with no job silently becomes "nothing to reset".
    for (const row of CODEX_PET_GATE_REPAIR_ROWS) {
      const key = codexPetGateRowJobKey(row);
      expect(key).toBe(row === "look-a" || row === "look-b" ? row : `row-${row}`);
    }
  });

  it("keeps an unattributable atlas defect out of the repair scope", () => {
    const validation = {
      cells: [{ state: "idle", column: 2, errors: ["used-cell-empty"] }],
      errors: [
        "idle[2]:used-cell-empty",
        "width:1500:expected:1536",
        "atlas-missing-alpha-channel",
        "opaque-chroma-pixels:88",
      ],
    };

    // Dimensions, alpha and residue outside the cell grid are assembly/despill
    // defects; regenerating an action group cannot fix them, so they must not
    // burn the repair budget or masquerade as a continuable scope.
    expect(atlasValidationErrorsWithoutCellScope(validation)).toEqual([
      "width:1500:expected:1536",
      "atlas-missing-alpha-channel",
      "opaque-chroma-pixels:88",
    ]);
    expect(repairRowsFromAtlasValidation(validation)).toEqual(["idle"]);
  });

  it("treats a fully cell-attributed rejection as repairable", () => {
    const validation = {
      cells: [
        { state: "running-left", column: 0, errors: ["frame-off-canvas"] },
        { state: "running-left", column: 1, errors: [] },
      ],
      errors: ["running-left[0]:frame-off-canvas"],
    };

    expect(atlasValidationErrorsWithoutCellScope(validation)).toEqual([]);
    expect(repairRowsFromAtlasValidation(validation)).toEqual(["running-left"]);
  });

  it("splits direction continuity failures across the two look rows", () => {
    expect(repairRowsFromDirectionContinuity({ errors: ["045:missing-turn"] })).toEqual(["look-a"]);
    expect(repairRowsFromDirectionContinuity({ errors: ["247.5:reversed"] })).toEqual(["look-b"]);
    expect([...repairRowsFromDirectionContinuity({
      errors: ["000:flat", "337.5:flat"],
    })].sort()).toEqual(["look-a", "look-b"]);
    // 157.5 is the last frame of look-a and 180 the first of look-b; an off-by-one
    // here would redraw the wrong paid board.
    expect(repairRowsFromDirectionContinuity({ errors: ["157.5:jump"] })).toEqual(["look-a"]);
    expect(repairRowsFromDirectionContinuity({ errors: ["180:jump"] })).toEqual(["look-b"]);
  });

  it("ignores a continuity error that names no known direction", () => {
    expect(repairRowsFromDirectionContinuity({ errors: ["unknown:oops", ""] })).toEqual([]);
  });
});

/**
 * A board verdict is the conjunction of every cell, so one broken pose used to
 * throw away seven good paid poses. Under per-image billing each redraw costs a
 * fresh user approval, which makes reusing the clean slots the difference between
 * a bounded repair and a run that burns its budget on the same eight poses.
 */
describe("Codex pet pose board salvage bookkeeping", () => {
  type Extracted = Parameters<typeof poseBoardSlotHealth>[0];

  function extracted(input: {
    readonly frameErrors: readonly (readonly string[])[];
    readonly unusedSlotOpaquePixels?: readonly number[];
  }): Extracted {
    return {
      diagnostics: input.frameErrors.map((errors) => ({ errors })),
      unusedSlotOpaquePixels: input.unusedSlotOpaquePixels ?? [],
    } as unknown as Extracted;
  }

  it("names the physical source slot, not the chronological frame index", () => {
    // A board with a frameOrder permutation reads its diagnostics
    // chronologically; blaming the chronological index would donate and redraw
    // the wrong cell.
    const health = poseBoardSlotHealth(
      extracted({ frameErrors: [[], ["frame-off-canvas"], [], []] }),
      { columns: 2, rows: 2, frameCount: 4, frameOrder: [3, 2, 1, 0] },
    );

    expect([...health.bad]).toEqual([2]);
    expect([...health.good].sort((left, right) => left - right)).toEqual([0, 1, 3]);
  });

  it("counts an empty trailing slot as clean and a dirty one as broken", () => {
    const clean = poseBoardSlotHealth(
      extracted({ frameErrors: [[], []], unusedSlotOpaquePixels: [0, 12] }),
      { columns: 2, rows: 2, frameCount: 2 },
    );
    expect([...clean.good].sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
    expect(clean.bad).toEqual([]);

    const dirty = poseBoardSlotHealth(
      extracted({ frameErrors: [[], []], unusedSlotOpaquePixels: [0, 4_000] }),
      { columns: 2, rows: 2, frameCount: 2 },
    );
    expect([...dirty.bad]).toEqual([3]);
  });

  it("donates only slots the new board actually failed", () => {
    const salvage = {
      board: Buffer.from("donor"),
      goodSourceSlots: [0, 1, 2, 5],
      attempt: 1,
      boardArtifactId: "artifact-1",
    };

    // A splice may only replace cells that were going to be rejected anyway, so
    // the result still has to clear the same deterministic gates and the same
    // visual review.
    expect([...poseBoardSalvageSlots(salvage, [2, 5, 7])]).toEqual([2, 5]);
    expect(poseBoardSalvageSlots(salvage, [])).toEqual([]);
    expect(poseBoardSalvageSlots(null, [2])).toEqual([]);
    expect(poseBoardSalvageSlots(salvage, [3, 4])).toEqual([]);
  });

  it("keeps the donor that covers slots the newer board cannot", () => {
    const previous = {
      board: Buffer.from("older"),
      goodSourceSlots: [0, 1, 2, 3],
      attempt: 1,
      boardArtifactId: "artifact-1",
    };
    const narrower = {
      board: Buffer.from("newer"),
      goodSourceSlots: [0, 1],
      attempt: 2,
      boardArtifactId: "artifact-2",
    };
    const wider = {
      board: Buffer.from("newest"),
      goodSourceSlots: [0, 1, 2, 3, 4],
      attempt: 3,
      boardArtifactId: "artifact-3",
    };

    expect(preferPoseBoardSalvage(null, narrower)).toBe(narrower);
    // Slots 2 and 3 exist only on the older board, and it is no smaller: giving
    // it up would mean paying to redraw cells already in hand.
    expect(preferPoseBoardSalvage(previous, narrower)).toBe(previous);
    expect(preferPoseBoardSalvage(previous, wider)).toBe(wider);
    // Same coverage, fresher pixels: prefer the newer board, which also carries
    // whatever the last repair requirement fixed.
    expect(preferPoseBoardSalvage(previous, {
      ...previous,
      board: Buffer.from("same-coverage"),
      attempt: 4,
      boardArtifactId: "artifact-4",
    }).boardArtifactId).toBe("artifact-4");
  });

  it("writes the donor slot map in the schema the loader accepts", () => {
    expect(poseBoardSalvageMetadata({ goodSourceSlots: [0, 3], attempt: 2 })).toEqual({
      schemaVersion: "codex-pet-pose-board-salvage-v1",
      goodSourceSlots: [0, 3],
      attempt: 2,
    });
  });
});

/**
 * Per-image billing runs one attempt per invocation, so the in-memory donor never
 * survives to the approved retry. The durable board artifact is the only carrier,
 * which makes this loader the whole salvage path in production.
 */
describe("Codex pet durable pose board donor", () => {
  type Ctx = Parameters<typeof loadPoseBoardSalvage>[0];
  type Job = Parameters<typeof loadPoseBoardSalvage>[1];

  const GEOMETRY = { columns: 4, rows: 2, frameCount: 8 } as const;

  function donorArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "artifact-1",
      metadata: {
        inputRevision: "rev-1",
        columns: 4,
        rows: 2,
        frameCount: 8,
        salvage: poseBoardSalvageMetadata({ goodSourceSlots: [0, 1, 4], attempt: 1 }),
        ...overrides,
      },
    };
  }

  function salvageCtx(candidates: readonly Record<string, unknown>[], load?: (candidate: unknown) => Promise<Buffer>) {
    const queries: unknown[] = [];
    const ctx = {
      runId: "run-1",
      project: { id: "project-1", userId: "user-1" },
      prisma: {
        codexPetArtifact: {
          findMany: async (args: unknown) => {
            queries.push(args);
            return candidates;
          },
        },
      },
      artifacts: { load: load ?? (async () => Buffer.from("donor-pixels")) },
    };
    return { ctx: ctx as unknown as Ctx, queries };
  }

  const job = { id: "job-row-idle", input: { inputRevision: "rev-1" } } as unknown as Job;

  it("loads the donor and scopes the query to this run, project and user", async () => {
    const { ctx, queries } = salvageCtx([donorArtifact()]);

    await expect(loadPoseBoardSalvage(ctx, job, GEOMETRY)).resolves.toMatchObject({
      goodSourceSlots: [0, 1, 4],
      attempt: 1,
      boardArtifactId: "artifact-1",
    });
    // A donor is paid pixels belonging to one user's run. Widening this query
    // would splice someone else's character into their board.
    expect(queries[0]).toMatchObject({
      where: {
        jobId: "job-row-idle",
        runId: "run-1",
        projectId: "project-1",
        userId: "user-1",
        kind: "pose_board",
        status: "ready",
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("refuses a donor whose dependencies or geometry changed", async () => {
    // A changed inputRevision means the approved base or prompt moved on: those
    // pixels no longer depict the same character.
    await expect(loadPoseBoardSalvage(salvageCtx([donorArtifact({ inputRevision: "rev-2" })]).ctx, job, GEOMETRY))
      .resolves.toBeNull();
    // Different grid arithmetic makes slot i of the donor a different pose.
    await expect(loadPoseBoardSalvage(salvageCtx([donorArtifact({ columns: 3, rows: 2, frameCount: 6 })]).ctx, job, GEOMETRY))
      .resolves.toBeNull();
    await expect(loadPoseBoardSalvage(salvageCtx([donorArtifact({ frameCount: 6 })]).ctx, job, GEOMETRY))
      .resolves.toBeNull();
  });

  it("ignores donors written under a different or missing salvage schema", async () => {
    await expect(loadPoseBoardSalvage(salvageCtx([donorArtifact({
      salvage: { schemaVersion: "codex-pet-pose-board-salvage-v0", goodSourceSlots: [0, 1], attempt: 1 },
    })]).ctx, job, GEOMETRY)).resolves.toBeNull();
    await expect(loadPoseBoardSalvage(salvageCtx([donorArtifact({ salvage: undefined })]).ctx, job, GEOMETRY))
      .resolves.toBeNull();
  });

  it("drops slot indexes that fall outside the board grid", async () => {
    const { ctx } = salvageCtx([donorArtifact({
      salvage: { schemaVersion: "codex-pet-pose-board-salvage-v1", goodSourceSlots: [0, 8, -1, 2.5, "3", 7], attempt: 1 },
    })]);

    // Stored metadata is data, not a contract: a bad index would later ask sharp
    // to extract a rectangle outside the canvas and throw mid-repair.
    await expect(loadPoseBoardSalvage(ctx, job, GEOMETRY)).resolves.toMatchObject({ goodSourceSlots: [0, 7] });
  });

  it("skips a donor whose bytes are already gone and falls through to the next", async () => {
    const { ctx } = salvageCtx(
      [donorArtifact({ salvage: poseBoardSalvageMetadata({ goodSourceSlots: [3], attempt: 2 }) }), donorArtifact()],
      async (candidate) => {
        // Intermediates carry a TTL, so the newest donor can be swept while an
        // older one survives. A throw here must not fail the whole repair.
        if ((candidate as { metadata: { salvage: { attempt: number } } }).metadata.salvage.attempt === 2) {
          throw new Error("object expired");
        }
        return Buffer.from("older-pixels");
      },
    );

    await expect(loadPoseBoardSalvage(ctx, job, GEOMETRY)).resolves.toMatchObject({
      goodSourceSlots: [0, 1, 4],
      attempt: 1,
    });
  });

  it("returns nothing when the job has no input revision to scope against", async () => {
    const { ctx, queries } = salvageCtx([donorArtifact()]);

    await expect(loadPoseBoardSalvage(ctx, { id: "job-row-idle", input: {} } as unknown as Job, GEOMETRY))
      .resolves.toBeNull();
    expect(queries).toEqual([]);
  });

  it("returns nothing when no clean slot survived", async () => {
    await expect(loadPoseBoardSalvage(salvageCtx([donorArtifact({
      salvage: poseBoardSalvageMetadata({ goodSourceSlots: [], attempt: 1 }),
    })]).ctx, job, GEOMETRY)).resolves.toBeNull();
    await expect(loadPoseBoardSalvage(salvageCtx([]).ctx, job, GEOMETRY)).resolves.toBeNull();
  });
});
