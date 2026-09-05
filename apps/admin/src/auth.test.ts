/**
 * auth.ts 的用例：权限门禁、权限目录、会话存取。
 *
 * 重点在两处「上一版栽过跟头」的地方：
 * - 可授予权限名单必须包含 KNOWLEDGE_MANAGE（旧的 Admins.tsx 手抄时漏了这一条，
 *   于是后台勾不出知识库权限，而服务端是收的）；
 * - loadSession 遇到结构不对的存量数据要当没登录，并把它清掉 —— 旧代码直接
 *   `JSON.parse(raw) as Session`，少了 permissions 的旧格式会一路穿到 can() 里炸成白屏。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  can,
  clearSession,
  GRANTABLE_PERMISSIONS,
  loadSession,
  permissionLabel,
  saveSession,
  type Session,
} from "./auth.js";

const SUPER: Session = { token: "t", adminId: "a", role: "super_admin", permissions: [] };
const PLAIN: Session = { token: "t", adminId: "b", role: "admin", permissions: ["USER_MANAGE"] };

/** loadSession 只认这个键，用例里要塞脏数据就得用它。 */
const KEY = "ai_assistant_admin_session";

beforeEach(() => {
  sessionStorage.clear();
});

describe("can", () => {
  it("super_admin 不看 permissions，任何权限都放行", () => {
    expect(can(SUPER, "ADMIN_MANAGE")).toBe(true);
    expect(can(SUPER, "KNOWLEDGE_MANAGE")).toBe(true);
  });

  it("普通管理员只有授予集里的那些", () => {
    expect(can(PLAIN, "USER_MANAGE")).toBe(true);
    expect(can(PLAIN, "KNOWLEDGE_MANAGE")).toBe(false);
    expect(can(PLAIN, "ADMIN_MANAGE")).toBe(false);
  });

  it("没会话一律 false", () => {
    expect(can(null, "USER_MANAGE")).toBe(false);
  });
});

describe("权限目录", () => {
  it("可授予名单含知识库、不含管理员管理", () => {
    expect(GRANTABLE_PERMISSIONS).toContain("KNOWLEDGE_MANAGE");
    expect(GRANTABLE_PERMISSIONS).not.toContain("ADMIN_MANAGE");
    // 与服务端 GRANTABLE_PERMISSIONS 同口径：五条里去掉 ADMIN_MANAGE
    expect(GRANTABLE_PERMISSIONS).toHaveLength(4);
  });

  it("认识的权限码给中文名，不认识的原样返回", () => {
    expect(permissionLabel("KNOWLEDGE_MANAGE")).toBe("知识库管理");
    expect(permissionLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("会话存取", () => {
  it("存进去再读出来是同一份", () => {
    saveSession(PLAIN);
    expect(loadSession()).toEqual(PLAIN);
  });

  it("clearSession 之后读不到", () => {
    saveSession(PLAIN);
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it("没存过读到 null", () => {
    expect(loadSession()).toBeNull();
  });

  it.each([
    ["不是 JSON", "{"],
    ["不是对象", '"just a string"'],
    ["token 空", '{"token":"","adminId":"a","role":"admin","permissions":[]}'],
    ["缺 adminId", '{"token":"t","role":"admin","permissions":[]}'],
    ["role 不认识", '{"token":"t","adminId":"a","role":"root","permissions":[]}'],
    ["缺 permissions", '{"token":"t","adminId":"a","role":"admin"}'],
  ])("存量数据 %s：当没登录，并把它清掉", (_label, raw) => {
    sessionStorage.setItem(KEY, raw);
    expect(loadSession()).toBeNull();
    // 不清的话每次渲染都要重走一遍解析
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("服务端发来的陌生权限码留着，非字符串的滤掉", () => {
    sessionStorage.setItem(KEY, '{"token":"t","adminId":"a","role":"admin","permissions":["FUTURE_PERM",7,null]}');
    expect(loadSession()?.permissions).toEqual(["FUTURE_PERM"]);
  });
});
