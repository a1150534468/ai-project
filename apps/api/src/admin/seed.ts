import { getPrisma } from "@ai-assistant/db";
import { createAdmin } from "./service.js";

function seedCredentials(): { username: string; password: string } {
  const username = process.env.SEED_ADMIN_USERNAME;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!username || !password || password.length < 8) {
    throw new Error("需提供 SEED_ADMIN_USERNAME 与 SEED_ADMIN_PASSWORD(≥8)");
  }
  return { username, password };
}

async function seedSuperAdmin(): Promise<void> {
  const prisma = getPrisma();
  const { username, password } = seedCredentials();
  const existing = await prisma.admin.findUnique({ where: { username }, select: { id: true } });
  if (existing) {
    process.stdout.write(`超管 ${username} 已存在，跳过\n`);
    return;
  }
  const admin = await createAdmin(prisma, {
    username,
    password,
    role: "super_admin",
    permissions: [],
  });
  process.stdout.write(`已创建超管 ${username}（id=${admin.id}）\n`);
}

seedSuperAdmin().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`seed 失败: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
