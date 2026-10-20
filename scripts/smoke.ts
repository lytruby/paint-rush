// 冒烟测试：模拟"两个标签页"连接同一服务器。
// 用法：npm run smoke -- [baseUrl]    默认 http://localhost:3000
// 检查：1) /healthz 返回 ok  2) 两个客户端强制走 WebSocket 都能连上
//       3) 双方都收到 hello  4) 第一个客户端收到在线数 >= 2 的 presence 广播
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "../shared/protocol.js";

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const TIMEOUT = 15_000;

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failed = true;
}
let failed = false;

function connect(label: string): Promise<{ s: S; hello: { online: number } }> {
  return new Promise((resolve, reject) => {
    const s: S = io(base, { transports: ["websocket"], reconnection: false, timeout: TIMEOUT });
    const t = setTimeout(() => reject(new Error(`${label} 连接超时`)), TIMEOUT);
    s.on("connect_error", (e) => { clearTimeout(t); reject(new Error(`${label} 连接失败: ${e.message}`)); });
    s.on("hello", (hello) => { clearTimeout(t); resolve({ s, hello }); });
  });
}

async function main() {
  console.log(`目标: ${base}`);
  try {
    const r = await fetch(`${base}/healthz`);
    const body = (await r.json()) as { ok?: boolean };
    check("GET /healthz", r.ok && body.ok === true, `HTTP ${r.status}`);
  } catch (e) {
    check("GET /healthz", false, String(e));
  }

  try {
    const a = await connect("客户端A");
    check("客户端A 通过 WebSocket 连接并收到 hello", a.s.io.engine.transport.name === "websocket");

    const sawTwo = new Promise<boolean>((res) => {
      a.s.on("presence", (p) => p.online >= 2 && res(true));
      setTimeout(() => res(false), TIMEOUT);
    });
    const b = await connect("客户端B");
    check("客户端B 通过 WebSocket 连接并收到 hello", b.s.io.engine.transport.name === "websocket", `online=${b.hello.online}`);
    check("客户端A 收到在线数≥2 的 presence 广播", await sawTwo);

    a.s.close();
    b.s.close();
  } catch (e) {
    check("WebSocket 双客户端连接", false, String(e));
  }

  console.log(failed ? "\n结果：失败" : "\n结果：全部通过");
  process.exit(failed ? 1 : 0);
}

main();
