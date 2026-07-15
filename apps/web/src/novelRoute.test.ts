import { describe, expect, it } from "vitest";
import { novelProjectIdFromHash } from "./novelRoute";

describe("novel route", () => {
  it("restores a novel workbench deep link", () => {
    expect(novelProjectIdFromHash("#novel/project-1/workbench")).toBe("project-1");
  });

  it("ignores unrelated or malformed hashes", () => {
    expect(novelProjectIdFromHash("#chat")).toBeNull();
    expect(novelProjectIdFromHash("#novel/project-1")).toBeNull();
    expect(novelProjectIdFromHash("#novel/%E0%A4%A/workbench")).toBeNull();
  });
});
