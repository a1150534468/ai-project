import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { PageTransition } from "./PageTransition";

describe("PageTransition", () => {
  it("renders the active view content", () => {
    const html = renderToStaticMarkup(
      <PageTransition viewKey="chat"><div>chat-page</div></PageTransition>,
    );
    expect(html).toContain("chat-page");
  });
});
