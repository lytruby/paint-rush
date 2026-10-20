export const view = document.getElementById("view")!;
const overlay = document.getElementById("overlay")!;

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  return root.querySelector(sel) as T;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

// ---- 昵称：存在 localStorage，默认随机 ----
const ADJ = ["迅捷的", "快乐的", "勇敢的", "机智的", "闪电", "彩虹", "淡定的", "暴走的"];
const NOUN = ["企鹅", "狐狸", "熊猫", "海豚", "刺猬", "柯基", "水豚", "章鱼"];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export function getName(): string {
  let n = localStorage.getItem("pr_name");
  if (!n) {
    n = pick(ADJ) + pick(NOUN);
    localStorage.setItem("pr_name", n);
  }
  return n;
}

export function setName(n: string) {
  const v = n.trim().slice(0, 12);
  if (v) localStorage.setItem("pr_name", v);
}

// ---- 浮层：房间不存在 / 已满 / 其他错误 ----
export function showOverlay(title: string, msg: string, actions: { label: string; primary?: boolean; onClick: () => void }[]) {
  overlay.innerHTML = `
    <div class="modal">
      <h2>${esc(title)}</h2>
      <p>${esc(msg)}</p>
      <div class="actions">${actions
        .map((a, i) => `<button data-i="${i}" class="${a.primary ? "primary" : ""}">${esc(a.label)}</button>`)
        .join("")}</div>
    </div>`;
  overlay.hidden = false;
  overlay.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.onclick = () => actions[Number(b.dataset.i)].onClick();
  });
}

export function hideOverlay() {
  overlay.hidden = true;
  overlay.innerHTML = "";
}

// ---- 轻提示 ----
let toastTimer = 0;
export function toast(msg: string) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "show";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.className = ""), 2200);
}
