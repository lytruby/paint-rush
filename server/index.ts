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
  addPlayer,
  checkJoin,
  checkStart,
  createRoom,
  hooks,
  normalizeCode,
  removePlayer,
  rooms,
  sanitizeName,
  startCountdown,
  sweepEmptyRooms,
  toInfo,
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

function leaveCurrentRoom(socket: IOSocket) {
  const room = currentRoom(socket);
  const playerId = socket.data.playerId;
  if (room && playerId) {
    removePlayer(room, playerId);
    socket.leave(room.code);
    broadcastRoom(room);
    console.log(`[room ${room.code}] ${playerId} left (players=${room.players.length})`);
  }
  socket.data.code = undefined;
  socket.data.playerId = undefined;
}

io.on("connection", (socket: IOSocket) => {
  const online = io.engine.clientsCount;
  socket.emit("hello", { protocol: PROTOCOL_VERSION, serverTime: Date.now(), online });
  io.emit("presence", { online });

  socket.on("join", (payload) => {
    if (socket.data.playerId) return; // 一个连接只能在一个房间里
    const code = normalizeCode(payload?.code);
    const room = rooms.get(code);
    const err = checkJoin(room);
    if (err || !room) return sendError(socket, err ?? "ROOM_NOT_FOUND");

    const player = addPlayer(room, socket.id, sanitizeName(payload?.name));
    socket.data.code = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    socket.emit("joined", { playerId: player.id, token: player.token, room: toInfo(room) });
    broadcastRoom(room);
    console.log(`[room ${room.code}] ${player.id} "${player.name}" joined slot ${player.slot}`);
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
    const player = room?.players.find((p) => p.id === socket.data.playerId);
    if (room && player) handleInput(room, player, payload);
  });

  socket.on("leave", () => leaveCurrentRoom(socket));

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    io.emit("presence", { online: io.engine.clientsCount });
  });
});

setInterval(() => sweepEmptyRooms(), 10_000).unref();

httpServer.listen(PORT, () => {
  console.log(`[paint-rush] listening on :${PORT} (${isProd ? "production" : "development"})`);
});
