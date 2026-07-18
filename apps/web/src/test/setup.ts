import { createElement } from "react";
import { vi } from "vitest";

// Iconify resolves icons asynchronously and may schedule a React state update
// after Vitest has already torn down jsdom. Tests care about the requested
// icon identity, not the network/cache loader, so keep a deterministic global
// test double and expose the icon name for assertions.
vi.mock("@iconify/react", () => ({
  Icon: ({ icon, ...props }: { readonly icon: string } & Record<string, unknown>) => (
    createElement("span", { ...props, "data-icon": icon })
  ),
}));
