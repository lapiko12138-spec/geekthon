import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

// stdout is reserved for the JSON-RPC stream; route stray logs to stderr.
console.log = console.error;

const execFileP = promisify(execFile);

// weread CLI (authed; config in ~/.weread-cli). Override with WEREAD_BIN.
const WEREAD_BIN = process.env.WEREAD_BIN || `${process.env.HOME}/.local/bin/weread`;
// Default weather location (tunable via env). Hermes may also pass coords.
const DEFAULT_LAT = Number(process.env.WEATHER_LAT ?? "39.9042");
const DEFAULT_LON = Number(process.env.WEATHER_LON ?? "116.4074");

const server = new McpServer({ name: "world", version: "1.0.0" });

function jsonText(o: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] };
}
function errText(m: string) {
  return { content: [{ type: "text" as const, text: m }], isError: true };
}

// Real health/screen come from the health-dashboard's processed JSON files
// (already collected on this Mac: Apple Health autosync + frontmost-app screen
// sampler). We read the files directly — robust, and no PII leaves the machine.
const HEALTH_DIR =
  process.env.HEALTH_DIR || `${process.env.HOME}/Documents/黑客松/data/processed`;
async function readProcessed(name: string): Promise<Record<string, unknown>> {
  const txt = await readFile(`${HEALTH_DIR}/${name}`, "utf8");
  return JSON.parse(txt) as Record<string, unknown>;
}

// ── Weather (Open-Meteo · free · no key) ─────────────────────────────────────
const WMO: Record<number, string> = {
  0: "晴", 1: "晴间多云", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇",
  51: "小毛雨", 53: "毛雨", 55: "大毛雨", 56: "冻毛雨", 57: "冻毛雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "米雪",
  80: "阵雨", 81: "强阵雨", 82: "暴阵雨", 85: "阵雪", 86: "强阵雪",
  95: "雷阵雨", 96: "雷雨伴冰雹", 99: "强雷雨冰雹",
};
server.registerTool(
  "get_weather",
  {
    description:
      "获取当前天气与今日高/低温（Open-Meteo 实时）。无参数时用默认位置；可传 latitude、longitude。" +
      "返回 { temperature_c, humidity_pct, wind_kmh, condition, today_high_c, today_low_c }。" +
      "用户问天气、冷不冷、要不要加衣/带伞、适不适合出门/运动时调用。",
    inputSchema: {
      latitude: z.number().optional().describe("纬度，省略则用默认"),
      longitude: z.number().optional().describe("经度，省略则用默认"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ latitude, longitude }) => {
    const lat = latitude ?? DEFAULT_LAT;
    const lon = longitude ?? DEFAULT_LON;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
    try {
      const res = await fetch(url);
      if (!res.ok) return errText(`weather HTTP ${res.status}`);
      const d = (await res.json()) as {
        latitude: number; longitude: number; timezone: string;
        current: { temperature_2m: number; relative_humidity_2m: number; weather_code: number; wind_speed_10m: number };
        daily: { weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[] };
      };
      return jsonText({
        temperature_c: d.current.temperature_2m,
        humidity_pct: d.current.relative_humidity_2m,
        wind_kmh: d.current.wind_speed_10m,
        condition: WMO[d.current.weather_code] ?? `code ${d.current.weather_code}`,
        today_high_c: d.daily.temperature_2m_max[0],
        today_low_c: d.daily.temperature_2m_min[0],
        location: { latitude: d.latitude, longitude: d.longitude, timezone: d.timezone },
      });
    } catch (e) {
      return errText(`weather error: ${String(e)}`);
    }
  },
);

// ── Reading (wraps the authed weread CLI) ────────────────────────────────────
server.registerTool(
  "get_reading_today",
  {
    description:
      "微信读书阅读统计：今日阅读分钟、近 7 天每日分钟、连续阅读天数、读得最久的书。" +
      "用户问读了多久/今天读书了吗/最近在读什么时调用。",
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const { stdout } = await execFileP(
        WEREAD_BIN,
        ["readdata", "summary", "--json", "--compact"],
        { timeout: 20000 },
      );
      const d = JSON.parse(stdout) as {
        ok: boolean;
        error?: { message?: string };
        data?: {
          readTimes?: Record<string, number>;
          readDays?: number;
          readLongest?: { book?: { title?: string; author?: string } }[];
        };
      };
      if (!d.ok) return errText(`weread: ${d.error?.message ?? "未知错误"}`);
      const readTimes = d.data?.readTimes ?? {};
      const entries = Object.entries(readTimes)
        .map(([ts, sec]) => ({ ts: Number(ts), min: Math.round(sec / 60) }))
        .sort((a, b) => a.ts - b.ts);
      const today = entries.length ? entries[entries.length - 1] : undefined;
      const longest = d.data?.readLongest?.[0]?.book;
      return jsonText({
        today_minutes: today?.min ?? 0,
        last7_total_minutes: entries.reduce((s, e) => s + e.min, 0),
        read_days: d.data?.readDays ?? null,
        per_day: entries.map((e) => ({
          date: new Date(e.ts * 1000).toISOString().slice(0, 10),
          minutes: e.min,
        })),
        longest_book: longest ? { title: longest.title, author: longest.author } : null,
      });
    } catch (e) {
      return errText(`weread exec error: ${String(e)}`);
    }
  },
);

// ── Screen time (frontmost-app sampler → processed JSON) ─────────────────────
server.registerTool(
  "get_screen_today",
  {
    description:
      "今日屏幕使用时长（分钟）与占用最多的 App（本机前台采样，实时）。" +
      "用户问看了多久屏幕/在用什么 App/是不是看太久了时调用。",
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const d = (await readProcessed("screen-time-latest.json")) as {
        date?: string; totalMinutes?: number;
        apps?: { appName?: string; durationMinutes?: number }[];
      };
      const apps = Array.isArray(d.apps)
        ? d.apps.slice(0, 5).map((a) => ({ app: a.appName, minutes: a.durationMinutes }))
        : [];
      return jsonText({ date: d.date, total_minutes: d.totalMinutes, top_apps: apps });
    } catch (e) {
      return errText(`screen read error: ${String(e)}`);
    }
  },
);

// ── Health (Apple Health auto-export → processed JSON) ───────────────────────
server.registerTool(
  "get_health_today",
  {
    description:
      "今日健康数据：步数(及目标)、距离、活动能量、运动/站立分钟、心率、静息心率（Apple Health 自动导出）。" +
      "用户问步数/走了多少/运动了吗/心率/今天动得够不够时调用。",
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const d = (await readProcessed("today-health-latest.json")) as {
        date?: string;
        metrics?: Record<string, Record<string, number | null>>;
      };
      const m = d.metrics ?? {};
      const g = (k: string, f: string) => m[k]?.[f] ?? null;
      return jsonText({
        date: d.date,
        steps: g("steps", "value"),
        steps_goal: g("steps", "goal"),
        distance_km: g("walkingRunningDistance", "valueKm"),
        active_energy_kcal: g("activeEnergy", "valueKcal"),
        exercise_minutes: g("exerciseTime", "valueMinutes"),
        stand_minutes: g("standTime", "valueMinutes"),
        heart_rate_avg: g("heartRate", "avg"),
        heart_rate_latest: g("heartRate", "latest"),
        resting_heart_rate: g("restingHeartRate", "avg") ?? g("restingHeartRate", "latest"),
      });
    } catch (e) {
      return errText(`health read error: ${String(e)}`);
    }
  },
);

// ── Calendar (iCloud / CalDAV via the todo-calendar service on :3456) ────────
const CAL_BASE = process.env.CALENDAR_URL || "http://localhost:3456";
async function fetchCalMonth(
  year: number,
  month: number,
): Promise<{ events: { date: string; summary: string; done?: boolean; priority?: string }[]; calName?: string }> {
  const url = `${CAL_BASE}/api/caldav/events?year=${year}&month=${String(month).padStart(2, "0")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`calendar HTTP ${res.status}`);
  return (await res.json()) as {
    events: { date: string; summary: string; done?: boolean; priority?: string }[];
    calName?: string;
  };
}
server.registerTool(
  "get_calendar_today",
  {
    description:
      "今日及近期日历安排（iCloud 日历）。返回今天的事件 + 接下来几天的安排。" +
      "用户问今天有什么安排/接下来要做什么/有没有日程/某天有什么事时调用。",
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth() + 1;
      const d = now.getDate();
      const pad = (n: number) => String(n).padStart(2, "0");
      const todayStr = `${y}-${pad(m)}-${pad(d)}`;
      const cur = await fetchCalMonth(y, m);
      const ny = m === 12 ? y + 1 : y;
      const nm = m === 12 ? 1 : m + 1;
      let nextEvents: { date: string; summary: string }[] = [];
      try {
        nextEvents = (await fetchCalMonth(ny, nm)).events;
      } catch {
        // next month best-effort
      }
      const seen = new Set<string>();
      const all = [...(cur.events ?? []), ...nextEvents].filter((e) => {
        const k = `${e.date}|${e.summary}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const today = all
        .filter((e) => e.date === todayStr)
        .map((e) => ({ summary: e.summary }));
      const upcoming = all
        .filter((e) => e.date > todayStr)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 8)
        .map((e) => ({ date: e.date, summary: e.summary }));
      return jsonText({
        date: todayStr,
        calendar: cur.calName ?? "iCloud",
        today_count: today.length,
        today,
        upcoming,
      });
    } catch (e) {
      return errText(
        `calendar error: ${String(e)} (todo-calendar :3456 在跑吗？iCloud 连了吗？)`,
      );
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("world MCP server running (stdio)");
}
main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
