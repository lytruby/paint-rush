import { GRID_SIZE as N, TICK_HZ, type RoomInfo, type Snapshot } from "../shared/protocol";
import { heldDir } from "./input";
import { sfx } from "./sfx";

const CELL = 32;
const TICK_MS = 1000 / TICK_HZ;
const PAINT_ANIM_MS = 180;
export const COLORS: Record<number, string> = { 1: "#ff5d73", 2: "#3ec7ff" };
const DARK: Record<number, string> = { 1: "#b8324a", 2: "#1b84b3" };

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** 只负责"把服务器快照画出来"：不做任何规则计算 */
/** 见过的玩家（id → 昵称、颜色槽位）。对手离开后，棋盘和结算仍能用他原来的颜色和昵称显示 */
export const roster = new Map<string, { name: string; slot: 1 | 2 }>();
export function rememberPlayers(room: RoomInfo) {
  for (const p of room.players) roster.set(p.id, { name: p.name, slot: p.slot });
}

export class GameView {
  private prev: Snapshot | null = null;
  private cur: Snapshot | null = null;
  private curAt = 0; // 收到 cur 的本地时刻
  private changedAt = new Float64Array(N * N);
  private raf = 0;
  private ctx: CanvasRenderingContext2D | null = null;
  private root: HTMLElement | null = null;
  private room: RoomInfo | null = null;
  private me: string | null = null;

  /** 收到快照：tick 不大于当前的视为重复或乱序，直接丢弃 */
  onSnapshot(s: Snapshot) {
    if (this.cur && s.tick <= this.cur.tick) return;
    const now = performance.now();
    const mySlot = this.me ? this.slotOf(this.me) : 0;
    let painted = false, stole = false;
    if (this.cur) {
      for (let i = 0; i < s.grid.length; i++) {
        if (s.grid[i] === this.cur.grid[i]) continue;
        this.changedAt[i] = now;
        if (s.grid[i] === mySlot) {
          if (this.cur.grid[i] === 0) painted = true;
          else stole = true;
        }
      }
    }
    if (s.status === "playing" && this.cur?.status === "playing") {
      if (stole) sfx.steal();
      else if (painted) sfx.paint();
      const sec = Math.ceil(s.remainingMs / 1000);
      if (sec <= 10 && sec !== this.lastHurry) {
        this.lastHurry = sec;
        sfx.hurry();
      }
    }
    this.prev = this.cur;
    this.cur = s;
    this.curAt = now;
  }
  private lastHurry = 0;

  latest() {
    return this.cur;
  }

  /** 挂载到房间视图里的 #board 与 HUD 元素上 */
  mount(root: HTMLElement, room: RoomInfo, me: string | null) {
    this.unmount();
    this.root = root;
    this.room = room;
    this.me = me;
    const canvas = root.querySelector<HTMLCanvasElement>("canvas")!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = N * CELL * dpr;
    canvas.height = N * CELL * dpr;
    canvas.style.width = `${N * CELL}px`;
    canvas.style.height = `${N * CELL}px`;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  unmount() {
    cancelAnimationFrame(this.raf);
    this.ctx = null;
    this.root = null;
  }

  private slotOf(id: string) {
    return this.room?.players.find((p) => p.id === id)?.slot ?? roster.get(id)?.slot ?? 1;
  }

  private draw() {
    const ctx = this.ctx;
    const s = this.cur;
    if (!ctx || !s) return;
    const now = performance.now();

    // ---- 棋盘 ----
    ctx.fillStyle = "#12141d";
    ctx.fillRect(0, 0, N * CELL, N * CELL);
    for (let i = 0; i < N * N; i++) {
      const x = (i % N) * CELL;
      const y = Math.floor(i / N) * CELL;
      const owner = s.grid[i];
      ctx.fillStyle = "#1c1f2e";
      ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
      if (owner) {
        const t = Math.min(1, (now - this.changedAt[i]) / PAINT_ANIM_MS);
        const k = 0.55 + 0.45 * ease(t); // 新涂的格子从中心"溅开"
        const size = (CELL - 2) * k;
        ctx.globalAlpha = 0.55 + 0.3 * ease(t);
        ctx.fillStyle = COLORS[owner];
        ctx.fillRect(x + 1 + (CELL - 2 - size) / 2, y + 1 + (CELL - 2 - size) / 2, size, size);
        ctx.globalAlpha = 1;
      }
    }

    // ---- 玩家：在上一帧与当前帧之间插值，平滑移动 ----
    const k = Math.min(1, (now - this.curAt) / TICK_MS);
    for (const p of s.players) {
      const pp = this.prev?.players.find((q) => q.id === p.id);
      const jump = !pp || Math.abs(pp.x - p.x) + Math.abs(pp.y - p.y) > 1; // 新一局/重生：直接跳到位
      const fx = jump ? p.x : pp!.x + (p.x - pp!.x) * k;
      const fy = jump ? p.y : pp!.y + (p.y - pp!.y) * k;
      const slot = this.slotOf(p.id);
      const cx = fx * CELL + CELL / 2;
      const cy = fy * CELL + CELL / 2;
      ctx.globalAlpha = p.connected ? 1 : 0.35;
      ctx.fillStyle = "rgba(0,0,0,.35)";
      roundRect(ctx, cx - 12, cy - 10, 26, 26, 7);
      ctx.fill();
      ctx.fillStyle = COLORS[slot];
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      roundRect(ctx, cx - 13, cy - 13, 26, 26, 7);
      ctx.fill();
      ctx.stroke();
      // 眼睛：己方角色的眼睛立刻看向按住的方向（本地即时反馈，不等服务器回包）
      const look = p.id === this.me ? heldDir() : null;
      const ex = look === "left" ? -3 : look === "right" ? 3 : 0;
      const ey = look === "up" ? -3 : look === "down" ? 3 : 0;
      ctx.fillStyle = DARK[slot];
      ctx.fillRect(cx - 7 + ex, cy - 4 + ey, 4, 6);
      ctx.fillRect(cx + 3 + ex, cy - 4 + ey, 4, 6);
      if (look) {
        // 按住方向的一侧亮起一个小箭头
        const [dx, dy] = look === "left" ? [-1, 0] : look === "right" ? [1, 0] : look === "up" ? [0, -1] : [0, 1];
        const ax = cx + dx * 19, ay = cy + dy * 19;
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.beginPath();
        ctx.moveTo(ax + dx * 5, ay + dy * 5);
        ctx.lineTo(ax - dy * 5 - dx * 2, ay + dx * 5 - dy * 2);
        ctx.lineTo(ax + dy * 5 - dx * 2, ay - dx * 5 - dy * 2);
        ctx.fill();
      }
      if (p.id === this.me) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.moveTo(cx - 5, cy - 22);
        ctx.lineTo(cx + 5, cy - 22);
        ctx.lineTo(cx, cy - 16);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    this.updateHud(s, now);
  }

  private updateHud(s: Snapshot, now: number) {
    const root = this.root;
    if (!root) return;
    const counts = { 1: 0, 2: 0 } as Record<number, number>;
    for (const v of s.grid) if (v) counts[v]++;
    for (const slot of [1, 2]) {
      const pct = (counts[slot] / (N * N)) * 100;
      const el = root.querySelector<HTMLElement>(`#pct${slot}`);
      if (el) el.textContent = `${Math.round(pct)}%`;
      const bar = root.querySelector<HTMLElement>(`#bar${slot}`);
      if (bar) bar.style.width = `${pct}%`;
    }
    const timer = root.querySelector<HTMLElement>("#timer");
    if (timer && s.status === "playing") {
      const rem = Math.max(0, s.remainingMs - (now - this.curAt));
      const sec = Math.ceil(rem / 1000);
      timer.textContent = String(sec);
      timer.classList.toggle("hot", sec <= 10);
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
