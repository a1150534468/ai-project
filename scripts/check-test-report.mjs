#!/usr/bin/env node
/**
 * 假绿防护：聚合各 workspace 的 vitest JSON 报告，与入仓基线比对。
 *
 * 为什么需要它：本仓有一批 `describe.skipIf(...)` 守卫的测试，缺 env 时会
 * 静默跳过且退出码为 0 —— 「少跑了 40 个 DB 测试」在 CI 上表现为绿色。
 * 光看退出码无法区分「全跑过了」和「大半没跑」。
 *
 * 断言（任一不满足即失败）：
 *   1. failed === 0                          —— 常规红灯，两种模式都查
 *   2. failedSuites === 0                    —— import/收集阶段就炸，两种模式都查
 *   3. skipped 不超基线                      —— 核心防护。两种模式算法不同，见下
 *   4. passed >= minPassed                   —— 仅全量模式。skipped 抓不到
 *      「整个 workspace 的报告压根没产出」这种失效，passed 能抓到。
 *   5. workspaces === expectedWorkspaces     —— 仅全量模式。报告文件数必须齐
 *
 * 两种模式：
 *   全量（默认）：ci.yml 的 test-full + build，全仓跑一遍，用全局基线。
 *   受影响（--affected）：ci.yml 的 test-affected，PR 上只跑 turbo --filter 选中的包。
 *     此时 expectedWorkspaces / minPassed 这两个「全仓口径」的数**必然不成立**
 *     （只改了 web 时不可能有 7 份报告、1650 个 passed），所以这两条让位；
 *     换来的是 skipped 按 workspace 记账——基线里没记账的 workspace 一律要求 0，
 *     比全量模式那个全局上限更严（全局上限允许「web 一个不跑、api 跳 22 个」）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const REPORT_NAME = ".vitest-report.json";
const BASELINE_PATH = join(ROOT, ".github", "test-baseline.json");
const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", "dist", "build", ".next", "coverage"]);

/** 只影响「怎么判定」，不影响「跑了什么」。由 ci.yml 的 test-affected 传入。 */
const affectedMode = process.argv.includes("--affected");

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
if (affectedMode) {
  console.log("  模式: 受影响范围（PR）—— 不查全仓口径，skipped 按 workspace 收紧");
} else {
  console.log("  模式: 全量");
  console.log(
    `  workspaces 期望 ${baseline.expectedWorkspaces} / 实际 ${rows.length}`,
  );
  console.log(`  passed   下限 ${baseline.minPassed} / 实际 ${total.passed}`);
  console.log(`  skipped  上限 ${baseline.maxSkipped} / 实际 ${total.skipped}`);
}

if (!affectedMode && rows.length !== baseline.expectedWorkspaces) {
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
  //
  // 措辞刻意不说「文件」：vitest 的 numFailedTestSuites 把**文件级 suite 和它里面
  // 每一层 describe 都各算一个**（实测：一个文件、一个 describe、一个失败用例 ⇒
  // numTotalTestSuites=2、numFailedTestSuites=2）。run 33630383578 就因此印出
  // 「2 个测试文件失败」，而实际只有 apps/web 一个文件的一个用例红，白查了一轮。
  fail(
    `${total.failedSuites} 个测试套件失败（文件与其中每层 describe 各算一个）` +
      `${total.failed === 0 ? "；用例数达标，说明是 import/收集阶段就失败了，整个文件没跑" : ""}。`,
  );
}

if (affectedMode) {
  // PR 上只跑了 --filter 选中的包，全局上限不再适用（只改 web 时不该让 api 那 17 个
  // 预期跳过占用额度）。改成按 workspace 记账：基线里没记账的 workspace 一律要求 0。
  if (rows.length === 0) {
    fail(
      "受影响的 workspace 一个测试报告都没产出。" +
        "turbo --filter 选中了包但 vitest 没写报告（构建失败 / 被缓存跳过 / 脚本没跑 test）。",
    );
  }
  const allowance = baseline.maxSkippedByWorkspace ?? {};
  console.log("\n按 workspace 的 skip 额度");
  console.log("─".repeat(78));
  console.log(`${"workspace".padEnd(34)}${"skipped".padStart(9)}${"额度".padStart(9)}`);
  for (const row of rows) {
    const limit = allowance[row.workspace] ?? 0;
    console.log(
      `${row.workspace.padEnd(34)}${String(row.skipped).padStart(9)}${String(limit).padStart(9)}`,
    );
    if (row.skipped > limit) {
      fail(
        `${row.workspace} 跳过 ${row.skipped} 个，本 workspace 只允许 ${limit} 个。` +
          "受影响范围内的多余跳过同样是被 skipIf 静默吞掉的假绿，" +
          "要么补上缺的 env（注意 test-affected 起的是 pgvector + redis），要么在 .github/test-baseline.json 的 maxSkippedByWorkspace 记账并说明原因。",
      );
    }
  }
  console.log("─".repeat(78));
} else {
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
}

if (process.exitCode) {
  console.error(
    "\n若这是有意的变更（真的删了测试 / 真的新增了 skip），请同步更新 .github/test-baseline.json，" +
      "并在 commit 里说明原因。不要为了让 CI 变绿而放宽基线。",
  );
} else {
  console.log("\n✅ 测试报告与基线一致。");
}
