import { getPrisma } from "@yc/db";
import { createAdmin } from "./service.js";

async function main(): Promise<void> {
  const username = process.env.SEED_ADMIN_USERNAME;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!username || !password || password.length < 8) {
    throw new Error("需提供 SEED_ADMIN_USERNAME 与 SEED_ADMIN_PASSWORD(≥8)");
  }

  const prisma = getPrisma();
  const exists = await prisma.admin.findUnique({ where: { username } });

  if (exists) {
    process.stdout.write(`超管 ${username} 已存在，跳过\n`);
    return;
  }

  const a = await createAdmin(prisma, {
    username,
    password,
    role: "super_admin",
    permissions: [],
  });

  process.stdout.write(`已创建超管 ${username}（id=${a.id}）\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    process.stderr.write(
      `seed 失败: ${e instanceof Error ? e.message : String(e)}\n`
    );
    process.exit(1);
  });
