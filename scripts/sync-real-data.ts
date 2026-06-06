// Real-data sync (AOS "Data Sync" connector).
// Reads the already-collected real signals on this Mac and feeds them as RAW
// inputs to the scoring service (:4100), so the desktop pet's petState reflects
// your actual day (steps / screen / reading), not mock values.
//
//   health-dashboard processed JSON  →  steps, screenHr, (workout, healthAnomaly)
//   weread CLI                       →  readingMin
//
// Files are read at runtime; no health PII is stored in this repo.
// Run:  npm run sync      (loops every SYNC_INTERVAL_MS, default 60s)
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const MOCK = process.env.MOCK_URL || "http://localhost:4100/scores/today";
const PROCESSED =
  process.env.HEALTH_DIR || `${process.env.HOME}/Documents/黑客松/data/processed`;
const WEREAD = process.env.WEREAD_BIN || `${process.env.HOME}/.local/bin/weread`;
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? "60000");

async function readJSON(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${PROCESSED}/${name}`, "utf8"));
}

async function readingMinutesToday(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileP(
      WEREAD,
      ["readdata", "summary", "--json", "--compact"],
      { timeout: 15000 },
    );
    const d = JSON.parse(stdout) as { ok?: boolean; data?: { readTimes?: Record<string, number> } };
    if (!d.ok) return undefined;
    const rt = d.data?.readTimes ?? {};
    const ents = Object.entries(rt)
      .map(([ts, sec]) => ({ ts: Number(ts), sec }))
      .sort((a, b) => a.ts - b.ts);
    const last = ents.length ? ents[ents.length - 1] : undefined;
    return last ? Math.round(last.sec / 60) : undefined;
  } catch {
    return undefined; // weread offline/login — keep previous readingMin (mock merges)
  }
}

async function syncOnce(): Promise<void> {
  // clear any dev forceState override so the real rule drives petState
  const payload: Record<string, unknown> = { forceState: null };

  try {
    const s = await readJSON("screen-time-latest.json");
    if (typeof s.totalMinutes === "number") {
      payload.screenHr = Number((s.totalMinutes / 60).toFixed(2));
    }
  } catch {
    // screen file missing — skip (mock keeps previous)
  }

  try {
    const h = await readJSON("today-health-latest.json");
    const m: Record<string, any> = h.metrics ?? {};
    if (typeof m.steps?.value === "number") payload.steps = m.steps.value;
    const ex = m.exerciseTime?.valueMinutes;
    if (typeof ex === "number") payload.workoutDone = ex >= 20;
    const rhr = m.restingHeartRate?.avg ?? m.restingHeartRate?.latest;
    if (typeof rhr === "number") payload.healthAnomaly = rhr > 100 || rhr < 40;
  } catch {
    // health file missing — skip
  }

  const rm = await readingMinutesToday();
  if (rm !== undefined) payload.readingMin = rm;

  try {
    const res = await fetch(MOCK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = (await res.json()) as { petState?: string };
    console.log(
      new Date().toISOString(),
      JSON.stringify(payload),
      "⇒ petState =",
      out.petState,
    );
  } catch (e) {
    console.error("POST :4100 failed:", String(e));
  }
}

console.log(
  `real-data sync → ${MOCK} every ${INTERVAL_MS / 1000}s (reads ${PROCESSED} + weread)`,
);
void syncOnce();
setInterval(() => void syncOnce(), INTERVAL_MS);
