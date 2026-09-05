import { useState } from "react";
import { errorMessage } from "../apiError";
import { register } from "../api";
import { AuthField, AuthScreen, AuthSwitch } from "./AuthScreen";

interface RegisterProps {
  onAuthed: (token: string) => void;
  onSwitchToLogin: () => void;
  isLoading?: boolean;
}

interface Draft {
  readonly username: string;
  readonly password: string;
  readonly confirm: string;
}

/**
 * 前端这一道只为「少跑一趟网络」，真正说了算的是后端；顺序照着填表顺序来，
 * 第一条不过就把话说给用户听，不一次抖出三条。
 */
const RULES: readonly { readonly ok: (draft: Draft) => boolean; readonly message: string }[] = [
  { ok: (d) => d.username.trim() !== "", message: "请输入用户名" },
  { ok: (d) => d.username.length >= 3 && d.username.length <= 32, message: "用户名长度需 3-32 字符" },
  { ok: (d) => d.password.trim() !== "", message: "请输入密码" },
  { ok: (d) => d.password.length >= 8, message: "密码长度至少 8 字符" },
  { ok: (d) => d.confirm.trim() !== "", message: "请确认密码" },
  { ok: (d) => d.password === d.confirm, message: "两次输入的密码不一致" },
];

function firstProblem(draft: Draft): string | null {
  return RULES.find((rule) => !rule.ok(draft))?.message ?? null;
}

export default function Register({ onAuthed, onSwitchToLogin, isLoading = false }: RegisterProps) {
  const [draft, setDraft] = useState<Draft>({ username: "", password: "", confirm: "" });
  const [error, setError] = useState("");

  const edit = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));

  const submit = async () => {
    setError("");
    const problem = firstProblem(draft);
    if (problem !== null) {
      setError(problem);
      return;
    }
    try {
      onAuthed(await register(draft.username, draft.password));
    } catch (failure) {
      setError(errorMessage(failure, "注册出错，请稍后重试"));
    }
  };

  const send = () => void submit();

  return (
    <AuthScreen
      scroll
      title="创建账户"
      error={error}
      busy={isLoading}
      submitLabel="创建账户"
      busyLabel="注册中..."
      onSubmit={send}
      footer={
        <>
          已有账户？ <AuthSwitch onClick={onSwitchToLogin}>去登录</AuthSwitch>
        </>
      }
    >
      <AuthField
        label="用户名"
        icon="mdi:account-outline"
        value={draft.username}
        placeholder="3-32 个字符"
        onChange={(username) => edit({ username })}
        onSubmit={send}
      />
      <AuthField
        label="密码"
        icon="mdi:lock-outline"
        type="password"
        value={draft.password}
        placeholder="至少 8 个字符"
        onChange={(password) => edit({ password })}
        onSubmit={send}
      />
      <AuthField
        label="确认密码"
        icon="mdi:lock-check-outline"
        type="password"
        value={draft.confirm}
        placeholder="再输入一遍密码"
        onChange={(confirm) => edit({ confirm })}
        onSubmit={send}
      />
    </AuthScreen>
  );
}
