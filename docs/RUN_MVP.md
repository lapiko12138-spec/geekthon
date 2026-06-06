# RUN_MVP — 端到端启动与验收

> 桌面 AI 桌宠 MVP 的总运行说明：按依赖顺序起全部组件，跑两个验收演示。全程 mock 数据、无数据库。

## 组件与端口

| 组件 | 端口 / 方式 | 目录 | 作用 |
|---|---|---|---|
| 评分服务 (mock) | http `:4100` | `mock/` | 规则算出 `Scores` v2（`petState` / `achievements`） |
| scores MCP server | stdio（Hermes 自动拉起） | `mcp/` | 给 Hermes 两个取数工具 |
| Hermes Agent | http `:8642`（OpenAI 兼容） | `~/.hermes` | 脑：云端 DeepSeek + 挂 scores MCP |
| 桌宠 | Tauri 窗口 | `pet/` | 身体：按 `petState` 切精灵 + 点击对话 |

**依赖顺序：评分服务 → Hermes（含 MCP）→ 桌宠。**

## 0. 前置

- 装好 Node / pnpm、Rust（Tauri 需要）、Hermes Agent。
- `~/.hermes/.env` 里：
  - `API_SERVER_ENABLED=true`、`API_SERVER_KEY=change-me-local-dev`
  - 真实 `OPENAI_API_KEY`（DeepSeek 的 key；本机 provider 为 `openai-api`，base_url 指向 DeepSeek）
  - `API_SERVER_CORS_ORIGINS` 含 `http://localhost:1420` 与 `tauri://localhost`
  - 详见 `hermes/RUN.md`
- 依赖：`cd geekthon && npm install`；`cd geekthon/pet && pnpm install`。

## 1. 按序启动（3 个终端）

```sh
# 终端 1 — 评分服务 (:4100)
cd ~/geekthon && npm run mock

# 终端 2 — Hermes（:8642 + 自动拉起 scores MCP）
hermes gateway

# 终端 3 — 桌宠（Tauri 窗口）
cd ~/geekthon/pet && pnpm tauri dev
```

> MCP server 不用手动起——Hermes 按 `~/.hermes/config.yaml` 的 `mcp_servers.scores`（tsx 绝对路径）自动拉起。

## 2. 验收演示 A — 状态切换（闭环）

把当天改成「双双未达标」→ 桌宠变 `slacking`：

```sh
curl -X POST http://localhost:4100/scores/today -H 'Content-Type: application/json' \
  -d '{"steps":4000,"readingMin":10,"screenHr":3}'
```

桌宠每 5s 轮询，~5s 内切到 **slacking**（蔫）。其它真实规则路径（白天）：

```sh
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"steps":9000,"readingMin":40,"screenHr":1}'  # 全达标 → thriving
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"steps":1500}'                              # 运动过低 → angry
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"screenHr":9}'                              # 屏幕超标 → eyestrain
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"healthAnomaly":true}'                      # → sick（夜间也触发）
```

> ⚠️ 夜间（22:00–06:00）规则强制 `resting`，所以白天才会自然看到 angry/eyestrain/thriving 等。
> 任意时间想强制演示某态：`-d '{"forceState":"slacking"}'`（dev 覆盖，`{"forceState":null}` 清除）。

## 3. 验收演示 B — 问答通路

1. **点桌宠** → 冒出输入框 → 问「**我今天运动达标了吗？**」→ 回车。
2. Hermes 经 scores MCP 调 `get_today_scores`，据当天数据在气泡里回答。

命令行等价验证（直接打 Hermes API）：

```sh
curl -s http://localhost:8642/v1/chat/completions \
  -H "Authorization: Bearer change-me-local-dev" -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"我今天运动达标了吗？"}]}' \
  | jq -r '.choices[0].message.content'
```

## 4. 看全部 7 态 + 撒花（dev 菜单）

桌宠每 5s 跟随 :4100。任意状态（夜间也能看，绕过规则）：

```sh
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"forceState":"thriving"}'   # 元气
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"forceState":"angry"}'      # 生气
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"forceState":"eyestrain"}'  # 迷糊
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"forceState":"sick"}'       # 生病
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"workoutDone":true}'        # 撒花(成就)
curl -X POST :4100/scores/today -H 'Content-Type: application/json' -d '{"forceState":null}'         # 清除→回规则
```

拖动：按住麦麦拖 → 走路动画；松手回到当前态。

## 5. 停止

- 终端 1 / 3：`Ctrl+C`。
- Hermes：`hermes gateway stop`。

## 验收清单（= MVP Done）

- [x] **演示 A**：改 mock → 桌宠几秒内换表情
- [x] **演示 B**：问桌宠 → Hermes 调 `get_today_scores` 据实作答
- [x] 全程 mock、零真实数据、零数据库

---

相关文档：数据契约 `docs/CONTRACT.md` · 评分服务 `mock/README.md` · MCP `mcp/README.md` · Hermes `hermes/RUN.md` · 桌宠 `pet/README.md` · 长期架构 `docs/HERMES_AOS.md`
