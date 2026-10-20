// 前后端共享的协议定义：常量 + 消息类型。
// 对应 docs/DESIGN.md 第 4 节。阶段 1 只定义类型，业务逻辑在后续阶段实现。

export const PROTOCOL_VERSION = 1;

// ---- 游戏常量 ----
export const GRID_SIZE = 16; // 16×16 网格
export const TICK_HZ = 10; // 服务器 tick 频率；每 tick 最多走一格，即移动速度 10 格/秒
export const ROUND_MS = 60_000; // 每局 60 秒
export const COUNTDOWN_MS = 3_000; // 开局 3-2-1
export const RECONNECT_GRACE_MS = 15_000; // 掉线保留座位 15 秒
export const ROOM_EMPTY_TTL_MS = 60_000; // 空房间 60 秒后销毁
export const MAX_INPUTS_PER_SEC = 20; // 输入限流
export const MAX_PLAYERS = 2;
export const NAME_MAX_LEN = 12;

// ---- 基础类型 ----
export type Dir = "up" | "down" | "left" | "right";
export type RoomStatus = "lobby" | "countdown" | "playing" | "ended";
// REPLACED：同一座位在另一个连接（例如复制的标签页）上恢复了，旧连接被踢出
export type ErrorCode = "ROOM_NOT_FOUND" | "ROOM_FULL" | "NOT_HOST" | "NOT_READY" | "BAD_REQUEST" | "REPLACED";

export interface PlayerPublic {
  id: string;
  name: string;
  slot: 1 | 2; // 颜色/座位
  connected: boolean;
}

export interface RoomInfo {
  code: string;
  status: RoomStatus;
  hostId: string;
  players: PlayerPublic[];
  round: number;
  rematchVotes: string[];
  // 当前阶段（倒计时/对局）剩余毫秒数，按服务器发出时刻计算；客户端用"收到时刻 + 剩余"推算结束时间，
  // 避免依赖两端时钟一致。lobby / ended 时为 0。
  phaseRemainingMs: number;
}

export interface Snapshot {
  tick: number;
  status: RoomStatus;
  remainingMs: number;
  players: { id: string; x: number; y: number; connected: boolean }[];
  grid: number[]; // 长度 GRID_SIZE²，0 = 无人，1/2 = slot
}

export interface OverPayload {
  scores: { id: string; cells: number; pct: number }[];
  winnerId: string | null; // null = 平局
  reason: "time" | "opponent_left";
}

// ---- HTTP API ----
export interface CreateRoomRes {
  code: string;
}
export interface RoomQueryRes {
  exists: boolean;
  status?: RoomStatus;
  playerCount?: number;
}

// ---- WebSocket 事件（Socket.IO 强类型） ----
export interface ClientToServerEvents {
  join: (p: { code: string; name: string; token?: string }) => void;
  start: () => void;
  input: (p: { seq: number; dir: Dir | null }) => void;
  rematch: () => void;
  leave: () => void;
}

export interface ServerToClientEvents {
  // 阶段 1 联通性诊断事件
  hello: (p: { protocol: number; serverTime: number; online: number }) => void;
  presence: (p: { online: number }) => void;
  // 业务事件（阶段 2 起实现）
  joined: (p: { playerId: string; token: string; room: RoomInfo }) => void;
  room: (p: RoomInfo) => void;
  snapshot: (p: Snapshot) => void;
  over: (p: OverPayload) => void;
  error: (p: { code: ErrorCode; msg: string }) => void;
}
