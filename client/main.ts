import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "../shared/protocol";

// 阶段 1：只验证联通性——显示连接状态、传输方式（应升级为 websocket）和在线连接数
const $ = (id: string) => document.getElementById(id)!;

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io();

function setStatus(text: string, ok: boolean | null) {
  $("status").textContent = text;
  $("dot").className = "dot" + (ok === true ? " ok" : ok === false ? " bad" : "");
}

socket.on("connect", () => {
  setStatus(`已连接（${socket.id}）`, true);
  const engine = socket.io.engine;
  $("transport").textContent = engine.transport.name;
  engine.once("upgrade", () => ($("transport").textContent = engine.transport.name));
});

socket.on("disconnect", () => setStatus("连接断开，正在重连…", false));
socket.on("connect_error", () => setStatus("连接失败，正在重试…", false));
socket.on("hello", (p) => ($("online").textContent = String(p.online)));
socket.on("presence", (p) => ($("online").textContent = String(p.online)));
