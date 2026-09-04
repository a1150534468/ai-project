import { useId, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { BrandLogo, RippleButton } from "../motion";
import { ThemeToggle } from "./ThemeToggle";
import { cx } from "./ui";

/**
 * 登录页与注册页是同一张卡：品牌区 + 一叠输入框 + 报错条 + 主按钮 + 底部换页入口。
 * 两页只差标题、字段和文案，所以这里只留骨架，具体填什么由各自那页给。
 */
const SHELL = "auth-shell flex min-h-screen items-center justify-center bg-surface-muted p-4";
/** 字段多的那页（注册有三个框）矮屏放不下，要能滚；py-8 排在 p-4 之后，纵向留白按它算 */
const SHELL_SCROLL = "overflow-y-auto py-8";
const CARD = "auth-card rounded-[18px] border border-hairline-subtle bg-surface p-7 sm:p-8";
const INPUT =
  "w-full rounded-[11px] border border-hairline-subtle bg-surface py-3 pl-10 pr-4 outline-none transition-all focus:border-brand focus:ring-2 focus:ring-brand/20";
const SUBMIT =
  "w-full rounded-full bg-brand py-3 font-normal text-white transition-transform active:scale-[0.98] disabled:bg-hairline disabled:text-ink-tertiary disabled:shadow-none";
const ERROR_BOX = "mb-6 rounded-lg border border-danger/30 bg-danger/10 p-3";

/** 带图标的一行输入。回车等于按主按钮 —— 这两页都只有一个能提交的动作。 */
export function AuthField({
  label,
  icon,
  value,
  placeholder,
  type = "text",
  onChange,
  onSubmit,
}: {
  readonly label: string;
  readonly icon: string;
  readonly value: string;
  readonly placeholder: string;
  readonly type?: "text" | "password";
  readonly onChange: (next: string) => void;
  readonly onSubmit: () => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <Icon icon={icon} className="absolute left-3 top-3.5 text-ink-tertiary" aria-hidden />
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSubmit();
          }}
          className={INPUT}
        />
      </div>
    </div>
  );
}

/** 底部「去注册 / 去登录」那个纯文字按钮 */
export function AuthSwitch({ onClick, children }: { readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="font-medium text-brand">
      {children}
    </button>
  );
}
interface AuthScreenProps {
  /** 卡片标题：登录账户 / 创建账户 */
  readonly title: string;
  /** 空串表示没有错要报 */
  readonly error: string;
  readonly busy: boolean;
  readonly submitLabel: string;
  readonly busyLabel: string;
  readonly onSubmit: () => void;
  /** 底部那句「没有账户？去注册」 */
  readonly footer: ReactNode;
  /** 需要滚动的那页（字段多）传 true */
  readonly scroll?: boolean;
  /** 输入框们 */
  readonly children: ReactNode;
}

export function AuthScreen({
  title,
  error,
  busy,
  submitLabel,
  busyLabel,
  onSubmit,
  footer,
  scroll = false,
  children,
}: AuthScreenProps) {
  return (
    <div className={cx(SHELL, scroll && SHELL_SCROLL)}>
      <ThemeToggle compact className="fixed right-5 top-5 z-10" />
      <div className="w-full max-w-[420px]">
        <div className="mb-8 text-center">
          <div className="mb-5 flex justify-center">
            <BrandLogo size={52} />
          </div>
          <h1 className="mb-2 text-[34px] font-semibold leading-tight text-ink">AI 助手</h1>
          <p className="text-[15px] text-ink-secondary">您的全能 AI 助手</p>
        </div>

        <div className={CARD}>
          <h2 className="mb-6 text-xl font-semibold text-ink">{title}</h2>
          <div className="mb-6 space-y-4">{children}</div>

          {error !== "" && (
            <div className={ERROR_BOX}>
              <p className="flex items-center text-sm text-danger-ink">
                <Icon icon="mdi:alert-circle" className="mr-2" aria-hidden />
                {error}
              </p>
            </div>
          )}

          <RippleButton onClick={onSubmit} disabled={busy} className={SUBMIT}>
            {busy ? (
              <span className="flex items-center justify-center">
                <Icon icon="mdi:loading" className="mr-2 animate-spin" aria-hidden />
                {busyLabel}
              </span>
            ) : (
              submitLabel
            )}
          </RippleButton>

          <p className="mt-6 text-center text-xs text-ink-secondary">{footer}</p>
        </div>
      </div>
    </div>
  );
}
