// 对局规则：全部由服务器计算（服务器权威）。客户端只发送方向意图。
import { GRID_SIZE as N, MAX_INPUTS_PER_SEC, type Dir, type OverPayload, type Snapshot } from "../shared/protocol.js";
import type { Player, Room } from "./rooms.js";

const DIRS: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
// 出生点：左右两侧，相对居中
const SPAWN: Record<1 | 2, { x: number; y: number }> = { 1: { x: 2, y: 7 }, 2: { x: N - 3, y: 8 } };

const idx = (x: number, y: number) => y * N + x;

/** 新一局：清空棋盘，回到出生点（出生格先染色） */
export function initRound(room: Room) {
  room.grid = new Uint8Array(N * N);
  room.tick += 1; // tick 在房间内单调递增，跨局也不回退，客户端据此丢弃旧快照
  room.lastOver = null;
  for (const p of room.players) {
    p.x = SPAWN[p.slot].x;
    p.y = SPAWN[p.slot].y;
    p.dir = null;
    p.pressed = null;
    room.grid[idx(p.x, p.y)] = p.slot;
  }
}

/**
 * 处理一条输入。返回是否被接受。
 * - 只在 playing 阶段接受
 * - seq 必须严格递增：重复包和乱序到达的旧包直接丢弃
 * - 每秒最多 MAX_INPUTS_PER_SEC 条，超出丢弃（限流）
 * - dir 只能是四个方向或 null
 */
export function handleInput(room: Room, p: Player, payload: unknown): boolean {
  if (room.status !== "playing") return false;
  const { seq, dir } = (payload ?? {}) as { seq?: unknown; dir?: unknown };
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= p.lastSeq) return false;
  if (dir !== null && !(typeof dir === "string" && dir in DIRS)) return false;

  const now = Date.now();
  if (now - p.rateWindowStart >= 1000) {
    p.rateWindowStart = now;
    p.rateCount = 0;
  }
  if (++p.rateCount > MAX_INPUTS_PER_SEC) return false;

  p.lastSeq = seq;
  p.dir = dir as Dir | null;
  // 记录"本 tick 内按过的方向"：即使按下后在下个 tick 前就松开，也至少走一格（短按不丢）
  if (dir) p.pressed = dir as Dir;
  return true;
}

/**
 * 推进一个 tick：每人最多移动一格（所以连按不会加速）。
 * 碰撞规则（对双方公平，与处理顺序无关）：
 * - 越界：原地不动
 * - 目标格是对方当前所在格：被挡住
 * - 双方目标是同一格：双方都被挡住
 */
export function step(room: Room) {
  const ps = room.players;
  const targets = ps.map((p) => {
    const d = p.connected ? p.dir ?? p.pressed : null;
    p.pressed = null;
    if (!d) return null;
    const [dx, dy] = DIRS[d];
    const x = p.x + dx;
    const y = p.y + dy;
    return x < 0 || y < 0 || x >= N || y >= N ? null : { x, y };
  });
  const blocked = targets.map((t, i) =>
    !t ||
    ps.some((o, j) => j !== i && ((o.x === t.x && o.y === t.y) || (targets[j]?.x === t.x && targets[j]?.y === t.y))),
  );
  ps.forEach((p, i) => {
    const t = targets[i];
    if (blocked[i] || !t) return;
    p.x = t.x;
    p.y = t.y;
    room.grid[idx(p.x, p.y)] = p.slot;
  });
  room.tick += 1;
}

export function snapshot(room: Room): Snapshot {
  return {
    tick: room.tick,
    status: room.status,
    remainingMs: room.status === "playing" ? Math.max(0, room.phaseEndsAt - Date.now()) : 0,
    players: room.players.map((p) => ({ id: p.id, x: p.x, y: p.y, connected: p.connected })),
    grid: Array.from(room.grid),
  };
}

/** 结算：按格子数比较，相同为平局 */
export function computeOver(room: Room, reason: OverPayload["reason"]): OverPayload {
  const total = N * N;
  const scores = room.players.map((p) => {
    const cells = room.grid.reduce((n, v) => n + (v === p.slot ? 1 : 0), 0);
    return { id: p.id, cells, pct: Math.round((cells / total) * 1000) / 10 };
  });
  let winnerId: string | null = null;
  if (scores.length === 2 && scores[0].cells !== scores[1].cells) {
    winnerId = scores[0].cells > scores[1].cells ? scores[0].id : scores[1].id;
  } else if (scores.length === 1) {
    winnerId = scores[0].id;
  }
  return { scores, winnerId, reason };
}
