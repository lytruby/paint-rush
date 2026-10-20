// 阶段 4 验收：房间和玩家生命周期（约 90 秒）
// 用法：npm run accept:4 -- [baseUrl]    默认 http://localhost:3000
// 主流程（房间 R）：对局中"刷新"回到原位继续玩 → 重复连接踢旧连接 → 第三人满员 → 打完一局
//   → 双方再来一局 → 第 2 局中 B 关闭页面：A 看到"掉线中"，15 秒后判 A 获胜
//   → 新玩家 D 中途加入回到大厅 → 房主 A 离开，D 成为房主
// 并行流程（房间 Q）：对局中主动离开 → 立即结算，对方获胜
import { io, type Socket } from "socket.io-client";
import { RECONNECT_GRACE_MS, type ClientToServerEvents, type OverPayload, type RoomInfo, type ServerToClientEvents, type Snapshot } from "../shared/protocol.js";

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failed = true;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) return false; await sleep(20); }
  return true;
}

interface C { s: S; id: string; token: string; room: RoomInfo | null; last: Snapshot | null; over: OverPayload | null; errors: string[]; seq: number }
function client(): Promise<C> {
  return new Promise((res, rej) => {
    const s: S = io(base, { transports: ["websocket"], reconnection: false, forceNew: true });
    const c: C = { s, id: "", token: "", room: null, last: null, over: null, errors: [], seq: 0 };
    s.on("joined", (j) => { c.id = j.playerId; c.token = j.token; c.room = j.room; });
    s.on("room", (r) => (c.room = r));
    s.on("snapshot", (p) => { if (!c.last || p.tick > c.last.tick) c.last = p; });
    s.on("over", (o) => (c.over = o));
    s.on("error", (e) => c.errors.push(e.code));
    s.once("connect", () => res(c));
    s.once("connect_error", rej);
  });
}
const pos = (c: C, id = c.id) => c.last?.players.find((p) => p.id === id);
const peer = (c: C, id: string) => c.room?.players.find((p) => p.id === id);
async function joinAs(code: string, name: string, token?: string) {
  const c = await client();
  c.s.emit("join", { code, name, token });
  await waitFor(() => !!c.id || c.errors.length > 0, 5000);
  return c;
}
const mkRoom = async () => ((await (await fetch(`${base}/api/rooms`, { method: "POST" })).json()) as { code: string }).code;

async function leaveFlow() {
  const code = await mkRoom();
  const G = await joinAs(code, "G");
  const H = await joinAs(code, "H");
  await waitFor(() => G.room?.players.length === 2, 3000);
  G.s.emit("start");
  await waitFor(() => G.room?.status === "playing", 6000);
  H.s.emit("leave");
  const ok = await waitFor(() => !!G.over && G.room?.status === "ended", 3000);
  return { ok, over: G.over, gid: G.id, players: G.room?.players.length, close: () => G.s.close() };
}

async function main() {
  console.log(`目标: ${base}`);
  const leaveP = leaveFlow();

  const code = await mkRoom();
  let A = await joinAs(code, "A");
  const B = await joinAs(code, "B");
  await waitFor(() => A.room?.players.length === 2, 3000);
  A.s.emit("start");
  await waitFor(() => A.room?.status === "playing" && A.last?.status === "playing", 6000);

  // ---- 1. 对局中刷新：断开 → 对手看到掉线中 → 带 token 重连回到原座位 ----
  A.s.emit("input", { seq: ++A.seq, dir: "right" });
  await waitFor(() => (pos(A)?.x ?? 0) >= 5, 3000);
  A.s.emit("input", { seq: ++A.seq, dir: null });
  await sleep(800);
  const aId = A.id, aToken = A.token, aSlot = peer(A, A.id)!.slot;
  A.s.close(); // 相当于刷新页面（旧连接断开）
  const sawOffline = await waitFor(() => peer(B, aId)?.connected === false, 3000);
  check('对局中 A 刷新：B 看到 A "掉线中"', sawOffline);
  // 掉线后服务器会清空该座位的方向，角色不能再动；从 B 的视角取此后的位置作为基准
  // （高延迟下 A 断开前可能还有一步在路上，所以不能用 A 断开前最后看到的位置）
  await sleep(500);
  const before = pos(B, aId)!;
  A = await joinAs(code, "A", aToken);
  check("A 带 token 重新进入，回到原座位（同一 playerId 和颜色）", A.id === aId && peer(A, aId)?.slot === aSlot);
  check("重连后直接回到对局中视图（status=playing）", A.room?.status === "playing");
  await waitFor(() => !!A.last, 2000);
  const after = pos(A)!;
  check("重连后位置不变（角色停在原地）", after.x === before.x && after.y === before.y, `(${before.x},${before.y}) → (${after.x},${after.y})`);
  check("B 看到 A 恢复在线", await waitFor(() => peer(B, aId)?.connected === true, 3000));
  // 新连接的 seq 从 1 开始，必须被接受。向上走：A 一直在第 7 行，B 的出生点在 A 右下方，向下可能被 B 挡住
  A.s.emit("input", { seq: 1, dir: "up" });
  const moved = await waitFor(() => (pos(A)?.y ?? 99) < after.y, 3000);
  A.s.emit("input", { seq: 2, dir: null });
  A.seq = 2;
  check("刷新后可以继续操作（新连接的 seq 从 1 开始被接受）", moved);

  // ---- 2. 重复连接：同一 token 再开一个连接 → 旧连接被踢 ----
  const A2 = await joinAs(code, "A", aToken);
  const kicked = await waitFor(() => A.errors.includes("REPLACED"), 3000);
  check("同一座位在新标签页打开：旧连接收到 REPLACED 被踢出，新连接接管同一座位", kicked && A2.id === aId);
  A.s.close();
  A = A2;
  A.seq = 0;
  await sleep(300);
  check("被踢的旧连接断开不会把座位标成掉线", peer(B, aId)?.connected === true);

  // ---- 3. 第三人 ----
  const C3 = await joinAs(code, "C");
  check('对局中第三人加入：提示"房间已满"', C3.errors.includes("ROOM_FULL"));
  C3.s.close();

  // ---- 4. 打完这一局，然后再来一局 ----
  const rem = A.last?.remainingMs ?? 60000;
  console.log(`…等待第 1 局结束（约 ${Math.ceil(rem / 1000)} 秒）`);
  const ended = await waitFor(() => A.room?.status === "ended" && B.room?.status === "ended", rem + 5000);
  check("第 1 局正常结束（时间到）", ended && A.over?.reason === "time");
  A.s.emit("rematch");
  await waitFor(() => (B.room?.rematchVotes.length ?? 0) === 1, 3000);
  check('A 点"再来一局"后，B 看到"对方已准备"，仍停在结算页', B.room?.rematchVotes.includes(aId) === true && B.room?.status === "ended");
  B.s.emit("rematch");
  const r2 = await waitFor(() => A.room?.status === "countdown" && B.room?.status === "countdown", 3000);
  check("双方都点再来一局 → 两端进入第 2 局倒计时", r2 && A.room?.round === 2, `round=${A.room?.round}`);
  const fresh = A.last!.grid.filter((v) => v !== 0).length;
  check("新一局棋盘已重置（只剩两个出生格）", fresh === 2, `已染色 ${fresh} 格`);
  await waitFor(() => A.room?.status === "playing", 5000);

  // ---- 5. 第 2 局中 B 关闭页面且不回来 → 15 秒后判 A 获胜 ----
  const bId = B.id;
  const tClose = Date.now();
  B.s.close();
  check('B 关闭页面：A 看到 B "掉线中"', await waitFor(() => peer(A, bId)?.connected === false, 3000));
  await sleep(RECONNECT_GRACE_MS - 3000);
  check("15 秒保留期内对局继续（没有提前结算）", A.room?.status === "playing");
  const won = await waitFor(() => A.room?.status === "ended" && !!A.over && A.over.reason === "opponent_left", 8000);
  const waited = ((Date.now() - tClose) / 1000).toFixed(1);
  check("掉线超时后结算：reason=opponent_left，A 获胜", won && A.over?.winnerId === aId, `约 ${waited} 秒后`);
  check("结算里仍包含离开者的分数", (A.over?.scores.length ?? 0) === 2);
  check("B 的座位已释放（房间只剩 A）", A.room?.players.length === 1);

  // ---- 6. 中途加入 + 房主转移 ----
  const D = await joinAs(code, "D");
  check("新玩家 D 用同一链接加入空座 → 房间回到大厅", !!D.id && (await waitFor(() => A.room?.status === "lobby" && A.room.players.length === 2, 3000)));
  check("A 仍是房主", A.room?.hostId === aId);
  A.s.emit("leave");
  const transferred = await waitFor(() => D.room?.hostId === D.id && D.room.players.length === 1, 3000);
  check("房主 A 离开后，D 自动成为房主", transferred);

  // ---- 并行流程结果：主动离开 ----
  const lf = await leaveP;
  check("对局中主动离开：立即结算，剩下的一方获胜（opponent_left）", lf.ok && lf.over?.reason === "opponent_left" && lf.over?.winnerId === lf.gid && lf.players === 1);

  lf.close(); A.s.close(); D.s.close();
  console.log(failed ? "\n结果：失败" : "\n结果：全部通过");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.log(`FAIL  ${e.message}`); process.exit(1); });
