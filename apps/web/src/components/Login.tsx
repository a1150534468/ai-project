import { useEffect, useState } from "react";
import { errorMessage } from "../apiError";
import { ApiError } from "../apiError";
import { getDemoAccountConfig, loginDemo } from "../api";
import { request } from "../http";
import { Icon } from "@iconify/react";
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
  const [demoUsername, setDemoUsername] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDemoAccountConfig()
      .then((config) => {
        if (!cancelled && config.enabled) setDemoUsername(config.username);
      })
      .catch(() => {
        // 体验入口是增强项，配置读取失败不应阻塞普通登录。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const busy = isLoading || submitting || demoBusy;

  const submit = async () => {
    if (busy) return;
    setError("");
    if (identifier.trim() === "") {
      setError("请输入用户名或 UID");
      return;
    }
    if (password.trim() === "") {
      setError("请输入密码");
      return;
    }
    setSubmitting(true);
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
      setError(errorMessage(failure, "登录出错，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDemo = async () => {
    if (busy) return;
    setError("");
    setDemoBusy(true);
    try {
      onLogin(await loginDemo());
    } catch (failure) {
      if (failure instanceof ApiError) {
        if (failure.status === 403) setError("体验账号暂不可用");
        else if (failure.status === 409) setError("体验账号配置有冲突，请联系项目维护者");
        else if (failure.status === 404) setError("体验账号暂未开放");
        else setError("体验登录失败，请稍后重试");
      } else {
        setError(errorMessage(failure, "体验登录出错，请稍后重试"));
      }
    } finally {
      setDemoBusy(false);
    }
  };

  const send = () => void submit();

  return (
    <AuthScreen
      title="登录账户"
      error={error}
      busy={busy}
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
      {demoUsername && (
        <div className="rounded-[12px] border border-brand/25 bg-brand-soft p-4">
          <div className="flex items-start gap-3">
            <Icon icon="mdi:briefcase-outline" className="mt-0.5 flex-none text-xl text-brand-ink" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">面试体验账号</p>
              <p className="mt-1 text-xs text-ink-secondary">账号：{demoUsername} · 无需注册</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void submitDemo()}
            disabled={busy}
            className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-full bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:bg-hairline disabled:text-ink-tertiary"
          >
            <Icon
              icon={demoBusy ? "mdi:loading" : "mdi:arrow-right-circle-outline"}
              className={demoBusy ? "animate-spin" : ""}
              aria-hidden
            />
            {demoBusy ? "进入体验中..." : "一键进入体验"}
          </button>
          <p className="mt-2 text-center text-[11px] text-ink-tertiary">演示数据会定期重置</p>
        </div>
      )}
    </AuthScreen>
  );
}
