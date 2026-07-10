import { readFile, writeFile, readdir, stat, mkdir, rename, rm, cp } from "node:fs/promises";

export async function fsRead(a: { path: string }): Promise<string> {
  return readFile(a.path, "utf8");
}

export async function fsWrite(a: { path: string; content: string }): Promise<string> {
  await writeFile(a.path, a.content, "utf8");
  return `已写入 ${a.path}（${a.content.length} 字节）`;
}

export async function fsEdit(a: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<string> {
  const text = await readFile(a.path, "utf8");
  const count = a.old_string ? text.split(a.old_string).length - 1 : 0;
  if (count === 0) throw new Error(`未找到要替换的内容：${a.old_string.slice(0, 40)}`);
  if (!a.replace_all && count > 1) throw new Error(`old_string 在文件中出现 ${count} 处，不唯一；请加上下文或用 replace_all`);
  const next = a.replace_all ? text.split(a.old_string).join(a.new_string) : text.replace(a.old_string, a.new_string);
  await writeFile(a.path, next, "utf8");
  return `已替换 ${a.replace_all ? count : 1} 处于 ${a.path}`;
}

export async function fsList(a: { path: string }): Promise<string> {
  return (await readdir(a.path)).join("\n");
}

export async function fsStat(a: { path: string }): Promise<string> {
  const s = await stat(a.path);
  const type = s.isDirectory() ? "directory" : s.isFile() ? "file" : "other";
  return JSON.stringify({ type, size: s.size, mtime: s.mtime.toISOString() });
}

export async function fsMkdir(a: { path: string }): Promise<string> {
  await mkdir(a.path, { recursive: true });
  return `已创建目录 ${a.path}`;
}

export async function fsMove(a: { from: string; to: string }): Promise<string> {
  try {
    await rename(a.from, a.to);
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code?: string }).code === "EXDEV") {
      await cp(a.from, a.to, { recursive: true });
      await rm(a.from, { recursive: true, force: true });
    } else throw e;
  }
  return `已移动 ${a.from} → ${a.to}`;
}

export async function fsDelete(a: { path: string; recursive?: boolean }): Promise<string> {
  await rm(a.path, { recursive: a.recursive === true, force: false });
  return `已删除 ${a.path}`;
}

export async function fsCopy(a: { from: string; to: string }): Promise<string> {
  await cp(a.from, a.to, { recursive: true });
  return `已复制 ${a.from} → ${a.to}`;
}
