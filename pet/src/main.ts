import { getCurrentWindow } from "@tauri-apps/api/window";
import { fetch } from "@tauri-apps/plugin-http";
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
  if (thinking) {
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
let bubbleTimer: number | undefined;
function showBubble(text: string, autoHideMs = 4000) {
  bubble.textContent = text;
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
    showBubble(STATE_LABEL[s] ?? s); // auto-bubble on state change
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
  "立刻收起毒舌，真诚地温柔关心、给主人安慰和撑腰——这种时候绝不调侃。";
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
  } catch {
    setThinking(false);
    showBubble("连不上 Hermes —— :8642 的 API server 开了吗？", 6000);
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
pet.addEventListener("click", () => {
  if (dragged) {
    dragged = false;
    return;
  }
  chatForm.classList.toggle("hidden");
  if (!chatForm.classList.contains("hidden")) chatInput.focus();
});
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = chatInput.value.trim();
  if (!q) return;
  chatInput.value = "";
  chatForm.classList.add("hidden");
  void askHermes(q);
});

// ── Boot ─────────────────────────────────────────────────────────────────────
resolve(); // start on ambient (resting) until the first poll arrives
void pollScores();
setInterval(() => void pollScores(), POLL_MS);
