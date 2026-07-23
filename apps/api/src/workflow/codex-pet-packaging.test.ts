import { describe, expect, it } from "vitest";
import { codexPetFinalPackageInputRevision } from "./codex-pet-packaging.js";

describe("Codex pet durable package revision", () => {
  it("is stable across PostgreSQL jsonb numeric round trips", () => {
    const finalAtlas = Buffer.from("same-approved-atlas");
    const beforeDatabase = {
      directionRegistration: {
        lowerBodyAnchorDeltaPixels: -0.16976368876080983,
      },
    };
    const afterDatabase = {
      directionRegistration: {
        lowerBodyAnchorDeltaPixels: -0.1697636887608098,
      },
    };

    expect(codexPetFinalPackageInputRevision({ finalAtlas, report: beforeDatabase }))
      .toEqual(codexPetFinalPackageInputRevision({ finalAtlas, report: afterDatabase }));
  });
});
