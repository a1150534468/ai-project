import type { FastifyReply } from "fastify";
import { SSE_HEARTBEAT_MS } from "./routes-runtime.js";

export interface ChatEventStream {
  send(event: string, data: unknown): void;
  close(): void;
}

export function openChatEventStream(reply: FastifyReply, heartbeatMs = SSE_HEARTBEAT_MS): ChatEventStream {
  const response = reply.raw as typeof reply.raw & { flush?: () => void };
  let writable = true;

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders?.();

  let heartbeat: NodeJS.Timeout | undefined;
  const stopHeartbeat = () => {
    if (heartbeat === undefined) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const markClosed = () => {
    writable = false;
    stopHeartbeat();
  };
  response.once("close", markClosed);

  const send = (event: string, data: unknown) => {
    if (!writable || response.destroyed || response.writableEnded) return;
    try {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.flush?.();
    } catch {
      markClosed();
    }
  };

  heartbeat = setInterval(() => send("ping", { ts: Date.now() }), heartbeatMs);
  heartbeat.unref?.();

  return {
    send,
    close() {
      markClosed();
      response.off("close", markClosed);
      if (!response.destroyed && !response.writableEnded) response.end();
    },
  };
}
