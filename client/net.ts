import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "../shared/protocol";

// 全局唯一连接；Socket.IO 自带断线自动重连
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io();
