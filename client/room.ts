import type { ErrorCode, PlayerPublic, RoomInfo, RoomQueryRes } from "../shared/protocol";
import { AUTOJOIN_KEY } from "./home";
import { socket } from "./net";
import { $, esc, getName, hideOverlay, setName, showOverlay, toast, view } from "./ui";

interface RoomState {
  code: string;
  me: string | null; // 我的 playerId；null 表示尚未加入
  room: RoomInfo | null;
  countdownEnd: number; // performance.now() 基准
  raf: number;
}

let cur: RoomState | null = null;
let nav: (path: string) => void = () => {};

const goHome = () => {
  hideOverlay();
  leaveRoom();
  nav("/");
};

export async function enterRoom(code: string, navigate: (path: string) => void) {
  nav = navigate;
  cur = { code, me: null, room: null, countdownEnd: 0, raf: 0 };
  document.title = `房间 ${code} · 抢地盘`;
  view.innerHTML = `<section class="card"><p class="muted">正在进入房间 ${esc(code)}…</p></section>`;

  // 从首页创建或加入：直接入座
  if (sessionStorage.getItem(AUTOJOIN_KEY) === code) {
    sessionStorage.removeItem(AUTOJOIN_KEY);
    return join();
  }

  // 通过邀请链接打开：先预检，再显示确认卡片（可以修改昵称）
  let q: RoomQueryRes;
  try {
    q = (await (await fetch(`/api/rooms/${code}`)).json()) as RoomQueryRes;
  } catch {
    return showOverlay("网络错误", "无法连接服务器，请稍后重试。", [{ label: "重试", primary: true, onClick: () => location.reload() }]);
  }
  if (cur?.code !== code) return; // 期间已离开
  if (!q.exists) return showRoomError("ROOM_NOT_FOUND");
  if ((q.playerCount ?? 0) >= 2) return showRoomError("ROOM_FULL");

  view.innerHTML = `
    <section class="card invite">
      <p class="muted">好友邀请你加入</p>
      <h2>房间 <span class="code">${esc(code)}</span></h2>
      <label class="field">你的昵称<input id="name" maxlength="12" value="${esc(getName())}" autocomplete="off" /></label>
      <button id="joinBtn" class="primary big">加入房间</button>
    </section>`;
  $<HTMLButtonElement>("#joinBtn").onclick = () => {
    setName($<HTMLInputElement>("#name").value);
    join();
  };
}

export function leaveRoom() {
  if (!cur) return;
  if (cur.me) socket.emit("leave");
  cancelAnimationFrame(cur.raf);
  cur = null;
}

function join() {
  if (!cur) return;
  socket.emit("join", { code: cur.code, name: getName() });
}

function showRoomError(code: ErrorCode, msg?: string) {
  const map: Partial<Record<ErrorCode, [string, string]>> = {
    ROOM_NOT_FOUND: ["房间不存在", `房间 ${cur?.code ?? ""} 不存在或已解散，请确认链接是否正确。`],
    ROOM_FULL: ["房间已满", `房间 ${cur?.code ?? ""} 已经有两名玩家了。可以创建一个新房间，邀请好友来玩。`],
  };
  const [title, text] = map[code] ?? ["出错了", msg ?? "未知错误"];
  showOverlay(title, text, [{ label: "返回首页", primary: true, onClick: goHome }]);
  if (cur) cur.me = null;
}

// ---- 服务器事件 ----
socket.on("joined", (p) => {
  if (!cur || p.room.code !== cur.code) return;
  cur.me = p.playerId;
  sessionStorage.setItem("pr_token", p.token); // 阶段 4 用于刷新重连
  render(p.room);
});

socket.on("room", (r) => {
  if (!cur || !cur.me || r.code !== cur.code) return;
  render(r);
});

socket.on("error", (e) => {
  if (!cur) return;
  if (e.code === "ROOM_NOT_FOUND" || e.code === "ROOM_FULL") showRoomError(e.code);
  else toast(e.msg);
});

// 阶段 2 的简化：断线后服务器会移除座位，重连时重新加入（阶段 4 改为 token 恢复原座位）
socket.on("connect", () => {
  if (cur?.me) {
    cur.me = null;
    join();
  }
});

// ---- 渲染 ----
function render(room: RoomInfo) {
  if (!cur) return;
  const prevStatus = cur.room?.status;
  cur.room = room;
  cancelAnimationFrame(cur.raf);

  if (room.status === "lobby") renderLobby(room);
  else if (room.status === "countdown") renderCountdown(room);
  else if (room.status === "playing") renderPlaying(room);
  else view.innerHTML = `<section class="card"><p class="muted">结算（阶段 3 实现）</p></section>`;

  if (prevStatus && prevStatus !== "lobby" && room.status === "lobby") toast("对手离开了，已回到大厅");
}

function slotHtml(room: RoomInfo, slot: 1 | 2) {
  const p: PlayerPublic | undefined = room.players.find((x) => x.slot === slot);
  if (!p) return `<div class="slot empty p${slot}"><span class="swatch"></span><span class="pname">等待对手加入…</span></div>`;
  const tags = [p.id === room.hostId ? `<span class="tag">房主</span>` : "", p.id === cur?.me ? `<span class="tag me">你</span>` : ""].join("");
  return `<div class="slot p${slot}"><span class="swatch"></span><span class="pname">${esc(p.name)}</span>${tags}
    <span class="state ${p.connected ? "on" : "off"}">${p.connected ? "在线" : "掉线中"}</span></div>`;
}

function playersBar(room: RoomInfo) {
  return `<div class="slots">${slotHtml(room, 1)}<span class="vs">VS</span>${slotHtml(room, 2)}</div>`;
}

function renderLobby(room: RoomInfo) {
  const link = `${location.origin}/r/${room.code}`;
  const isHost = room.hostId === cur?.me;
  const ready = room.players.length === 2 && room.players.every((p) => p.connected);
  const action = isHost
    ? `<button id="start" class="primary big" ${ready ? "" : "disabled"}>${ready ? "开始游戏" : "等待对手加入…"}</button>`
    : `<p class="muted center">等待房主开始游戏…</p>`;

  view.innerHTML = `
    <section class="card lobby">
      <div class="roomhead">
        <div><span class="label">房间码</span><b class="code">${esc(room.code)}</b></div>
        <button id="copy">复制邀请链接</button>
      </div>
      <p class="link" title="把这个链接发给好友">${esc(link)}</p>
      ${playersBar(room)}
      ${action}
      <button id="leave" class="ghost">离开房间</button>
    </section>`;

  $<HTMLButtonElement>("#copy").onclick = async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(link);
      btn.textContent = "已复制";
    } catch {
      prompt("复制下面的邀请链接：", link);
    }
  };
  const start = document.getElementById("start") as HTMLButtonElement | null;
  if (start) start.onclick = () => socket.emit("start");
  $<HTMLButtonElement>("#leave").onclick = goHome;
}

function renderCountdown(room: RoomInfo) {
  view.innerHTML = `
    <section class="card">
      ${playersBar(room)}
      <div class="countdown"><div class="num" id="cd"></div><p class="muted">第 ${room.round} 局即将开始</p></div>
    </section>`;
  const st = cur!;
  st.countdownEnd = performance.now() + room.phaseRemainingMs;
  const el = $("#cd");
  let last = "";
  const tick = () => {
    const rem = st.countdownEnd - performance.now();
    const txt = rem > 0 ? String(Math.ceil(rem / 1000)) : "开始！";
    if (txt !== last) {
      last = txt;
      el.textContent = txt;
      el.classList.remove("pop");
      void el.offsetWidth; // 重新触发动画
      el.classList.add("pop");
    }
    if (rem > -500) st.raf = requestAnimationFrame(tick);
  };
  tick();
}

function renderPlaying(room: RoomInfo) {
  view.innerHTML = `
    <section class="card">
      ${playersBar(room)}
      <div class="countdown"><div class="num">开始！</div><p class="muted">对局画面会在阶段 3 实现</p></div>
      <button id="leave" class="ghost">离开房间</button>
    </section>`;
  $<HTMLButtonElement>("#leave").onclick = goHome;
}
