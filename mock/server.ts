import express, { Request, Response } from 'express';
import type { Scores, PetState, MetricScore } from '../types/contract';

const app = express();
app.use(express.json());

// In-memory store keyed by "YYYY-MM-DD"
const store = new Map<string, Scores>();

// ── helpers ──────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function makeMetric(value: number): MetricScore {
  const v = clamp01(value);
  return { value: v, goalMet: v >= 1.0 };
}

// CONTRACT §3.3 — priority order, first match wins
function derivePetState(exercise: MetricScore, reading: MetricScore): PetState {
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 6) return 'resting';           // nighttime
  if (exercise.goalMet && reading.goalMet) return 'thriving';
  if (exercise.goalMet || reading.goalMet) return 'good';
  return 'slacking';
}

function buildScores(date: string, exVal: number, rdVal: number): Scores {
  const exercise = makeMetric(exVal);
  const reading  = makeMetric(rdVal);
  return {
    date,
    exercise,
    reading,
    petState: derivePetState(exercise, reading),
    updatedAt: new Date().toISOString(),
  };
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

function getOrCreate(date: string): Scores {
  if (!store.has(date)) {
    store.set(date, buildScores(date, 0.5, 0.5));
  }
  return store.get(date)!;
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

// GET /scores/today
app.get('/scores/today', (_req: Request, res: Response) => {
  res.json(getOrCreate(todayStr()));
});

// GET /scores/range?start=YYYY-MM-DD&end=YYYY-MM-DD
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
  res.json(datesInRange(start, end).map(getOrCreate));
});

// POST /scores/today
// Accepts { exercise?: { value: number }, reading?: { value: number } }
// Ignores petState in body — always recomputed by rule.
// Values are clamped to [0, 1] before storage.
app.post('/scores/today', (req: Request, res: Response) => {
  const body = req.body ?? {};
  const date = todayStr();
  const prev = getOrCreate(date);

  const exVal = typeof body?.exercise?.value === 'number'
    ? body.exercise.value
    : prev.exercise.value;
  const rdVal = typeof body?.reading?.value === 'number'
    ? body.reading.value
    : prev.reading.value;

  const updated = buildScores(date, exVal, rdVal);
  store.set(date, updated);
  res.json(updated);
});

// ── start ─────────────────────────────────────────────────────────────────────

const PORT = 4100;
app.listen(PORT, () => {
  console.log(`Mock scores server → http://localhost:${PORT}`);
});
