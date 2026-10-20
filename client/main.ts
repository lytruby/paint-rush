import { renderHome } from "./home";
import { socket } from "./net";
import { enterRoom, leaveRoom } from "./room";
import { hideOverlay } from "./ui";

// ---- 路由：只有 / 和 /r/:code ----
function route() {
  hideOverlay();
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,8})\/?$/);
  if (m) enterRoom(m[1].toUpperCase(), navigate);
  else renderHome(navigate);
}

function navigate(path: string) {
  if (location.pathname !== path) history.pushState(null, "", path);
  route();
}

window.addEventListener("popstate", () => {
  leaveRoom();
  route();
});

document.getElementById("logo")!.addEventListener("click", (e) => {
  e.preventDefault();
  leaveRoom();
  navigate("/");
});

// ---- 右上角连接状态 ----
const net = document.getElementById("net")!;
const setNet = (cls: string, txt: string) => {
  net.className = `net ${cls}`;
  net.querySelector(".txt")!.textContent = txt;
};
socket.on("connect", () => setNet("ok", "已连接"));
socket.on("disconnect", () => setNet("bad", "连接中断，正在重连…"));
socket.on("connect_error", () => setNet("bad", "连接失败，正在重试…"));

route();
