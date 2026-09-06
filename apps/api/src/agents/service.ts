import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type { PrismaClient } from "@prisma/client";
import { publicObjectUrl } from "../storage/public-url.js";
import { loadS3Config } from "../storage/s3.js";
import { generateAvatarSvg } from "./avatar.js";
import { CUSTOM_AGENT_ICON } from "./icons.js";
import { getPresetAgent, loadAgentPresets } from "./presets.js";

/**
 * Agent 列表项。内置和自建两种共用这一个形状，前端不需要分支渲染。
 *
 * 后三个字段只有自建 Agent 才有值：内置 Agent 没有创建时间，头像固定用 icon 名字。
 */
export interface AgentOption {
  id: string;
  name: string;
  description: string;
  /** Iconify 名字。头像图片（avatarSvg / avatarUrl）都没有时才会用到它。 */
  icon: string;
  type: "preset" | "custom";
  createdAt?: string;
  /** 模型画的矢量线稿，已经过白名单清洗，可以直接内联。 */
  avatarSvg?: string | null;
  /** 用户自己上传的位图，已转成公网可访问的 URL。优先级高于 avatarSvg。 */
  avatarUrl?: string | null;
}

/** 开一个新会话时需要从 Agent 身上取走的东西。会被整份抄进 `Session` 行，见 chat/routes.ts。 */
export interface AgentRuntime {
  agentId: string;
  agentName: string;
  agentPrompt: string;
  agentIcon: string;
}

/** 生成 Agent 配置和画头像都先用这个模型：够快，格式也稳。 */
const PRIMARY_CREATE_MODEL = "mimo-v2.5-pro-ultraspeed";

/** 主模型出问题（限流、超时、吐不出合法 JSON）就换这个。两个模型走同一个网关，只是权重不同。 */
const FALLBACK_CREATE_MODEL = "MiniMax-M3";

/**
 * `avatarPublicUrl` 的实现被记在这里，包括「S3 没配好」那种情况下的退化实现。
 *
 * 记住失败的结果是有意的：`loadS3Config()` 读的是进程启动就固定的环境变量，
 * 这一次抛错就意味着永远都会抛错。不记的话，一个没配 S3 的环境（本地、CI）
 * 每渲染一次列表就要白抛 N 次异常。
 */
let cachedAvatarUrlOf: ((key: string) => string) | null = null;

/**
 * object key → 可访问的 URL。
 *
 * S3 没配置时**原样返回 key**，而不是抛错或返回 null：本地开发和 CI 都没有对象存储，
 * 但它们仍然需要能把 Agent 列表画出来。头像显示成一个坏图链，比整个接口 500 要好。
 */
export function avatarPublicUrl(key: string | null): string | null {
  if (!key) return null;

  if (!cachedAvatarUrlOf) {
    try {
      const cfg = loadS3Config();
      cachedAvatarUrlOf = (k) => publicObjectUrl(cfg, k);
    } catch {
      cachedAvatarUrlOf = (k) => k;
    }
  }

  return cachedAvatarUrlOf(key);
}

/** 内置 Agent 的列表视图。注意**不带 prompt** —— 提示词是不发给前端的。 */
export function publicPresetAgents(): AgentOption[] {
  return loadAgentPresets().map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    icon: preset.icon,
    type: "preset",
  }));
}

/**
 * 按 id 拿图标。用在只有 `Session.agentId` 可用的地方（会话列表、消息头），不查库。
 *
 * 查不到就当自建 Agent 处理 —— 自建的图标是统一的一个，不需要知道是哪一个；
 * 空 id 落到 preset-1，跟 {@link resolveAgent} 的默认值保持一致。
 */
export function iconForAgentId(agentId?: string | null): string {
  return getPresetAgent(agentId || "preset-1")?.icon ?? CUSTOM_AGENT_ICON;
}

/** 某个用户的自建 Agent，新的在前 —— 刚建完的那个要出现在列表最上面。 */
export async function listCustomAgents(prisma: PrismaClient, userId: string): Promise<AgentOption[]> {
  const rows = await prisma.userAgent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    // 不 select prompt：这个列表是发给前端的，提示词没必要出仓。
    select: { id: true, name: true, description: true, createdAt: true, avatarSvg: true, avatarUrl: true },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    icon: CUSTOM_AGENT_ICON,
    type: "custom",
    createdAt: row.createdAt.toISOString(),
    avatarSvg: row.avatarSvg,
    avatarUrl: avatarPublicUrl(row.avatarUrl),
  }));
}

/**
 * 把一个 agentId 解析成开会话需要的四件套。
 *
 * 三条路，**每一条都返回一个可用的 Agent，绝不返回 null**：开会话这个动作不该因为
 * Agent 找不到而失败（用户可能刚把它删了，或者前端存着一个过期 id）。
 *
 * 1. 内置 id → 直接命中，**不碰数据库**（内置的都在内存里，最常见的路径也就最快）；
 * 2. 自建 id 且属于这个用户 → 用它；
 * 3. 其余（不存在 / 是别人的 / id 是空的）→ 落到 preset-1。
 *
 * `where` 里同时带 `userId`，所以第 3 条把「别人的 Agent」和「不存在」合并成了同一种结果 ——
 * 探测别人有哪些 Agent 这条路也就堵死了。
 *
 * preset-1 自己都没有的时候才抛错：那说明 presets.md 被改坏了，属于部署事故，
 * 得响亮地失败，不能悄悄给用户一个没有人格的助手。
 */
export async function resolveAgent(
  prisma: PrismaClient,
  userId: string,
  agentId?: string | null,
): Promise<AgentRuntime> {
  const id = agentId || "preset-1";

  const preset = getPresetAgent(id);
  if (preset) {
    return { agentId: preset.id, agentName: preset.name, agentPrompt: preset.prompt, agentIcon: preset.icon };
  }

  const custom = await prisma.userAgent.findFirst({ where: { id, userId } });
  if (custom) {
    return { agentId: custom.id, agentName: custom.name, agentPrompt: custom.prompt, agentIcon: CUSTOM_AGENT_ICON };
  }

  const fallback = getPresetAgent("preset-1");
  if (!fallback) throw new Error("default agent missing");
  return { agentId: fallback.id, agentName: fallback.name, agentPrompt: fallback.prompt, agentIcon: fallback.icon };
}

interface GeneratedAgent {
  name: string;
  description: string;
  systemPrompt: string;
}

/**
 * 从模型输出里抠出 Agent 配置。抠不出来就抛错，由调用方决定要不要换模型重试。
 *
 * `/\{[\s\S]*\}/` 是贪婪的，取的是**第一个 `{` 到最后一个 `}`**，所以模型在 JSON 前后
 * 加了「好的，这是配置：」之类的话也不影响。贪婪在这里比懒惰对：JSON 内部一定还有别的 `}`，
 * 懒惰匹配会在第一个内层 `}` 就停下。
 *
 * `name` 和 `systemPrompt` 缺一个就作废 —— 没名字的 Agent 在列表里是一行空白，
 * 没提示词的 Agent 等于没有人格，两种都不如让它失败重来。`description` 可以空，
 * 它只影响列表上的一句话简介。
 *
 * 两个 slice 是**存库前的最后一道闸**：库里的列宽是有限的，而这两个字段的内容由模型决定。
 */
function parseGeneratedAgent(text: string): GeneratedAgent {
  const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as Partial<GeneratedAgent>;

  const name = parsed.name?.trim();
  const systemPrompt = parsed.systemPrompt?.trim();
  if (!name || !systemPrompt) throw new Error("invalid generated agent");

  return {
    name: name.slice(0, 40),
    description: parsed.description?.trim().slice(0, 160) ?? "",
    // 提示词不截断：截一半的 system prompt 会得到一个行为莫名其妙的 Agent。
    systemPrompt,
  };
}

/** 只输出 JSON 这条要求要写死在 system 里；写在 user 消息里模型会当成「本次任务的偏好」而不是硬约束。 */
const GENERATE_SYSTEM = "你是智能体配置生成器。只输出 JSON，不要 Markdown。";

/** 跑一次生成。JSON 解析失败也会从这里抛出去 —— 对调用方来说「这个模型不行」是一回事。 */
async function requestGeneratedAgent(client: Anthropic, model: string, requirement: string): Promise<GeneratedAgent> {
  const resp = await client.messages.create({
    model,
    // systemPrompt 是这三个字段里最长的，2200 够写一份几百字的人格设定还有余量。
    max_tokens: 2200,
    system: GENERATE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "把下面这句需求变成一个中文智能体的配置，systemPrompt 要能直接拿去当 system prompt 用。",
          "",
          `需求：${requirement}`,
          "",
          "输出一个 JSON 对象，三个字段：",
          "- name：不超过 40 字的名字",
          "- description：一句话说清它负责什么",
          "- systemPrompt：完整、具体、可执行的指令；默认允许它使用平台已开放的全部工具",
        ].join("\n"),
      },
    ],
  });

  const text = resp.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return parseGeneratedAgent(text);
}

/**
 * 按一句需求造一个自建 Agent，落库并返回列表项。
 *
 * 主模型失败就换备用模型再来一次，**只重试一次**：两个模型都吐不出合法 JSON，
 * 大概率是需求本身有问题（比如整段是注入指令），再试也是烧钱。
 *
 * 头像用**实际生成成功的那个模型**画，而不是固定用主模型 —— 主模型这会儿正不可用，
 * 拿它画头像只会再等一次超时。头像失败不影响创建（`avatarSvg` 存 null，前端回落默认图标）。
 */
export async function generateCustomAgent(prisma: PrismaClient, userId: string, requirement: string) {
  const client = createLlmClient(loadLlmConfig());

  let modelUsed = PRIMARY_CREATE_MODEL;
  let generated: GeneratedAgent;
  try {
    generated = await requestGeneratedAgent(client, PRIMARY_CREATE_MODEL, requirement);
  } catch {
    modelUsed = FALLBACK_CREATE_MODEL;
    generated = await requestGeneratedAgent(client, FALLBACK_CREATE_MODEL, requirement);
  }

  const avatarSvg = await generateAvatarSvg(client, modelUsed, generated.name, generated.description);

  const row = await prisma.userAgent.create({
    data: {
      userId,
      name: generated.name,
      description: generated.description,
      prompt: generated.systemPrompt,
      // 记下用了哪个模型，出了问题能看出是哪一条路生成的。
      modelUsed,
      avatarSvg,
    },
  });

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: CUSTOM_AGENT_ICON,
    type: "custom" as const,
    modelUsed,
    createdAt: row.createdAt.toISOString(),
    avatarSvg: row.avatarSvg,
    avatarUrl: avatarPublicUrl(row.avatarUrl),
  };
}

/*
 * 下面这些改动/查询有一个共同的写法：条件里**总是同时带 `id` 和 `userId`**，
 * 而且用 `updateMany` / `findFirst` 而不是 `update` / `findUnique`。
 *
 * 这样「Agent 不存在」和「Agent 是别人的」会得到完全一样的结果（`false` / `undefined`），
 * 路由层一律回 404。用 `update` 就做不到 —— 它在记录不存在时抛的错和越权时抛的错不一样，
 * 时序和错误码都会变成一条枚举别人 Agent id 的信道。
 */

/** 重命名。`false` = 不存在或不属于该用户。 */
export async function renameAgent(
  prisma: PrismaClient,
  userId: string,
  id: string,
  name: string,
): Promise<boolean> {
  const result = await prisma.userAgent.updateMany({ where: { id, userId }, data: { name } });
  return result.count === 1;
}

/**
 * 删 Agent，连着它的全部会话和消息一起。
 *
 * `Session.agentId` **没有外键**（它同时要能存内置 Agent 的 `preset-N`，那不是任何表的主键），
 * 所以数据库不会替我们级联，必须手动 `deleteMany`。`Message` 那一层有
 * `onDelete: Cascade` 指向 `Session`，跟着会话一起走。
 *
 * 三步放在一个事务里：删了 Agent 却留下一批指向空 Agent 的会话，比什么都不删更难收拾。
 *
 * 返回被删记录的 `avatarUrl` 交给调用方在**事务外**删对象存储里的文件 ——
 * 网络 IO 不能待在事务里占着连接，而且对象删失败也不该让整个删除回滚
 * （留一个孤儿文件只是浪费空间，回滚会让用户以为没删掉）。
 */
export async function deleteAgentCascade(
  prisma: PrismaClient,
  userId: string,
  id: string,
): Promise<{ avatarUrl: string | null } | undefined> {
  return prisma.$transaction(async (tx) => {
    const agent = await tx.userAgent.findFirst({ where: { id, userId }, select: { avatarUrl: true } });
    if (!agent) return undefined;

    await tx.session.deleteMany({ where: { userId, agentId: id } });
    await tx.userAgent.deleteMany({ where: { id, userId } });

    return { avatarUrl: agent.avatarUrl };
  });
}

/**
 * 重画头像。返回新的 `avatarSvg`（可能是 null，前端回落默认图标）；Agent 不存在返回 `undefined`。
 *
 * 这里的「换模型重试」和创建时不一样：创建看的是**抛没抛错**，这里看的是**画出来没有**。
 * `generateAvatarSvg` 从不抛错，洗不出干净结果就是 null，所以判据只能是返回值。
 *
 * 两次都失败也照样写库（写进 null），这是为了让「重画」有确定的语义：
 * 点了就是要换一张，宁可换成默认图标，也不要让用户以为按钮坏了。
 */
export async function regenerateAgentAvatar(
  prisma: PrismaClient,
  userId: string,
  id: string,
): Promise<{ avatarSvg: string | null } | undefined> {
  const agent = await prisma.userAgent.findFirst({
    where: { id, userId },
    select: { name: true, description: true },
  });
  if (!agent) return undefined;

  const client = createLlmClient(loadLlmConfig());

  let avatarSvg = await generateAvatarSvg(client, PRIMARY_CREATE_MODEL, agent.name, agent.description);
  if (!avatarSvg) {
    avatarSvg = await generateAvatarSvg(client, FALLBACK_CREATE_MODEL, agent.name, agent.description);
  }

  await prisma.userAgent.updateMany({ where: { id, userId }, data: { avatarSvg } });
  return { avatarSvg };
}

/**
 * 取当前头像的 object key。上传新图时用它找到旧文件去删。
 *
 * 返回 `undefined` 表示 Agent 不存在；返回 `{ avatarUrl: null }` 表示存在但还没上传过图 ——
 * 这两种情况调用方的动作不同（404 / 继续上传），所以不能合并成一个 null。
 */
export async function agentAvatarUrlOf(
  prisma: PrismaClient,
  userId: string,
  id: string,
): Promise<{ avatarUrl: string | null } | undefined> {
  const row = await prisma.userAgent.findFirst({ where: { id, userId }, select: { avatarUrl: true } });
  return row ?? undefined;
}

/** 记下新上传的头像 key。`false` = 不存在或不属于该用户。 */
export async function setAgentAvatarUrl(
  prisma: PrismaClient,
  userId: string,
  id: string,
  avatarUrl: string,
): Promise<boolean> {
  const result = await prisma.userAgent.updateMany({ where: { id, userId }, data: { avatarUrl } });
  return result.count === 1;
}
