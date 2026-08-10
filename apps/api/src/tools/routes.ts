import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/require-user.js";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { connectorToolSchema, localTools, TOOL_SKILL_MARKET_INSTALL, type ConnectorTool } from "@ai-assistant/connector-protocol";
import { getDispatcher } from "../connector/hub.js";
import { pickActiveDevice } from "../connector/select-device.js";
import { touchDevice } from "../device/service.js";
import { findMarketSkill, listMarketCategories, listMarketSkills } from "../tool-market/catalog.js";
import type { MarketSkill } from "../tool-market/types.js";
import { buildInstallRecord } from "./market-tools.js";
import { availableInstalledToolNames, parseDeviceTools } from "./tool-mounts.js";

const installSchema = z.object({
  categoryKey: z.string().min(1).max(80),
  marketId: z.string().min(1).max(80),
});

const installResultSchema = z.object({
  tool: connectorToolSchema,
});

function installTimeoutMs(): number {
  const raw = Number(process.env.TOOL_INSTALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
}

function toolMarketDownloadUrl(marketId: string): string | null {
  const base = process.env.TOOL_MARKET_DOWNLOAD_BASE_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/${marketId}.zip`;
}

function builtinTools(availableToolNames: ReadonlySet<string>) {
  return localTools.map((tool) => ({
    id: tool.name,
    name: tool.name,
    toolName: tool.name,
    description: tool.description,
    builtin: true,
    installed: true,
    availableOnCurrentDevice: availableToolNames.has(tool.name),
  }));
}

function installDto(row: {
  id: string;
  categoryKey: string;
  marketId: string;
  name: string;
  description: string;
  toolName: string;
  status: string;
  installedAt: Date;
  updatedAt: Date;
}, availableOnCurrentDevice = false) {
  return {
    id: row.id,
    categoryKey: row.categoryKey,
    marketId: row.marketId,
    name: row.name,
    description: row.description,
    toolName: row.toolName,
    status: row.status,
    installedAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    builtin: false,
    installed: row.status === "installed",
    availableOnCurrentDevice: row.status === "installed" && availableOnCurrentDevice,
  };
}

export async function toolRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.get("/api/tool-market", async (_req, reply) => {
    return reply.send({ success: true, data: listMarketCategories() });
  });

  app.get("/api/tool-market/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    try {
      return reply.send({ success: true, data: listMarketSkills(key) });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("UNKNOWN_CATEGORY")) {
        return reply.code(404).send({ error: "分类不存在" });
      }
      throw error;
    }
  });

  app.get("/api/tools/installed", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const rows = await prisma.userToolInstall.findMany({
      where: { userId, status: "installed" },
      orderBy: { updatedAt: "desc" },
    });
    const devices = await prisma.device.findMany({
      where: { userId, online: true, revokedAt: null },
      select: { id: true, userId: true, lastSeenAt: true, appVersion: true, capabilities: true, tools: true },
    });
    const active = pickActiveDevice(devices);
    const availableBuiltinToolNames = new Set(active?.capabilities ?? []);
    const availableSkillToolNames = active
      ? availableInstalledToolNames(active.capabilities, parseDeviceTools(active.tools))
      : new Set<string>();
    return reply.send({
      success: true,
      data: {
        currentDeviceOnline: Boolean(active),
        builtin: builtinTools(availableBuiltinToolNames),
        installed: rows.map((row) => installDto(row, availableSkillToolNames.has(row.toolName))),
      },
    });
  });

  app.post("/api/tools/install", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const parsed = installSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    let skill: MarketSkill | null;
    try {
      skill = findMarketSkill(parsed.data.categoryKey, parsed.data.marketId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("UNKNOWN_CATEGORY")) {
        return reply.code(404).send({ error: "分类不存在" });
      }
      throw error;
    }
    if (!skill) return reply.code(404).send({ error: "工具不存在" });

    const record = buildInstallRecord({
      categoryKey: parsed.data.categoryKey,
      marketId: skill.id,
      name: skill.name,
    });

    const devices = await prisma.device.findMany({
      where: { userId, online: true, revokedAt: null },
      select: { id: true, userId: true, lastSeenAt: true, appVersion: true, capabilities: true, tools: true },
    });
    const active = pickActiveDevice(devices);
    if (!active) return reply.code(409).send({ error: "需要唯一在线的本机 Connector 才能安装工具" });

    let installedTool: ConnectorTool;
    try {
      const raw = await getDispatcher().dispatchTool({
        deviceId: active.id,
        userId,
        deviceUserId: active.userId,
        tool: TOOL_SKILL_MARKET_INSTALL,
        args: {
          categoryKey: parsed.data.categoryKey,
          marketId: skill.id,
          name: skill.name,
          downloadUrl: toolMarketDownloadUrl(skill.id),
        },
        timeoutMs: installTimeoutMs(),
      });
      installedTool = installResultSchema.parse(JSON.parse(raw)).tool;
    } catch (error) {
      const message = error instanceof Error ? error.message : "本地安装失败";
      return reply.code(502).send({ error: "本地安装失败", detail: message });
    }

    const nextTools = [
      ...parseDeviceTools(active.tools).filter((tool) => tool.name !== installedTool.name),
      installedTool,
    ];
    const nextCapabilities = [...new Set([...active.capabilities, installedTool.name])];
    await touchDevice(prisma, active.id, active.appVersion, nextCapabilities, nextTools);

    const row = await prisma.userToolInstall.upsert({
      where: {
        userId_marketId: {
          userId,
          marketId: skill.id,
        },
      },
      create: {
        userId,
        categoryKey: record.categoryKey,
        marketId: record.marketId,
        name: record.name,
        description: record.description,
        toolName: record.toolName,
        status: record.status,
      },
      update: {
        categoryKey: record.categoryKey,
        name: record.name,
        description: record.description,
        toolName: record.toolName,
        status: record.status,
      },
    });

    return reply.send({ success: true, data: installDto(row, true) });
  });

  app.delete("/api/tools/:toolName", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const { toolName } = req.params as { toolName: string };
    await prisma.userToolInstall.updateMany({
      where: { userId, toolName },
      data: { status: "uninstalled" },
    });
    return reply.send({ success: true });
  });
}
