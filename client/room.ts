import { ROUND_MS, type ErrorCode, type OverPayload, type PlayerPublic, type RoomInfo, type RoomQueryRes } from "../shared/protocol";
import { GameView, rememberPlayers, roster } from "./game";
import { AUTOJOIN_KEY } from "./home";
import { setInputPhase } from "./input";
import { sfx } from "./sfx";
import { socket } from "./net";
import { $, esc, getName, hideOverlay, setName, showOverlay, toast, view } from "./ui";

interface RoomState {
  code: string;
  me: string | null; // 我的 playerId；null 表示尚未加入
  room: RoomInfo | null;
  countdownEnd: number; // performance.now() 基准
  raf: number;
  game: GameView;
  over: OverPayload | null;
}

let cur: RoomState | null = null;
let nav: (path: string) => void = () => {};

// 重连凭证按房间存在 sessionStorage：同一标签页刷新后还在，不同标签页互不影响
const tokenKey = (code: string) => `pr_token_${code}`;

const goHome = () => {
  hideOverlay();
  leaveRoom();
  nav("/");
};

export async function enterRoom(code: string, navigate: (path: string) => void) {
  nav = navigate;
  cur?.game.unmount();
  cur = { code, me: null, room: null, countdownEnd: 0, raf: 0, game: new GameView(), over: null };
  document.title = `房间 ${code} · 抢地盘`;
  view.innerHTML = `<section class="card"><p class="muted">正在进入房间 ${esc(code)}…</p></section>`;

  // 从首页创建或加入、或者本标签页之前在这个房间里（刷新）：直接入座 / 恢复原座位
  if (sessionStorage.getItem(AUTOJOIN_KEY) === code || sessionStorage.getItem(tokenKey(code))) {
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
  cur.game.unmount();
  setInputPhase("lobby");
  cur = null;
}

function join() {
  if (!cur) return;
  const token = sessionStorage.getItem(tokenKey(cur.code)) ?? undefined;
  socket.emit("join", { code: cur.code, name: getName(), token });
}

function showRoomError(code: ErrorCode, msg?: string) {
  const map: Partial<Record<ErrorCode, [string, string]>> = {
    ROOM_NOT_FOUND: ["房间不存在", `房间 ${cur?.code ?? ""} 不存在或已解散，请确认链接是否正确。`],
    ROOM_FULL: ["房间已满", `房间 ${cur?.code ?? ""} 已经有两名玩家了。可以创建一个新房间，邀请好友来玩。`],
    REPLACED: ["已在别处打开", "你在另一个标签页或窗口重新进入了这个房间，这个页面已断开。"],
  };
  const [title, text] = map[code] ?? ["出错了", msg ?? "未知错误"];
  if (cur && code !== "REPLACED") sessionStorage.removeItem(tokenKey(cur.code)); // 凭证已失效
  if (cur) cur.me = null;
  showOverlay(title, text, [{ label: "返回首页", primary: true, onClick: goHome }]);
}

// ---- 服务器事件 ----
socket.on("joined", (p) => {
  if (!cur || p.room.code !== cur.code) return;
  cur.me = p.playerId;
  sessionStorage.setItem(tokenKey(cur.code), p.token);
  render(p.room);
});

socket.on("room", (r) => {
  if (!cur || !cur.me || r.code !== cur.code) return;
  render(r);
});

socket.on("snapshot", (s) => {
  if (cur?.me) cur.game.onSnapshot(s);
});

socket.on("over", (o) => {
  if (!cur?.me) return;
  cur.over = o;
  if (cur.room?.status !== "ended") sfx.result(o.winnerId === null ? "draw" : o.winnerId === cur.me ? "win" : "lose");
  if (cur.room?.status === "ended") render(cur.room);
});

socket.on("error", (e) => {
  if (!cur) return;
  if (e.code === "ROOM_NOT_FOUND" || e.code === "ROOM_FULL" || e.code === "REPLACED") showRoomError(e.code);
  else toast(e.msg);
});

// 断线重连：服务器为我们保留座位 15 秒，带 token 重新 join 即可回到原座位
socket.on("connect", () => {
  if (cur?.me) join();
});

// ---- 渲染 ----
function render(room: RoomInfo) {
  if (!cur) return;
  const prev = cur.room;
  cur.room = room;
  rememberPlayers(room);
  cancelAnimationFrame(cur.raf);
  setInputPhase(room.status);

  if (room.status === "lobby") {
    cur.game.unmount();
    renderLobby(room);
  } else renderGame(room);

  // 状态变化提示
  const opp = room.players.find((p) => p.id !== cur!.me);
  const prevOpp = prev?.players.find((p) => p.id === opp?.id);
  if (prev?.status === "ended" && room.status === "lobby") toast("新对手加入了房间");
  else if (opp && prevOpp?.connected && !opp.connected) toast("对手掉线了，15 秒内没回来就算对方离开");
  else if (opp && prevOpp && !prevOpp.connected && opp.connected) toast("对手回来了");
  else if (prev && prev.players.length === 2 && room.players.length === 1 && room.status === "lobby") toast("对手离开了房间");
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

// ---- 对局视图：倒计时 / 对局中 / 结算 共用同一块棋盘 ----
function hudSide(room: RoomInfo, slot: 1 | 2) {
  const p = room.players.find((x) => x.slot === slot);
  // 对手已离开（结算页）：用缓存里的昵称，标注"已离开"
  const goneId = !p ? cur?.over?.scores.find((s) => roster.get(s.id)?.slot === slot)?.id : undefined;
  const name = p ? esc(p.name) + (p.id === cur?.me ? "（你）" : "") : goneId ? `${esc(roster.get(goneId)!.name)}（已离开）` : "—";
  const off = p && !p.connected ? `<span class="state off">掉线中</span>` : "";
  const pct = `<b class="pct" id="pct${slot}">0%</b>`;
  return slot === 1
    ? `<div class="hp p1"><span class="swatch"></span><span class="pname">${name}</span>${off}${pct}</div>`
    : `<div class="hp p2">${pct}${off}<span class="pname">${name}</span><span class="swatch"></span></div>`;
}

function resultHtml(room: RoomInfo, over: OverPayload | null) {
  if (!over) return `<div class="banner"><h2>结算中…</h2></div>`;
  const me = cur?.me;
  const title = over.winnerId === null ? "平局！" : over.winnerId === me ? "你赢了！" : "你输了";
  const cls = over.winnerId === null ? "draw" : over.winnerId === me ? "win" : "lose";
  const reason = over.reason === "opponent_left" ? "对手离开了对局" : "时间到";
  const rows = over.scores
    .map((s) => {
      const p = room.players.find((x) => x.id === s.id) ?? roster.get(s.id);
      const gone = !room.players.some((x) => x.id === s.id);
      const name = (p?.name ?? "对手") + (gone ? "（已离开）" : "");
      return `<div class="srow p${p?.slot ?? 2}"><span class="swatch"></span><span class="pname">${esc(name)}</span><b>${s.pct}%</b><span class="muted">${s.cells} 格</span></div>`;
    })
    .join("");
  return `<div class="banner ${cls}"><p class="muted">${reason}</p><h2>${title}</h2>${rows}${rematchHtml(room)}</div>`;
}

function rematchHtml(room: RoomInfo) {
  const me = cur?.me ?? "";
  const opp = room.players.find((p) => p.id !== me);
  if (!opp) {
    return `<div class="rematch"><p class="muted">对手已离开。把邀请链接发给新朋友，对方加入后会回到大厅。</p>
      <button id="copyLink">复制邀请链接</button></div>`;
  }
  const iVoted = room.rematchVotes.includes(me);
  const oppVoted = room.rematchVotes.includes(opp.id);
  const oppState = !opp.connected ? `<span class="tag off">对手掉线中</span>` : oppVoted ? `<span class="tag ready">对方已准备</span>` : "";
  return `<div class="rematch">
    <button id="rematch" class="primary" ${iVoted ? "disabled" : ""}>${iVoted ? "等待对方…" : "再来一局"}</button>${oppState}
  </div>`;
}

function renderGame(room: RoomInfo) {
  const st = cur!;
  let overlay = "";
  if (room.status === "countdown") overlay = `<div class="num" id="cd"></div><p>第 ${room.round} 局 · 方向键 / WASD 移动</p>`;
  if (room.status === "ended") overlay = resultHtml(room, st.over);

  view.innerHTML = `
    <section class="card game ${room.status}">
      <div class="hud">${hudSide(room, 1)}<div class="timer" id="timer">${Math.round(ROUND_MS / 1000)}</div>${hudSide(room, 2)}</div>
      <div class="bar"><span class="b1" id="bar1"></span><span class="b2" id="bar2"></span></div>
      <div class="board" id="board">
        <canvas></canvas>
        <div class="board-overlay ${overlay ? "show" : ""}">${overlay}</div>
      </div>
      <div class="actions-row">
        <span class="muted hint">方向键 / WASD 移动，走过的格子会染成你的颜色</span>
        <button id="leave" class="ghost">${room.status === "ended" ? "返回首页" : "离开对局"}</button>
      </div>
    </section>`;
  st.game.mount($(".card.game"), room, st.me);
  $<HTMLButtonElement>("#leave").onclick = goHome;
  const rm = document.getElementById("rematch") as HTMLButtonElement | null;
  if (rm) rm.onclick = () => {
    rm.disabled = true;
    socket.emit("rematch");
  };
  const cp = document.getElementById("copyLink") as HTMLButtonElement | null;
  if (cp) cp.onclick = async () => {
    const link = `${location.origin}/r/${room.code}`;
    try {
      await navigator.clipboard.writeText(link);
      cp.textContent = "已复制";
    } catch {
      prompt("复制下面的邀请链接：", link);
    }
  };
  if (room.status === "ended") $("#timer").textContent = "0";
  if (room.status === "countdown") runCountdown(room);
}

function runCountdown(room: RoomInfo) {
  const st = cur!;
  st.countdownEnd = performance.now() + room.phaseRemainingMs;
  const el = $("#cd");
  let last = "";
  const tick = () => {
    const rem = st.countdownEnd - performance.now();
    const txt = rem > 0 ? String(Math.ceil(rem / 1000)) : "开始！";
    if (txt !== last) {
      last = txt;
      if (rem > 0) sfx.count();
      else sfx.go();
      el.textContent = txt;
      el.classList.remove("pop");
      void el.offsetWidth; // 重新触发动画
      el.classList.add("pop");
    }
    if (rem > -500) st.raf = requestAnimationFrame(tick);
  };
  tick();
}
