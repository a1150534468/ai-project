import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Stagger, StaggerItem } from "./Stagger";

describe("Stagger", () => {
  it("所有子项原样渲染出来，顺序不变", () => {
    const html = renderToStaticMarkup(
      <Stagger>
        <StaggerItem>
          <span>row-1</span>
        </StaggerItem>
        <StaggerItem>
          <span>row-2</span>
        </StaggerItem>
      </Stagger>,
    );

    expect(html.indexOf("row-1")).toBeLessThan(html.indexOf("row-2"));
  });

  // 入场动效已经去掉，两个壳子现在只剩「把 className 挂到 div 上」这一个作用
  it("外层和每一项的 className 分别落到自己的 div 上", () => {
    const html = renderToStaticMarkup(
      <Stagger className="grid gap-3">
        <StaggerItem className="card">
          <span>row-1</span>
        </StaggerItem>
      </Stagger>,
    );

    expect(html).toBe('<div class="grid gap-3"><div class="card"><span>row-1</span></div></div>');
  });
});
