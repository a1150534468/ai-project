import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function readPort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // vendor 拆分：react 栈 / 动效 / markdown 栈各自成 chunk，
        // 页面级 lazy（App.tsx）之外，首屏也不必为聊天页的 markdown 渲染买单。
        // 用函数形式按路径匹配：对象形式只匹配包入口垫片，react-dom 的实现会漏回主 chunk。
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (/node_modules\/(motion|framer-motion|motion-dom|motion-utils)\//.test(id)) return "motion";
          if (
            /node_modules\/(react-markdown|remark-gfm|rehype-sanitize|micromark|mdast|hast|unist|unified|remark|rehype)[^/]*\//.test(id)
          ) {
            return "markdown";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: readPort(process.env.PORT, 5174),
    proxy: { "/api": process.env.API_PROXY_TARGET || "http://localhost:8090" },
  },
});
