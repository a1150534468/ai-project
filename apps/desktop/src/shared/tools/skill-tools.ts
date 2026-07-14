import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { connectorToolSchema, type ConnectorTool } from "@ai-assistant/connector-protocol";

const manifestToolSchema = connectorToolSchema.extend({
  command: z.string().min(1),
});

const skillManifestSchema = z.object({
  tools: z.array(manifestToolSchema).min(1),
});

interface ManifestTool extends ConnectorTool {
  command: string;
}

interface SkillRuntimeTool extends ManifestTool {
  skillDir: string;
}

const installArgsSchema = z.object({
  marketId: z.string().min(1),
  name: z.string().min(1),
  downloadUrl: z.string().min(1).optional().nullable(),
});

export interface ExecuteSkillToolOptions {
  skillsDir?: string;
  timeoutMs: number;
}

export function defaultSkillsDir(): string {
  return process.env.AI_ASSISTANT_SKILLS_DIR || join(homedir(), ".ai-assistant", "skills");
}

function marketToolName(marketId: string): string {
  return `skill_${marketId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 58)}`;
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function publicTool(tool: ManifestTool): ConnectorTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}

async function loadRuntimeTools(skillsDir: string): Promise<SkillRuntimeTool[]> {
  let entries: Array<{ isDirectory: () => boolean; name: string }>;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return [];
    throw error;
  }

  const tools: SkillRuntimeTool[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = resolve(skillsDir, entry.name);
    const raw = await readFile(join(skillDir, "ai-assistant-tool.json"), "utf8").catch((error: unknown) => {
      if (isNodeCode(error, "ENOENT")) return null;
      throw error;
    });
    if (!raw) continue;
    const manifest = skillManifestSchema.parse(JSON.parse(raw));
    for (const tool of manifest.tools) {
      tools.push({ ...tool, skillDir });
    }
  }
  return tools;
}

export async function discoverSkillTools(skillsDir = defaultSkillsDir()): Promise<ConnectorTool[]> {
  const runtimeTools = await loadRuntimeTools(skillsDir);
  return runtimeTools.map(publicTool);
}

async function runProcess(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`TIMEOUT: ${command} 超过 ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    collect(child.stdout, (chunk) => {
      stdout += chunk;
    });
    collect(child.stderr, (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      reject(new Error(`EXEC_ERROR: ${command} 退出码 ${code}${output ? `\n${output}` : ""}`));
    });
  });
}

async function downloadZip(downloadUrl: string, zipPath: string): Promise<void> {
  const url = new URL(downloadUrl);
  if (url.protocol === "file:") {
    await copyFile(fileURLToPath(url), zipPath);
    return;
  }
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`EXEC_ERROR: 下载 skill 失败 ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(zipPath, data);
}

async function extractZip(zipPath: string, targetDir: string, timeoutMs: number): Promise<void> {
  if (process.platform === "win32") {
    const script = `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(targetDir)} -Force`;
    await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], targetDir, timeoutMs);
    return;
  }
  await runProcess("unzip", ["-q", "-o", zipPath, "-d", targetDir], targetDir, timeoutMs);
}

function fallbackRunnerSource(skillName: string): string {
  return [
    "import { readFile } from 'node:fs/promises';",
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    "const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');",
    "const base = new URL('.', import.meta.url);",
    "let instructions = '';",
    "for (const file of ['SKILL.md', 'skill.md', 'README.md', 'readme.md']) {",
    "  try { instructions = await readFile(new URL(file, base), 'utf8'); break; } catch {}",
    "}",
    `console.log(JSON.stringify({ skill: ${JSON.stringify(skillName)}, prompt: input.prompt ?? '', context: input.context ?? '', instructions }, null, 2));`,
  ].join("\n");
}

async function ensureFallbackManifest(skillDir: string, marketId: string, name: string): Promise<ConnectorTool> {
  const manifestPath = join(skillDir, "ai-assistant-tool.json");
  const existing = await readFile(manifestPath, "utf8").catch((error: unknown) => {
    if (isNodeCode(error, "ENOENT")) return null;
    throw error;
  });
  if (existing) {
    const manifest = skillManifestSchema.parse(JSON.parse(existing));
    return publicTool(manifest.tools[0]);
  }

  const runnerName = "ai-assistant-skill-runner.mjs";
  await writeFile(join(skillDir, runnerName), fallbackRunnerSource(name), "utf8");
  const tool: ManifestTool = {
    name: marketToolName(marketId),
    description: `执行已安装的 skill「${name}」`,
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        context: { type: "string" },
      },
      required: ["prompt"],
    },
    command: `node ${runnerName}`,
  };
  await writeFile(manifestPath, JSON.stringify({ tools: [tool] }, null, 2), "utf8");
  return publicTool(tool);
}

export async function installMarketSkillTool(
  args: Record<string, unknown>,
  options: ExecuteSkillToolOptions,
): Promise<string> {
  const parsed = installArgsSchema.parse(args);
  const skillsDir = options.skillsDir ?? defaultSkillsDir();
  const targetDir = join(skillsDir, parsed.marketId);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  if (parsed.downloadUrl) {
    const zipPath = join(targetDir, `${parsed.marketId}.zip`);
    await downloadZip(parsed.downloadUrl, zipPath);
    await extractZip(zipPath, targetDir, options.timeoutMs);
    await rm(zipPath, { force: true });
  }

  const tool = await ensureFallbackManifest(targetDir, parsed.marketId, parsed.name);
  return JSON.stringify({ installedDir: targetDir, tool });
}

function collect(stream: NodeJS.ReadableStream, onChunk: (chunk: string) => void): void {
  stream.on("data", (chunk: Buffer | string) => {
    onChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
}

async function runCommand(
  command: string,
  cwd: string,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`TIMEOUT: skill 执行超过 ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    collect(child.stdout, (chunk) => {
      stdout += chunk;
    });
    collect(child.stderr, (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      reject(new Error(`EXEC_ERROR: skill 退出码 ${code}${output ? `\n${output}` : ""}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function executeSkillTool(
  name: string,
  args: Record<string, unknown>,
  options: ExecuteSkillToolOptions,
): Promise<string> {
  const skillsDir = options.skillsDir ?? defaultSkillsDir();
  const tools = await loadRuntimeTools(skillsDir);
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`EXEC_ERROR: 未找到已安装 skill 工具 ${name}`);
  }
  return runCommand(tool.command, tool.skillDir, args, options.timeoutMs);
}
