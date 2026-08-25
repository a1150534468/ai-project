// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert, alertClass, Badge, badgeClass, Button, buttonClass, Card, cardClass } from "./index";

/** 语义 token 之外的字面色值一律不许出现在基元里（design-system.md §2 Rules 的第二条） */
const LITERAL_COLOR = /\b(?:bg|text|border|ring)-(?:\[#|(?:gray|slate|red|amber|yellow|orange|blue|sky|emerald|green|violet|indigo|rose|purple|teal|cyan|pink)-\d)/;

const ALL_CLASSES = [
  ...(["primary", "secondary", "outline", "ghost", "danger"] as const).flatMap((variant) =>
    (["sm", "md", "lg"] as const).flatMap((size) =>
      (["pill", "rounded"] as const).map((shape) => buttonClass({ variant, size, shape })),
    ),
  ),
  ...(["brand", "danger", "warning", "info", "success", "neutral"] as const).flatMap((tone) =>
    (["soft", "solid", "outline"] as const).map((variant) => badgeClass({ tone, variant })),
  ),
  ...(["danger", "warning", "info", "success", "brand"] as const).flatMap((tone) =>
    [alertClass({ tone }), alertClass({ tone, bordered: true })],
  ),
  ...(["none", "sm", "md", "lg"] as const).map((padding) => cardClass({ padding })),
];

describe("ui 基元只用语义 token", () => {
  it("任何参数组合都不产出字面色值 / Tailwind 调色板类", () => {
    for (const className of ALL_CLASSES) {
      expect(className, className).not.toMatch(LITERAL_COLOR);
    }
  });

  it("text-white 只出现在固定实底上", () => {
    for (const className of ALL_CLASSES.filter((c) => c.includes("text-white"))) {
      expect(className, className).toMatch(/bg-(brand|danger|info)\b/);
    }
  });
});

describe("状态色三件套的配对由基元锁死", () => {
  it("弱底 X/10 必须配 X-ink 文字，不能配 X", () => {
    for (const tone of ["danger", "warning", "info", "success"] as const) {
      for (const className of [badgeClass({ tone }), alertClass({ tone }), alertClass({ tone, bordered: true })]) {
        expect(className, className).toContain(`bg-${tone}/10`);
        expect(className, className).toContain(`text-${tone}-ink`);
      }
    }
  });

  it("实底档不用 X-ink 当底色，且 warning/success 不配白字（3.1:1 过不了 AA）", () => {
    for (const tone of ["brand", "danger", "warning", "info", "success"] as const) {
      const className = badgeClass({ tone, variant: "solid" });
      expect(className, className).not.toContain(`bg-${tone}-ink`);
    }
    expect(badgeClass({ tone: "warning", variant: "solid" })).toContain("text-scrim");
    expect(badgeClass({ tone: "success", variant: "solid" })).toContain("text-scrim");
  });

  it("brand 走专用的 brand-soft，不用半透明", () => {
    expect(badgeClass({ tone: "brand" })).toBe("inline-flex flex-none items-center gap-1 rounded-full font-medium bg-brand-soft text-brand-ink px-2 py-0.5 text-[11px]");
    expect(alertClass({ tone: "brand" })).not.toContain("bg-brand/");
  });
});

describe("buttonClass 收敛圆角与禁用态", () => {
  it("只产出 rounded-full / rounded-[10px] 两种圆角", () => {
    for (const shape of ["pill", "rounded"] as const) {
      const className = buttonClass({ shape });
      expect(className, className).toContain(shape === "pill" ? "rounded-full" : "rounded-[10px]");
      expect(className.match(/rounded-\S+/g), className).toHaveLength(1);
    }
  });

  it("实底档禁用态换灰底灰字而不是调透明度", () => {
    for (const variant of ["primary", "danger"] as const) {
      const className = buttonClass({ variant });
      expect(className, className).toContain("disabled:bg-hairline");
      expect(className, className).toContain("disabled:text-ink-tertiary");
      expect(className, className).not.toContain("disabled:opacity");
    }
  });

  it("弱强调档统一用 disabled:opacity-50，不再有 40 / 45 / 60 三种漂移", () => {
    for (const variant of ["secondary", "outline", "ghost"] as const) {
      expect(buttonClass({ variant }), variant).toContain("disabled:opacity-50");
    }
  });

  it("hover 不换到 -ink 档（暗色下 brand-ink 提亮会让白字掉到 2.3:1）", () => {
    expect(buttonClass({ variant: "primary" })).toContain("hover:bg-brand/90");
    expect(buttonClass({ variant: "primary" })).not.toContain("hover:bg-brand-ink");
  });

  it("不自己设 flex，好让调用方的 flex-1 生效（弹窗按钮行要平分宽度）", () => {
    expect(buttonClass()).not.toMatch(/\bflex-(none|1|auto|initial)\b/);
    expect(buttonClass({ className: "flex-1" })).toContain("flex-1");
  });
});

describe("cardClass", () => {
  it("默认就是全站最高频的那串手写 className", () => {
    expect(cardClass()).toBe("rounded-2xl border border-hairline-subtle bg-surface p-5");
  });

  it("padding=none 不留空格残留，bordered=false 去掉描边", () => {
    expect(cardClass({ padding: "none" })).toBe("rounded-2xl border border-hairline-subtle bg-surface");
    expect(cardClass({ bordered: false, padding: "sm", tone: "muted" })).toBe("rounded-2xl bg-surface-muted p-3");
  });
});

describe("组件壳的行为", () => {
  it("<Button> 默认 type=button，不会误提交表单", () => {
    render(<Button>保存</Button>);
    expect(screen.getByRole("button", { name: "保存" })).toHaveAttribute("type", "button");
  });

  it("<Button> 的 type 可以被覆盖，disabled 透传", () => {
    render(
      <Button type="submit" disabled>
        提交
      </Button>,
    );
    const button = screen.getByRole("button", { name: "提交" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toBeDisabled();
  });

  it("<Alert tone=danger> 用 role=alert，其余用 role=status", () => {
    const { unmount } = render(<Alert tone="danger">额度不足</Alert>);
    expect(screen.getByRole("alert")).toHaveTextContent("额度不足");
    unmount();
    render(<Alert tone="info">正在同步</Alert>);
    expect(screen.getByRole("status")).toHaveTextContent("正在同步");
  });

  it("<Card> / <Badge> 把 className 拼在工厂结果之后", () => {
    const { container } = render(
      <Card className="mb-6">
        <Badge tone="success" className="ml-2" />
      </Card>,
    );
    expect(container.firstElementChild).toHaveClass("rounded-2xl", "bg-surface", "p-5", "mb-6");
    expect(container.querySelector("span")).toHaveClass("bg-success/10", "text-success-ink", "ml-2");
  });
});
