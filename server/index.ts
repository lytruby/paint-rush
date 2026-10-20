import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "../shared/protocol.js";

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === "production";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(rootDir, "dist");

const app = express();
app.use(express.json());

// 健康检查：部署平台和冒烟脚本使用
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, protocol: PROTOCOL_VERSION, online: io.engine.clientsCount });
});

// 生产模式下托管前端构建产物；/r/:code 等前端路由回退到 index.html
if (isProd && existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/|socket\.io\/|healthz).*/, (_req, res) => {
    res.sendFile(join(distDir, "index.html"));
  });
}

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  // 同源部署，无需 CORS；开发时由 Vite 代理
  pingInterval: 10_000,
  pingTimeout: 8_000,
});

io.on("connection", (socket) => {
  const online = io.engine.clientsCount;
  console.log(`[conn] ${socket.id} (online=${online})`);
  socket.emit("hello", { protocol: PROTOCOL_VERSION, serverTime: Date.now(), online });
  io.emit("presence", { online });

  socket.on("disconnect", (reason) => {
    const left = io.engine.clientsCount;
    console.log(`[disc] ${socket.id} ${reason} (online=${left})`);
    io.emit("presence", { online: left });
  });
});

httpServer.listen(PORT, () => {
  console.log(`[paint-rush] listening on :${PORT} (${isProd ? "production" : "development"})`);
});
