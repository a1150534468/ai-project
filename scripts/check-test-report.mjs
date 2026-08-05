#!/usr/bin/env node
/**
 * 假绿防护：聚合各 workspace 的 vitest JSON 报告，与入仓基线比对。
 *
 * 为什么需要它：本仓有一批 `describe.skipIf(...)` 守卫的测试，缺 env 时会
 * 静默跳过且退出码为 0 —— 「少跑了 40 个 DB 测试」在 CI 上表现为绿色。
 * 光看退出码无法区分「全跑过了」和「大半没跑」。
 *
 * 三道断言，任一不满足即失败：
 *   1. failed === 0                          —— 常规红灯
 *   2. skipped <= maxSkipped                 —— 跳过数不得超基线（核心防护）
 *   3. passed >= minPassed                   —— 通过数不得低于基线。skipped 抓不到
 *      「整个 workspace 的报告压根没产出」这种失效，passed 能抓到。
 *   4. workspaces === expectedWorkspaces     —— 报告文件数必须齐
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const REPORT_NAME = ".vitest-report.json";
const BASELINE_PATH = join(ROOT, ".github", "test-baseline.json");
const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", "dist", "build", ".next", "coverage"]);

/** 只向下找 3 层：workspace 都在 apps/* 与 packages/* 下。 */
function findReports(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findReports(full, depth + 1, out);
    else if (entry.name === REPORT_NAME) out.push(full);
  }
  return out;
}

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exitCode = 1;
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const reports = findReports(ROOT).sort();

const total = { passed: 0, failed: 0, skipped: 0, todo: 0, failedSuites: 0 };
const rows = [];

for (const file of reports) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`报告解析失败 ${relative(ROOT, file)}: ${error.message}`);
    continue;
  }
  const row = {
    workspace: relative(ROOT, file).replace(`/${REPORT_NAME}`, ""),
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: report.numPendingTests ?? 0,
    todo: report.numTodoTests ?? 0,
    failedSuites: report.numFailedTestSuites ?? 0,
  };
  rows.push(row);
  for (const key of Object.keys(total)) total[key] += row[key];
}

console.log("\n各 workspace 测试结果");
console.log("─".repeat(78));
console.log(
  `${"workspace".padEnd(34)}${"passed".padStart(8)}${"failed".padStart(8)}${"skipped".padStart(9)}${"todo".padStart(7)}`,
);
for (const row of rows) {
  console.log(
    `${row.workspace.padEnd(34)}${String(row.passed).padStart(8)}${String(row.failed).padStart(8)}${String(row.skipped).padStart(9)}${String(row.todo).padStart(7)}`,
  );
}
console.log("─".repeat(78));
console.log(
  `${"合计".padEnd(33)}${String(total.passed).padStart(8)}${String(total.failed).padStart(8)}${String(total.skipped).padStart(9)}${String(total.todo).padStart(7)}`,
);
console.log(`\n基线: ${relative(ROOT, BASELINE_PATH)}`);
console.log(
  `  workspaces 期望 ${baseline.expectedWorkspaces} / 实际 ${rows.length}`,
);
console.log(`  passed   下限 ${baseline.minPassed} / 实际 ${total.passed}`);
console.log(`  skipped  上限 ${baseline.maxSkipped} / 实际 ${total.skipped}`);

if (rows.length !== baseline.expectedWorkspaces) {
  fail(
    `只收到 ${rows.length} 份测试报告，基线要求 ${baseline.expectedWorkspaces} 份。` +
      `有 workspace 的测试没有真正执行（构建失败、被 turbo 缓存跳过、或 vitest 未产出报告）。`,
  );
}

if (total.failed > 0) {
  fail(`${total.failed} 个测试失败。`);
}

if (total.failedSuites > 0) {
  // 用例数达标、只有 suite 失败，通常是 import/收集阶段就炸了（语法错、缺依赖、
  // 顶层 throw）。这种情况整个文件的用例一个都没跑，但 numPassedTests 不会变，
  // 单看计数是绿的，所以必须独立成一条。
  fail(
    `${total.failedSuites} 个测试文件失败${total.failed === 0 ? "（用例数达标，说明是 import/收集阶段就失败了，整个文件没跑）" : ""}。`,
  );
}

if (total.skipped > baseline.maxSkipped) {
  fail(
    `跳过 ${total.skipped} 个测试，超过基线上限 ${baseline.maxSkipped}。` +
      `多出的 ${total.skipped - baseline.maxSkipped} 个大概率是缺 env 被 skipIf 静默跳过 —— 这是假绿，不是通过。`,
  );
}

if (total.passed < baseline.minPassed) {
  fail(
    `只通过 ${total.passed} 个测试，低于基线下限 ${baseline.minPassed}。` +
      `少了 ${baseline.minPassed - total.passed} 个 —— 有测试没被执行。`,
  );
}

if (process.exitCode) {
  console.error(
    "\n若这是有意的变更（真的删了测试 / 真的新增了 skip），请同步更新 .github/test-baseline.json，" +
      "并在 commit 里说明原因。不要为了让 CI 变绿而放宽基线。",
  );
} else {
  console.log("\n✅ 测试报告与基线一致。");
}
