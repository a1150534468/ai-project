// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, toastReducer, useToast, type ToastKind, type ToastState } from "./Toast";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const OK = { id: "a", kind: "ok" as const, text: "已保存" };
const ERR = { id: "b", kind: "err" as const, text: "保存失败" };

describe("toastReducer", () => {
  it("add 追加到末尾：先弹的排在上面", () => {
    const first = toastReducer([], { type: "add", toast: OK });

    expect(toastReducer(first, { type: "add", toast: ERR })).toEqual([OK, ERR]);
  });

  it("remove 只摘掉指定 id，其余原样留下", () => {
    const both: ToastState = [OK, ERR];

    expect(toastReducer(both, { type: "remove", id: "a" })).toEqual([ERR]);
  });

  it("remove 一个不在里面的 id 既不报错也不动别人", () => {
    expect(toastReducer([OK], { type: "remove", id: "查无此条" })).toEqual([OK]);
  });

  // 删除发生在 2.6 秒后的定时器里，那时候闭包拿的是旧数组 —— 就地改会把这期间新弹的抹掉
  it("不改原数组，每次都给新引用", () => {
    const before: ToastState = [OK];
    const after = toastReducer(before, { type: "add", toast: ERR });

    expect(before).toEqual([OK]);
    expect(after).not.toBe(before);
  });
});

/** 摸得到 `show` 的最小宿主：`useToast` 必须在 provider 里面调，所以得包一层组件。 */
function Trigger({ kind, text }: { kind: ToastKind; text: string }) {
  const { show } = useToast();

  return (
    <button type="button" onClick={() => show(kind, text)}>
      弹一条
    </button>
  );
}

describe("ToastProvider", () => {
  it("原样渲染子树：它是包在 App 外面的，不能吃掉内容", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <span>app-root</span>
      </ToastProvider>,
    );

    expect(html).toContain("app-root");
  });

  it("show 之后提示文案出现在页面上，并排了一个撤下它的定时器", () => {
    vi.useFakeTimers();
    const { getByRole, getByText } = render(
      <ToastProvider>
        <Trigger kind="ok" text="已保存" />
      </ToastProvider>,
    );

    fireEvent.click(getByRole("button", { name: "弹一条" }));

    expect(getByText("已保存")).toBeTruthy();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("同一次点击里连弹两条也不会撞 key：两条都在", () => {
    vi.useFakeTimers();
    const { getByRole, getAllByText } = render(
      <ToastProvider>
        <Trigger kind="err" text="保存失败" />
      </ToastProvider>,
    );

    const button = getByRole("button", { name: "弹一条" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(getAllByText("保存失败")).toHaveLength(2);
  });

  it("提示区标了 aria-live：只停 2.6 秒，读屏用户得听得到", () => {
    vi.useFakeTimers();
    const { getByRole } = render(
      <ToastProvider>
        <Trigger kind="ok" text="已保存" />
      </ToastProvider>,
    );

    expect(getByRole("status").getAttribute("aria-live")).toBe("polite");
  });
});

describe("useToast", () => {
  it("在 provider 外面用直接报错，而不是静默不弹", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => renderToStaticMarkup(<Trigger kind="ok" text="孤儿" />)).toThrow("useToast 必须在 ToastProvider 内使用");
  });
});
