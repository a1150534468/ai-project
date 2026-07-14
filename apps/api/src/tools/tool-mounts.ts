import type Anthropic from "@anthropic-ai/sdk";
import { connectorToolSchema, type ConnectorTool } from "@ai-assistant/connector-protocol";
import { z } from "zod";

export interface InstalledToolSummary {
  name: string;
  toolName: string;
  description: string;
}

export interface SelectMountedToolsInput {
  requestedToolIds: readonly string[];
  builtinTools: readonly Anthropic.Tool[];
  installedTools: readonly InstalledToolSummary[];
  deviceCapabilities: readonly string[];
  deviceTools: readonly ConnectorTool[];
}

export interface MountedToolsResult {
  tools: Anthropic.Tool[];
  allowedToolNames: Set<string>;
}

const connectorToolsSchema = z.array(connectorToolSchema);

export function parseDeviceTools(value: unknown): ConnectorTool[] {
  const parsed = connectorToolsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function availableInstalledToolNames(
  deviceCapabilities: readonly string[],
  deviceTools: readonly ConnectorTool[],
): Set<string> {
  const supported = new Set(deviceCapabilities);
  return new Set(deviceTools.filter((tool) => supported.has(tool.name)).map((tool) => tool.name));
}

function toAnthropicTool(tool: ConnectorTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}

export function selectMountedTools(input: SelectMountedToolsInput): MountedToolsResult {
  const requested = new Set(input.requestedToolIds);
  const supported = new Set(input.deviceCapabilities);
  const allowedToolNames = new Set<string>();
  const tools: Anthropic.Tool[] = [];

  for (const tool of input.builtinTools) {
    if (!supported.has(tool.name) || allowedToolNames.has(tool.name)) {
      continue;
    }
    tools.push(tool);
    allowedToolNames.add(tool.name);
  }

  const deviceToolByName = new Map(input.deviceTools.map((tool) => [tool.name, tool]));
  for (const install of input.installedTools) {
    if (!requested.has(install.toolName) || !supported.has(install.toolName) || allowedToolNames.has(install.toolName)) {
      continue;
    }
    const deviceTool = deviceToolByName.get(install.toolName);
    if (!deviceTool) continue;
    tools.push(toAnthropicTool(deviceTool));
    allowedToolNames.add(install.toolName);
  }

  return { tools, allowedToolNames };
}
