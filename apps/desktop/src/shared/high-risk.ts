import { posix, win32 } from "node:path";

export interface RiskResult {
  risky: boolean;
  reason?: string;
}

const CMD_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+\/(?:\s|$|\*)/i, reason: "递归删除根目录" },
  { re: /\bmkfs\b|\bformat\b\s+[a-z]:/i, reason: "磁盘格式化" },
  { re: /\bdd\b.*of=\/dev\//i, reason: "裸写磁盘设备" },
  { re: /Remove-Item\s+.*(C:\\Windows|C:\\Program Files)/i, reason: "删除 Windows 系统目录" },
  { re: /\bdel\b\s+\/[sq]\s+.*(C:\\Windows)/i, reason: "删除 Windows 系统目录" },
  { re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\.|\*|~)(\s|$|\/)/i, reason: "递归删除危险目标" },
  { re: /\brm\s+(-r\s+-f|-f\s+-r)\s+(\/|\.|\*|~)/i, reason: "递归删除危险目标" },
];

const CRED_PATH = /(\/|\\)\.(ssh|aws|gnupg)(\/|\\|$)|(\/|\\)\.env$|id_rsa|(\/|\\)credentials$/i;
const SYS_PATH = /^(\/etc|\/boot|\/sys|\/proc|\/usr\/bin|\/usr\/sbin|\/sbin|\/bin)(\/|$)|^[A-Za-z]:\\(Windows|Program Files)(\\|$)/i;
const ROOT_LIKE = /^(\/|[A-Za-z]:\\?)$|^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)$/i;

function sensitiveRead(p: string): boolean {
  return CRED_PATH.test(p) || SYS_PATH.test(p);
}

function sensitiveWrite(p: string): boolean {
  return CRED_PATH.test(p) || SYS_PATH.test(p);
}

function normalizeRiskPath(p: string): string {
  if (!p) {
    return p;
  }
  if (/^[A-Za-z]:[\\/]/.test(p) || p.includes("\\")) {
    return win32.normalize(p);
  }
  return posix.normalize(p);
}

export function checkHighRisk(tool: string, args: Record<string, unknown>): RiskResult {
  if (tool === "terminal_exec") {
    const command = String(args.command ?? "");
    for (const p of CMD_PATTERNS) {
      if (p.re.test(command)) {
        return { risky: true, reason: p.reason };
      }
    }
    return { risky: false };
  }

  const path = normalizeRiskPath(String(args.path ?? ""));
  const from = normalizeRiskPath(String(args.from ?? ""));
  const to = normalizeRiskPath(String(args.to ?? ""));

  switch (tool) {
    case "fs_read":
    case "fs_glob":
    case "fs_grep":
    case "fs_list":
    case "fs_stat": {
      const target = path || normalizeRiskPath(String(args.cwd ?? ""));
      if (sensitiveRead(target)) {
        return { risky: true, reason: "访问凭据/系统目录" };
      }
      return { risky: false };
    }
    case "fs_write":
    case "fs_edit":
    case "fs_mkdir": {
      if (sensitiveWrite(path)) {
        return { risky: true, reason: "写入系统/敏感目录" };
      }
      return { risky: false };
    }
    case "fs_delete": {
      if (args.recursive === true && ROOT_LIKE.test(path)) {
        return { risky: true, reason: "递归删除根/家目录" };
      }
      if (sensitiveWrite(path)) {
        return { risky: true, reason: "删除系统/敏感目录" };
      }
      return { risky: false };
    }
    case "fs_move":
    case "fs_copy": {
      if (sensitiveWrite(to) || sensitiveWrite(from)) {
        return { risky: true, reason: "移动/复制涉及系统/敏感目录" };
      }
      return { risky: false };
    }
    default:
      return { risky: false };
  }
}
