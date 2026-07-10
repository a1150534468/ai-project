import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import packageJson from "../../package.json" with { type: "json" };

describe("desktop package distribution config", () => {
  it("defines Windows installer and update scripts", () => {
    expect(packageJson.scripts["dist:win"]).toBe(
      "node scripts/fetch-vcredist.mjs && pnpm run build && electron-builder --win --x64 --config electron-builder.config.cjs --publish never",
    );
    expect(packageJson.scripts["publish:win"]).toBe(
      "pnpm run dist:win && node scripts/publish-s3-release.mjs",
    );
  });

  it("keeps electron-updater as a runtime dependency", () => {
    expect(packageJson.dependencies["electron-updater"]).toBeDefined();
  });

  it("builds preload as CommonJS for packaged Electron injection", () => {
    const config = readFileSync(new URL("../../electron.vite.config.ts", import.meta.url), "utf8");

    expect(config).toContain('format: "cjs"');
    expect(config).toContain('entryFileNames: "[name].cjs"');
  });

  it("keeps ws external in the Electron main bundle", () => {
    const config = readFileSync(new URL("../../electron.vite.config.ts", import.meta.url), "utf8");

    expect(config).toContain('external: ["ws"]');
  });

  it("uses the public S3-compatible bucket as the default update feed", () => {
    const config = readFileSync(new URL("../../electron-builder.config.cjs", import.meta.url), "utf8");

    expect(config).toContain("https://updates.example.com/desktop/win");
    expect(config).not.toContain("https://api.example.com/desktop/win");
  });

  it("requests administrator elevation for packaged Windows launches", () => {
    const config = readFileSync(new URL("../../electron-builder.config.cjs", import.meta.url), "utf8");

    expect(config).toContain('requestedExecutionLevel: "requireAdministrator"');
  });

  it("bundles the VC++ redist installer fallback via NSIS include", () => {
    const config = readFileSync(new URL("../../electron-builder.config.cjs", import.meta.url), "utf8");
    const nsh = readFileSync(new URL("../../build/installer.nsh", import.meta.url), "utf8");

    expect(config).toContain('include: "build/installer.nsh"');
    expect(nsh).toContain("vc_redist.x64.exe");
    expect(nsh).toContain("/install /quiet /norestart");
  });

  it("ships as an Electron app without a WebView2 bootstrap dependency", () => {
    const packageText = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const builderConfig = readFileSync(new URL("../../electron-builder.config.cjs", import.meta.url), "utf8");
    const combinedConfig = `${packageText}\n${builderConfig}`.toLowerCase();

    expect(packageJson.devDependencies.electron).toBeDefined();
    expect(builderConfig).toContain("asar: true");
    expect(builderConfig).toContain("\"out/**/*\"");
    expect(combinedConfig).not.toContain("webview2");
    expect(combinedConfig).not.toContain("microsoftedgewebview2setup");
  });
});
