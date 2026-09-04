import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifySchema, RouteOptions } from "fastify";

type JsonSchema = Record<string, unknown>;

const tagDefinitions = [
  { name: "系统", description: "服务健康检查和基础信息" },
  { name: "认证", description: "用户注册与登录" },
  { name: "对话", description: "AI 对话和会话记录" },
  { name: "智能体", description: "智能体创建、推荐和执行" },
  { name: "长期记忆", description: "用户长期记忆、搜索与开关" },
  { name: "知识库", description: "用户知识库和文档管理" },
  { name: "工具市场", description: "工具市场、安装和卸载" },
  { name: "设备与连接器", description: "桌面设备配对、连接器和工具桥接" },
  { name: "工作流 · 图片", description: "图片生成、提示词优化和素材管理" },
  { name: "工作流 · Codex 桌宠", description: "Codex v2 桌宠生成、实时进度、安装与知识库归档" },
  { name: "工作流 · 小说", description: "小说工程、章节、资产和自动运行" },
  { name: "工作流 · 文章", description: "文章生成、改写和配图" },
  { name: "工作流 · 批量生成", description: "内容提取和多维批量生成" },
  { name: "公告", description: "公开公告" },
  { name: "管理 · 管理员", description: "管理员账号与权限" },
  { name: "管理 · 用户", description: "用户、设备和配额管理" },
  { name: "管理 · 内容", description: "公告、知识库和客户端菜单管理" },
  { name: "管理 · 审计", description: "管理端操作日志" },
];

const publicRoutes = new Set([
  "GET /health",
  "POST /api/auth/login",
  "POST /api/auth/register",
  "POST /api/admin/login",
  "GET /api/announcements",
  "GET /api/client-menu",
  "GET /api/models",
]);

const exactSummaries: Record<string, string> = {
  "GET /health": "检查 API 服务健康状态",
  "POST /api/auth/register": "注册用户",
  "POST /api/auth/login": "用户登录",
  "GET /api/auth/me": "查询当前登录用户资料",
  "POST /api/admin/login": "管理员登录",
  "POST /api/chat": "发送对话消息",
  "GET /api/sessions": "查询会话列表",
  "GET /api/sessions/:id/messages": "查询会话消息",
  "DELETE /api/sessions/:id": "删除会话",
  "GET /api/models": "查询可用模型",
  "GET /api/client-menu": "查询客户端菜单",
  "GET /api/announcements": "查询当前公告",
  "GET /ws/connector": "建立桌面连接器 WebSocket",
  "POST /api/workflow/dub/skyhuman/callback": "接收数字人服务回调",
  "GET /api/workflow/codex-pets/models": "查询 Codex 桌宠可选生图与视觉质检模型",
  "GET /api/workflow/codex-pets/projects": "查询 Codex 桌宠项目列表",
  "POST /api/workflow/codex-pets/projects": "创建 Codex 桌宠草稿",
  "GET /api/workflow/codex-pets/projects/:projectId": "查询 Codex 桌宠项目详情",
  "PATCH /api/workflow/codex-pets/projects/:projectId": "更新 Codex 桌宠项目",
  "DELETE /api/workflow/codex-pets/projects/:projectId": "软删除 Codex 桌宠项目历史（保留数据与产物）",
  "POST /api/workflow/codex-pets/projects/:projectId/start": "开始制作 Codex 桌宠",
  "POST /api/workflow/codex-pets/projects/:projectId/runs/:runId/base-selection": "确认 Codex 桌宠主形象",
  "POST /api/workflow/codex-pets/projects/:projectId/runs/:runId/cancel": "取消 Codex 桌宠制作",
  "GET /api/workflow/codex-pets/projects/:projectId/runs/:runId/events": "查询 Codex 桌宠进度事件",
  "GET /api/workflow/codex-pets/projects/:projectId/runs/:runId/events/stream": "订阅 Codex 桌宠实时进度",
  "POST /api/workflow/codex-pets/projects/:projectId/install-link": "生成 Codex 桌宠安装深链",
  "GET /api/workflow/codex-pets/projects/:projectId/download": "下载 Codex 桌宠兼容包",
  "GET /api/public/codex-pets/artifacts/:artifactId": "读取签名 Codex 桌宠精灵图或预览",
};

const actionNames: Record<string, string> = {
  login: "登录",
  register: "注册",
  generate: "生成",
  regenerate: "重新生成",
  redraw: "重绘",
  rewrite: "改写",
  analyze: "分析",
  "analyze-materials": "分析素材",
  "analyze-reference": "分析参考内容",
  "analyze-parsed": "分析解析结果",
  parse: "解析",
  cancel: "取消",
  pause: "暂停",
  resume: "继续",
  revise: "修订",
  rollback: "回滚",
  branch: "创建分支",
  restore: "恢复版本",
  import: "导入",
  export: "导出",
  install: "安装",
  revoke: "撤销",
  disable: "禁用",
  delete: "删除",
  confirm: "确认",
  "confirm-team": "确认团队",
  complete: "完成设置",
  render: "渲染",
  stitch: "合成",
  remix: "重新混制",
  activate: "启用版本",
  "optimize-prompt": "优化提示词",
  "ai-draft": "AI 起草",
  backfill: "补建数据",
  "voice-sample": "生成声音样本",
  "bgm-upload": "上传 BGM",
  preview: "预览",
};

const resourceNames: Record<string, string> = {
  admins: "管理员",
  announcements: "公告",
  audit: "审计日志",
  users: "用户",
  devices: "设备",
  models: "模型",
  analytics: "数据分析",
  "client-menu": "客户端菜单",
  kb: "知识库",
  documents: "文档",
  memory: "长期记忆",
  agents: "智能体",
  "agent-teams": "智能体团队",
  runs: "运行记录",
  sessions: "会话",
  messages: "消息",
  "scheduled-tasks": "定时任务",
  tools: "工具",
  "tool-market": "工具市场",
  bindings: "微信绑定",
  projects: "项目",
  tasks: "任务",
  images: "图片",
  videos: "视频",
  references: "参考素材",
  avatars: "数字人形象",
  bgm: "背景音乐",
  voices: "声音",
  episodes: "剧集",
  shots: "分镜",
  assets: "资产",
  bible: "设定集",
  chapters: "章节",
  characters: "角色",
  locations: "地点",
  storylines: "故事线",
  structure: "小说结构",
  prompts: "提示词模板",
  checkpoints: "检查点",
};

const multipartRoutes = new Set([
  "POST /api/agents/generate",
  "POST /api/kb/:id/documents",
  "POST /api/admin/kb/:id/documents",
  "POST /api/admin/dub/bgm",
  "POST /api/workflow/dub/bgm/upload",
  "POST /api/workflow/dub/analyze",
  "POST /api/workflow/dub/avatars",
  "POST /api/workflow/dub/video/generate",
  "POST /api/workflow/local-business-promos/projects/:projectId/audio/bgm-upload",
  "POST /api/workflow/local-business-promos/projects/:projectId/audio/voice-sample",
  "POST /api/workflow/videos/analyze-materials",
  "POST /api/workflow/videos/materials",
]);

const codexPetActionPromptsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  maxProperties: 10,
  description: "每个动作最多 500 字，全部动作合计最多 4000 字",
  properties: Object.fromEntries([
    "idle", "running-right", "running-left", "waving", "jumping",
    "failed", "waiting", "running", "review", "look",
  ].map((key) => [key, { type: "string", maxLength: 500 }])),
};

const bodySchemas: Record<string, JsonSchema> = {
  "POST /api/auth/register": {
    type: "object",
    additionalProperties: false,
    required: ["username", "password"],
    properties: {
      username: { type: "string", minLength: 3, maxLength: 32, description: "用户名" },
      password: { type: "string", minLength: 8, maxLength: 200, format: "password", description: "密码" },
    },
  },
  "POST /api/auth/login": {
    type: "object",
    additionalProperties: false,
    required: ["identifier", "password"],
    properties: {
      identifier: { type: "string", description: "用户名或用户 UID" },
      password: { type: "string", format: "password", description: "密码" },
    },
  },
  "POST /api/admin/login": {
    type: "object",
    additionalProperties: false,
    required: ["username", "password"],
    properties: {
      username: { type: "string", description: "管理员用户名" },
      password: { type: "string", format: "password", description: "管理员密码" },
    },
  },
  "POST /api/device/pair": {
    type: "object",
    additionalProperties: false,
    required: ["name", "platform"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100, description: "设备名称" },
      platform: { type: "string", enum: ["win", "mac", "linux"], description: "设备平台" },
    },
  },
  "POST /api/wechat/bindings": {
    type: "object",
    additionalProperties: false,
    required: ["deviceId", "targetType", "targetId"],
    properties: {
      deviceId: { type: "string", description: "已配对设备 ID" },
      targetType: { type: "string", enum: ["agent", "team"], description: "绑定目标类型" },
      targetId: { type: "string", description: "智能体或团队 ID" },
      model: { type: "string", description: "可选模型覆盖" },
    },
  },
  "PATCH /api/memory/toggle": {
    type: "object",
    additionalProperties: false,
    required: ["enabled"],
    properties: { enabled: { type: "boolean", description: "是否启用长期记忆" } },
  },
  "POST /api/scheduled-tasks/ai-draft": {
    type: "object",
    additionalProperties: false,
    required: ["description"],
    properties: { description: { type: "string", minLength: 1, maxLength: 1000, description: "自然语言任务描述" } },
  },
  "POST /api/scheduled-tasks": scheduledTaskSchema(false),
  "PATCH /api/scheduled-tasks/:id": scheduledTaskSchema(true),
  // These workflow routes perform their authoritative Zod validation in the
  // handler. Keep the generated Fastify schema permissive so OpenAPI
  // documentation does not reject a future optional field before the handler
  // can return its normal validation error.
  "POST /api/workflow/codex-pets/projects": {
    type: "object",
    additionalProperties: true,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 30 },
      description: { type: "string", maxLength: 500 },
      prompt: { type: "string", maxLength: 4000 },
      actionPrompts: codexPetActionPromptsSchema,
      stylePreset: { type: "string", enum: ["auto", "pixel", "plush", "clay", "sticker", "flat-illustration", "3d-toy", "painterly"] },
      styleNotes: { type: "string", maxLength: 1000 },
      referenceAssetIds: { type: "array", maxItems: 3, items: { type: "string" } },
      autoContinue: { type: "boolean" },
      imageModel: { type: "string", enum: ["qwen-image-2.0-pro-2026-04-22", "gpt-image-2"] },
      visualQaModel: { type: "string", minLength: 1, maxLength: 128 },
      idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
    },
  },
  "PATCH /api/workflow/codex-pets/projects/:projectId": {
    type: "object",
    additionalProperties: true,
    properties: {
      name: { type: "string", maxLength: 30 },
      description: { type: "string", maxLength: 500 },
      prompt: { type: "string", maxLength: 4000 },
      actionPrompts: codexPetActionPromptsSchema,
      stylePreset: { type: "string" },
      styleNotes: { type: "string", maxLength: 1000 },
      referenceAssetIds: { type: "array", maxItems: 3, items: { type: "string" } },
      autoContinue: { type: "boolean" },
      imageModel: { type: "string", enum: ["qwen-image-2.0-pro-2026-04-22", "gpt-image-2"] },
      visualQaModel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  "POST /api/workflow/codex-pets/projects/:projectId/start": {
    type: "object",
    additionalProperties: true,
    properties: { idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } },
  },
  "POST /api/workflow/codex-pets/projects/:projectId/runs/:runId/base-selection": {
    type: "object",
    additionalProperties: true,
    description: "三选一：artifactId、autoSelect=true 或 regenerate=true。",
    properties: {
      artifactId: { type: "string" },
      autoSelect: { type: "boolean" },
      regenerate: { type: "boolean" },
    },
  },
};

function scheduledTaskSchema(partial: boolean): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    ...(partial ? {} : { required: ["title", "prompt", "model", "cron", "timezone"] }),
    properties: {
      title: { type: "string", maxLength: 100, description: "任务标题" },
      prompt: { type: "string", maxLength: 8000, description: "执行提示词" },
      model: { type: "string", description: "模型名称" },
      agentId: { type: "string", nullable: true, description: "可选智能体 ID" },
      kbIds: { type: "array", items: { type: "string" }, description: "关联知识库 ID" },
      deviceId: { type: "string", nullable: true, description: "可选桌面设备 ID" },
      cron: { type: "string", description: "Cron 表达式" },
      timezone: { type: "string", example: "Asia/Shanghai", description: "IANA 时区" },
      oneShot: { type: "boolean", description: "是否只运行一次" },
      emailTo: { type: "string", format: "email", description: "结果通知邮箱" },
      ...(partial ? { enabled: { type: "boolean", description: "是否启用" } } : {}),
  },
  };
}

const querySchemas: Array<[RegExp, JsonSchema]> = [
  [/^\/api\/workflow\/codex-pets\/projects\/[^/]+\/(install-link|download)$/, objectSchema({ runId: { type: "string", description: "可选的历史运行 ID" } })],
  [/^\/api\/public\/codex-pets\/artifacts\/[^/]+$/, objectSchema({
    exp: { type: "integer", minimum: 1, description: "签名过期时间（Unix 秒）" },
    sig: { type: "string", minLength: 32, description: "HMAC 签名" },
    purpose: { type: "string", enum: ["install", "preview"], default: "install" },
  }, ["exp", "sig"])],
  [/^\/api\/memory\/search$/, objectSchema({ q: { type: "string", description: "搜索关键词" } }, ["q"])],
  [/^\/api\/admin\/analytics\/(daily|rankings|sales)$/, objectSchema({ days: { type: "integer", minimum: 1, maximum: 180, default: 30, description: "统计天数" } })],
  [/^\/api\/admin\/analytics\/(retention|ltv)$/, objectSchema({ from: { type: "string", format: "date", description: "开始日期" }, to: { type: "string", format: "date", description: "结束日期" } })],
  [/^\/api\/admin\/audit$/, objectSchema({ adminId: { type: "string" }, action: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } })],
  [/^\/api\/admin\/users$/, objectSchema({ q: { type: "string", description: "用户名或 UID 关键词（不区分大小写）" }, page: { type: "integer", minimum: 1, default: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20 } })],
  [/\/events$/, objectSchema({ after: { type: "integer", minimum: 0, description: "从指定事件序号后读取" } })],
  [/\/events\/stream$/, objectSchema({ after: { type: "integer", minimum: 0, description: "从指定事件序号后建立 SSE" } })],
];

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

function normalizeMethod(method: RouteOptions["method"]): string {
  const value = Array.isArray(method) ? method[0] : method;
  return String(value).toUpperCase();
}

function tagForPath(url: string): string {
  if (url === "/health") return "系统";
  if (url === "/ws/connector" || url.startsWith("/api/device/")) return "设备与连接器";
  if (url.startsWith("/api/auth/")) return "认证";
  if (url.startsWith("/api/chat") || url.startsWith("/api/sessions")) return "对话";
  if (url.startsWith("/api/agents")) return "智能体";
  if (url.startsWith("/api/memory")) return "长期记忆";
  if (url.startsWith("/api/kb")) return "知识库";
  if (url.startsWith("/api/tool")) return "工具市场";
  if (url.startsWith("/api/workflow/images")) return "工作流 · 图片";
  if (url.startsWith("/api/workflow/codex-pets") || url.startsWith("/api/public/codex-pets")) return "工作流 · Codex 桌宠";
  if (url.startsWith("/api/workflow/novels")) return "工作流 · 小说";
  if (url.startsWith("/api/workflow/article-workflow")) return "工作流 · 文章";
  if (url === "/api/announcements") return "公告";
  if (url.startsWith("/api/admin/audit")) return "管理 · 审计";
  if (/^\/api\/admin\/(users|devices)/.test(url)) return "管理 · 用户";
  if (/^\/api\/admin\/(kb|announcements|client-menu)/.test(url)) return "管理 · 内容";
  if (url.startsWith("/api/admin")) return "管理 · 管理员";
  return "系统";
}

function meaningfulSegments(url: string): string[] {
  return url
    .split("/")
    .filter(Boolean)
    .filter((part) => !part.startsWith(":"))
    .filter((part) => !/^\d+$/.test(part))
    .filter((part) => !["api", "admin", "workflow"].includes(part));
}

function summaryForRoute(method: string, url: string): string {
  const key = `${method} ${url}`;
  if (exactSummaries[key]) return exactSummaries[key];
  const segments = meaningfulSegments(url);
  const last = segments.at(-1) ?? "接口";
  const previous = segments.at(-2) ?? last;
  const action = actionNames[last];
  const resource = resourceNames[action ? previous : last] ?? (action ? previous : last).replaceAll("-", " ");
  if (action) return `${action}${resource}`;
  if (method === "GET") return url.includes(":") ? `查询${resource}详情` : `查询${resource}列表`;
  if (method === "POST") return `创建${resource}`;
  if (method === "PATCH" || method === "PUT") return `更新${resource}`;
  if (method === "DELETE") return `删除${resource}`;
  return `${method} ${resource}`;
}

function pathParamSchema(url: string): JsonSchema | undefined {
  const names = [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  if (!names.length) return undefined;
  return objectSchema(
    Object.fromEntries(names.map((name) => [name, { type: name === "index" || name.toLowerCase().includes("index") ? "integer" : "string", description: `${name} 路径参数` }])),
    names,
  );
}

function querySchema(url: string): JsonSchema | undefined {
  return querySchemas.find(([pattern]) => pattern.test(url))?.[1];
}

function securityForRoute(method: string, url: string): ReadonlyArray<Record<string, readonly string[]>> {
  const key = `${method} ${url}`;
  if (publicRoutes.has(key)
    || (url.startsWith("/api/tool-market/") && method === "GET")
    || (url.startsWith("/api/public/codex-pets/artifacts/") && method === "GET")) return [];
  if (url === "/ws/connector") return [{ connectorProtocolToken: [] }];
  if (url === "/api/workflow/dub/skyhuman/callback") return [{ callbackSecret: [] }];
  if (url.startsWith("/api/admin/")) return [{ adminBearerAuth: [] }];
  return [{ bearerAuth: [] }];
}

function descriptionForRoute(method: string, url: string): string {
  const security = securityForRoute(method, url);
  const notes: string[] = [];
  if (!security.length) notes.push("公开接口，无需登录。");
  else if (security.some((item) => "adminBearerAuth" in item)) notes.push("需要管理员 JWT，并可能受细粒度权限控制。");
  else if (security.some((item) => "bearerAuth" in item)) notes.push("需要用户 JWT；可使用 Authorization Bearer 或登录 Cookie。");
  if (url === "/ws/connector") notes.push("该地址使用 WebSocket 升级；设备 Token 在连接后的注册消息中提交，Swagger UI 不能直接调试 WebSocket。");
  if (url.endsWith("/events/stream")) notes.push("响应类型为 text/event-stream（SSE）。");
  if (multipartRoutes.has(`${method} ${url}`)) notes.push("请求类型为 multipart/form-data。文件字段名为 file；其余字段按接口业务填写。");
  return notes.join("\n\n");
}

function requestBodyForRoute(method: string, url: string): JsonSchema | undefined {
  const key = `${method} ${url}`;
  if (bodySchemas[key]) return bodySchemas[key];
  if (multipartRoutes.has(key)) {
    return objectSchema({
      file: { type: "string", format: "binary", description: "上传文件" },
    }, ["file"]);
  }
  if (!["POST", "PUT", "PATCH"].includes(method)) return undefined;
  return {
    type: "object",
    additionalProperties: true,
    description: "业务请求体。未集中建模的复杂工作流字段以对应页面提交结构为准。",
  };
}

function responseSchemaForRoute(url: string): Record<string, JsonSchema> {
  const errorResponse: JsonSchema = {
    type: "object",
    additionalProperties: true,
    required: ["error"],
    properties: {
      error: { type: "string", description: "错误信息" },
      code: { type: "string", description: "可选机器可读错误码" },
    },
  };
  if (url.endsWith("/blob") || url.endsWith("/export") || url.startsWith("/api/public/codex-pets/artifacts/")) {
    return {
      "200": { type: "string", format: "binary", description: "文件流" },
      "4xx": errorResponse,
      "5xx": errorResponse,
    };
  }
  if (url.endsWith("/events/stream")) {
    return {
      "200": { type: "string", description: "SSE 事件流" },
      "4xx": errorResponse,
      "5xx": errorResponse,
    };
  }
  return {
    "2xx": { type: "object", additionalProperties: true, description: "请求成功" },
    "4xx": errorResponse,
    "5xx": errorResponse,
  };
}

export function documentRoute(schema: FastifySchema | undefined, url: string, route: RouteOptions): FastifySchema {
  const source = schema ?? {};
  const method = normalizeMethod(route.method);
  const key = `${method} ${url}`;
  const params = pathParamSchema(url);
  const body = requestBodyForRoute(method, url);
  const querystring = querySchema(url);
  return {
    ...source,
    tags: source.tags?.length ? source.tags : [tagForPath(url)],
    summary: source.summary ?? summaryForRoute(method, url),
    description: source.description ?? descriptionForRoute(method, url),
    operationId: source.operationId ?? key.toLowerCase().replace(/[:/]+/g, "_").replace(/[^a-z0-9_]+/g, "").replace(/^_|_$/g, ""),
    security: source.security ?? securityForRoute(method, url),
    ...(source.params || !params ? {} : { params }),
    ...(source.querystring || !querystring ? {} : { querystring }),
    ...(source.body || !body ? {} : { body }),
    ...(source.response ? {} : { response: responseSchemaForRoute(url) }),
    ...(multipartRoutes.has(key) ? { consumes: ["multipart/form-data"] } : {}),
    ...(url.endsWith("/events/stream") ? { produces: ["text/event-stream"] } : {}),
    ...(url.endsWith("/blob") || url.endsWith("/export") ? { produces: ["application/octet-stream"] } : {}),
  };
}

export function apiDocsEnabled(): boolean {
  return process.env.API_DOCS_ENABLED !== "false";
}

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "AI 助手 API",
        version: "1.0.0",
        description: [
          "AI 助手主 API 接口文档。",
          "",
          "主 API 默认地址为 `http://localhost:8090`。",
          "在右上角 **Authorize** 中填写 Token 后可直接调试。请勿在共享环境中填写生产密钥。",
        ].join("\n"),
      },
      servers: [{ url: process.env.API_DOCS_BASE_URL ?? "http://localhost:8090", description: "主 API 服务" }],
      tags: tagDefinitions,
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "普通用户登录返回的 JWT" },
          adminBearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "管理员登录返回的 JWT" },
          connectorProtocolToken: { type: "apiKey", in: "header", name: "X-Device-Token", description: "仅用于说明设备连接器认证；实际在 WebSocket 注册消息中发送" },
          callbackSecret: { type: "apiKey", in: "query", name: "secret", description: "数字人平台回调密钥" },
        },
        schemas: {
          ErrorResponse: {
            type: "object",
            additionalProperties: true,
            required: ["error"],
            properties: {
              error: { type: "string", description: "面向调用方的错误信息" },
              code: { type: "string", description: "可选机器可读错误码" },
            },
          },
        },
        responses: {
          BadRequest: { description: "请求参数不合法", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          Unauthorized: { description: "未认证或令牌无效", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          Forbidden: { description: "权限不足", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          InternalError: { description: "服务内部错误", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    transform: ({ schema, url, route }) => ({ schema: documentRoute(schema, url, route), url }),
    transformObject: (document) =>
      "openapiObject" in document ? document.openapiObject : document.swaggerObject,
  });
}

export async function registerOpenApiUi(app: FastifyInstance): Promise<void> {
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    staticCSP: true,
    uiConfig: {
      docExpansion: "none",
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      persistAuthorization: true,
      tryItOutEnabled: true,
    },
    theme: { title: "AI 助手 API 文档" },
  });

  app.get("/openapi.json", { schema: { hide: true } }, async (_request, reply) => {
    return reply.type("application/json; charset=utf-8").send(app.swagger());
  });
  app.get("/openapi.yaml", { schema: { hide: true } }, async (_request, reply) => {
    return reply.type("application/yaml; charset=utf-8").send(app.swagger({ yaml: true }));
  });
}
