import { useState } from "react";
import { Icon } from "@iconify/react";
import { register } from "../api";
import { BrandLogo, RippleButton } from "../motion";
import { ThemeToggle } from "./ThemeToggle";

interface RegisterProps {
  onAuthed: (token: string) => void;
  onSwitchToLogin: () => void;
  isLoading?: boolean;
}

export default function Register({ onAuthed, onSwitchToLogin, isLoading = false }: RegisterProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [channelCode, setChannelCode] = useState("");
  const [error, setError] = useState("");

  const handleRegister = async () => {
    try {
      setError("");

      // Validation
      if (!username.trim()) {
        setError("请输入用户名");
        return;
      }
      if (username.length < 3 || username.length > 32) {
        setError("用户名长度需 3-32 字符");
        return;
      }
      if (!password.trim()) {
        setError("请输入密码");
        return;
      }
      if (password.length < 8) {
        setError("密码长度至少 8 字符");
        return;
      }
      if (!confirmPassword.trim()) {
        setError("请确认密码");
        return;
      }
      if (password !== confirmPassword) {
        setError("两次输入的密码不一致");
        return;
      }
      const code = channelCode.trim().toUpperCase();
      if (!code) {
        setError("请输入注册码");
        return;
      }
      if (!/^[A-Z]{2}$/.test(code)) {
        setError("注册码为 2 位字母");
        return;
      }

      const token = await register(username, password, code);
      onAuthed(token);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "注册出错，请稍后重试"
      );
    }
  };

  return (
    <div className="auth-shell min-h-screen bg-surface-muted flex items-center justify-center overflow-y-auto p-4 py-8">
      <ThemeToggle compact className="fixed right-5 top-5 z-10" />
      <div className="w-full max-w-[420px]">
        {/* Logo & Branding */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-5">
            <BrandLogo size={52} />
          </div>
          <h1 className="text-[34px] font-semibold leading-tight text-ink mb-2">AI 助手</h1>
          <p className="text-ink-secondary text-[15px]">您的全能 AI 助手</p>
        </div>

        {/* Register Card */}
        <div className="auth-card bg-surface rounded-[18px] p-7 sm:p-8 border border-hairline-subtle">
          <h2 className="text-xl font-semibold text-ink mb-6">创建账户</h2>

          {/* Input Fields */}
          <div className="space-y-4 mb-6">
            {/* Username Input */}
            <div>
              <label className="block text-sm font-medium text-ink mb-2">
                用户名
              </label>
              <div className="relative">
                <Icon
                  icon="mdi:account-outline"
                  className="absolute left-3 top-3.5 text-ink-tertiary"
                />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleRegister()}
                  placeholder="3-32 个字符"
                  className="w-full pl-10 pr-4 py-3 rounded-[11px] border border-hairline-subtle focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none transition-all bg-surface"
                />
              </div>
            </div>

            {/* Channel Code Input */}
            <div>
              <label className="block text-sm font-medium text-ink mb-2">
                注册码
              </label>
              <div className="relative">
                <Icon
                  icon="mdi:key-outline"
                  className="absolute left-3 top-3.5 text-ink-tertiary"
                />
                <input
                  type="text"
                  value={channelCode}
                  onChange={(e) => setChannelCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && handleRegister()}
                  placeholder="2 位大写字母，如 AB"
                  maxLength={2}
                  className="w-full pl-10 pr-4 py-3 rounded-[11px] border border-hairline-subtle focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none transition-all bg-surface"
                />
              </div>
            </div>

            {/* Password Input */}
            <div>
              <label className="block text-sm font-medium text-ink mb-2">
                密码
              </label>
              <div className="relative">
                <Icon
                  icon="mdi:lock-outline"
                  className="absolute left-3 top-3.5 text-ink-tertiary"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleRegister()}
                  placeholder="至少 8 个字符"
                  className="w-full pl-10 pr-4 py-3 rounded-[11px] border border-hairline-subtle focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none transition-all bg-surface"
                />
              </div>
            </div>

            {/* Confirm Password Input */}
            <div>
              <label className="block text-sm font-medium text-ink mb-2">
                确认密码
              </label>
              <div className="relative">
                <Icon
                  icon="mdi:lock-check-outline"
                  className="absolute left-3 top-3.5 text-ink-tertiary"
                />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleRegister()}
                  placeholder="再输入一遍密码"
                  className="w-full pl-10 pr-4 py-3 rounded-[11px] border border-hairline-subtle focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none transition-all bg-surface"
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

          {/* Register Button */}
          <RippleButton
            onClick={handleRegister}
            disabled={isLoading}
            className="w-full bg-brand disabled:bg-hairline disabled:text-ink-tertiary text-white font-normal py-3 rounded-full transition-transform active:scale-[0.98] disabled:shadow-none"
          >
            {isLoading ? (
              <span className="flex items-center justify-center">
                <Icon icon="mdi:loading" className="animate-spin mr-2" />
                注册中...
              </span>
            ) : (
              "创建账户"
            )}
          </RippleButton>

          {/* Footer */}
          <p className="text-xs text-ink-secondary text-center mt-6">
            已有账户？{" "}
            <button
              onClick={onSwitchToLogin}
              className="text-brand font-medium"
            >
              去登录
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
