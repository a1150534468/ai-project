import type { PrismaClient } from "@ai-assistant/db";

export class BindingForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingForbiddenError";
  }
}

export interface CreateBindingInput {
  deviceId: string;
  targetType: "agent" | "team";
  targetId: string;
  model?: string;
}

const DEFAULT_WECHAT_MODEL = "MiniMax-M3";

export async function createBinding(
  prisma: PrismaClient,
  userId: string,
  input: CreateBindingInput
): Promise<{ id: string }> {
  // 权限校验：设备必须属于当前用户
  const device = await prisma.device.findUnique({
    where: { id: input.deviceId },
    select: { userId: true },
  });

  if (!device || device.userId !== userId) {
    throw new BindingForbiddenError("无权绑定该设备");
  }

  // 检查是否已有绑定
  const existing = await prisma.wechatBinding.findUnique({
    where: { deviceId: input.deviceId },
  });

  // 若已绑定：只换目标 agent，复用原会话线程，不新建 session
  if (existing) {
    const updated = await prisma.wechatBinding.update({
      where: { deviceId: input.deviceId },
      data: {
        targetType: input.targetType,
        targetId: input.targetId,
        model: input.model ?? DEFAULT_WECHAT_MODEL,
      },
    });
    return { id: updated.id };
  }

  // 不存在绑定：创建专属持续会话线程
  const session = await prisma.session.create({
    data: {
      userId,
      title: "微信",
      agentId: input.targetType === "agent" ? input.targetId : undefined,
    },
  });

  // 创建新绑定
  const created = await prisma.wechatBinding.create({
    data: {
      userId,
      deviceId: input.deviceId,
      targetType: input.targetType,
      targetId: input.targetId,
      model: input.model ?? DEFAULT_WECHAT_MODEL,
      sessionId: session.id,
    },
  });

  return { id: created.id };
}

export async function listBindings(prisma: PrismaClient, userId: string) {
  const rows = await prisma.wechatBinding.findMany({ where: { userId } });
  // 在线状态以「设备连接器是否在线」为准（桌面端连上=在线、断开=离线），而非依赖桌面上报 wechat.status
  const devices = await prisma.device.findMany({
    where: { id: { in: rows.map((r) => r.deviceId) } },
    select: { id: true, online: true },
  });
  const onlineByDevice = new Map(devices.map((d) => [d.id, d.online]));
  return rows.map((r) => ({ ...r, online: onlineByDevice.get(r.deviceId) ?? false }));
}

export async function deleteBinding(
  prisma: PrismaClient,
  userId: string,
  id: string
): Promise<void> {
  // 权限校验：绑定必须属于当前用户
  const binding = await prisma.wechatBinding.findUnique({
    where: { id },
  });

  if (!binding || binding.userId !== userId) {
    throw new BindingForbiddenError("无权删除");
  }

  await prisma.wechatBinding.delete({
    where: { id },
  });
}
