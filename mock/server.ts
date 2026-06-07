import express, { Request, Response, NextFunction } from 'express';
import type { Scores, PetState, MetricScore } from '../types/contract';

const app = express();
app.use(express.json());

// CORS: allow browser/webview clients (desktop pet, dashboard) to poll this
// service. Mock data, so a permissive policy is fine for the MVP.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── Scoring config — the "评分服务" (all thresholds tunable here) ─────────────
const GOAL_STEPS = 8000; //        daily exercise goal (steps)
const GOAL_READING_MIN = 30; //    daily reading goal (minutes)
const SCREEN_BUDGET_HR = 4; //     healthy daily screen budget (hours)
const EXERCISE_LOW = 0.25; //      exercise.value below this → angry (~steps < 2000)
const SCREEN_SEVERE = 0.3; //      screen.value at/below this → eyestrain (heavy overuse)
const READING_2H_MIN = 120; //     reading achievement threshold (minutes)
const NIGHT_START = 22; //         hour ≥ 22 → resting
const NIGHT_END = 6; //            hour < 6  → resting

const PET_STATES: PetState[] = [
  'thriving',
  'good',
  'slacking',
  'resting',
  'angry',
  'eyestrain',
  'sick',
];

// ── Raw daily signals (what real collectors would feed the scorer) ───────────
interface RawDay {
  steps: number;
  readingMin: number;
  screenHr: number;
  workoutDone: boolean;
  healthAnomaly: boolean; // health vitals out of range (source TBD; here a manual flag)
  forceState?: PetState; // DEV-ONLY: directly set petState for demos (bypasses the rule)
}
const DEFAULT_RAW: RawDay = {
  steps: 8000,
  readingMin: 20,
  screenHr: 2,
  workoutDone: false,
  healthAnomaly: false,
};

// In-memory raw store keyed by "YYYY-MM-DD"
const rawStore = new Map<string, RawDay>();

// ── helpers ──────────────────────────────────────────────────────────────────
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
// "More is better" metric: value = progress / goal (capped at 1.0).
function metric(value: number): MetricScore {
  const v = clamp01(value);
  return { value: v, goalMet: v >= 1.0 };
}
// Screen is "less is better": invert raw hours into a healthiness value.
// ≤ budget → 1.0; linearly down to 0 at 2× budget. Higher value = healthier.
function screenMetric(usageHr: number): MetricScore {
  const v =
    usageHr <= SCREEN_BUDGET_HR
      ? 1.0
      : clamp01((2 * SCREEN_BUDGET_HR - usageHr) / SCREEN_BUDGET_HR);
  return { value: v, goalMet: usageHr <= SCREEN_BUDGET_HR };
}
// Beijing-time hour (UTC+8, no DST) — robust regardless of the machine timezone.
function beijingHour(): number {
  return (new Date().getUTCHours() + 8) % 24;
}
const NEG_OK_HOUR = 15; // 下午 3 点前不展示任何负面状态（给一天留出余地）
function isNight(): boolean {
  const h = beijingHour();
  return h >= NIGHT_START || h < NIGHT_END;
}

// CONTRACT §3.3 (v2) — priority order, first match wins.
function derivePetState(
  exercise: MetricScore,
  reading: MetricScore,
  screen: MetricScore,
  healthAnomaly: boolean,
): PetState {
  if (isNight()) return 'resting'; //                          night (non-negative, anytime)
  const allMet = exercise.goalMet && reading.goalMet && screen.goalMet;
  if (allMet) return 'thriving'; //                            best (anytime)
  // 下午 NEG_OK_HOUR 点前：不展示任何负面状态（angry/eyestrain/sick/slacking），最多到 good
  if (beijingHour() < NEG_OK_HOUR) return 'good';
  // NEG_OK_HOUR 之后：完整负面规则（sick > angry > eyestrain > good > slacking）
  if (healthAnomaly) return 'sick';
  if (exercise.value < EXERCISE_LOW) return 'angry';
  if (screen.value <= SCREEN_SEVERE) return 'eyestrain';
  if (exercise.goalMet || reading.goalMet) return 'good';
  return 'slacking';
}

// Cumulative achievements reached today (the pet diffs NEW ones → celebrate).
function computeAchievements(raw: RawDay): string[] {
  const a: string[] = [];
  if (raw.steps >= GOAL_STEPS) a.push('steps_goal');
  if (raw.workoutDone) a.push('workout_done');
  if (raw.readingMin >= GOAL_READING_MIN) a.push('reading_goal');
  if (raw.readingMin >= READING_2H_MIN) a.push('reading_2h');
  return a;
}

function buildScores(date: string, raw: RawDay): Scores {
  const exercise = metric(raw.steps / GOAL_STEPS);
  const reading = metric(raw.readingMin / GOAL_READING_MIN);
  const screen = screenMetric(raw.screenHr);
  const petState =
    raw.forceState && PET_STATES.includes(raw.forceState)
      ? raw.forceState // DEV override
      : derivePetState(exercise, reading, screen, raw.healthAnomaly);
  return {
    date,
    exercise,
    reading,
    screen,
    petState,
    achievements: computeAchievements(raw),
    updatedAt: new Date().toISOString(),
  };
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}
function getRaw(date: string): RawDay {
  if (!rawStore.has(date)) rawStore.set(date, { ...DEFAULT_RAW });
  return rawStore.get(date)!;
}
function scoresFor(date: string): Scores {
  return buildScores(date, getRaw(date));
}

// Timezone-safe date iteration using UTC arithmetic
function datesInRange(start: string, end: string): string[] {
  const result: string[] = [];
  let cur = start;
  while (cur <= end) {
    result.push(cur);
    const [y, m, d] = cur.split('-').map(Number);
    cur = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().split('T')[0];
  }
  return result;
}

// ── routes ────────────────────────────────────────────────────────────────────
app.get('/scores/today', (_req: Request, res: Response) => {
  res.json(scoresFor(todayStr()));
});

app.get('/scores/range', (req: Request, res: Response) => {
  const { start, end } = req.query as { start?: string; end?: string };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!start || !end) {
    res.status(400).json({ error: 'query params start and end are required' });
    return;
  }
  if (!iso.test(start) || !iso.test(end)) {
    res.status(400).json({ error: 'dates must be YYYY-MM-DD' });
    return;
  }
  if (start > end) {
    res.status(400).json({ error: 'start must be <= end' });
    return;
  }
  res.json(datesInRange(start, end).map(scoresFor));
});

// POST /scores/today — feed RAW signals; the scorer recomputes everything.
// Body (all optional, merged onto today's raw):
//   steps, readingMin, screenHr  (numbers)
//   workoutDone, healthAnomaly   (booleans)
//   forceState                   (DEV-only: set petState directly for demos;
//                                 send null to clear the override)
// Any petState/metrics in the body are ignored — the scorer owns them.
app.post('/scores/today', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const date = todayStr();
  const raw = getRaw(date);

  if (typeof body.steps === 'number') raw.steps = Math.max(0, body.steps);
  if (typeof body.readingMin === 'number') {
    raw.readingMin = Math.max(0, body.readingMin);
  }
  if (typeof body.screenHr === 'number') raw.screenHr = Math.max(0, body.screenHr);
  if (typeof body.workoutDone === 'boolean') raw.workoutDone = body.workoutDone;
  if (typeof body.healthAnomaly === 'boolean') {
    raw.healthAnomaly = body.healthAnomaly;
  }
  if (
    typeof body.forceState === 'string' &&
    (PET_STATES as string[]).includes(body.forceState)
  ) {
    raw.forceState = body.forceState as PetState;
  } else if (body.forceState === null) {
    delete raw.forceState; // clear the dev override
  }

  rawStore.set(date, raw);
  res.json(buildScores(date, raw));
});

// ── agent activity signal ────────────────────────────────────────────────────
// Hermes' pre_llm_call hook POSTs here whenever the agent is thinking/replying
// (any channel: Feishu, pet chat box, CLI). The pet polls it and plays a
// "talking" animation while the agent is active.
let lastActiveAt = 0;
app.post("/activity", (_req: Request, res: Response) => {
  lastActiveAt = Date.now();
  res.json({ ok: true });
});
app.get("/activity", (_req: Request, res: Response) => {
  res.json({ msAgo: lastActiveAt ? Date.now() - lastActiveAt : null });
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = 4100;
app.listen(PORT, () => {
  console.log(`Mock scores server (v2) → http://localhost:${PORT}`);
});
