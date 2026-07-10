import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { presetIconAt } from "./icons.js";

export interface AgentPreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  icon: string;
}

const PRESETS_PATH = fileURLToPath(new URL("./presets.md", import.meta.url));

function summarizePrompt(prompt: string): string {
  const role = prompt.match(/主要负责：([^。\n]+)/)?.[1]?.trim();
  if (role) return role;
  const scenario = prompt.match(/适合处理以下任务：([^。\n]+)/)?.[1]?.trim();
  if (scenario) return scenario;
  return "通用智能体";
}

export function parseAgentPresets(markdown: string): AgentPreset[] {
  const headingRe = /^##\s+(\d+)\.\s+(.+)$/gm;
  const headings = [...markdown.matchAll(headingRe)];
  const presets: AgentPreset[] = [];

  headings.forEach((heading, idx) => {
    const no = heading[1];
    const name = heading[2].trim();
    const start = (heading.index ?? 0) + heading[0].length;
    const end = idx + 1 < headings.length ? headings[idx + 1].index ?? markdown.length : markdown.length;
    const section = markdown.slice(start, end);
    const prompt = section.match(/```text\s*([\s\S]*?)```/)?.[1]?.trim();
    if (!prompt) return;
    presets.push({
      id: `preset-${no}`,
      name,
      description: summarizePrompt(prompt),
      prompt,
      icon: presetIconAt(idx),
    });
  });

  return presets;
}

let cache: AgentPreset[] | null = null;

export function loadAgentPresets(): AgentPreset[] {
  if (!cache) {
    cache = parseAgentPresets(readFileSync(PRESETS_PATH, "utf8"));
  }
  return cache;
}

export function getPresetAgent(id: string): AgentPreset | null {
  return loadAgentPresets().find((preset) => preset.id === id) ?? null;
}
