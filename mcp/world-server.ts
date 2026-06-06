import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("world MCP server running (stdio)");
}
main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
