import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const host = document.getElementById("root");
// 少了这个节点就是 index.html 被改坏了。原来是 `!` 断言，那样只会在 createRoot 里
// 抛一句「container is not a DOM element」，看不出是哪儿的问题。
if (!host) throw new Error("index.html 里缺少 #root 挂载点");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
