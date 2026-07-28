/**
 * 真实上游验证：按交付档位结算。
 * 口径——只有「成功交付一张图」才算一次上游调用；失败/重试不算。
 * 本轮预算：最多 6 次成功（形象照 1 + 通用 1 + 电商主图 1 + 电商长图 3）。
 * 用法：QA_CASE=portrait|general|main|master npx tsx .cc-tmp/qa-delivered-tier.ts
 */
import { getPrisma } from "@ai-assistant/db";
import { signToken } from "../src/auth/token.js";

const prisma = getPrisma();
const BASE = process.env.QA_API_BASE ?? "http://localhost:8090";
const USER_ID = process.env.QA_USER_ID ?? "cmrg7sx3w0002c3lsyza7tqci";
const CASE = process.env.QA_CASE ?? "";
const TOKEN = signToken(USER_ID, process.env.SESSION_SECRET!);

const authHeaders = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

async function balance(): Promise<number> {
  const res = await fetch(`${process.env.BILLING_BASE_URL}/balance/${USER_ID}`, {
    headers: { "X-Internal-Token": process.env.BILLING_INTERNAL_TOKEN ?? "" },
  });
  return ((await res.json()) as { balance: number }).balance;
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: authHeaders, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* 保留原文便于诊断 */ }
  return { status: res.status, json };
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* 同上 */ }
  return { status: res.status, json };
}

async function waitFor<T>(label: string, poll: () => Promise<T | null>, timeoutMs = 600_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await poll();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  log(`${label} 超时`);
  return null;
}

// ---------- 形象照：2K 下单，看是否按交付档降到 1K ----------
async function runPortrait(): Promise<void> {
  const before = await balance();
  log("余额(前):", before);

  const rid = `qa-tier-portrait-${Date.now().toString(36)}`;
  const created = await post("/api/workflow/portraits/generate", {
    requestId: rid,
    presetId: "business-elite",
    model: "gpt-image-2",
    aspectRatio: "3:4",
    resolution: "2K",
    count: 1,
    referenceAssetIds: ["cms2qjtcg0002c3gnq7p37lpy"],
    authorizationAccepted: true,
    consentVersion: "portrait-consent-v1",
  });
  log("下单:", created.status, JSON.stringify(created.json).slice(0, 400));
  if (created.status >= 300) return;

  const requestId = rid;
  log("requestId:", requestId);

  const done = await waitFor("形象照", async () => {
    const task = await prisma.portraitTask.findUnique({
      where: { requestId },
      select: {
        id: true, status: true, resolution: true, billingStatus: true, billingResourceKey: true,
        billingReservedUnits: true, billingSettledUnits: true, error: true,
        outputs: { select: { width: true, height: true } },
      },
    });
    if (!task) return null;
    log(`  status=${task.status} 计费=${task.billingStatus} key=${task.billingResourceKey} 成品=${task.outputs.length}`);
    return task.status === "completed" || task.status === "failed" ? task : null;
  });

  log("最终:", JSON.stringify(done, null, 2));
  const after = await balance();
  log("余额(后):", after, "实际扣点 =", before - after, "（2K 应是 20；若降档到 1K 则是 10）");
}

// ---------- 通用生图：2K 下单 ----------
async function runGeneral(): Promise<void> {
  const before = await balance();
  log("余额(前):", before);

  const created = await post("/api/workflow/images/tasks", {
    prompt: "一只戴眼镜的橘猫坐在书堆上，柔光摄影",
    model: "gpt-image-2",
    size: "1536x2048",
    count: 1,
  });
  log("下单:", created.status, JSON.stringify(created.json).slice(0, 400));
  if (created.status >= 300) return;

  const requestId: string = created.json?.data?.requestId ?? created.json?.data?.task?.requestId;
  log("requestId:", requestId);

  const done = await waitFor("通用生图", async () => {
    const task = await prisma.imageGenerationTask.findUnique({
      where: { requestId },
      select: {
        id: true, status: true, size: true, billingStatus: true, billingResourceKey: true,
        billingReservedUnits: true, billingSettledUnits: true, error: true,
      },
    });
    if (!task) return null;
    const assets = await prisma.imageAsset.findMany({ where: { requestId }, select: { width: true, height: true, size: true } });
    log(`  status=${task.status} 计费=${task.billingStatus} key=${task.billingResourceKey} 图=${assets.map((a) => `${a.width}x${a.height}`).join(",")}`);
    return task.status === "completed" || task.status === "failed" ? { task, assets } : null;
  });

  log("最终:", JSON.stringify(done, null, 2));
  log("余额(后):", await balance());
}

if (CASE === "portrait") await runPortrait();
else if (CASE === "general") await runGeneral();
else log("请用 QA_CASE=portrait|general|main|master 指定用例");

await prisma.$disconnect();
