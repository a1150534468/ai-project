/**
 * 浏览器入口。三层 Provider 的嵌套顺序有讲究，从外往里：
 *  - `ErrorBoundary` 在最外层，里面任何一层（含 Provider 自己）抛异常都还有兜底页面可看。
 *  - `MotionRoot` 统一接管动效开关（`prefers-reduced-motion`），要先于会做动画的 Toast 挂上。
 *  - `ToastProvider` 提供全局提示，App 里各处都可能弹。
 */
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { MotionRoot, ToastProvider } from "./motion";
import { initializeTheme } from "./theme";
import "./index.css";

// 主题要在首屏渲染之前落到 <html> 上，否则暗色模式会先闪一下白底
initializeTheme();

const container = document.getElementById("root");
if (!container) throw new Error("index.html 里的 #root 没了，前端挂不上去");

createRoot(container).render(
  <ErrorBoundary>
    <MotionRoot>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MotionRoot>
  </ErrorBoundary>,
);
