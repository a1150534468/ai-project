import { describe, expect, it } from "vitest";
import { withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  it("returns a dependency result before the deadline", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "dependency")).resolves.toBe("ok");
  });

  it("rejects a stalled dependency at the deadline", async () => {
    await expect(withTimeout(new Promise(() => undefined), 10, "dependency")).rejects.toThrow(
      "dependency timed out after 10ms",
    );
  });
});
