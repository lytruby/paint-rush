// 诊断：测量"发出输入 → 快照中出现位移"的延迟
import { io } from "socket.io-client";
const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const mk = () => io(base, { transports: ["websocket"], forceNew: true, reconnection: false });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { code } = await (await fetch(`${base}/api/rooms`, { method: "POST" })).json();
const A = mk(), B = mk();
let aid = "", last: any = null, status = "";
A.on("joined", (j) => (aid = j.playerId));
A.on("snapshot", (s) => (last = s));
A.on("room", (r) => (status = r.status));
await new Promise<void>((r) => A.on("connect", () => r())); await new Promise<void>((r) => B.on("connect", () => r()));
// ping
const t0 = Date.now(); await new Promise<void>((r) => { A.once("joined", () => r()); A.emit("join", { code, name: "A" }); }); console.log(`join RTT ${Date.now() - t0}ms`);
B.emit("join", { code, name: "B" }); await sleep(500);
A.emit("start");
while (status !== "playing") await sleep(10);
await sleep(300);
let seq = 0;
for (const dir of ["right", "down", "left", "up"]) {
  const p0 = last.players.find((p: any) => p.id === aid);
  const ts = Date.now();
  A.emit("input", { seq: ++seq, dir });
  let moved = -1;
  while (Date.now() - ts < 3000) { const p = last.players.find((q: any) => q.id === aid); if (p.x !== p0.x || p.y !== p0.y) { moved = Date.now() - ts; break; } await sleep(2); }
  await sleep(400);
  A.emit("input", { seq: ++seq, dir: null });
  console.log(`${dir}: 首次位移延迟 ${moved}ms`);
  await sleep(600);
}
process.exit(0);
