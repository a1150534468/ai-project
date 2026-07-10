import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getPrisma, getRedis } from "@yc/db";
import {
  clientMessageSchema,
  type ConnectorTool,
  type HubMessage,
  type ToolInvoke,
} from "@yc/connector-protocol";
import { createRegistry } from "./registry.js";
import { createDispatcher, type Dispatcher } from "./dispatch.js";
import {
  verifyDeviceToken,
  touchDevice,
  refreshDeviceHeartbeat,
  replaceOtherUserDevices,
  openSession,
  closeSession,
} from "../device/service.js";
import { createBillingClient } from "@yc/billing";
import { createLlmClient, loadLlmConfig } from "@yc/llm";
import { runTurn } from "../agent/run.js";
import { resolveBindingByDevice } from "../wechat/binding.js";
import { runWechatTurn } from "../wechat/turn.js";
import { handleWechatInbound, handleWechatStatus } from "../wechat/service.js";

export interface HubConnCtx {
  send: (msg: HubMessage) => void;
  onRegistered: (
    deviceId: string,
    userId: string,
    appVersion: string,
    capabilities: readonly string[],
    tools: readonly ConnectorTool[],
  ) => Promise<void>;
  onHeartbeat: (deviceId: string) => Promise<void>;
  onClose: () => Promise<void>;
  resolveTool: (deviceId: string, id: string, data: string) => Promise<void> | void;
  rejectTool: (deviceId: string, id: string, code: string, message: string) => Promise<void> | void;
  verifyToken: (token: string) => Promise<{ id: string; userId: string } | null>;
  onWechatInbound: (deviceId: string, msg: import("@yc/connector-protocol").WechatInbound) => Promise<void>;
  onWechatStatus: (deviceId: string, msg: import("@yc/connector-protocol").WechatStatus) => Promise<void>;
  log?: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };
  registered: boolean;
  deviceId: string | null;
  sessionId: string | null;
}

export async function handleClientMessage(ctx: HubConnCtx, raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  const rawType =
    typeof (parsed as { type?: unknown })?.type === "string" ? (parsed as { type: string }).type : "";
  if (rawType.startsWith("wechat.")) {
    ctx.log?.info({ rawType, registered: ctx.registered }, "hub 收到 wechat.* 原始消息");
  }
  const r = clientMessageSchema.safeParse(parsed);
  if (!r.success) {
    if (rawType.startsWith("wechat.")) {
      ctx.log?.warn({ rawType, issues: r.error.issues.slice(0, 5) }, "hub wechat.* 消息 schema 校验失败被丢弃");
    }
    return;
  }
  const msg = r.data;

  if (msg.type === "device.register") {
    const dev = await ctx.verifyToken(msg.token);
    if (!dev || dev.id !== msg.deviceId) {
      ctx.send({ type: "device.ack", ok: false, serverTime: Date.now() });
      return;
    }
    ctx.registered = true;
    ctx.deviceId = dev.id;
    await ctx.onRegistered(dev.id, dev.userId, msg.appVersion, msg.capabilities, msg.tools);
    ctx.send({ type: "device.ack", ok: true, serverTime: Date.now() });
    return;
  }

  if (!ctx.registered || !ctx.deviceId) return; // 注册前其它消息一律忽略

  switch (msg.type) {
    case "tool.result":
      await ctx.resolveTool(ctx.deviceId, msg.id, msg.data);
      break;
    case "tool.error":
      await ctx.rejectTool(ctx.deviceId, msg.id, msg.code, msg.message);
      break;
    case "tool.stream":
      // v1 暂不向上游转发流，仅忽略（结果由 tool.result 汇总）
      break;
    case "hb.pong":
      await ctx.onHeartbeat(ctx.deviceId);
      break;
    case "wechat.inbound":
      await ctx.onWechatInbound(ctx.deviceId, msg);
      break;
    case "wechat.status":
      await ctx.onWechatStatus(ctx.deviceId, msg);
      break;
  }
}

// ---- socket 装配（多实例 + 跨实例转发）----
const INSTANCE_ID = randomUUID();

interface RemoteInvoke { kind: "invoke"; replyTo: string; deviceId: string; invoke: ToolInvoke; }
interface RemoteResult { kind: "result"; id: string; ok: boolean; data?: string; code?: string; message?: string; }
interface RemoteDisconnect { kind: "disconnect"; deviceId: string; immediate?: boolean; }
interface LocalConnection {
  connectionId: string;
  send: (msg: HubMessage) => void;
  close: () => void;
}

const DEFAULT_DISCONNECT_GRACE_MS = 60_000;

function disconnectGraceMs(): number {
  const raw = Number(process.env.CONNECTOR_DISCONNECT_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DISCONNECT_GRACE_MS;
}

let dispatcherRef: Dispatcher | null = null;
export function getDispatcher(): Dispatcher {
  if (!dispatcherRef) throw new Error("hub 未初始化");
  return dispatcherRef;
}
export function getInstanceId(): string {
  return INSTANCE_ID;
}

export type KickRoute = "local" | "remote" | "noop";

// 踢线路由决策（纯函数）：本地直接关；非本地且 owner 为他实例则远端转发；否则无操作。
export function decideKick(isLocal: boolean, owner: string | null, instanceId: string): KickRoute {
  if (isLocal) return "local";
  if (owner && owner !== instanceId) return "remote";
  return "noop";
}

let kickRef: ((deviceId: string) => Promise<void>) | null = null;
export function kickDevice(deviceId: string): Promise<void> {
  if (!kickRef) throw new Error("hub 未初始化");
  return kickRef(deviceId);
}

export async function registerHub(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const redis = getRedis();
  const pub = redis;
  const sub = redis.duplicate();
  const registry = createRegistry(redis as never);

  const local = new Map<string, LocalConnection>();
  const disconnectFailTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const immediateDisconnects = new Set<string>();

  const dispatcher = createDispatcher({
    send: async (deviceId, invoke) => {
      const localConn = local.get(deviceId);
      if (localConn) {
        localConn.send(invoke);
        return;
      }
      const owner = await registry.getLocation(deviceId);
      if (!owner) throw new Error("DEVICE_OFFLINE: 设备不在线");
      const payload: RemoteInvoke = { kind: "invoke", replyTo: INSTANCE_ID, deviceId, invoke };
      await pub.publish(`yunclaude:conn:inbox:${owner}`, JSON.stringify(payload));
    },
    onPendingCreated: async (id, _deviceId, timeoutMs) => {
      try {
        await registry.setPendingOwner(id, INSTANCE_ID, timeoutMs);
      } catch (error) {
        app.log.warn({ err: error, id }, "connector pending owner register failed");
      }
    },
    onPendingSettled: async (id) => {
      try {
        await registry.clearPendingOwner(id);
      } catch (error) {
        app.log.debug({ err: error, id }, "connector pending owner clear failed");
      }
    },
  });
  dispatcherRef = dispatcher;

  const cancelDisconnectFail = (deviceId: string): void => {
    const timer = disconnectFailTimers.get(deviceId);
    if (!timer) return;
    clearTimeout(timer);
    disconnectFailTimers.delete(deviceId);
  };

  const markImmediateDisconnect = (deviceId: string): void => {
    immediateDisconnects.add(deviceId);
    cancelDisconnectFail(deviceId);
  };

  const scheduleDisconnectFail = (deviceId: string): void => {
    cancelDisconnectFail(deviceId);
    const timer = setTimeout(() => {
      disconnectFailTimers.delete(deviceId);
      void (async () => {
        const owner = await registry.getLocation(deviceId);
        if (owner) {
          app.log.debug({ deviceId, owner }, "connector disconnect recovered before pending fail");
          return;
        }
        dispatcher.failDevice(deviceId, "CONNECTION_LOST");
        app.log.info({ deviceId }, "connector disconnect grace expired");
      })().catch((error) => {
        app.log.warn({ err: error, deviceId }, "connector disconnect grace check failed");
      });
    }, disconnectGraceMs());
    timer.unref?.();
    disconnectFailTimers.set(deviceId, timer);
  };

  const routePendingResult = async (m: RemoteResult, source: string): Promise<boolean> => {
    const owner = await registry.getPendingOwner(m.id);
    if (!owner) {
      app.log.debug({ id: m.id, source }, "connector result ignored: pending owner missing");
      return false;
    }
    if (owner === INSTANCE_ID) {
      app.log.debug({ id: m.id, source }, "connector result ignored: local pending missing");
      return false;
    }
    await pub.publish(`yunclaude:conn:inbox:${owner}`, JSON.stringify(m));
    app.log.debug({ id: m.id, owner, source }, "connector result forwarded to pending owner");
    return true;
  };

  const settleRemoteResult = (m: RemoteResult): boolean => {
    if (m.ok) return dispatcher.resolve("", m.id, m.data ?? "");
    return dispatcher.reject("", m.id, m.code ?? "EXEC_ERROR", m.message ?? "");
  };

  // 踢线：清位置键 + 本地关 socket 或经 inbox 通知 owner 实例关闭。异常吞掉不影响吊销。
  const kick = async (deviceId: string): Promise<void> => {
    try {
      const localConn = local.get(deviceId);
      const isLocal = Boolean(localConn);
      if (isLocal) markImmediateDisconnect(deviceId);
      const owner = isLocal ? INSTANCE_ID : await registry.getLocation(deviceId);
      await registry.clearLocation(deviceId);
      const route = decideKick(isLocal, owner, INSTANCE_ID);
      if (route === "local") {
        localConn?.close();
      } else if (route === "remote") {
        const payload: RemoteDisconnect = { kind: "disconnect", deviceId, immediate: true };
        await pub.publish(`yunclaude:conn:inbox:${owner}`, JSON.stringify(payload));
      }
    } catch (error) {
      if (error instanceof Error) {
        app.log.debug({ err: error, deviceId }, "connector kick failed");
        return;
      }
      throw error;
    }
  };
  kickRef = kick;

  // ---- 微信服务装配 ----
  const wechatBilling = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const wechatLlm = createLlmClient(loadLlmConfig());
  const wechatDeps = {
    resolveBinding: (deviceId: string) => resolveBindingByDevice(prisma, deviceId),
    runTurn: (
      binding: import("../wechat/binding.js").ResolvedBinding,
      text: string,
      media: import("@yc/connector-protocol").WechatInbound["media"],
    ) =>
      runWechatTurn({
        prisma,
        billing: wechatBilling,
        runTurn,
        client: wechatLlm,
        binding,
        text,
        media,
      }),
    sendToDevice: (deviceId: string, msg: import("@yc/connector-protocol").WechatSend) => {
      const c = local.get(deviceId);
      if (!c) return false;
      c.send(msg);
      return true;
    },
  };
  const updateWechatOnline = async (deviceId: string, online: boolean, reason?: string) => {
    await prisma.wechatBinding
      .updateMany({
        where: { deviceId },
        data: { online, lastSeenAt: new Date() },
      })
      .catch(() => {});
  };

  // 订阅本实例 inbox：处理远端发来的 invoke / result / disconnect
  await sub.subscribe(`yunclaude:conn:inbox:${INSTANCE_ID}`);
  sub.on("message", (_ch, raw) => {
    void (async () => {
      let m: RemoteInvoke | RemoteResult | RemoteDisconnect;
      try {
        m = JSON.parse(raw);
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      if (m.kind === "invoke") {
        const localConn = local.get(m.deviceId);
        if (!localConn) return; // 设备已离开本实例
        forwardRemoteInvoke(local, pub, m);
      } else if (m.kind === "result") {
        const handled = settleRemoteResult(m);
        if (!handled) await routePendingResult(m, "inbox");
      } else if (m.kind === "disconnect") {
        if (m.immediate) markImmediateDisconnect(m.deviceId);
        local.get(m.deviceId)?.close(); // 本实例持有则关闭，触发 onClose 清理
      }
    })().catch((error) => {
      app.log.warn({ err: error }, "connector inbox message failed");
    });
  });

  // 优雅关闭：关掉订阅连接，避免测试/重启时连接泄漏
  app.addHook("onClose", async () => {
    for (const timer of disconnectFailTimers.values()) {
      clearTimeout(timer);
    }
    disconnectFailTimers.clear();
    try {
      await sub.quit();
    } catch (error) {
      if (error instanceof Error) {
        app.log.debug({ err: error }, "connector inbox subscriber close failed");
        return;
      }
      throw error;
    }
  });

  app.get("/ws/connector", { websocket: true }, (socket) => {
    const connectionId = randomUUID();
    const ctx: HubConnCtx = {
      send: (msg) => socket.send(JSON.stringify(msg)),
      verifyToken: async (token) => {
        const d = await verifyDeviceToken(prisma, token);
        return d ? { id: d.id, userId: d.userId } : null;
      },
      onWechatInbound: (deviceId, msg) => {
        app.log.info(
          { deviceId, from: msg.from, textLen: msg.text.length, media: msg.media.length, msgId: msg.msgId },
          "wechat inbound 收到",
        );
        void updateWechatOnline(deviceId, true); // 收到消息=该绑定在线
        return handleWechatInbound(wechatDeps, msg)
          .then(() => app.log.info({ deviceId, from: msg.from }, "wechat inbound 已处理并下发回复"))
          .catch((err) => app.log.error({ err, deviceId, from: msg.from }, "wechat inbound 处理失败"));
      },
      onWechatStatus: (_deviceId, msg) => {
        app.log.info({ deviceId: msg.deviceId, state: msg.state }, "wechat status");
        return handleWechatStatus(updateWechatOnline, msg);
      },
      onRegistered: async (deviceId, userId, appVersion, capabilities, tools) => {
        const replacedDeviceIds = await replaceOtherUserDevices(prisma, userId, deviceId);
        for (const replacedDeviceId of replacedDeviceIds) {
          await kick(replacedDeviceId);
        }
        const previousOwner = await registry.getLocation(deviceId);
        cancelDisconnectFail(deviceId);
        const previous = local.get(deviceId);
        const next: LocalConnection = {
          connectionId,
          send: (msg) => socket.send(JSON.stringify(msg)),
          close: () => socket.close(),
        };
        local.set(deviceId, next);
        if (previous && previous.connectionId !== connectionId) {
          previous.close();
        }
        await registry.setLocation(deviceId, INSTANCE_ID);
        if (previousOwner && previousOwner !== INSTANCE_ID) {
          const payload: RemoteDisconnect = { kind: "disconnect", deviceId };
          await pub.publish(`yunclaude:conn:inbox:${previousOwner}`, JSON.stringify(payload));
        }
        await touchDevice(prisma, deviceId, appVersion, capabilities, tools);
        const s = await openSession(prisma, deviceId, userId, appVersion);
        ctx.sessionId = s.id;
      },
      onHeartbeat: async (deviceId) => {
        if (local.get(deviceId)?.connectionId !== connectionId) return;
        await registry.setLocation(deviceId, INSTANCE_ID);
        await refreshDeviceHeartbeat(prisma, deviceId);
      },
      onClose: async () => {
        if (!ctx.deviceId) return;
        const deviceId = ctx.deviceId;
        const localConn = local.get(deviceId);
        const ownsLocalConnection = localConn?.connectionId === connectionId;
        let stillOnlineElsewhere = false;

        if (ownsLocalConnection) {
          local.delete(deviceId);
          const cleared = await registry.clearLocationIfOwner(deviceId, INSTANCE_ID);
          stillOnlineElsewhere = !cleared && Boolean(await registry.getLocation(deviceId));
        }

        const immediate = immediateDisconnects.delete(deviceId);
        if (immediate) {
          cancelDisconnectFail(deviceId);
          dispatcher.failDevice(deviceId, "CONNECTION_LOST");
        } else if (ownsLocalConnection && !stillOnlineElsewhere) {
          scheduleDisconnectFail(deviceId);
        }

        if (ctx.sessionId) {
          await closeSession(prisma, ctx.sessionId, deviceId, {
            markOffline: ownsLocalConnection && !stillOnlineElsewhere,
          });
        }
      },
      resolveTool: async (deviceId, id, data) => {
        const handled = dispatcher.resolve(deviceId, id, data);
        if (!handled) {
          await routePendingResult({ kind: "result", id, ok: true, data }, "client");
        }
      },
      rejectTool: async (deviceId, id, code, message) => {
        const handled = dispatcher.reject(deviceId, id, code, message);
        if (!handled) {
          await routePendingResult({ kind: "result", id, ok: false, code, message }, "client");
        }
      },
      registered: false,
      deviceId: null,
      sessionId: null,
      log: app.log,
    };

    // 心跳：每 25s ping
    const hb = setInterval(() => ctx.send({ type: "hb.ping", ts: Date.now() }), 25_000);

    socket.on("message", (data: Buffer) => void handleClientMessage(ctx, data.toString()));
    socket.on("close", () => {
      clearInterval(hb);
      void ctx.onClose();
    });
  });
}

// owner 实例本地执行远端 invoke，并把结果 publish 回 replyTo
function forwardRemoteInvoke(
  local: Map<string, LocalConnection>,
  pub: { publish: (ch: string, msg: string) => Promise<number> },
  m: RemoteInvoke,
): void {
  if (!local.has(m.deviceId)) return;
  const d = getDispatcher();
  d.dispatchTool({
    deviceId: m.deviceId,
    userId: "_",
    deviceUserId: "_",
    tool: m.invoke.tool,
    args: m.invoke.args,
    timeoutMs: m.invoke.timeoutMs,
  })
    .then((data) => {
      const res: RemoteResult = { kind: "result", id: m.invoke.id, ok: true, data };
      void pub.publish(`yunclaude:conn:inbox:${m.replyTo}`, JSON.stringify(res));
    })
    .catch((err: Error) => {
      const [code, ...rest] = err.message.split(": ");
      const res: RemoteResult = { kind: "result", id: m.invoke.id, ok: false, code, message: rest.join(": ") };
      void pub.publish(`yunclaude:conn:inbox:${m.replyTo}`, JSON.stringify(res));
    });
}
