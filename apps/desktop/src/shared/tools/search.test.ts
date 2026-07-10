import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsGlob, fsGrep } from "./search.js";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "yc-search-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "const hello = 1;\nfunction foo() {}\n");
  await writeFile(join(dir, "src", "b.ts"), "const world = 2;\n");
  await writeFile(join(dir, "readme.md"), "hello docs\n");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("fsGlob", () => {
  it("按模式找 ts 文件", async () => {
    const out = await fsGlob({ pattern: "src/**/*.ts", cwd: dir });
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
    expect(out).not.toContain("readme.md");
  });
});

describe("fsGrep", () => {
  it("搜内容返回 path:line", async () => {
    const out = await fsGrep({ pattern: "hello", path: dir });
    expect(out).toMatch(/a\.ts:1/);
    expect(out).toMatch(/readme\.md:1/);
  });
  it("可用 glob 限定文件类型", async () => {
    const out = await fsGrep({ pattern: "hello", path: dir, glob: "**/*.ts" });
    expect(out).toContain("a.ts");
    expect(out).not.toContain("readme.md");
  });
  it("非法正则报清晰错误", async () => {
    await expect(fsGrep({ pattern: "(?P<n>", path: dir })).rejects.toThrow(/EXEC_ERROR|正则/);
  });
});
