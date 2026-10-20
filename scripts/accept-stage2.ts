// 阶段 2 验收：房间流程
// 用法：npm run accept:2 -- [baseUrl]    默认 http://localhost:3000
// 覆盖：创建房间 → A 入座 → B 通过房间码入座、双方互相可见 → 第三人 C 被拒（房间已满）
//       → 错误房间码有提示 → 非房主不能开始 → 房主开始后两端同时进入倒计时 → 3 秒后进入对局
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, RoomInfo, ServerToClientEvents } from "../shared/protocol.js";

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const T = 10_000;
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failed = true;
};

function client(): Promise<S> {
  return new Promise((res, rej) => {
    const s: S = io(base, { transports: ["websocket"], reconnection: false, forceNew: true });
    s.once("connect", () => res(s));
    s.once("connect_error", (e) => rej(e));
  });
}

function once<E extends keyof ServerToClientEvents>(s: S, ev: E, pred: (p: any) => boolean = () => true): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`等待 ${String(ev)} 超时`)), T);
    const h = (p: any) => {
      if (!pred(p)) return;
      clearTimeout(t);
      s.off(ev, h as any);
      res(p);
    };
    s.on(ev, h as any);
  });
}

async function main() {
  console.log(`目标: ${base}`);
  const created = (await (await fetch(`${base}/api/rooms`, { method: "POST" })).json()) as { code: string };
  check("POST /api/rooms 创建房间，返回 4 位房间码", /^[A-Z0-9]{4}$/.test(created.code), created.code);
  const code = created.code;

  const q0 = await (await fetch(`${base}/api/rooms/${code}`)).json();
  check("GET /api/rooms/:code 查询到新房间", q0.exists === true && q0.playerCount === 0);

  const qBad = await (await fetch(`${base}/api/rooms/ZZZZ`)).json();
  check("GET /api/rooms/ZZZZ（错误房间码）返回不存在", qBad.exists === false);

  const [A, B, C, D] = await Promise.all([client(), client(), client(), client()]);

  // A 入座
  const aJoined = once(A, "joined");
  A.emit("join", { code, name: "玩家A" });
  const ja = await aJoined;
  check("A 加入成功并成为房主", ja.room.hostId === ja.playerId && ja.room.players.length === 1);

  // B 入座，A 收到包含双方的 room 广播
  const aSeesTwo = once(A, "room", (r: RoomInfo) => r.players.length === 2);
  const bJoined = once(B, "joined");
  B.emit("join", { code: code.toLowerCase(), name: "玩家B" }); // 房间码大小写不敏感
  const jb = await bJoined;
  const ra: RoomInfo = await aSeesTwo;
  const names = (r: RoomInfo) => r.players.map((p) => p.name).join(",");
  check("B 加入后，B 看到双方", jb.room.players.length === 2, names(jb.room));
  check("B 加入后，A 也看到双方", ra.players.length === 2, names(ra));
  check("双方颜色座位不同（slot 1 / slot 2）", ra.players[0].slot === 1 && ra.players[1].slot === 2);

  // 第三人 C 被拒
  const cErr = once(C, "error");
  C.emit("join", { code, name: "玩家C" });
  const ec = await cErr;
  check('第三人 C 收到"房间已满"', ec.code === "ROOM_FULL", ec.msg);
  const qFull = await (await fetch(`${base}/api/rooms/${code}`)).json();
  check("GET 预检也显示满员（playerCount=2），前端据此提示", qFull.playerCount === 2);

  // 错误房间码
  const dErr = once(D, "error");
  D.emit("join", { code: "ZZZZ", name: "玩家D" });
  const ed = await dErr;
  check('错误房间码收到"房间不存在"', ed.code === "ROOM_NOT_FOUND", ed.msg);

  // 非房主不能开始
  const bErr = once(B, "error");
  B.emit("start");
  const eb = await bErr;
  check("非房主 B 点开始被拒绝", eb.code === "NOT_HOST", eb.msg);

  // 房主开始：两端同时进入倒计时
  const tA = once(A, "room", (r: RoomInfo) => r.status === "countdown").then((r) => ({ r, at: Date.now() }));
  const tB = once(B, "room", (r: RoomInfo) => r.status === "countdown").then((r) => ({ r, at: Date.now() }));
  A.emit("start");
  const [ca, cb] = await Promise.all([tA, tB]);
  const gap = Math.abs(ca.at - cb.at);
  check("房主开始后，A、B 都进入倒计时", ca.r.status === "countdown" && cb.r.status === "countdown", `第 ${ca.r.round} 局`);
  check("两端收到倒计时的时间差 < 200ms", gap < 200, `${gap}ms`);
  check("倒计时剩余约 3 秒", ca.r.phaseRemainingMs > 2500 && ca.r.phaseRemainingMs <= 3000, `${ca.r.phaseRemainingMs}ms`);

  const pA = once(A, "room", (r: RoomInfo) => r.status === "playing");
  const pB = once(B, "room", (r: RoomInfo) => r.status === "playing");
  const [pa, pb] = await Promise.all([pA, pB]);
  check("倒计时结束后两端同时进入对局", pa.status === "playing" && pb.status === "playing");

  [A, B, C, D].forEach((s) => s.close());
  console.log(failed ? "\n结果：失败" : "\n结果：全部通过");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log(`FAIL  ${e.message}`);
  process.exit(1);
});
