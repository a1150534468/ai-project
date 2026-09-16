#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_ROOT = join(REPOSITORY_ROOT, "packages", "db", "prisma", "migrations");
const LAST_PROTECTED_TIMESTAMP = "20260904080000";
const EXPECTED_FILE_COUNT = 82;
const EXPECTED_DIGEST = "34839a95a12053710d5a820ece70630bb63bddc51f9774f3db021bdb7011fe0b";

function migrationTimestamp(name) {
  const matched = /^(\d{14})_.+/.exec(name);
  return matched?.[1] ?? null;
}

const entries = await readdir(MIGRATIONS_ROOT, { withFileTypes: true });
const protectedFiles = entries
  .filter((entry) => entry.isDirectory())
  .filter((entry) => {
    const timestamp = migrationTimestamp(entry.name);
    return timestamp !== null && timestamp <= LAST_PROTECTED_TIMESTAMP;
  })
  .map((entry) => join(entry.name, "migration.sql"));
protectedFiles.push("migration_lock.toml");
protectedFiles.sort();

const digest = createHash("sha256");
for (const migrationPath of protectedFiles) {
  digest.update(migrationPath);
  digest.update("\0");
  digest.update(await readFile(join(MIGRATIONS_ROOT, migrationPath)));
  digest.update("\0");
}

const actualDigest = digest.digest("hex");
if (protectedFiles.length !== EXPECTED_FILE_COUNT || actualDigest !== EXPECTED_DIGEST) {
  console.error("[migrations] 历史迁移完整性校验失败。");
  console.error(`  受保护文件：期望 ${EXPECTED_FILE_COUNT}，实际 ${protectedFiles.length}`);
  console.error(`  聚合摘要：期望 ${EXPECTED_DIGEST}，实际 ${actualDigest}`);
  console.error(`  目录：${relative(REPOSITORY_ROOT, MIGRATIONS_ROOT)}`);
  console.error("历史 migration.sql 与 migration_lock.toml 不允许修改；新变更必须新增时间戳更晚的迁移。");
  process.exit(1);
}

console.log(`[migrations] ${protectedFiles.length} 个历史文件完整性校验通过。`);
