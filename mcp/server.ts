import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// stdout is reserved exclusively for the JSON-RPC stream the MCP client parses.
// A single stray write to stdout — ours or a dependency's console.log — corrupts
// the framing and drops the connection. Pin console.log to stderr so it can never
// pollute the protocol. All of our own logging already uses console.error.
console.log = console.error;

const MOCK_BASE = 'http://localhost:4100';

const server = new McpServer({ name: 'scores-mcp', version: '1.0.0' });

// ── tools ─────────────────────────────────────────────────────────────────────

server.registerTool(
  'get_today_scores',
  {
    description:
      "Returns today's Scores snapshot from the data layer. " +
      'Shape: { date: "YYYY-MM-DD", exercise: { value: 0–1, goalMet: bool }, ' +
      'reading: { value: 0–1, goalMet: bool }, ' +
      'petState: "thriving"|"good"|"slacking"|"resting", updatedAt: ISO8601 }. ' +
      "Call this when the user asks about today's exercise or reading progress, " +
      "the pet's current state, or whether daily goals were met.",
    // Read-only: this tool only queries data, never mutates it.
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const res = await fetch(`${MOCK_BASE}/scores/today`);
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `Data source error: HTTP ${res.status}` }],
          isError: true,
        };
      }
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Cannot reach mock server at ${MOCK_BASE}: ${err}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'get_scores_range',
  {
    description:
      'Returns an array of Scores objects for the given date range, sorted ascending by date. ' +
      'Use this for trend analysis, weekly summaries, or questions like "how did I do this week?". ' +
      'Each item has the same shape as get_today_scores.',
    inputSchema: {
      start: z.string().describe('Start date in YYYY-MM-DD format (inclusive)'),
      end: z.string().describe('End date in YYYY-MM-DD format (inclusive)'),
    },
    // Read-only: this tool only queries data, never mutates it.
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ start, end }) => {
    try {
      const url = `${MOCK_BASE}/scores/range?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Data source error: HTTP ${res.status} – ${body}` }],
          isError: true,
        };
      }
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Cannot reach mock server at ${MOCK_BASE}: ${err}` }],
        isError: true,
      };
    }
  },
);

// ── start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Scores MCP server running (stdio)');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
