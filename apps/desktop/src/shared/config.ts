export interface AppConfig {
  apiBase: string;
  wsUrl: string;
  webUrl: string;
}

export interface AppConfigDefaults {
  readonly apiBase: string;
  readonly webUrl: string;
}

const DEV_DEFAULTS: AppConfigDefaults = {
  apiBase: "http://localhost:8090",
  webUrl: "http://localhost:5173",
};

const PACKAGED_DEFAULTS: AppConfigDefaults = {
  apiBase: "https://api.example.com",
  webUrl: "https://app.example.com",
};

function deriveWsUrl(apiBase: string): string {
  const u = new URL(apiBase);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws/connector";
  return u.toString().replace(/\/$/, "");
}

export function defaultConfigForRuntime(isPackaged: boolean): AppConfigDefaults {
  return isPackaged ? PACKAGED_DEFAULTS : DEV_DEFAULTS;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  defaults: AppConfigDefaults = DEV_DEFAULTS
): AppConfig {
  const apiBase = env.AI_ASSISTANT_API_BASE ?? defaults.apiBase;
  const webUrl = env.AI_ASSISTANT_WEB_URL ?? defaults.webUrl;
  return { apiBase, wsUrl: deriveWsUrl(apiBase), webUrl };
}
