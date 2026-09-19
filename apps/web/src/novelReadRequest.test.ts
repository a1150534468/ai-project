import { describe, expect, it, vi } from "vitest";
import { createNovelRequest } from "./novelReadRequest";
import type { request } from "./http";

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("novel read single flight", () => {
  it("shares concurrent reads, but never caches a settled response", async () => {
    const gate = deferred();
    const transport = vi.fn(() => gate.promise);
    const read = createNovelRequest(transport as typeof request);
    const first = read("/book", { token: "u1" });
    const second = read("/book", { token: "u1" });
    expect(first).toBe(second);
    expect(transport).toHaveBeenCalledTimes(1);
    gate.resolve({ id: 1 });
    await first;
    await read("/book", { token: "u1" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("isolates users and resources and releases rejected flights", async () => {
    const gate = deferred();
    const transport = vi.fn(() => gate.promise);
    const read = createNovelRequest(transport as typeof request);
    const calls = [read("/a", { token: "u1" }), read("/a", { token: "u2" }), read("/b", { token: "u1" })];
    const settled = Promise.allSettled(calls);
    expect(transport).toHaveBeenCalledTimes(3);
    gate.reject(new Error("network"));
    await settled;
    transport.mockResolvedValueOnce({ ok: true });
    await expect(read("/a", { token: "u1" })).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("does not reuse pre-mutation reads or share writes", async () => {
    const old = deferred();
    const transport = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ fresh: true });
    const read = createNovelRequest(transport as typeof request);
    const before = read("/a", { token: "u1" });
    await Promise.all([read("/a", { token: "u1", method: "PUT" }), read("/a", { token: "u1", method: "PUT" })]);
    expect(await read("/a", { token: "u1" })).toEqual({ fresh: true });
    expect(transport).toHaveBeenCalledTimes(4);
    old.resolve({ stale: true });
    await before;
  });
});
