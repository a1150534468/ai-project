import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { MotionRoot, ToastProvider } from "./motion";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <MotionRoot>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MotionRoot>
  </ErrorBoundary>
);
