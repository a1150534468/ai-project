import { glob } from "tinyglobby";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";

const IGNORE = ["**/node_modules/**", "**/.git/**"];
const MAX_FILES = 2000;
const MAX_MATCHES = 200;

export async function fsGlob(a: { pattern: string; cwd?: string }): Promise<string> {
  const files = await glob(a.pattern, { cwd: a.cwd, ignore: IGNORE, dot: false });
  const capped = files.slice(0, 1000);
  const note = files.length > capped.length ? `\n[已截断，共 ${files.length} 个]` : "";
  return capped.join("\n") + note;
}

export async function fsGrep(a: { pattern: string; path: string; glob?: string }): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(a.pattern);
  } catch {
    throw new Error("EXEC_ERROR: 非法正则表达式");
  }
  const files = (await glob(a.glob ?? "**/*", { cwd: a.path, ignore: IGNORE, absolute: true })).slice(0, MAX_FILES);
  const hits: string[] = [];
  for (const f of files) {
    if (hits.length >= MAX_MATCHES) break;
    let text: string;
    try { text = await readFile(f, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push(`${relative(a.path, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= MAX_MATCHES) break;
      }
    }
  }
  return hits.length ? hits.join("\n") + (hits.length >= MAX_MATCHES ? `\n[已达 ${MAX_MATCHES} 条上限]` : "") : "（无匹配）";
}
