import type { Dir } from "../shared/protocol";
import { socket } from "./net";

// 方向键 / WASD（使用 e.code，和键盘布局、输入法无关）
const KEYMAP: Record<string, Dir> = {
  ArrowUp: "up", KeyW: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
};

let active = false;
let held: Dir[] = []; // 按住的方向栈：以最后按下且仍按住的为准
let seq = 0; // 单调递增序号，服务器据此去重和丢弃乱序
let lastSent: Dir | null | undefined;

function current(): Dir | null {
  return held.length ? held[held.length - 1] : null;
}

/** 只在方向变化时发送；系统按键重复（e.repeat）不会重复发送 */
function send(force = false) {
  const d = current();
  if (!force && d === lastSent) return;
  lastSent = d;
  socket.emit("input", { seq: ++seq, dir: d });
}

window.addEventListener("keydown", (e) => {
  const d = KEYMAP[e.code];
  if (!active || !d) return;
  e.preventDefault();
  if (e.repeat) return;
  held = held.filter((x) => x !== d);
  held.push(d);
  send();
});

window.addEventListener("keyup", (e) => {
  const d = KEYMAP[e.code];
  if (!active || !d) return;
  held = held.filter((x) => x !== d);
  send();
});

// 切走窗口时松开所有方向，避免角色一直走
window.addEventListener("blur", () => {
  if (!active) return;
  held = [];
  send();
});

/** countdown 时开始记录按键（可以提前按住），playing 时把当前方向强制补发一次 */
export function setInputPhase(status: string) {
  const wasActive = active;
  active = status === "countdown" || status === "playing";
  if (!active) {
    held = [];
    lastSent = undefined;
  } else if (status === "playing") {
    send(true);
  } else if (!wasActive) {
    held = [];
  }
}
