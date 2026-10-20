import type { CreateRoomRes, RoomQueryRes } from "../shared/protocol";
import { $, esc, getName, setName, view } from "./ui";

export const AUTOJOIN_KEY = "pr_autojoin"; // 从首页进入房间时直接加入，不再显示邀请确认卡片

export function renderHome(nav: (path: string) => void) {
  document.title = "抢地盘 Paint Rush";
  view.innerHTML = `
    <section class="hero">
      <h1>60 秒，抢下更多地盘</h1>
      <p class="muted">走过的格子会染成你的颜色，也能把对手的格子抢回来。时间到时，占地多的一方获胜。</p>
    </section>
    <section class="card">
      <label class="field">你的昵称
        <input id="name" maxlength="12" value="${esc(getName())}" autocomplete="off" />
      </label>
      <button id="create" class="primary big">创建房间，邀请好友</button>
      <div class="divider"><span>或者加入好友的房间</span></div>
      <form id="joinForm" class="row">
        <input id="code" placeholder="4 位房间码" maxlength="4" autocomplete="off" />
        <button type="submit">加入</button>
      </form>
      <p class="err" id="homeErr"></p>
    </section>`;

  const nameInput = $<HTMLInputElement>("#name");
  const err = $("#homeErr");
  const saveName = () => setName(nameInput.value);

  $<HTMLButtonElement>("#create").onclick = async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    saveName();
    btn.disabled = true;
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      const { code } = (await res.json()) as CreateRoomRes;
      sessionStorage.setItem(AUTOJOIN_KEY, code);
      nav(`/r/${code}`);
    } catch {
      err.textContent = "创建失败，请检查网络后重试";
      btn.disabled = false;
    }
  };

  $<HTMLFormElement>("#joinForm").onsubmit = async (e) => {
    e.preventDefault();
    saveName();
    const code = $<HTMLInputElement>("#code").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      err.textContent = "请输入 4 位房间码";
      return;
    }
    try {
      const q = (await (await fetch(`/api/rooms/${code}`)).json()) as RoomQueryRes;
      if (!q.exists) err.textContent = `房间 ${code} 不存在，请检查房间码`;
      else if ((q.playerCount ?? 0) >= 2) err.textContent = `房间 ${code} 已满（2/2）`;
      else {
        sessionStorage.setItem(AUTOJOIN_KEY, code);
        nav(`/r/${code}`);
      }
    } catch {
      err.textContent = "网络错误，请重试";
    }
  };
}
