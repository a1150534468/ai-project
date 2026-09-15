import type { FastifyRequest } from "fastify";
import type { LoadedAdmin } from "./guard.js";

export function requestAdmin(request: FastifyRequest): LoadedAdmin {
  return (request as FastifyRequest & { admin: LoadedAdmin }).admin;
}

export function requestAdminId(request: FastifyRequest): string {
  return requestAdmin(request).id;
}
