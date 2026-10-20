import { defineConfig } from "vite";

// 开发模式：Vite (5173) 负责前端热更新，Socket.IO / API 请求代理到后端 (3000)
// 生产模式：vite build 输出到 dist/，由 Express 统一托管，单服务部署
export default defineConfig({
  root: "client",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/socket.io": { target: "http://localhost:3000", ws: true },
      "/api": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
    },
  },
});
