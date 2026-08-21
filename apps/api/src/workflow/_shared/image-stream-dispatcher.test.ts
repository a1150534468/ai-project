import { describe, expect, it } from "vitest";
import { imageStreamDispatcherEnabled, withImageStreamDispatcher } from "./image-stream-dispatcher.js";

describe("image stream dispatcher", () => {
  it("is on by default and only opts out on an explicit 0", () => {
    expect(imageStreamDispatcherEnabled({})).toBe(true);
    expect(imageStreamDispatcherEnabled({ IMAGE_UPSTREAM_DISPATCHER: "1" })).toBe(true);
    expect(imageStreamDispatcherEnabled({ IMAGE_UPSTREAM_DISPATCHER: " 0 " })).toBe(false);
  });

  it("attaches the dispatcher to https upstream calls", () => {
    const init = withImageStreamDispatcher("https://api.example.com/v1/images/edits", { method: "POST" }, {});
    expect((init as { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect(init.method).toBe("POST");
  });

  it("leaves local http (minio/loopback) on the default dispatcher", () => {
    const init = withImageStreamDispatcher("http://127.0.0.1:9000/bucket/key.png", {}, {});
    expect((init as { dispatcher?: unknown }).dispatcher).toBeUndefined();
  });

  it("does not override a dispatcher the caller already set", () => {
    const injected = { marker: true };
    const init = withImageStreamDispatcher(
      "https://api.example.com/v1/images/edits",
      { dispatcher: injected } as RequestInit,
      {},
    );
    expect((init as { dispatcher?: unknown }).dispatcher).toBe(injected);
  });

  it("passes the init through untouched when disabled", () => {
    const original = { method: "POST" };
    const init = withImageStreamDispatcher("https://api.example.com/x", original, { IMAGE_UPSTREAM_DISPATCHER: "0" });
    expect(init).toBe(original);
  });

  it("passes the init through on an unparsable url instead of throwing", () => {
    const original = { method: "POST" };
    expect(withImageStreamDispatcher("not a url", original, {})).toBe(original);
  });
});
