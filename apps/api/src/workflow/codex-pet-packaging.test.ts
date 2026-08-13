import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  codexPetCanonicalValidationReport,
  codexPetFinalPackageInputRevision,
} from "./codex-pet-packaging.js";

/** Significant decimal digits in a JSON number, ignoring sign/point/exponent. */
function significantDigits(value: number): number {
  const [mantissa] = String(value).split(/[eE]/);
  return mantissa.replace("-", "").replace(".", "").replace(/^0+/, "").replace(/0+$/, "").length;
}

function everyNumber(value: unknown, visit: (n: number) => void): void {
  if (Array.isArray(value)) return value.forEach((item) => everyNumber(item, visit));
  if (value && typeof value === "object") {
    return Object.values(value).forEach((item) => everyNumber(item, visit));
  }
  if (typeof value === "number") visit(value);
}

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

// Ratios lifted verbatim from the 老鼠猫 run that failed final packaging at 94%
// with `最终打包验证报告 checksum 不匹配`. Every one of these carries a 16- or
// 17-digit tail, which is exactly what the durable Job used to persist raw.
const LAOSHUMAO_RATIOS = {
  cardinalAnchor: {
    evidence: [{
      extractionDiagnostics: {
        chromaCoverage: 0.7393094887428808,
        enclosedRegions: [{ insetRatio: 0.06349206349206349 }, { insetRatio: 0.08888888888888889 }],
      },
    }],
  },
  directionRegistration: {
    sharedScale: 0.5269694320370435,
    target: { lowerBodyAnchorX: 98.36242100145843 },
    neutralValidationByBoard: [{
      frames: [
        { heightRatio: 0.8901098901098901, lowerBodyAnchorDeltaPixels: 0.02897244116452669 },
        { widthRatio: 0.7841726618705036, lowerBodyAnchorDeltaPixels: -0.1546371481293818 },
        { widthRatio: 1.086330935251798, lowerBodyAnchorDeltaPixels: 0.0003417613043268375 },
      ],
      medianWidthRatio: 0.8669064748201438,
    }],
  },
} satisfies Record<string, unknown>;

describe("Codex pet canonical validation report", () => {
  it("keeps every number inside the 15 digits a double round trips exactly", () => {
    const canonical = codexPetCanonicalValidationReport(LAOSHUMAO_RATIOS);

    const widths: number[] = [];
    everyNumber(canonical, (n) => widths.push(significantDigits(n)));

    expect(widths.length).toBeGreaterThan(0);
    expect(Math.max(...widths)).toBeLessThanOrEqual(15);
  });

  it("is what gets persisted, so the checksum survives the jsonb round trip", () => {
    const finalAtlas = Buffer.from("laoshumao-approved-atlas");
    const binding = codexPetFinalPackageInputRevision({ finalAtlas, report: LAOSHUMAO_RATIOS });

    // What the Job row now stores, and what Prisma hands back on recovery.
    const persisted = codexPetCanonicalValidationReport(LAOSHUMAO_RATIOS);
    const afterDatabase = JSON.parse(JSON.stringify(persisted)) as Record<string, unknown>;

    expect(codexPetFinalPackageInputRevision({ finalAtlas, report: afterDatabase }))
      .toEqual(binding);
  });

  it("removes the rounding boundary that a raw 17-digit tail leaves exposed", () => {
    // Rounding to 15 digits is not by itself drift-proof: 9.999999999999995 and
    // the double one ULP above it land on opposite sides of the 15th digit, so a
    // report persisted raw can come back with a different canonical form. Storing
    // the canonical value instead means the persisted number is already a 15-digit
    // decimal, and nudging *that* by an ULP no longer changes what we hash.
    const raw = 9.999999999999995;
    const rawDrifted = raw * (1 + 2 * Number.EPSILON);
    expect(rawDrifted).not.toBe(raw);
    // The old failure mode, reproduced.
    expect(Number(rawDrifted.toPrecision(15))).not.toBe(Number(raw.toPrecision(15)));

    const finalAtlas = Buffer.from("boundary-atlas");
    const persisted = codexPetCanonicalValidationReport({
      despill: { remainingOpaqueKeyPixels: raw },
    });
    const stored = (persisted as { despill: { remainingOpaqueKeyPixels: number } })
      .despill.remainingOpaqueKeyPixels;
    const storedDrifted = stored * (1 + 2 * Number.EPSILON);
    expect(storedDrifted).not.toBe(stored);

    expect(codexPetFinalPackageInputRevision({
      finalAtlas,
      report: { despill: { remainingOpaqueKeyPixels: storedDrifted } },
    })).toEqual(codexPetFinalPackageInputRevision({
      finalAtlas,
      report: persisted as Record<string, unknown>,
    }));
  });

  it("collapses non-finite numbers the same way JSON.stringify does", () => {
    const canonical = codexPetCanonicalValidationReport({
      ratios: { nan: Number.NaN, inf: Number.POSITIVE_INFINITY, negZero: -0 },
    });

    expect(canonical).toEqual({ ratios: { inf: null, nan: null, negZero: 0 } });
  });

  it("is idempotent, so re-canonicalising a recovered report is a no-op", () => {
    const once = codexPetCanonicalValidationReport(LAOSHUMAO_RATIOS);
    const twice = codexPetCanonicalValidationReport(once as Record<string, unknown>);

    const digest = (value: unknown) => createHash("sha256")
      .update(JSON.stringify(value)).digest("hex");

    expect(digest(twice)).toBe(digest(once));
  });
});
