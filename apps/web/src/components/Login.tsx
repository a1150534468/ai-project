import { useState } from "react";
import { ApiError } from "../apiError";
import { request } from "../http";
import { AuthField, AuthScreen, AuthSwitch } from "./AuthScreen";

interface LoginProps {
  onLogin: (token: string) => void;
  onSwitchToRegister: () => void;
  isLoading?: boolean;
}

export default function Login({ onLogin, onSwitchToRegister, isLoading = false }: LoginProps) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    if (identifier.trim() === "") {
      setError("请输入用户名或 UID");
      return;
    }
    if (password.trim() === "") {
      setError("请输入密码");
      return;
    }
    try {
      // 显式 token: null —— 登录页不该带上 localStorage 里可能残留的旧 token。
      const data = await request<{ token: string }>("/api/auth/login", {
        method: "POST",
        token: null,
        body: { identifier, password },
      });
      onLogin(data.token);
    } catch (failure) {
      // 后端的原始报错不往界面上抛：凭据错误统一提示，别泄露账号存不存在。
      if (failure instanceof ApiError) {
        setError("登录失败，请检查用户名和密码");
        return;
      }
      setError(failure instanceof Error ? failure.message : "登录出错，请稍后重试");
    }
  };

  const send = () => void submit();

  return (
    <AuthScreen
      title="登录账户"
      error={error}
      busy={isLoading}
      submitLabel="登录"
      busyLabel="登录中..."
      onSubmit={send}
      footer={
        <>
          没有账户？ <AuthSwitch onClick={onSwitchToRegister}>去注册</AuthSwitch>
        </>
      }
    >
      <AuthField
        label="用户名 / UID"
        icon="mdi:account-outline"
        value={identifier}
        placeholder="输入用户名或 UID"
        onChange={setIdentifier}
        onSubmit={send}
      />
      <AuthField
        label="密码"
        icon="mdi:lock-outline"
        type="password"
        value={password}
        placeholder="输入密码"
        onChange={setPassword}
        onSubmit={send}
      />
    </AuthScreen>
  );
}
