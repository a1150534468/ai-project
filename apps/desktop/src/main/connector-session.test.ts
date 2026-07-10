import { describe, expect, it } from "vitest";
import { sessionUserIdFromToken, shouldReuseRegisteredDevice } from "../shared/connector-session.js";

describe("connector session ownership", () => {
  it("extracts the user id from a session token payload", () => {
    expect(sessionUserIdFromToken("user-1.1790000000000.signature")).toBe("user-1");
    expect(sessionUserIdFromToken("malformed-token")).toBeNull();
  });

  it("reuses a registered connector only for the same web session user", () => {
    expect(shouldReuseRegisteredDevice({
      registeredDeviceId: "device-1",
      activeDeviceUserId: "user-1",
      sessionToken: "user-1.1790000000000.signature",
    })).toBe(true);

    expect(shouldReuseRegisteredDevice({
      registeredDeviceId: "device-1",
      activeDeviceUserId: "user-1",
      sessionToken: "user-2.1790000000000.signature",
    })).toBe(false);
  });
});
