import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelCard } from "./ModelMarketplace";

describe("ModelCard", () => {
  it("does not render the internal model id", () => {
    const html = renderToStaticMarkup(
      <ModelCard model={{ model: "claude-opus-4-8", displayName: "Claude/opus 4.8" }} />,
    );

    expect(html).toContain("Claude/opus 4.8");
    expect(html).not.toContain("claude-opus-4-8");
  });

  it("falls back to a placeholder when the model has no display name", () => {
    const html = renderToStaticMarkup(<ModelCard model={{ model: "gpt-x", displayName: "" }} />);

    expect(html).toContain("未命名模型");
  });
});
