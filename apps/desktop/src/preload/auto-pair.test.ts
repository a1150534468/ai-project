import { describe, expect, it, vi } from "vitest";
import { createAutoPairController } from "./auto-pair.js";

describe("createAutoPairController", () => {
  it("pairs once when a session token appears", async () => {
    let token = "";
    const pairSessionToken = vi.fn(async () => ({ ok: true, deviceId: "dev1" }));
    const controller = createAutoPairController({
      getSessionToken: () => token,
      pairSessionToken,
      logger: { warn: () => {} },
    });

    await controller.checkNow();
    token = "session-token";
    await controller.checkNow();
    await controller.checkNow();

    expect(pairSessionToken).toHaveBeenCalledTimes(1);
    expect(pairSessionToken).toHaveBeenCalledWith("session-token");
  });

  it("retries a token after a failed pair attempt", async () => {
    const pairSessionToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("pair failed"))
      .mockResolvedValueOnce({ ok: true, deviceId: "dev1" });
    const controller = createAutoPairController({
      getSessionToken: () => "session-token",
      pairSessionToken,
      logger: { warn: () => {} },
    });

    await controller.checkNow();
    await controller.checkNow();

    expect(pairSessionToken).toHaveBeenCalledTimes(2);
  });
});
