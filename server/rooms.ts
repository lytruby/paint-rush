// 房间与玩家的内存状态，以及所有状态变更函数（集中在这里，便于推理生命周期，见 DESIGN.md 第 8 节风险 2）
import { randomBytes } from "node:crypto";
import {
  COUNTDOWN_MS,
  MAX_PLAYERS,
  NAME_MAX_LEN,
  ROOM_EMPTY_TTL_MS,
  ROUND_MS,
  type ErrorCode,
  type RoomInfo,
  type RoomStatus,
} from "../shared/protocol.js";

export interface Player {
  id: string;
  token: string; // 私密重连凭证（阶段 4 使用）
  name: string;
  slot: 1 | 2;
  socketId: string;
  connected: boolean;
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
}

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

export function addPlayer(room: Room, socketId: string, name: string): Player {
  const slot: 1 | 2 = room.players.some((p) => p.slot === 1) ? 2 : 1;
  const player: Player = { id: randomId(6), token: randomId(16), name, slot, socketId, connected: true };
  room.players.push(player);
  room.players.sort((a, b) => a.slot - b.slot);
  if (!room.players.some((p) => p.id === room.hostId)) room.hostId = player.id;
  room.emptySince = null;
  return player;
}

/**
 * 移除玩家。
 * 阶段 2 的简化规则：任何时候有人离开或断线都直接移除；如果不在大厅，就取消当前阶段并回到大厅。
 * 阶段 4 会改为"掉线保留 15 秒 + 对局中离开则提前结算"。
 */
export function removePlayer(room: Room, playerId: string) {
  room.players = room.players.filter((p) => p.id !== playerId);
  room.rematchVotes.delete(playerId);
  if (room.hostId === playerId) room.hostId = room.players[0]?.id ?? ""; // 房主转移给剩下的人
  if (room.players.length === 0) room.emptySince = Date.now();
  if (room.status !== "lobby") {
    clearTimer(room);
    room.status = "lobby";
    room.phaseEndsAt = 0;
  }
}

/** 开始校验：仅房主、仅大厅、两人都在线 */
export function checkStart(room: Room, playerId: string): ErrorCode | null {
  if (room.hostId !== playerId) return "NOT_HOST";
  if (room.status !== "lobby") return "BAD_REQUEST";
  if (room.players.length < MAX_PLAYERS || room.players.some((p) => !p.connected)) return "NOT_READY";
  return null;
}

/** 进入 3-2-1 倒计时，结束后进入对局（对局逻辑在阶段 3 实现） */
export function startCountdown(room: Room, onChange: (room: Room) => void) {
  clearTimer(room);
  room.status = "countdown";
  room.round += 1;
  room.rematchVotes.clear();
  room.phaseEndsAt = Date.now() + COUNTDOWN_MS;
  onChange(room);
  room.timer = setTimeout(() => {
    room.timer = null;
    room.status = "playing";
    room.phaseEndsAt = Date.now() + ROUND_MS;
    onChange(room);
  }, COUNTDOWN_MS);
}

export function clearTimer(room: Room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
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
      rooms.delete(code);
    }
  }
}
