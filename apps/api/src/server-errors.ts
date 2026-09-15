import type { FastifyInstance } from "fastify";

interface HttpError {
  readonly statusCode?: number;
  readonly message?: string;
}

function clientStatus(error: HttpError): number {
  return typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
    ? error.statusCode
    : 500;
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    const httpError = error as HttpError;
    const status = clientStatus(httpError);
    if (status >= 500) request.log.error({ err: error }, "unhandled error");
    else request.log.warn({ err: error }, "request error");

    if (reply.raw.headersSent) {
      reply.raw.end();
      return reply;
    }
    const message = status >= 500
      ? "服务器内部错误"
      : typeof httpError.message === "string"
        ? httpError.message
        : "请求失败";
    return reply.code(status).send({ error: message });
  });
}
