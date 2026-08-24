import { useState } from "react";
import { Icon } from "@iconify/react";
import { BrandLogo, RippleButton } from "../motion";
import { ApiError } from "../apiError";
import { request } from "../http";
import { ThemeToggle } from "./ThemeToggle";

interface LoginProps {
  onLogin: (token: string) => void;
  onSwitchToRegister: () => void;
  isLoading?: boolean;
}

export default function Login({ onLogin, onSwitchToRegister, isLoading = false }: LoginProps) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState("");

  const handleLogin = async () => {
    try {
      setError("");
      if (!identifier.trim()) {
        setError("请输入用户名或 UID");
        return;
      }
      if (!password.trim()) {
        setError("请输入密码");
        return;
      }

      // 显式 token: null——登录页不该带上 localStorage 里可能残留的旧 token。
      const data = await request<{ token: string }>("/api/auth/login", {
        method: "POST",
        token: null,
        body: { identifier, password },
      });
      onLogin(data.token);
    } catch (err) {
      // 后端的原始报错不往界面上抛，凭据错误统一提示，避免泄露账号是否存在。
      if (err instanceof ApiError) {
        setError("登录失败，请检查用户名和密码");
        return;
      }
      setError(
        err instanceof Error ? err.message : "登录出错，请稍后重试"
      );
    }
  };

  return (
    <div className="auth-shell min-h-screen bg-[#f5f5f7] flex items-center justify-center p-4">
      <ThemeToggle compact className="fixed right-5 top-5 z-10" />
      <div className="w-full max-w-[420px]">
        {/* Logo & Branding */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-5">
            <BrandLogo size={52} />
          </div>
          <h1 className="text-[34px] font-semibold leading-tight text-gray-900 mb-2">AI 助手</h1>
          <p className="text-gray-500 text-[15px]">您的全能 AI 助手</p>
        </div>

        {/* Login Card */}
        <div className="auth-card bg-white rounded-[18px] p-7 sm:p-8 border border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">登录账户</h2>

          {/* Input Fields */}
          <div className="space-y-4 mb-6">
            {/* Identifier Input */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                用户名 / UID
              </label>
              <div className="relative">
                <Icon
                  icon="mdi:account-outline"
                  className="absolute left-3 top-3.5 text-gray-400"
                />
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                  placeholder="输入用户名或 UID"
                  className="w-full pl-10 pr-4 py-3 rounded-[11px] border border-gray-200 focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none transition-all bg-white"
                />
              </div>
            </div>

            {/* Password Input */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                密码
              </label>
              <div className="relative">
                <Icon
                  icon="mdi:lock-outline"
                  className="absolute left-3 top-3.5 text-gray-400"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                  placeholder="输入密码"
                  className="w-full pl-10 pr-4 py-3 rounded-[11px] border border-gray-200 focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none transition-all bg-white"
                />
              </div>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-600 flex items-center">
                <Icon icon="mdi:alert-circle" className="mr-2" />
                {error}
              </p>
            </div>
          )}

          {/* Login Button */}
          <RippleButton
            onClick={handleLogin}
            disabled={isLoading}
            className="w-full bg-brand disabled:bg-gray-300 text-white font-normal py-3 rounded-full transition-transform active:scale-[0.98] disabled:shadow-none"
          >
            {isLoading ? (
              <span className="flex items-center justify-center">
                <Icon icon="mdi:loading" className="animate-spin mr-2" />
                登录中...
              </span>
            ) : (
              "登录"
            )}
          </RippleButton>

          {/* Footer */}
          <p className="text-xs text-gray-500 text-center mt-6">
            没有账户？{" "}
            <button
              onClick={onSwitchToRegister}
              className="text-brand font-medium"
            >
              去注册
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
