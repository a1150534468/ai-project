import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { ToastProvider } from "./Toast";

describe("ToastProvider", () => {
  it("renders children", () => {
    const html = renderToStaticMarkup(
      <ToastProvider><span>app-root</span></ToastProvider>,
    );
    expect(html).toContain("app-root");
  });
});
