import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server, type Socket } from "socket.io";
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type CreateRoomRes,
  type ErrorCode,
  type RoomQueryRes,
  type ServerToClientEvents,
} from "../shared/protocol.js";
import {
  checkStart,
  createRoom,
  hooks,
  joinRoom,
  markDisconnected,
  normalizeCode,
  removePlayer,
  rooms,
  sanitizeName,
  startCountdown,
  sweepEmptyRooms,
  toInfo,
  voteRematch,
  type Room,
} from "./rooms.js";
import { handleInput, snapshot } from "./game.js";

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === "production";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(rootDir, "dist");

const ERROR_MSG: Record<ErrorCode, string> = {
  ROOM_NOT_FOUND: "房间不存在或已解散",
  ROOM_FULL: "房间已满（2/2）",
  NOT_HOST: "只有房主可以开始游戏",
  NOT_READY: "需要两名玩家都在线才能开始",
  BAD_REQUEST: "当前状态不允许该操作",
  REPLACED: "你在另一个标签页或窗口重新进入了这个房间，当前页面已断开",
};

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, protocol: PROTOCOL_VERSION, online: io.engine.clientsCount, rooms: rooms.size });
});

// 创建房间
app.post("/api/rooms", (_req, res) => {
  const room = createRoom();
  res.json({ code: room.code } satisfies CreateRoomRes);
});

// 查询房间（加入前预检，给出"不存在 / 已满"提示）
app.get("/api/rooms/:code", (req, res) => {
  const room = rooms.get(normalizeCode(req.params.code));
  const body: RoomQueryRes = room
    ? { exists: true, status: room.status, playerCount: room.players.length }
    : { exists: false };
  res.json(body);
});

if (isProd && existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/|socket\.io\/|healthz).*/, (_req, res) => {
    res.sendFile(join(distDir, "index.html"));
  });
}

interface SocketData {
  code?: string;
  playerId?: string;
}
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
  pingInterval: 10_000,
  pingTimeout: 8_000,
});

function broadcastRoom(room: Room) {
  io.to(room.code).emit("room", toInfo(room));
}

hooks.room = broadcastRoom;
hooks.snapshot = (room) => io.to(room.code).emit("snapshot", snapshot(room));
hooks.over = (room, over) => {
  io.to(room.code).emit("over", over);
  console.log(`[room ${room.code}] round ${room.round} over: ${JSON.stringify(over.scores)} winner=${over.winnerId}`);
};

function sendError(socket: IOSocket, code: ErrorCode) {
  socket.emit("error", { code, msg: ERROR_MSG[code] });
}

function currentRoom(socket: IOSocket): Room | undefined {
  return socket.data.code ? rooms.get(socket.data.code) : undefined;
}

/** 主动离开：立即释放座位（对局中会提前结算） */
function leaveCurrentRoom(socket: IOSocket) {
  const room = currentRoom(socket);
  const playerId = socket.data.playerId;
  if (room && playerId && room.players.find((p) => p.id === playerId)?.socketId === socket.id) {
    removePlayer(room, playerId);
    broadcastRoom(room);
    console.log(`[room ${room.code}] ${playerId} left (players=${room.players.length})`);
  }
  if (room) socket.leave(room.code);
  socket.data.code = undefined;
  socket.data.playerId = undefined;
}

io.on("connection", (socket: IOSocket) => {
  const online = io.engine.clientsCount;
  socket.emit("hello", { protocol: PROTOCOL_VERSION, serverTime: Date.now(), online });
  io.emit("presence", { online });

  socket.on("join", (payload) => {
    if (socket.data.playerId) return; // 一个连接只能在一个房间里
    const room = rooms.get(normalizeCode(payload?.code));
    const res = joinRoom(room, socket.id, sanitizeName(payload?.name), payload?.token);
    if (!res.ok || !room) return sendError(socket, res.ok ? "ROOM_NOT_FOUND" : res.error);
    const { player, resumed, replacedSocketId } = res;

    // 重复连接：同一座位在新连接上恢复，踢掉旧连接（旧连接不再代表这个座位）
    if (replacedSocketId) {
      const old = io.sockets.sockets.get(replacedSocketId);
      if (old) {
        sendError(old, "REPLACED");
        old.leave(room.code);
        old.data.code = undefined;
        old.data.playerId = undefined;
      }
    }

    socket.data.code = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    socket.emit("joined", { playerId: player.id, token: player.token, room: toInfo(room) });
    // 重连时立即补发当前画面和结算结果，让视图直接回到当前阶段
    if (room.status !== "lobby") socket.emit("snapshot", snapshot(room));
    if (room.status === "ended" && room.lastOver) socket.emit("over", room.lastOver);
    broadcastRoom(room);
    console.log(`[room ${room.code}] ${player.id} "${player.name}" ${resumed ? "resumed" : "joined"} slot ${player.slot}`);
  });

  socket.on("start", () => {
    const room = currentRoom(socket);
    if (!room || !socket.data.playerId) return sendError(socket, "BAD_REQUEST");
    const err = checkStart(room, socket.data.playerId);
    if (err) return sendError(socket, err);
    startCountdown(room);
    console.log(`[room ${room.code}] countdown round ${room.round}`);
  });

  socket.on("input", (payload) => {
    const room = currentRoom(socket);
    const player = room?.players.find((p) => p.id === socket.data.playerId && p.socketId === socket.id);
    if (room && player) handleInput(room, player, payload);
  });

  socket.on("rematch", () => {
    const room = currentRoom(socket);
    if (!room || !socket.data.playerId) return sendError(socket, "BAD_REQUEST");
    const err = voteRematch(room, socket.data.playerId);
    if (err) sendError(socket, err);
  });

  socket.on("leave", () => leaveCurrentRoom(socket));

  socket.on("disconnect", () => {
    // 掉线（含刷新、关闭标签页、网络中断）：保留座位 15 秒，而不是立即移除
    const room = currentRoom(socket);
    const player = room?.players.find((p) => p.id === socket.data.playerId);
    if (room && player && player.socketId === socket.id) {
      markDisconnected(room, player.id);
      console.log(`[room ${room.code}] ${player.id} disconnected (grace)`);
    }
    io.emit("presence", { online: io.engine.clientsCount });
  });
});

setInterval(() => sweepEmptyRooms(), 10_000).unref();

httpServer.listen(PORT, () => {
  console.log(`[paint-rush] listening on :${PORT} (${isProd ? "production" : "development"})`);
});
