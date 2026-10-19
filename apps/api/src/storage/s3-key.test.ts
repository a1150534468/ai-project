import { describe, expect, it } from "vitest";
import { normalizeKeyPrefix, resolveKey } from "./s3-key.js";

describe("normalizeKeyPrefix", () => {
  it("treats blank or missing values as no prefix", () => {
    expect(normalizeKeyPrefix(undefined)).toBe("");
    expect(normalizeKeyPrefix("")).toBe("");
    expect(normalizeKeyPrefix("   ")).toBe("");
  });

  it("keeps a plain environment folder", () => {
    expect(normalizeKeyPrefix("dev")).toBe("dev");
    expect(normalizeKeyPrefix("  prod  ")).toBe("prod");
    expect(normalizeKeyPrefix("preview-2")).toBe("preview-2");
  });

  // A prefix becomes part of every physical request, so anything that could
  // escape its folder or change URL parsing is refused at load time.
  it.each(["a/b", "/dev", "dev/", "..", "../prod", "dev/../prod", "a\\b", "dev root", "-dev", "d:dev", "x".repeat(64)])(
    "rejects unsafe prefix %j",
    (value) => {
      expect(() => normalizeKeyPrefix(value)).toThrow(/S3_KEY_PREFIX/);
    },
  );
});

describe("resolveKey", () => {
  it("returns the key untouched when no prefix is configured", () => {
    expect(resolveKey({ keyPrefix: "" }, "workflow/images/a.png")).toBe("workflow/images/a.png");
  });

  it("places the key inside the environment folder", () => {
    expect(resolveKey({ keyPrefix: "dev" }, "workflow/images/a.png")).toBe("dev/workflow/images/a.png");
    expect(resolveKey({ keyPrefix: "prod" }, "kb/1/a.pdf")).toBe("prod/kb/1/a.pdf");
  });

  // Silently producing `dev/dev/...` would hide the bug until a 404 in
  // production, so a double prefix is a hard error.
  it("rejects a key that already carries the prefix", () => {
    expect(() => resolveKey({ keyPrefix: "dev" }, "dev/workflow/a.png")).toThrow(/already prefixed/);
    expect(() => resolveKey({ keyPrefix: "dev" }, "dev")).toThrow(/already prefixed/);
  });

  // A legitimate key that merely starts with the same characters is fine:
  // only a full path-segment match counts as "already prefixed".
  it("allows a key whose first segment merely starts with the prefix text", () => {
    expect(resolveKey({ keyPrefix: "dev" }, "device/a.png")).toBe("dev/device/a.png");
    expect(resolveKey({ keyPrefix: "dev" }, "development/a.png")).toBe("dev/development/a.png");
  });
});
