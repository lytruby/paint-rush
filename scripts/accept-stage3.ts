// 阶段 3 验收：核心玩法（会完整打一局，约 65 秒）
// 用法：npm run accept:3 -- [baseUrl]    默认 http://localhost:3000
// 覆盖：双方移动并互相看到 / 两端快照一致 / 涂色 / 连按不加速 / 重复与乱序输入被丢弃 /
//       越界与碰撞（永不重叠）/ 60 秒后两端收到相同结算，且与最终棋盘一致
import { io, type Socket } from "socket.io-client";
import { GRID_SIZE as N, TICK_HZ, type ClientToServerEvents, type OverPayload, type RoomInfo, type ServerToClientEvents, type Snapshot } from "../shared/protocol.js";

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failed = true;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface C { s: S; id: string; snaps: Map<number, Snapshot>; last: Snapshot | null; over: OverPayload | null; room: RoomInfo | null; seq: number }

function client(): Promise<C> {
  return new Promise((res, rej) => {
    const s: S = io(base, { transports: ["websocket"], reconnection: false, forceNew: true });
    const c: C = { s, id: "", snaps: new Map(), last: null, over: null, room: null, seq: 0 };
    s.on("snapshot", (p) => { c.snaps.set(p.tick, p); if (!c.last || p.tick > c.last.tick) c.last = p; });
    s.on("over", (o) => (c.over = o));
    s.on("room", (r) => (c.room = r));
    s.on("joined", (j) => { c.id = j.playerId; c.room = j.room; });
    s.once("connect", () => res(c));
    s.once("connect_error", rej);
  });
}
const send = (c: C, dir: any, seq?: number) => c.s.emit("input", { seq: seq ?? ++c.seq, dir });
const me = (c: C, snap = c.last!) => snap.players.find((p) => p.id === c.id)!;
async function waitFor(pred: () => boolean, ms: number) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) return false; await sleep(20); }
  return true;
}

async function main() {
  console.log(`目标: ${base}`);
  const { code } = (await (await fetch(`${base}/api/rooms`, { method: "POST" })).json()) as { code: string };
  const A = await client();
  const B = await client();
  A.s.emit("join", { code, name: "A" });
  await waitFor(() => !!A.id, 5000);
  B.s.emit("join", { code, name: "B" });
  await waitFor(() => !!B.id && A.room?.players.length === 2, 5000);

  // 每个快照都检查：双方永不重叠、永不越界
  let overlap = 0, outOfBounds = 0;
  for (const c of [A, B]) c.s.on("snapshot", (p) => {
    const [p1, p2] = p.players;
    if (p1 && p2 && p1.x === p2.x && p1.y === p2.y) overlap++;
    for (const q of p.players) if (q.x < 0 || q.y < 0 || q.x >= N || q.y >= N) outOfBounds++;
  });

  A.s.emit("start");
  check("倒计时阶段就下发棋盘快照（显示出生点）", await waitFor(() => A.last?.status === "countdown", 3000));
  const ok = await waitFor(() => A.room?.status === "playing" && A.last?.status === "playing", 6000);
  check("倒计时后进入对局", ok);
  const a0 = me(A), b0 = me(B, B.last!);

  // 1) 移动 + 互相看到
  send(A, "right"); send(B, "left");
  await sleep(600);
  send(A, null); send(B, null);
  await sleep(250);
  const a1 = me(A), b1 = me(B, B.last!);
  check("A 向右移动", a1.x > a0.x, `x ${a0.x}→${a1.x}`);
  check("B 向左移动", b1.x < b0.x, `x ${b0.x}→${b1.x}`);
  const aSeenByB = B.last!.players.find((p) => p.id === A.id)!;
  check("B 看到的 A 位置 = A 自己的位置（实时互见）", aSeenByB.x === a1.x && aSeenByB.y === a1.y);

  // 2) 两端同一 tick 的快照完全一致
  const common = [...A.snaps.keys()].filter((t) => B.snaps.has(t));
  const same = common.every((t) => JSON.stringify(A.snaps.get(t)!.players) === JSON.stringify(B.snaps.get(t)!.players) && A.snaps.get(t)!.grid.join() === B.snaps.get(t)!.grid.join());
  check("两端同一 tick 的快照（位置 + 棋盘）完全一致", common.length > 5 && same, `比对 ${common.length} 帧`);

  // 3) 涂色
  const painted = A.last!.grid.filter((v) => v === 1).length;
  check("走过的格子被染色", painted >= a1.x - a0.x + 1, `A 占 ${painted} 格`);

  // 4) 连按不加速：1 秒内狂发 200 条（远超限流）方向交替的输入
  const before = me(A);
  const t0 = A.last!.tick;
  for (let i = 0; i < 200; i++) send(A, i % 2 ? "down" : "up");
  await sleep(1000);
  send(A, null);
  await sleep(200);
  const ticks = A.last!.tick - t0;
  const after = me(A);
  const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
  check("狂按 200 次，位移不超过经过的 tick 数（每 tick 最多一格）", moved <= ticks, `位移 ${moved} 格 / ${ticks} tick`);

  // 5) 重复包与乱序包被丢弃：先发 seq=10000 的 left，再发 seq=9999 的 right（旧包）和重复的 10000 down
  await sleep(1100); // 让限流窗口重置
  const p5 = me(A);
  A.seq = 10000;
  A.s.emit("input", { seq: 10000, dir: "left" });
  A.s.emit("input", { seq: 9999, dir: "right" });
  A.s.emit("input", { seq: 10000, dir: "down" });
  await sleep(350);
  send(A, null);
  await sleep(200);
  const p6 = me(A);
  check("乱序旧包和重复包被丢弃（只按 left 移动）", p6.x < p5.x && p6.y === p5.y, `(${p5.x},${p5.y})→(${p6.x},${p6.y})`);

  // 6) 碰撞：把两人移到同一行，相向而行
  const ra = me(A), rb = me(B, B.last!);
  send(B, rb.y > ra.y ? "up" : "down");
  await waitFor(() => me(B, B.last!).y === me(A).y, 3000);
  send(B, null);
  await sleep(150);
  send(A, "right"); send(B, "left");
  await sleep(2200);
  const ca = me(A), cb = me(B, B.last!);
  check("相向而行最终被挡住、相邻停下（不重叠）", ca.y === cb.y && Math.abs(ca.x - cb.x) === 1, `A(${ca.x},${ca.y}) B(${cb.x},${cb.y})`);
  send(A, null); send(B, null);

  // 7) 越界：A 一直向上走 2 秒
  send(A, "up");
  await sleep(2000);
  send(A, null);
  check("撞到边界停住，不会越界", me(A).y === 0 && outOfBounds === 0, `y=${me(A).y}`);

  // 8) 随机走一会儿，然后等时间到
  const dirs = ["up", "down", "left", "right"];
  const wander = setInterval(() => { send(A, dirs[Math.floor(Math.random() * 4)]); send(B, dirs[Math.floor(Math.random() * 4)]); }, 300);
  const remain = A.last!.remainingMs;
  console.log(`…等待对局结束（约 ${Math.ceil(remain / 1000)} 秒）`);
  const ended = await waitFor(() => !!A.over && !!B.over && A.room?.status === "ended" && B.room?.status === "ended", remain + 5000);
  clearInterval(wander);
  check("60 秒后对局结束，两端都进入结算", ended);
  check("全程双方从未重叠", overlap === 0, `重叠帧 ${overlap}`);
  if (ended) {
    check("两端收到的结算结果完全相同", JSON.stringify(A.over) === JSON.stringify(B.over), JSON.stringify(A.over!.scores.map((s) => `${s.cells}格/${s.pct}%`)));
    const g = A.last!.grid;
    const c1 = g.filter((v) => v === 1).length, c2 = g.filter((v) => v === 2).length;
    const sc = A.over!.scores;
    check("结算格子数与最终棋盘一致", sc[0].cells === c1 && sc[1].cells === c2, `棋盘 ${c1}:${c2}`);
    const expect = c1 === c2 ? null : c1 > c2 ? sc[0].id : sc[1].id;
    check("胜负判定正确（格子多者胜，相同为平局）", A.over!.winnerId === expect, A.over!.winnerId === null ? "平局" : `胜者 ${A.over!.winnerId === A.id ? "A" : "B"}`);
    const playMs = TICK_HZ; void playMs;
  }

  A.s.close(); B.s.close();
  console.log(failed ? "\n结果：失败" : "\n结果：全部通过");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.log(`FAIL  ${e.message}`); process.exit(1); });
