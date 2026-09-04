import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, errMsg, useConfirm, useToast } from "./ui.js";

/*
 * ui.tsx 是后台唯一的原语层，被 8 个页面共用，但此前一个用例都没有。
 * 这里只钉行为契约：渲不渲染、点了谁、await 到什么、定时器什么时候收 —— 不碰样式。
 */

let container: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function pick(selector: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`节点缺失: ${selector}`);
  return el;
}

/** 按可见文字取 footer 里的按钮 —— 两个按钮都是 .btn，只能靠文字区分。 */
function footerButton(text: string): HTMLElement {
  const found = Array.from(
    container.querySelectorAll<HTMLElement>(".modal-footer-actions button"),
  ).find((el) => el.textContent === text);
  if (!found) throw new Error(`按钮缺失: ${text}`);
  return found;
}

async function press(key: string) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("errMsg", () => {
  it("Error / 字符串取原文，空白与其他类型退回兜底文案", () => {
    expect(errMsg(new Error("配额不足"))).toBe("配额不足");
    expect(errMsg(new Error("   "))).toBe("操作失败");
    expect(errMsg("原样透出")).toBe("原样透出");
    expect(errMsg("")).toBe("操作失败");
    expect(errMsg({ code: 500 })).toBe("操作失败");
    expect(errMsg(undefined)).toBe("操作失败");
  });
});

describe("Modal", () => {
  it("open=false 时整棵子树不挂载", async () => {
    await mount(
      <Modal open={false} title="标题" onClose={() => {}}>
        正文
      </Modal>,
    );
    expect(container.querySelector(".modal-mask")).toBeNull();
  });

  it("标题/正文/footer 各就各位，width 落到卡片的内联样式", async () => {
    await mount(
      <Modal
        open
        title="删除确认"
        width="640px"
        onClose={() => {}}
        footer={<span>底部</span>}
      >
        <p>正文</p>
      </Modal>,
    );
    const card = pick(".modal-card");
    expect(card.style.width).toBe("640px");
    expect(card.getAttribute("aria-modal")).toBe("true");
    expect(pick(".modal-title").textContent).toBe("删除确认");
    expect(pick(".modal-body").textContent).toBe("正文");
    expect(pick(".modal-footer").textContent).toBe("底部");
  });

  it("不传 footer 就不渲染 footer 容器", async () => {
    await mount(
      <Modal open title="t" onClose={() => {}}>
        正文
      </Modal>,
    );
    expect(container.querySelector(".modal-footer")).toBeNull();
  });

  it("关闭键 / 遮罩 / Esc 都会关，点卡片内部不会", async () => {
    const onClose = vi.fn();
    await mount(
      <Modal open title="t" onClose={onClose}>
        正文
      </Modal>,
    );

    await click(pick(".modal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    // 卡片这层把冒泡截断，否则点正文也会顺手关掉
    await click(pick(".modal-card"));
    expect(onClose).toHaveBeenCalledTimes(1);

    await click(pick(".modal-mask"));
    expect(onClose).toHaveBeenCalledTimes(2);

    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(3);

    await press("Enter");
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("关掉之后 Esc 监听要摘掉", async () => {
    const onClose = vi.fn();
    await mount(
      <Modal open title="t" onClose={onClose}>
        正文
      </Modal>,
    );
    await mount(
      <Modal open={false} title="t" onClose={onClose}>
        正文
      </Modal>,
    );
    await press("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

});

type ConfirmFn = ReturnType<typeof useConfirm>["confirm"];

let confirmFn: ConfirmFn | null = null;

function ConfirmHost() {
  const { confirm, node } = useConfirm();
  confirmFn = confirm;
  return <>{node}</>;
}

function ask(opts: Parameters<ConfirmFn>[0]): Promise<boolean> {
  if (!confirmFn) throw new Error("ConfirmHost 未挂载");
  return confirmFn(opts);
}

describe("useConfirm", () => {
  it("确认键 await 到 true，取消键 await 到 false，收尾都会把弹窗摘掉", async () => {
    await mount(<ConfirmHost />);
    const answers: boolean[] = [];

    await act(async () => {
      ask({ message: "要删掉吗" }).then((ok) => answers.push(ok));
    });
    expect(container.textContent).toContain("要删掉吗");
    await click(footerButton("确认"));
    expect(answers).toEqual([true]);
    expect(container.querySelector(".modal-mask")).toBeNull();

    await act(async () => {
      ask({ message: "再问一次", confirmText: "删掉" }).then((ok) => answers.push(ok));
    });
    await click(footerButton("取消"));
    expect(answers).toEqual([true, false]);
    expect(container.querySelector(".modal-mask")).toBeNull();
  });

  it("danger 才给确认键加 danger 类", async () => {
    await mount(<ConfirmHost />);
    await act(async () => {
      void ask({ message: "m" });
    });
    expect(footerButton("确认").className).toBe("btn");

    await act(async () => {
      void ask({ message: "m", danger: true });
    });
    expect(footerButton("确认").className).toBe("btn danger");
  });

  it("第二问顶掉第一问时，旧 promise 按取消收尾（否则调用方的 await 永远卡住）", async () => {
    await mount(<ConfirmHost />);
    const answers: boolean[] = [];

    await act(async () => {
      ask({ message: "第一问" }).then((ok) => answers.push(ok));
    });
    await act(async () => {
      ask({ message: "第二问" }).then((ok) => answers.push(ok));
    });

    expect(answers).toEqual([false]);
    expect(container.textContent).toContain("第二问");
    expect(container.textContent).not.toContain("第一问");

    await click(footerButton("确认"));
    expect(answers).toEqual([false, true]);
  });

  it("默认标题是「确认」，传 title 就用传的", async () => {
    await mount(<ConfirmHost />);
    await act(async () => {
      void ask({ message: "m" });
    });
    expect(pick(".modal-title").textContent).toBe("确认");

    await act(async () => {
      void ask({ message: "m", title: "移出黑名单" });
    });
    expect(pick(".modal-title").textContent).toBe("移出黑名单");
  });

});

type ShowFn = ReturnType<typeof useToast>["show"];

let showFn: ShowFn | null = null;

function ToastHost() {
  const { show, node } = useToast();
  showFn = show;
  return <>{node}</>;
}

async function showToast(...args: Parameters<ShowFn>) {
  if (!showFn) throw new Error("ToastHost 未挂载");
  const show = showFn;
  await act(async () => {
    show(...args);
  });
}

async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useToast", () => {
  it("show 出文案与类型，2.5 秒整点收掉", async () => {
    vi.useFakeTimers();
    await mount(<ToastHost />);

    await showToast("保存成功");
    expect(pick(".toast").className).toBe("toast ok");
    expect(pick(".toast").textContent).toBe("保存成功");

    await tick(2499);
    expect(container.querySelector(".toast")).not.toBeNull();
    await tick(1);
    expect(container.querySelector(".toast")).toBeNull();
  });

  it("后一条顶掉前一条，且旧定时器不会提前把新的收走", async () => {
    vi.useFakeTimers();
    await mount(<ToastHost />);

    await showToast("第一条", "err");
    expect(pick(".toast").className).toBe("toast err");

    await tick(2000);
    await showToast("第二条");
    // 第一条的定时器本该在 2500 触发，被 show 清掉了
    await tick(600);
    expect(pick(".toast").textContent).toBe("第二条");
    expect(pick(".toast").className).toBe("toast ok");

    await tick(1900);
    expect(container.querySelector(".toast")).toBeNull();
  });
});
