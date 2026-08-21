import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface StartedWorkerRuntime {
  readonly name: string;
  close(signal: string): Promise<void>;
}

export function isDirectWorkerEntrypoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === metaUrl);
}

export function runStandaloneWorker(args: {
  readonly name: string;
  readonly start: () => Promise<StartedWorkerRuntime>;
  readonly afterClose?: () => Promise<void>;
  readonly onFatal?: () => Promise<void>;
}): void {
  let runtime: StartedWorkerRuntime | null = null;
  let closing = false;

  const shutdown = async (signal: string, exitCode = 0) => {
    if (closing) return;
    closing = true;
    try {
      await runtime?.close(signal);
      await args.afterClose?.();
    } catch (error) {
      exitCode = 1;
      console.error(`[${args.name}] shutdown error`, error);
    } finally {
      process.exit(exitCode);
    }
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  void args
    .start()
    .then((started) => {
      runtime = started;
    })
    .catch(async (error) => {
      console.error(`[${args.name}] fatal error`, error);
      await args.onFatal?.().catch(() => undefined);
      await shutdown("startup-failure", 1);
    });
}
