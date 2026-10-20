// 房间与玩家的内存状态，以及所有状态变更函数（集中在这里，便于推理生命周期，见 DESIGN.md 第 8 节风险 2）
import { randomBytes } from "node:crypto";
import {
  COUNTDOWN_MS,
  GRID_SIZE,
  MAX_PLAYERS,
  NAME_MAX_LEN,
  RECONNECT_GRACE_MS,
  ROOM_EMPTY_TTL_MS,
  ROUND_MS,
  TICK_HZ,
  type Dir,
  type ErrorCode,
  type OverPayload,
  type RoomInfo,
  type RoomStatus,
} from "../shared/protocol.js";
import { computeOver, initRound, step } from "./game.js";

export interface Player {
  id: string;
  token: string; // 私密重连凭证，只发给本人
  name: string;
  slot: 1 | 2;
  socketId: string;
  connected: boolean;
  disconnectedAt: number | null;
  graceTimer: NodeJS.Timeout | null; // 掉线保留计时器，到期视为离开
  // ---- 对局状态 ----
  x: number;
  y: number;
  dir: Dir | null; // 当前按住的方向
  pressed: Dir | null; // 本 tick 内按下过的方向（保证短按至少走一格）
  lastSeq: number; // 已处理的最大输入序号
  rateWindowStart: number;
  rateCount: number;
}

export interface Room {
  code: string;
  status: RoomStatus;
  hostId: string;
  players: Player[]; // 按 slot 排序，最多 2 人
  round: number;
  rematchVotes: Set<string>;
  phaseEndsAt: number; // 当前阶段结束的服务器时间戳，0 表示无
  emptySince: number | null;
  timer: NodeJS.Timeout | null;
  loop: NodeJS.Timeout | null; // 对局 tick 循环
  grid: Uint8Array; // 0 = 无人，1/2 = slot
  tick: number;
  lastOver: OverPayload | null;
}

/** 状态变化的广播出口，由 index.ts 注入（避免房间逻辑依赖 Socket.IO） */
export const hooks = {
  room: (_room: Room) => {},
  snapshot: (_room: Room) => {},
  over: (_room: Room, _over: OverPayload) => {},
};

// 去掉易混淆字符 I/O/0/1
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const rooms = new Map<string, Room>();

const randomId = (bytes: number) => randomBytes(bytes).toString("base64url");

export function createRoom(): Room {
  let code: string;
  do {
    code = Array.from(randomBytes(4), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  } while (rooms.has(code));
  const room: Room = {
    code,
    status: "lobby",
    hostId: "",
    players: [],
    round: 0,
    rematchVotes: new Set(),
    phaseEndsAt: 0,
    emptySince: Date.now(), // 创建后无人加入，同样按空房间规则回收
    timer: null,
    loop: null,
    grid: new Uint8Array(GRID_SIZE * GRID_SIZE),
    tick: 0,
    lastOver: null,
  };
  rooms.set(code, room);
  return room;
}

export function normalizeCode(code: unknown): string {
  return typeof code === "string" ? code.trim().toUpperCase().slice(0, 8) : "";
}

export function sanitizeName(name: unknown): string {
  const s = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return Array.from(s).slice(0, NAME_MAX_LEN).join("") || "玩家";
}

/** 加入校验：返回错误码或 null */
export function checkJoin(room: Room | undefined): ErrorCode | null {
  if (!room) return "ROOM_NOT_FOUND";
  if (room.players.length >= MAX_PLAYERS) return "ROOM_FULL";
  return null;
}

function addPlayer(room: Room, socketId: string, name: string): Player {
  const slot: 1 | 2 = room.players.some((p) => p.slot === 1) ? 2 : 1;
  const player: Player = {
    id: randomId(6),
    token: randomId(16),
    name,
    slot,
    socketId,
    connected: true,
    disconnectedAt: null,
    graceTimer: null,
    x: 0,
    y: 0,
    dir: null,
    pressed: null,
    lastSeq: 0,
    rateWindowStart: 0,
    rateCount: 0,
  };
  room.players.push(player);
  room.players.sort((a, b) => a.slot - b.slot);
  if (!room.players.some((p) => p.id === room.hostId)) room.hostId = player.id;
  room.emptySince = null;
  // 中途加入：如果房间停在结算页（上一个对手已离开），就回到大厅，和新对手重新开始
  if (room.status === "ended") {
    room.status = "lobby";
    room.rematchVotes.clear();
    room.lastOver = null;
  }
  return player;
}

export type JoinResult =
  | { ok: true; player: Player; resumed: boolean; replacedSocketId: string | null }
  | { ok: false; error: ErrorCode };

/**
 * 加入或重连（唯一入口）：
 * - token 匹配房间里的某个座位：恢复该座位（刷新 / 掉线重连），位置和分数都保留；
 *   如果旧连接还在，返回 replacedSocketId，由调用方踢掉旧连接
 * - 否则按新玩家处理：房间满员则拒绝
 */
export function joinRoom(room: Room | undefined, socketId: string, name: string, token: unknown): JoinResult {
  if (!room) return { ok: false, error: "ROOM_NOT_FOUND" };
  const existing = typeof token === "string" ? room.players.find((p) => p.token === token) : undefined;
  if (existing) {
    const replacedSocketId = existing.connected && existing.socketId !== socketId ? existing.socketId : null;
    if (existing.graceTimer) clearTimeout(existing.graceTimer);
    existing.graceTimer = null;
    existing.socketId = socketId;
    existing.connected = true;
    existing.disconnectedAt = null;
    // 新连接的客户端 seq 从 1 重新开始，必须重置，否则刷新后的输入会全部被当成旧包丢弃
    existing.lastSeq = 0;
    existing.dir = null;
    existing.pressed = null;
    return { ok: true, player: existing, resumed: true, replacedSocketId };
  }
  const err = checkJoin(room);
  if (err) return { ok: false, error: err };
  return { ok: true, player: addPlayer(room, socketId, name), resumed: false, replacedSocketId: null };
}

/** 掉线：保留座位 RECONNECT_GRACE_MS，角色停在原地；超时视为离开 */
export function markDisconnected(room: Room, playerId: string) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p || !p.connected) return;
  p.connected = false;
  p.disconnectedAt = Date.now();
  p.dir = null;
  p.pressed = null;
  p.graceTimer = setTimeout(() => {
    p.graceTimer = null;
    if (!p.connected && room.players.includes(p)) {
      removePlayer(room, p.id);
      hooks.room(room);
    }
  }, RECONNECT_GRACE_MS);
  hooks.room(room);
}

/**
 * 移除玩家（主动离开或掉线超时）。按当前阶段处理：
 * - 大厅：释放座位
 * - 倒计时 / 对局中：立即结算，剩下的一方以 opponent_left 获胜（离开者的分数也会出现在结算里）
 * - 结算页：清空再来一局的投票
 * 房主离开时，剩下的一方自动成为房主。
 */
export function removePlayer(room: Room, playerId: string) {
  const leaving = room.players.find((p) => p.id === playerId);
  if (!leaving) return;
  if (leaving.graceTimer) clearTimeout(leaving.graceTimer);
  leaving.graceTimer = null;

  if (room.status === "countdown" || room.status === "playing") {
    const winner = room.players.find((p) => p.id !== playerId);
    finishRound(room, "opponent_left", winner?.id ?? null);
  }

  room.players = room.players.filter((p) => p.id !== playerId);
  room.rematchVotes.clear();
  if (room.hostId === playerId) room.hostId = room.players[0]?.id ?? ""; // 房主转移给剩下的人
  if (room.players.length === 0) room.emptySince = Date.now();
}

/** 开始校验：仅房主、仅大厅、两人都在线 */
export function checkStart(room: Room, playerId: string): ErrorCode | null {
  if (room.hostId !== playerId) return "NOT_HOST";
  if (room.status !== "lobby") return "BAD_REQUEST";
  if (room.players.length < MAX_PLAYERS || room.players.some((p) => !p.connected)) return "NOT_READY";
  return null;
}

/** 再来一局：只在结算页有效；两人都在线且都投票后进入倒计时 */
export function voteRematch(room: Room, playerId: string): ErrorCode | null {
  if (room.status !== "ended") return "BAD_REQUEST";
  room.rematchVotes.add(playerId);
  const ready =
    room.players.length === MAX_PLAYERS &&
    room.players.every((p) => p.connected && room.rematchVotes.has(p.id));
  if (ready) startCountdown(room);
  else hooks.room(room);
  return null;
}

/** 进入 3-2-1 倒计时（期间显示棋盘和出生点），结束后进入对局 */
export function startCountdown(room: Room) {
  clearTimer(room);
  room.status = "countdown";
  room.round += 1;
  room.rematchVotes.clear();
  room.phaseEndsAt = Date.now() + COUNTDOWN_MS;
  initRound(room);
  hooks.room(room);
  hooks.snapshot(room);
  room.timer = setTimeout(() => {
    room.timer = null;
    startPlaying(room);
  }, COUNTDOWN_MS);
}

/** 对局：固定频率 tick，每个 tick 推进一步并广播全量快照；时间到即结算 */
function startPlaying(room: Room) {
  room.status = "playing";
  room.phaseEndsAt = Date.now() + ROUND_MS;
  hooks.room(room);
  hooks.snapshot(room);
  room.loop = setInterval(() => {
    step(room);
    if (Date.now() >= room.phaseEndsAt) finishRound(room, "time");
    else hooks.snapshot(room);
  }, 1000 / TICK_HZ);
}

export function finishRound(room: Room, reason: OverPayload["reason"], forcedWinner?: string | null) {
  clearTimer(room);
  room.status = "ended";
  room.phaseEndsAt = 0;
  room.rematchVotes.clear();
  room.lastOver = computeOver(room, reason);
  if (forcedWinner !== undefined) room.lastOver.winnerId = forcedWinner;
  hooks.snapshot(room); // 最终棋盘
  hooks.over(room, room.lastOver);
  hooks.room(room);
}

export function clearTimer(room: Room) {
  if (room.timer) clearTimeout(room.timer);
  if (room.loop) clearInterval(room.loop);
  room.timer = null;
  room.loop = null;
}

export function toInfo(room: Room): RoomInfo {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: room.players.map(({ id, name, slot, connected }) => ({ id, name, slot, connected })),
    round: room.round,
    rematchVotes: [...room.rematchVotes],
    phaseRemainingMs: room.phaseEndsAt ? Math.max(0, room.phaseEndsAt - Date.now()) : 0,
  };
}

/** 回收空置超过 TTL 的房间 */
export function sweepEmptyRooms(now = Date.now()) {
  for (const [code, room] of rooms) {
    if (room.players.length === 0 && room.emptySince !== null && now - room.emptySince > ROOM_EMPTY_TTL_MS) {
      clearTimer(room);
      for (const p of room.players) if (p.graceTimer) clearTimeout(p.graceTimer);
      rooms.delete(code);
    }
  }
}
