import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react";

/**
 * 渲染期没人接的错误在这里落地：给一段看得见的报错和一个重来的入口，而不是整屏白。
 * 只有 class 组件能当错误边界，所以这里不跟着其余组件走函数式。
 */

/**
 * 这一页的样式全写成内联：错误边界要在「样式表都没加载起来」这种情况下也能显示，
 * 不能依赖 Tailwind 的产物。
 */
const PAGE: CSSProperties = { padding: 24, fontFamily: "system-ui, sans-serif", color: "rgb(var(--color-danger-ink))" };
const TITLE: CSSProperties = { marginBottom: 8 };
const DETAIL: CSSProperties = { whiteSpace: "pre-wrap", fontSize: 12, color: "var(--apple-ink-secondary)" };
const RETRY: CSSProperties = {
  marginTop: 16,
  padding: "8px 16px",
  borderRadius: 8,
  background: "var(--accent-primary, #0066cc)",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly failure: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(failure: Error): ErrorBoundaryState {
    return { failure };
  }

  componentDidCatch(failure: Error, info: ErrorInfo): void {
    // 控制台留一份带组件栈的原始记录，线上排查只有这个能看
    console.error("UI 渲染错误:", failure, info.componentStack);
  }

  /** 先清掉错误再整页重载：不清的话重载前还会多渲染一帧错误页 */
  private readonly retry = () => {
    this.setState({ failure: null });
    location.reload();
  };

  render(): ReactNode {
    const { failure } = this.state;
    if (failure === null) return this.props.children;
    return (
      <div style={PAGE}>
        <h2 style={TITLE}>页面出错了</h2>
        <pre style={DETAIL}>{failure.message}</pre>
        <button type="button" onClick={this.retry} style={RETRY}>
          重新加载
        </button>
      </div>
    );
  }
}
