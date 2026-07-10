import { describe, it, expect, vi } from "vitest";
import { createConnection, type ConnectionDeps, type MinimalSocket } from "./ws-client.js";

type SocketEvent = "open" | "message" | "close" | "error";

interface FakeSocket extends MinimalSocket {
  readonly sent: unknown[];
  readonly closeCalls: number;
  fire: (ev: SocketEvent, data?: unknown) => void;
}

function fakeSocket(): FakeSocket {
  const handlers: Record<string, ((d?: unknown) => void)[]> = {};
  const sent: unknown[] = [];
  let closeCalls = 0;
  return {
    sent,
    get closeCalls() { return closeCalls; },
    on(ev, cb) { (handlers[ev] ??= []).push(cb); return this; },
    send(data) { sent.push(JSON.parse(String(data))); },
    close() { closeCalls += 1; },
    fire(ev, data) { (handlers[ev] ?? []).forEach((h) => h(data)); },
  };
}

const base = {
  getToken: () => "dev-token",
  appVersion: "1.0.0",
  platform: "win",
  deviceId: "dev1",
  daemonCtx: { send: () => {}, executeTool: async () => "", confirm: async () => true, onRegistered: () => {}, wechatSendReply: async () => {} },
} satisfies Omit<ConnectionDeps, "makeSocket">;

function hasType(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}

function requiredSocket(sockets: readonly FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index];
  if (!socket) {
    throw new Error(`missing socket at index ${index}`);
  }
  return socket;
}

describe("createConnection", () => {
  it("连上发送 device.register", () => {
    const sock = fakeSocket();
    createConnection({ ...base, makeSocket: () => sock });
    sock.fire("open");
    expect(sock.sent[0]).toMatchObject({ type: "device.register", token: "dev-token", deviceId: "dev1", appVersion: "1.0.0", platform: "win" });
  });
  it("注册时上报本地工具能力", () => {
    const sock = fakeSocket();
    createConnection({ ...base, capabilities: ["terminal_exec", "fs_read"], makeSocket: () => sock });
    sock.fire("open");
    expect(sock.sent[0]).toMatchObject({
      type: "device.register",
      capabilities: ["terminal_exec", "fs_read"],
    });
  });

  it("注册时上报已安装 skill 的动态工具定义", () => {
    const sock = fakeSocket();
    createConnection({
      ...base,
      capabilities: ["skill_10270"],
      tools: [{
        name: "skill_10270",
        description: "执行已安装的 skill",
        input_schema: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
        },
      }],
      makeSocket: () => sock,
    });
    sock.fire("open");
    expect(sock.sent[0]).toMatchObject({
      type: "device.register",
      capabilities: ["skill_10270"],
      tools: [{ name: "skill_10270" }],
    });
  });
  it("收 hb.ping 经 reducer 回 hb.pong（走 socket）", () => {
    const sock = fakeSocket();
    createConnection({ ...base, makeSocket: () => sock });
    sock.fire("open");
    sock.fire("message", JSON.stringify({ type: "hb.ping", ts: 1 }));
    expect(sock.sent.some((m) => hasType(m, "hb.pong"))).toBe(true);
  });

  it("注册成功前连续断线时继续指数退避，注册成功后重置退避", () => {
    const sockets: FakeSocket[] = [];
    const delays: number[] = [];
    const reconnects: Array<() => void> = [];

    createConnection({
      ...base,
      makeSocket: () => {
        const sock = fakeSocket();
        sockets.push(sock);
        return sock;
      },
      scheduleReconnect: (delayMs, fn) => {
        delays.push(delayMs);
        reconnects.push(fn);
      },
    });

    const first = requiredSocket(sockets, 0);
    first.fire("open");
    first.fire("close");
    reconnects[0]?.();

    const second = requiredSocket(sockets, 1);
    second.fire("open");
    second.fire("close");
    reconnects[1]?.();

    const third = requiredSocket(sockets, 2);
    third.fire("open");
    third.fire("message", JSON.stringify({ type: "device.ack", ok: true, serverTime: 1 }));
    third.fire("close");

    expect(delays).toEqual([1000, 2000, 1000]);
  });

  it("服务端拒绝注册时主动关闭 socket，交给 close 事件走重试", () => {
    const sock = fakeSocket();

    createConnection({ ...base, makeSocket: () => sock });
    sock.fire("open");
    sock.fire("message", JSON.stringify({ type: "device.ack", ok: false, serverTime: 1 }));

    expect(sock.closeCalls).toBe(1);
  });

  it("socket error 时主动关闭，避免半断连卡住", () => {
    const sock = fakeSocket();

    createConnection({ ...base, makeSocket: () => sock });
    sock.fire("error");

    expect(sock.closeCalls).toBe(1);
  });

  it("stop 会关闭当前 socket 且阻止后续重连", () => {
    const sock = fakeSocket();
    const delays: number[] = [];

    const conn = createConnection({
      ...base,
      makeSocket: () => sock,
      scheduleReconnect: (delayMs) => {
        delays.push(delayMs);
      },
    });

    conn.stop();
    sock.fire("close");

    expect(sock.closeCalls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("收 wechat.send 消息被正确处理并回调 wechatSendReply", async () => {
    const wechatSendReply = vi.fn(async () => {});
    const sock = fakeSocket();
    createConnection({
      ...base,
      daemonCtx: { ...base.daemonCtx, wechatSendReply },
      makeSocket: () => sock,
    });
    sock.fire("open");
    sock.fire("message", JSON.stringify({ type: "device.ack", ok: true, serverTime: 1 }));
    sock.fire("message", JSON.stringify({
      type: "wechat.send",
      id: "msg1",
      to: "wxid_abc123",
      contextToken: "ctx_token_xyz",
      text: "Hello from server",
    }));
    // 给异步处理一点时间
    await new Promise((r) => setTimeout(r, 10));
    expect(wechatSendReply).toHaveBeenCalledWith({
      to: "wxid_abc123",
      contextToken: "ctx_token_xyz",
      text: "Hello from server",
    });
  });
});
