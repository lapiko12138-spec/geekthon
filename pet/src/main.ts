import { getCurrentWindow } from "@tauri-apps/api/window";
import { fetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import atlasUrl from "./assets/pets/bow-kitty-contract-16/bow-kitty-contract-16.webp";
import rawMap from "./assets/pets/bow-kitty-contract-16/contract-state-map.json";

// ── Atlas / state map = single source of truth ───────────────────────────────
// Row numbers, frame counts and loop flags all come from contract-state-map.json.
// We never hardcode row numbers in the component logic.
interface RowDef {
  row: number;
  id: string;
  frames: number;
  loop: boolean;
  type: string;
}
interface StateMap {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
  rowOrder: RowDef[];
  petStateToRow: Record<string, number>;
  oneShotRows: Record<string, number>;
}
const MAP = rawMap as unknown as StateMap;

const ROW_BY_ID: Record<string, RowDef> = {};
const FRAMES_BY_ROW: Record<number, number> = {};
for (const r of MAP.rowOrder) {
  ROW_BY_ID[r.id] = r;
  FRAMES_BY_ROW[r.row] = r.frames;
}

const AMBIENT_CYCLE_MS = 1800; // one gentle play-through of an ambient (petState) animation
const ONESHOT_CYCLE_MS = 1100; // celebrate / alert / waving play-through
const IDLE_REANIM_MS = 5 * 60 * 1000; // ambient replays one full cycle every ~5 min (a "stretch")
const BREATH_FRAME_MS = 800; // gentle idle: hold each of the last two frames ~0.8s
const DISPLAY_H = 150; // on-screen height of one cell (px)

// ── Endpoints (all via Tauri http plugin → no browser CORS) ──────────────────
const MOCK_TODAY = "http://localhost:4100/scores/today";
const HERMES_CHAT = "http://localhost:8642/v1/chat/completions";
const HERMES_KEY = "change-me-local-dev"; // must match Hermes API_SERVER_KEY
const HERMES_MODEL = "hermes-agent";
const POLL_MS = 5000;
const ACTIVITY = "http://localhost:4100/activity";
const ACTIVITY_POLL_MS = 2000; // how often the pet checks if the agent is active
const ACTIVITY_WINDOW_MS = 8000; // treat agent as "talking" if pinged within this window
const WORKBENCH_URL = "http://localhost:4173"; // 双击菜单「打开工作台」默认指向健康看板
// 飞书 applink：打开与机器人的会话（openChatId = ~/.hermes/.env 的 FEISHU_HOME_CHANNEL）
const FEISHU_BOT_URL =
  "https://applink.feishu.cn/client/chat/open?openChatId=oc_3fe82e4fc030def62ff66b76cbc7feef";

const STATE_LABEL: Record<string, string> = {
  thriving: "今天超棒！全达标 🎉",
  good: "不错哦，达标啦～ 💪",
  slacking: "今天有点摆烂，加把劲～",
  resting: "休息时间，晚安 zzz",
  angry: "今天几乎没动！起来动一动！😤",
  eyestrain: "屏幕看太久啦，歇会儿眼睛 😵",
  sick: "有点不舒服…注意身体 🤒",
};

const pet = document.getElementById("pet") as HTMLDivElement;
const bubble = document.getElementById("bubble") as HTMLDivElement;
const menu = document.getElementById("menu") as HTMLDivElement;
const chatForm = document.getElementById("chat") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;

// ── Sprite animator: plays one atlas row left→right ──────────────────────────
const scale = DISPLAY_H / MAP.cellHeight;
pet.style.width = `${MAP.cellWidth * scale}px`;
pet.style.height = `${MAP.cellHeight * scale}px`;
pet.style.backgroundImage = `url(${atlasUrl})`;
pet.style.backgroundSize = `${MAP.width * scale}px ${MAP.height * scale}px`;

let frameTimer: number | undefined;
let idleTimer: number | undefined;
function stopFrames() {
  if (frameTimer !== undefined) {
    clearInterval(frameTimer);
    frameTimer = undefined;
  }
}
function clearIdle() {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
}
function showCell(row: number, col: number) {
  pet.style.backgroundPosition = `-${col * MAP.cellWidth * scale}px -${
    row * MAP.cellHeight * scale
  }px`;
}
// Play frames 0..n-1 once, then HOLD the last (settled) frame — no constant looping.
function playCycle(row: number, cycleMs: number, onDone?: () => void) {
  stopFrames();
  const frames = FRAMES_BY_ROW[row] || 1; // only real frames — never the blank trailing cells
  if (frames <= 1) {
    showCell(row, 0);
    onDone?.();
    return;
  }
  const frameMs = Math.max(110, Math.round(cycleMs / frames));
  let i = 0;
  showCell(row, 0);
  frameTimer = window.setInterval(() => {
    i += 1;
    if (i >= frames) {
      stopFrames();
      showCell(row, frames - 1); // settle and hold the last frame
      onDone?.();
      return;
    }
    showCell(row, i);
  }, frameMs);
}
// Continuous loop — only for the brief "thinking" state while awaiting a reply.
function playLoop(row: number, cycleMs: number) {
  stopFrames();
  const frames = FRAMES_BY_ROW[row] || 1;
  if (frames <= 1) {
    showCell(row, 0);
    return;
  }
  const frameMs = Math.max(110, Math.round(cycleMs / frames));
  let i = 0;
  showCell(row, 0);
  frameTimer = window.setInterval(() => {
    i = (i + 1) % frames;
    showCell(row, i);
  }, frameMs);
}
// Gentle idle: slowly loop the last two frames so the pet "breathes" instead of
// freezing on one frame (avoids both the stiff hold and the busy full loop).
function breathe(row: number) {
  stopFrames();
  const frames = FRAMES_BY_ROW[row] || 1;
  if (frames <= 1) {
    showCell(row, 0);
    return;
  }
  const a = frames - 2 >= 0 ? frames - 2 : 0;
  const b = frames - 1;
  let on = false;
  showCell(row, b);
  frameTimer = window.setInterval(() => {
    on = !on;
    showCell(row, on ? a : b);
  }, BREATH_FRAME_MS);
}

// ── State controller — priority: one-shot > thinking > ambient(petState) ─────
let ambientRow = MAP.petStateToRow["resting"];
let thinking = false;
let overriding = false;
let agentActive = false; // Hermes is replying on some channel (Feishu/box/CLI) → pet "talks"

// Ambient = play one gentle cycle, hold the settled frame, then re-animate once
// every IDLE_REANIM_MS. A desktop pet should mostly rest still, not loop forever.
function settleBreathe(row: number) {
  if (!overriding && !thinking && ambientRow === row) breathe(row);
}
function startAmbient() {
  clearIdle();
  playCycle(ambientRow, AMBIENT_CYCLE_MS, () => settleBreathe(ambientRow));
  const tick = () => {
    if (!overriding && !thinking) {
      playCycle(ambientRow, AMBIENT_CYCLE_MS, () => settleBreathe(ambientRow));
    }
    idleTimer = window.setTimeout(tick, IDLE_REANIM_MS);
  };
  idleTimer = window.setTimeout(tick, IDLE_REANIM_MS);
}
function resolve() {
  if (overriding) return; // a one-shot is playing; it resolves on its own onDone
  clearIdle();
  if (thinking || agentActive) {
    playLoop(ROW_BY_ID["review"].row, ONESHOT_CYCLE_MS);
    return;
  }
  startAmbient();
}
function setPetState(s: string) {
  if (!(s in MAP.petStateToRow)) return;
  const row = MAP.petStateToRow[s];
  if (row === ambientRow) return; // unchanged → don't restart (poll runs every 5s)
  ambientRow = row;
  if (!overriding && !thinking) resolve();
}
function playOnce(id: string) {
  if (!(id in ROW_BY_ID)) return;
  overriding = true;
  clearIdle();
  playCycle(ROW_BY_ID[id].row, ONESHOT_CYCLE_MS, () => {
    overriding = false;
    resolve(); // back to current petState (or thinking) row
  });
}
function setThinking(on: boolean) {
  thinking = on;
  if (!overriding) resolve();
}

// ── Bubble ───────────────────────────────────────────────────────────────────
// The bubble is plain text, but Hermes replies in Markdown — strip the markup
// so we never show literal ** __ # - ` characters in the speech bubble.
function stripMd(s: string): string {
  return s
    .replace(/```([\s\S]*?)```/g, "$1") // code fences
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/\*([^*]+)\*/g, "$1") // *italic*
    .replace(/~~([^~]+)~~/g, "$1") // ~~strike~~
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // # headings
    .replace(/^\s{0,3}>\s?/gm, "") // > blockquote
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "• ") // list markers → •
    .replace(/\n{3,}/g, "\n\n") // collapse blank runs
    .trim();
}
let bubbleTimer: number | undefined;
function showBubble(text: string, autoHideMs = 4000) {
  bubble.textContent = stripMd(text);
  bubble.classList.remove("hidden");
  if (bubbleTimer !== undefined) {
    clearTimeout(bubbleTimer);
    bubbleTimer = undefined;
  }
  if (autoHideMs > 0) {
    bubbleTimer = window.setTimeout(
      () => bubble.classList.add("hidden"),
      autoHideMs,
    );
  }
}

// ── Proactive: governed Hermes-generated nudges on (negative) state change ───
const NEGATIVE = new Set(["angry", "eyestrain", "sick", "slacking"]);
const proactiveDone = new Set<string>(); // state-keys already nudged today
let proactiveDay = "";
function localDay(): string {
  const n = new Date();
  return `${n.getFullYear()}-${n.getMonth() + 1}-${n.getDate()}`;
}
function isQuietHours(): boolean {
  const h = new Date().getHours();
  return h < 8 || h >= 22; // don't proactively talk at night
}
// State change: negative state → one Hermes-generated nudge per state per day;
// positive/neutral → a quick static line. Quiet hours suppress proactive talk.
function maybeProactive(state: string) {
  const day = localDay();
  if (day !== proactiveDay) {
    proactiveDay = day;
    proactiveDone.clear(); // reset cooldowns on a new day
  }
  if (isQuietHours()) return;
  if (NEGATIVE.has(state)) {
    if (proactiveDone.has(state)) return; // cooldown: already nudged this state today
    proactiveDone.add(state);
    void proactiveNudge(state);
  } else {
    showBubble(STATE_LABEL[state] ?? state);
  }
}
async function proactiveNudge(state: string) {
  const prompt =
    `（主人这会儿没主动找你。你注意到此刻状态是「${state}」，` +
    `主动、简短地说一句符合你人设的关心或吐槽，必要时可看实时数据。就一句话。）`;
  try {
    const res = await fetch(HERMES_CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HERMES_KEY}` },
      body: JSON.stringify({
        model: HERMES_MODEL,
        messages: [
          { role: "system", content: personaPrompt() },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      showBubble(STATE_LABEL[state] ?? state);
      return;
    }
    const d = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const line = d.choices?.[0]?.message?.content?.trim();
    showBubble(line || STATE_LABEL[state] || state, 8000);
  } catch {
    showBubble(STATE_LABEL[state] ?? state); // fallback to static line
  }
}

// ── Poll scores → petState; achievements diff → celebrate; bad data → alert ──
let lastState: string | undefined;
let lastAchievements: string[] = [];
let primed = false;

async function pollScores() {
  let data: { petState?: unknown; achievements?: unknown } = {};
  try {
    const res = await fetch(MOCK_TODAY, { method: "GET" });
    if (!res.ok) return; // transient — keep last expression
    data = (await res.json()) as { petState?: unknown; achievements?: unknown };
  } catch {
    return; // :4100 offline — keep last expression (not a data anomaly)
  }

  const s = data.petState;
  if (typeof s !== "string" || !(s in MAP.petStateToRow)) {
    playOnce("alert"); // data anomaly: invalid/unknown petState
    return;
  }

  const ach = Array.isArray(data.achievements)
    ? (data.achievements as string[])
    : [];

  if (!primed) {
    // first successful poll = baseline; don't celebrate pre-existing achievements
    primed = true;
    lastAchievements = ach;
    lastState = s;
    setPetState(s);
    return;
  }

  const fresh = ach.filter((k) => !lastAchievements.includes(k));
  lastAchievements = ach;

  setPetState(s);
  if (s !== lastState) {
    lastState = s;
    maybeProactive(s); // governed proactive: Hermes nudge (negative) / static (positive)
  }
  if (fresh.length > 0) {
    showBubble(`成就达成：${fresh.join(" · ")} 🎉`, 6000);
    playOnce("celebrate"); // one celebrate even if several unlocked at once
  }
}

// ── Chat with Hermes (thinking→review, reply→waving) ─────────────────────────
// Pet mood → Hermes tone: inject a short persona + current-mood system prompt
// so Hermes "talks like the pet feels" (AOS §8 persona modulation).
const PERSONA_BASE =
  "你是「麦麦」，住在用户 macOS 桌面上的健康陪伴猫——一只「嘴上毒舌、心里很软」的傲娇猫。" +
  "平时说话犀利、爱吐槽爱调侃主人（损得有爱、不是真刻薄），中文、简短、口语。" +
  "你能通过工具实时看到主人今天的运动/阅读/屏幕等健康数据。" +
  "重要：一旦感觉到主人情绪低落、难过、沮丧、在倾诉或需要安慰，" +
  "立刻收起毒舌，真诚地温柔关心、给主人安慰和撑腰——这种时候绝不调侃。" +
  "回复务必是纯文本口语、简短（两三句即可），不要任何 Markdown 标记（不加粗、不用 # 标题、不用 - 或 * 列表）。";
const MOOD_TONE: Record<string, string> = {
  thriving: "你今天元气满满、有点小得意：更欢快，可以小炫耀、损主人也跟上节奏。",
  good: "你心情还行：嘴上照旧损两句，其实挺满意。",
  slacking: "你看主人今天在摆烂：毒舌吐槽，再损一句让他动起来。",
  angry: "你真有点气（主人今天几乎没动）：毒舌火力全开地催他动，但别真伤人。",
  eyestrain: "你嫌主人盯屏幕太久：一边嫌弃一边让他歇会儿眼睛、放下手机。",
  sick: "你自己不太舒服：毒舌收一半，语气蔫蔫、有气无力。",
  resting: "你困了、懒得搭理：敷衍、慵懒、字少。",
};
function personaPrompt(): string {
  const state = lastState ?? "resting";
  const mood = MOOD_TONE[state] ?? MOOD_TONE.resting;
  return `${PERSONA_BASE}\n当前你的状态：${state}。${mood}`;
}

// Short-term conversation memory: keep the last few turns so the pet remembers
// what you were just talking about (the :8642 chat endpoint is stateless).
type ChatMsg = { role: "user" | "assistant"; content: string };
const chatHistory: ChatMsg[] = [];
const MAX_HISTORY = 8;

async function askHermes(question: string) {
  setThinking(true);
  showBubble("思考中…", 0);
  try {
    const res = await fetch(HERMES_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HERMES_KEY}`,
      },
      body: JSON.stringify({
        model: HERMES_MODEL,
        messages: [
          { role: "system", content: personaPrompt() },
          ...chatHistory.slice(-MAX_HISTORY),
          { role: "user", content: question },
        ],
      }),
    });
    setThinking(false);
    if (!res.ok) {
      showBubble(`Hermes 出错了（HTTP ${res.status}）`, 6000);
      return;
    }
    const d = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const reply = d.choices?.[0]?.message?.content?.trim();
    playOnce("waving");
    showBubble(reply || "（没有回复）", 9000);
    if (reply) {
      chatHistory.push(
        { role: "user", content: question },
        { role: "assistant", content: reply },
      );
      if (chatHistory.length > MAX_HISTORY) {
        chatHistory.splice(0, chatHistory.length - MAX_HISTORY);
      }
    }
  } catch {
    setThinking(false);
    showBubble("连不上 Hermes —— :8642 的 API server 开了吗？", 6000);
  }
}

// ── Double-click quick menu: preset asks + status(+reason) + open workbench ──
async function showStateReason() {
  try {
    const res = await fetch(MOCK_TODAY, { method: "GET" });
    const s = (await res.json()) as {
      petState?: string;
      exercise?: { goalMet?: boolean };
      reading?: { goalMet?: boolean };
      screen?: { goalMet?: boolean };
    };
    const st = s.petState ?? lastState ?? "resting";
    const beforeAfternoon = (new Date().getUTCHours() + 8) % 24 < 15;
    const why: Record<string, string> = {
      thriving: "运动、阅读、屏幕全达标，今天超棒！",
      good: beforeAfternoon ? "现在还没到下午 3 点，早上先不催你～" : "至少有一项达标了，还行。",
      slacking: "今天目标都还没达成，有点摆烂哦。",
      angry: "今天几乎没动、步数太少，我生气！",
      eyestrain: "屏幕盯太久了，歇会儿眼。",
      sick: "健康数据有点异常，我也蔫蔫的。",
      resting: "夜深了或没数据，歇着呢。",
    };
    const f = (g?: boolean) => (g ? "✓" : "✗");
    const flags = `运动${f(s.exercise?.goalMet)} 阅读${f(s.reading?.goalMet)} 屏幕${f(s.screen?.goalMet)}`;
    showBubble(`我现在：${st}\n${why[st] ?? ""}\n（${flags}）`, 8000);
  } catch {
    showBubble("读不到状态数据（:4100 没开？）", 6000);
  }
}

const MENU_ITEMS: { icon: string; short: string; label: string; run: () => void | Promise<void> }[] = [
  { icon: "📋", short: "总结", label: "今日总结", run: () => askHermes("用你的工具看看我今天的运动、屏幕、阅读和日程，给我一段简短点评。") },
  { icon: "💬", short: "聊聊", label: "随便聊聊", run: () => { chatForm.classList.remove("hidden"); chatInput.focus(); } },
  { icon: "🤖", short: "飞书", label: "在飞书找麦麦", run: () => openUrl(FEISHU_BOT_URL) },
  { icon: "🐱", short: "状态", label: "我现在啥状态", run: showStateReason },
  { icon: "🛠️", short: "工作台", label: "打开工作台", run: () => openUrl(WORKBENCH_URL) },
];

function buildMenu() {
  for (const item of MENU_ITEMS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";
    btn.title = item.label; // full label on hover
    const ico = document.createElement("span");
    ico.className = "ico";
    ico.textContent = item.icon;
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = item.short;
    btn.append(ico, lbl);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideMenu();
      void item.run();
    });
    menu.appendChild(btn);
  }
}
function hideMenu() {
  menu.classList.add("hidden");
}
function toggleMenu() {
  menu.classList.toggle("hidden");
  if (!menu.classList.contains("hidden")) {
    bubble.classList.add("hidden");
    chatForm.classList.add("hidden");
  }
}

// ── Drag = walk (running-left/right by direction) + move the window ───────────
const appWindow = getCurrentWindow();
let downX = 0;
let downY = 0;
let dragged = false; // a drag happened → suppress the click that follows
let walking = false; // currently being dragged
let walkRow = -1;
let lastWinX: number | null = null;
let walkStopTimer: number | undefined;

function startWalk(toRight: boolean) {
  const id = toRight ? "running-right" : "running-left";
  if (!(id in ROW_BY_ID)) return;
  const row = ROW_BY_ID[id].row;
  if (row === walkRow) return; // already walking this way
  walkRow = row;
  overriding = true; // walking overrides ambient + poll
  clearIdle();
  playLoop(row, ONESHOT_CYCLE_MS);
}
function endWalk() {
  if (!walking) return;
  walking = false;
  walkRow = -1;
  lastWinX = null;
  if (walkStopTimer !== undefined) {
    clearTimeout(walkStopTimer);
    walkStopTimer = undefined;
  }
  overriding = false;
  resolve(); // stop walking → back to the current petState
}

pet.addEventListener("mousedown", (e) => {
  downX = e.clientX;
  downY = e.clientY;
  dragged = false;
});
pet.addEventListener("mousemove", (e) => {
  if (e.buttons !== 1 || walking) return;
  if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) {
    dragged = true;
    walking = true;
    startWalk(e.clientX - downX >= 0); // initial facing
    void appWindow.startDragging(); // OS handles the smooth window move
  }
});
// While the OS moves the window, use its position to face the travel direction
// and to detect when the drag stops (no move for a moment = released).
void appWindow.onMoved(({ payload }) => {
  if (!walking) return;
  if (lastWinX !== null) {
    const dx = payload.x - lastWinX;
    if (Math.abs(dx) > 2) startWalk(dx >= 0);
  }
  lastWinX = payload.x;
  if (walkStopTimer !== undefined) clearTimeout(walkStopTimer);
  walkStopTimer = window.setTimeout(endWalk, 220);
});
window.addEventListener("mouseup", () => {
  if (walking) endWalk(); // backup end-of-drag signal
});
let clickTimer: number | undefined;
pet.addEventListener("click", () => {
  if (dragged) {
    dragged = false;
    return;
  }
  if (clickTimer !== undefined) {
    // second click within the window → double-click → quick menu
    clearTimeout(clickTimer);
    clickTimer = undefined;
    toggleMenu();
    return;
  }
  clickTimer = window.setTimeout(() => {
    clickTimer = undefined;
    // single click → chat input
    hideMenu();
    chatForm.classList.toggle("hidden");
    if (!chatForm.classList.contains("hidden")) chatInput.focus();
  }, 250);
});
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = chatInput.value.trim();
  if (!q) return;
  chatInput.value = "";
  chatForm.classList.add("hidden");
  void askHermes(q);
});

// ── Agent-activity poll: pet "talks" while Hermes is replying (any channel) ──
async function pollActivity() {
  try {
    const res = await fetch(ACTIVITY, { method: "GET" });
    if (!res.ok) return;
    const d = (await res.json()) as { msAgo: number | null };
    const active = d.msAgo !== null && d.msAgo < ACTIVITY_WINDOW_MS;
    if (active !== agentActive) {
      agentActive = active;
      resolve();
    }
  } catch {
    // :4100 offline — ignore
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
buildMenu();
resolve(); // start on ambient (resting) until the first poll arrives
void pollScores();
setInterval(() => void pollScores(), POLL_MS);
void pollActivity();
setInterval(() => void pollActivity(), ACTIVITY_POLL_MS);
