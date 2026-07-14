import { describe, expect, it, vi } from "vitest";
import { withNovelProjectLock } from "./project-lock.js";

describe("novel project lock", () => {
  it("uses a token-checked Redis lease around the whole project step", async () => {
    const set = vi.fn(async () => "OK");
    const evalCommand = vi.fn(async () => 1);
    const redis = { set, eval: evalCommand };
    const work = vi.fn(async () => "done");
    await expect(withNovelProjectLock({ projectId: "project-1", work, redis: redis as never })).resolves.toBe("done");
    expect(set).toHaveBeenCalledWith(expect.stringContaining("project-1"), expect.any(String), "PX", expect.any(Number), "NX");
    expect(work).toHaveBeenCalledTimes(1);
    expect(evalCommand).toHaveBeenCalledWith(expect.stringContaining("del"), 1, expect.stringContaining("project-1"), expect.any(String));
  });
});
