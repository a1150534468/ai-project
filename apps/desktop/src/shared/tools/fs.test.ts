import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsRead, fsWrite, fsEdit, fsList, fsStat, fsMkdir, fsMove, fsDelete, fsCopy } from "./fs.js";

let dir = "";
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "yc-fs-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("fs tools", () => {
  it("写后读回", async () => {
    const p = join(dir, "a.txt");
    await fsWrite({ path: p, content: "hello world" });
    expect(await fsRead({ path: p })).toBe("hello world");
  });
  it("edit 唯一替换", async () => {
    const p = join(dir, "b.txt");
    await fsWrite({ path: p, content: "foo bar foo" });
    await expect(fsEdit({ path: p, old_string: "foo", new_string: "X" })).rejects.toThrow(/唯一|unique|多处|出现/i);
    await fsEdit({ path: p, old_string: "bar", new_string: "BAZ" });
    expect(await fsRead({ path: p })).toBe("foo BAZ foo");
    await fsEdit({ path: p, old_string: "foo", new_string: "Y", replace_all: true });
    expect(await fsRead({ path: p })).toBe("Y BAZ Y");
  });
  it("mkdir/list", async () => {
    await fsMkdir({ path: join(dir, "sub/deep") });
    expect(await fsList({ path: dir })).toContain("sub");
  });
  it("move/copy/delete", async () => {
    const src = join(dir, "m.txt");
    await fsWrite({ path: src, content: "m" });
    await fsCopy({ from: src, to: join(dir, "m-copy.txt") });
    expect(await readFile(join(dir, "m-copy.txt"), "utf8")).toBe("m");
    await fsMove({ from: src, to: join(dir, "m2.txt") });
    expect(await fsRead({ path: join(dir, "m2.txt") })).toBe("m");
    await fsDelete({ path: join(dir, "m2.txt") });
    await expect(fsRead({ path: join(dir, "m2.txt") })).rejects.toThrow();
  });
  it("stat 返回类型与大小", async () => {
    const s = await fsStat({ path: join(dir, "a.txt") });
    expect(s).toContain("file");
    expect(s).toMatch(/size/i);
  });
});
