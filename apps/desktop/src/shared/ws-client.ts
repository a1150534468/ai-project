import type { ConnectorTool, HubMessage } from "@ai-assistant/connector-protocol";
import { handleHubMessage, nextBackoffMs, type DaemonCtx } from "./daemon.js";

export interface MinimalSocket {
  on(event: "open" | "message" | "close" | "error", cb: (data?: unknown) => void): MinimalSocket;
  send(data: string): void;
  close(): void;
}

export interface ConnectionDeps {
  makeSocket: () => MinimalSocket;
  getToken: () => string | null;
  appVersion: string;
  platform: "win" | "mac" | "linux";
  deviceId: string;
  capabilities?: readonly string[];
  tools?: readonly ConnectorTool[];
  daemonCtx: DaemonCtx;
  scheduleReconnect?: (delayMs: number, fn: () => void) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHubMessage(value: unknown): value is HubMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "device.ack") {
    return typeof value.ok === "boolean" && typeof value.serverTime === "number";
  }

  if (value.type === "hb.ping") {
    return typeof value.ts === "number";
  }

  if (value.type === "tool.invoke") {
    return (
      typeof value.id === "string" &&
      typeof value.tool === "string" &&
      isRecord(value.args) &&
      typeof value.timeoutMs === "number"
    );
  }

  if (value.type === "wechat.send") {
    return (
      typeof value.id === "string" &&
      typeof value.to === "string" &&
      typeof value.contextToken === "string" &&
      typeof value.text === "string"
    );
  }

  return false;
}

export function createConnection(deps: ConnectionDeps): { stop: () => void; send: (msg: unknown) => void } {
  let attempt = 0;
  let stopped = false;
  let currentSocket: MinimalSocket | null = null;
  const schedule = deps.scheduleReconnect ?? ((ms, fn) => { setTimeout(fn, ms).unref?.(); });
  const ctx: DaemonCtx = { ...deps.daemonCtx };

  function isActiveSocket(sock: MinimalSocket): boolean {
    return !stopped && currentSocket === sock;
  }

  function closeSocket(sock: MinimalSocket): void {
    try {
      sock.close();
    } catch (error) {
      if (error instanceof Error) {
        return;
      }
      throw error;
    }
  }

  function connect(): void {
    if (stopped) return;
    const sock = deps.makeSocket();
    currentSocket = sock;
    ctx.send = (msg) => sock.send(JSON.stringify(msg));

    sock.on("open", () => {
      if (!isActiveSocket(sock)) return;
      const token = deps.getToken();
      if (!token) {
        closeSocket(sock);
        return;
      }
      sock.send(JSON.stringify({
        type: "device.register", token, deviceId: deps.deviceId,
        platform: deps.platform, appVersion: deps.appVersion, capabilities: [...(deps.capabilities ?? [])],
        tools: [...(deps.tools ?? [])],
      }));
    });
    sock.on("message", (data) => {
      if (!isActiveSocket(sock)) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      if (!isHubMessage(parsed)) return;
      if (parsed.type === "device.ack") {
        if (!parsed.ok) {
          closeSocket(sock);
          return;
        }
        attempt = 0;
      }
      void handleHubMessage(ctx, parsed);
    });
    sock.on("close", () => {
      if (!isActiveSocket(sock)) return;
      currentSocket = null;
      const delay = nextBackoffMs(attempt);
      attempt += 1;
      schedule(delay, connect);
    });
    sock.on("error", () => {
      if (!isActiveSocket(sock)) return;
      closeSocket(sock);
    });
  }

  connect();
  return {
    stop: () => {
      stopped = true;
      const sock = currentSocket;
      currentSocket = null;
      if (sock) closeSocket(sock);
    },
    send: (msg: unknown) => ctx.send(msg),
  };
}
