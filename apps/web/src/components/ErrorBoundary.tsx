import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// 渲染期任何未捕获错误兜底：显示报错而非白屏（生产可定位 + 用户可重试）。
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留到控制台便于排查
    // eslint-disable-next-line no-console
    console.error("UI 渲染错误:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", color: "#b91c1c" }}>
        <h2 style={{ marginBottom: 8 }}>页面出错了</h2>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#374151" }}>
          {error.message}
        </pre>
        <button
          onClick={() => {
            this.setState({ error: null });
            location.reload();
          }}
          style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8, background: "#10b981", color: "#fff", border: "none", cursor: "pointer" }}
        >
          重新加载
        </button>
      </div>
    );
  }
}
