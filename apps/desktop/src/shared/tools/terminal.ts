import { spawn } from "node:child_process";
import { delimiter } from "node:path";

export interface ShellSpec {
  cmd: string;
  args: (command: string) => string[];
}

export function pickShell(platform: NodeJS.Platform): ShellSpec {
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c],
    };
  }
  return {
    cmd: "sh",
    args: (c) => ["-c", c],
  };
}

export interface TerminalArgs {
  command: string;
  cwd?: string;
}

export function runTerminal(
  a: TerminalArgs,
  opts: { timeoutMs: number; extraPathDir?: string | null }
): Promise<string> {
  const shell = pickShell(process.platform);
  // 把自带 Python 运行时目录前置到 PATH，让 `python`/`python3` 在客户机器上一定能解析到，
  // 不再依赖客户是否自装 Python。extraPathDir 为空时保持系统环境不变。
  const env = opts.extraPathDir
    ? { ...process.env, PATH: `${opts.extraPathDir}${delimiter}${process.env.PATH ?? ""}` }
    : process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(shell.cmd, shell.args(a.command), { cwd: a.cwd, env });
    let out = "",
      err = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令执行超时（${opts.timeoutMs}ms）`));
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });

    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(`${out}${err}${code === 0 ? "" : `\n[退出码 ${code}]`}`);
    });
  });
}
