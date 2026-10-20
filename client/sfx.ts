// 音效：全部用 Web Audio 现场合成，不加载任何音频文件（P1-1）
// 浏览器要求用户交互后才能出声，所以 AudioContext 在第一次按键或点击时才创建
const KEY = "pr_sfx";
let ctx: AudioContext | null = null;
let enabled = localStorage.getItem(KEY) !== "off";

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}
for (const ev of ["keydown", "pointerdown"]) window.addEventListener(ev, () => ac(), { once: true });

/** 一个音：频率、时长、波形、音量，可选滑音终点 */
function tone(freq: number, dur: number, type: OscillatorType = "sine", vol = 0.15, delay = 0, slideTo?: number) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

let lastPaint = 0;
export const sfx = {
  count: () => tone(520, 0.12, "square", 0.08),
  go: () => {
    tone(660, 0.1, "square", 0.08);
    tone(990, 0.22, "square", 0.08, 0.08);
  },
  /** 涂到新格子：短促的"啵"，音高随机微调，限频避免噪音 */
  paint: () => {
    const now = performance.now();
    if (now - lastPaint < 70) return;
    lastPaint = now;
    tone(380 + Math.random() * 120, 0.06, "triangle", 0.07, 0, 700);
  },
  /** 抢到对手的格子：更亮一点 */
  steal: () => {
    const now = performance.now();
    if (now - lastPaint < 70) return;
    lastPaint = now;
    tone(620 + Math.random() * 80, 0.08, "triangle", 0.09, 0, 1100);
  },
  hurry: () => tone(880, 0.05, "sine", 0.06),
  bump: () => tone(140, 0.08, "sawtooth", 0.05),
  result: (kind: "win" | "lose" | "draw") => {
    const seq = kind === "win" ? [523, 659, 784, 1047] : kind === "lose" ? [392, 330, 262] : [440, 440];
    seq.forEach((f, i) => tone(f, 0.18, "square", 0.08, i * 0.13));
  },
  isOn: () => enabled,
  toggle: () => {
    enabled = !enabled;
    localStorage.setItem(KEY, enabled ? "on" : "off");
    if (enabled) sfx.count();
    return enabled;
  },
};
