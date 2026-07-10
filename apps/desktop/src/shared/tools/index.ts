import {
  TOOL_TERMINAL_EXEC,
  TOOL_FS_READ,
  TOOL_FS_WRITE,
  TOOL_FS_EDIT,
  TOOL_FS_LIST,
  TOOL_FS_STAT,
  TOOL_FS_GLOB,
  TOOL_FS_GREP,
  TOOL_FS_MKDIR,
  TOOL_FS_MOVE,
  TOOL_FS_DELETE,
  TOOL_FS_COPY,
  TOOL_BROWSER_NAVIGATE,
  TOOL_BROWSER_SNAPSHOT,
  TOOL_BROWSER_CLICK,
  TOOL_BROWSER_TYPE,
  TOOL_BROWSER_WAIT,
  TOOL_BROWSER_EVALUATE,
  TOOL_BROWSER_SCREENSHOT,
  TOOL_BROWSER_CONSOLE,
  TOOL_BROWSER_NETWORK,
  TOOL_BROWSER_CLOSE,
  TOOL_SKILL_MARKET_INSTALL,
} from "@yc/connector-protocol";
import { checkHighRisk } from "../high-risk.js";
import { runTerminal } from "./terminal.js";
import { bundledPythonBinDir } from "./pyruntime.js";
import { fsRead, fsWrite, fsEdit, fsList, fsStat, fsMkdir, fsMove, fsDelete, fsCopy } from "./fs.js";
import { fsGlob, fsGrep } from "./search.js";
import {
  browserClick,
  browserClose,
  browserConsole,
  browserEvaluate,
  browserNavigate,
  browserNetwork,
  browserScreenshot,
  browserSnapshot,
  browserType,
  browserWait,
} from "./browser.js";
import { executeSkillTool, installMarketSkillTool } from "./skill-tools.js";

const DEFAULT_TOOL_TIMEOUT_MS = 600_000;

function localToolTimeoutMs(): number {
  const raw = Number(process.env.CONNECTOR_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_TIMEOUT_MS;
}

function browserWaitTimeoutMs(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 10_000;
  return Math.min(Math.floor(raw), 120_000);
}

export interface ExecOpts {
  confirm: (reason: string) => Promise<boolean>;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  opts: ExecOpts
): Promise<string> {
  const risk = checkHighRisk(name, args);
  if (risk.risky) {
    const ok = await opts.confirm(risk.reason ?? "高危操作");
    if (!ok) throw new Error(`BLOCKED: 用户拒绝高危操作（${risk.reason}）`);
  }

  const s = (k: string) => String(args[k] ?? "");

  switch (name) {
    case TOOL_TERMINAL_EXEC:
      return runTerminal(
        { command: s("command"), cwd: args.cwd ? s("cwd") : undefined },
        { timeoutMs: localToolTimeoutMs(), extraPathDir: bundledPythonBinDir() }
      );
    case TOOL_FS_READ:
      return fsRead({ path: s("path") });
    case TOOL_FS_WRITE:
      return fsWrite({ path: s("path"), content: s("content") });
    case TOOL_FS_EDIT:
      return fsEdit({
        path: s("path"),
        old_string: s("old_string"),
        new_string: s("new_string"),
        replace_all: args.replace_all === true,
      });
    case TOOL_FS_LIST:
      return fsList({ path: s("path") });
    case TOOL_FS_STAT:
      return fsStat({ path: s("path") });
    case TOOL_FS_GLOB:
      return fsGlob({ pattern: s("pattern"), cwd: args.cwd ? s("cwd") : undefined });
    case TOOL_FS_GREP:
      return fsGrep({
        pattern: s("pattern"),
        path: s("path"),
        glob: args.glob ? s("glob") : undefined,
      });
    case TOOL_FS_MKDIR:
      return fsMkdir({ path: s("path") });
    case TOOL_FS_MOVE:
      return fsMove({ from: s("from"), to: s("to") });
    case TOOL_FS_DELETE:
      return fsDelete({ path: s("path"), recursive: args.recursive === true });
    case TOOL_FS_COPY:
      return fsCopy({ from: s("from"), to: s("to") });
    case TOOL_BROWSER_NAVIGATE:
      return browserNavigate(s("url"));
    case TOOL_BROWSER_SNAPSHOT:
      return browserSnapshot();
    case TOOL_BROWSER_CLICK:
      return browserClick({
        ref: args.ref ? s("ref") : undefined,
        selector: args.selector ? s("selector") : undefined,
        text: args.text ? s("text") : undefined,
      });
    case TOOL_BROWSER_TYPE:
      return browserType({
        ref: args.ref ? s("ref") : undefined,
        selector: args.selector ? s("selector") : undefined,
        text: args.text ? s("text") : undefined,
        value: s("text"),
        submit: args.submit === true,
      });
    case TOOL_BROWSER_WAIT:
      return browserWait({
        selector: args.selector ? s("selector") : undefined,
        text: args.text ? s("text") : undefined,
        timeoutMs: browserWaitTimeoutMs(args.timeoutMs),
      });
    case TOOL_BROWSER_EVALUATE:
      return browserEvaluate(s("script"));
    case TOOL_BROWSER_SCREENSHOT:
      return browserScreenshot();
    case TOOL_BROWSER_CONSOLE:
      return browserConsole();
    case TOOL_BROWSER_NETWORK:
      return browserNetwork();
    case TOOL_BROWSER_CLOSE:
      return browserClose();
    case TOOL_SKILL_MARKET_INSTALL:
      return installMarketSkillTool(args, { timeoutMs: localToolTimeoutMs() });
    default:
      if (name.startsWith("skill_")) {
        return executeSkillTool(name, args, { timeoutMs: localToolTimeoutMs() });
      }
      throw new Error(`EXEC_ERROR: 未知工具 ${name}`);
  }
}
