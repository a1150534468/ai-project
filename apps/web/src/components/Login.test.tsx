// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../apiError";
import Login from "./Login";

const apiMocks = vi.hoisted(() => ({
  getDemoAccountConfig: vi.fn(),
  loginDemo: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...apiMocks,
}));

vi.mock("../http", () => ({
  request: vi.fn(),
}));

describe("Login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getDemoAccountConfig.mockResolvedValue({ enabled: true, username: "demo" });
    apiMocks.loginDemo.mockResolvedValue("demo-token");
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    );
  });

  it("显示体验账号并支持一键进入", async () => {
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} onSwitchToRegister={vi.fn()} />);

    expect(await screen.findByText("账号：demo · 无需注册")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "一键进入体验" }));

    await waitFor(() => expect(apiMocks.loginDemo).toHaveBeenCalledOnce());
    expect(onLogin).toHaveBeenCalledWith("demo-token");
  });

  it("体验账号未配置时不显示入口，普通登录仍可用", async () => {
    apiMocks.getDemoAccountConfig.mockResolvedValue({ enabled: false, username: null });
    const { container } = render(<Login onLogin={vi.fn()} onSwitchToRegister={vi.fn()} />);

    await waitFor(() => expect(apiMocks.getDemoAccountConfig).toHaveBeenCalledOnce());
    expect(container).not.toHaveTextContent("一键进入体验");
  });

  it("体验账号接口冲突时给出维护提示", async () => {
    apiMocks.loginDemo.mockRejectedValue(new ApiError("conflict", 409));
    render(<Login onLogin={vi.fn()} onSwitchToRegister={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "一键进入体验" }));

    expect(await screen.findByText("体验账号配置有冲突，请联系项目维护者")).toBeInTheDocument();
  });
});
