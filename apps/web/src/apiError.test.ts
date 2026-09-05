import { describe, expect, it } from "vitest";
import { ApiError, errorMessage } from "./apiError";

const MESSAGE_PROBES = [
  { what: "有话说就说它自己的", error: new Error("知识库不存在"), want: "知识库不存在" },
  { what: "空 message 走兜底 —— 被 AbortController 掐断的 fetch 就是这一档", error: new Error(""), want: "兜底" },
  { what: "ApiError 也是 Error，走同一条路", error: new ApiError("配额不足", 409), want: "配额不足" },
  { what: "抛字符串的（第三方库常干）拿不到 message，走兜底", error: "boom", want: "兜底" },
  { what: "抛 null 不许炸", error: null, want: "兜底" },
  { what: "抛对象字面量：有 message 字段也不认，它不是 Error", error: { message: "假的" }, want: "兜底" },
] as const;

describe("errorMessage", () => {
  for (const probe of MESSAGE_PROBES) {
    it(probe.what, () => {
      expect(errorMessage(probe.error, "兜底")).toBe(probe.want);
    });
  }
});

/** 造一个真 `Response`：`{ok,status,json}` 那种假货测不到「body 读不出来」这条路。 */
function response(body: string, status = 400, contentType = "application/json"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

describe("ApiError.fromResponse", () => {
  it("取 error 与 data，两者都留着", async () => {
    const error = await ApiError.fromResponse(
      response(JSON.stringify({ error: "补修额度用完了", data: { remaining: 0 } })),
      "请求失败",
    );

    expect(error.message).toBe("补修额度用完了");
    expect(error.status).toBe(400);
    expect(error.data).toEqual({ remaining: 0 });
  });

  it("网关吐 HTML 错误页时退回 fallback，data 为 null", async () => {
    const error = await ApiError.fromResponse(response("<html>502</html>", 502, "text/html"), "网关错误");

    expect(error.message).toBe("网关错误");
    expect(error.status).toBe(502);
    expect(error.data).toBeNull();
  });

  it("空 body 同样退回 fallback", async () => {
    const error = await ApiError.fromResponse(new Response(null, { status: 401 }), "未登录");

    expect(error.message).toBe("未登录");
    expect(error.data).toBeNull();
  });

  it("服务端回 error: \"\" 时不留空话，走 fallback", async () => {
    const error = await ApiError.fromResponse(response(JSON.stringify({ error: "" })), "保存失败");

    expect(error.message).toBe("保存失败");
  });

  it("data 是数组也算结构化，原样留着", async () => {
    const error = await ApiError.fromResponse(
      response(JSON.stringify({ error: "有三篇没通过", data: ["a", "b", "c"] })),
      "上传失败",
    );

    expect(error.data).toEqual(["a", "b", "c"]);
  });

  it("data 是标量就丢掉 —— 调用方按对象读，给它个数字只会读出 undefined", async () => {
    const error = await ApiError.fromResponse(response(JSON.stringify({ error: "超时", data: 42 })), "失败");

    expect(error.data).toBeNull();
  });

  it("name 是 ApiError，方便 catch 里分流", async () => {
    const error = await ApiError.fromResponse(response(JSON.stringify({ error: "x" })), "y");

    expect(error.name).toBe("ApiError");
    expect(error instanceof Error).toBe(true);
  });
});
