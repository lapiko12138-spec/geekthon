# T3 · Hermes Agent 运行与配置（脑子跑起来，不改源码）

> 目标：把 **Nous Research Hermes Agent** 跑起来，模型后端接**云端 DeepSeek**（OpenAI 兼容），
> 并把 T2 的 `scores` MCP server 挂上，让 Hermes 能调用 `get_today_scores` / `get_scores_range`。
>
> **本任务不修改 Hermes 源码**，只做安装与配置。
> 所有命令/配置均依据官方文档（见文末「来源」），非凭记忆。

---

## 0. 前置：先把数据层跑起来

Hermes 会**自己**以子进程方式拉起 MCP server（见第 3 节），你**不需要**手动启动 `mcp/server.ts`。
但 MCP server 内部要去 `http://localhost:4100` 取数，所以 **mock HTTP 服务必须先开着**：

```sh
# 在 geekthon 项目目录，单独一个终端常驻
npm run mock        # → http://localhost:4100
```

> 没开 :4100 的话，工具能被调用，但会返回 “Cannot reach mock server at http://localhost:4100”。

---

## 1. 安装 Hermes Agent

非 Windows 平台**唯一前置是 Git**；安装脚本会自动装好 uv、Python 3.11、Node v22、ripgrep、ffmpeg。

```sh
# macOS / Linux / WSL2
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

装完**重开一个终端**（或 `source` 你的 shell 配置），确认 `hermes` 命令可用：

```sh
hermes --version
hermes doctor          # 体检：依赖 / 配置是否就绪（可加 --fix 自动修）
```

> 所有配置都落在 `~/.hermes/` 目录：
> - `~/.hermes/config.yaml` —— 非机密配置（模型、MCP server、工具集……）
> - `~/.hermes/.env` —— **机密**（API key 等），**只放这里**

---

## 2. 模型后端配置：云端 DeepSeek（OpenAI 兼容）

DeepSeek 是 Hermes 的一等公民 provider，其 `https://api.deepseek.com` 即 OpenAI 兼容端点。

### 方式 A（推荐 · 交互向导，自动分流写 config.yaml 与 .env）

```sh
hermes setup
# → 选 Quick Setup
# → provider 选 DeepSeek
# → 粘贴 DeepSeek API Key（写入 ~/.hermes/.env）
# → Base URL 填 https://api.deepseek.com
# → 模型选 deepseek-v4-pro
```

### 方式 B（手动写配置文件）

`hermes setup` 走「通用 OpenAI 兼容」端点时，会把 DeepSeek 写成 `provider: openai-api`
（**本机当前就是这种**）。此时 **key 字段是 `OPENAI_API_KEY`，不是 `DEEPSEEK_API_KEY`**。

`~/.hermes/config.yaml`：

```yaml
model:
  provider: openai-api                    # 通用 OpenAI 兼容 provider
  default: deepseek-chat
  base_url: https://api.deepseek.com/v1   # 注意带 /v1
```

`~/.hermes/.env`（**占位 key，别写真 key**；真 key 自己换上、勿提交版本库）：

```dotenv
# DeepSeek key —— provider 为 openai-api 时用这个字段
OPENAI_API_KEY=sk-REPLACE_WITH_YOUR_DEEPSEEK_KEY
```

> **关键：key 字段由 `model.provider` 决定，别填错：**
> - `provider: openai-api`（base_url `…/v1`）→ key 放 **`OPENAI_API_KEY`**（本机当前用法）
> - `provider: deepseek`（一等 provider，base_url `https://api.deepseek.com`）→ key 放 `DEEPSEEK_API_KEY`
>
> 填错字段会导致模型鉴权失败。改完 config.yaml 后可用 `hermes model` 复核当前 provider。

验证模型连通（需 .env 里已是真 key）：

```sh
hermes -z "ping"        # 能返回一句话即模型后端通了
```

---

## 3. 挂载 T2 的 scores MCP server

在 `~/.hermes/config.yaml` 增加 `mcp_servers` 段。
**命令必须用 tsx 二进制 + 绝对路径直跑**——不要用 `npm`/`npx`/`ts-node`
（npm 会把 banner 打进 stdout 污染 JSON-RPC，ts-node 冷启动 11–16s 触发超时，详见 `mcp/README.md`）：

```yaml
mcp_servers:
  scores:
    command: "/Users/zhangjiahui/geekthon/node_modules/.bin/tsx"
    args: ["/Users/zhangjiahui/geekthon/mcp/server.ts"]
    enabled: true
    tools:
      include: []     # 留空 = 暴露该 server 的全部工具
      exclude: []
```

要点：
- 用**绝对路径**，与 Hermes 的工作目录无关，最稳。
- Hermes 启动时发现并注册 MCP 工具，工具名会被加前缀 `mcp_<server>_<tool>`，因此本 server 暴露为：
  - `mcp_scores_get_today_scores`
  - `mcp_scores_get_scores_range`
- 改完 config.yaml 后，在 Hermes 会话内执行 `/reload-mcp` 即可热加载，无需重启。

---

## 4. 验证命令

> 前提：第 0 节的 `npm run mock`（:4100）开着。**①② 不需要真 key；③④ 需要 `.env` 里 `OPENAI_API_KEY` 已是真 key。**

**① 确认 scores MCP server 已挂上、两个工具被发现**（不需要模型/真 key，最直接）
```sh
hermes mcp list          # 应看到 scores 一行，Status ✓ enabled
hermes mcp test scores   # 应 ✓ Connected，并列出 get_today_scores / get_scores_range
```
> 注意：`hermes doctor` 的「Tool Availability」只列**内置 toolset**，**不列 MCP 工具**——
> MCP 是否挂上以 `hermes mcp list` / `hermes mcp test` 为准，别在 doctor 里找。

**② 体检（总体健康，可选）**
```sh
hermes doctor            # Python / 配置 / 连通性
# 若提示 config 版本过旧（v22→v27），运行：hermes config migrate
#   交互式、安全：只补新增的可选项并升版本号（建议先 hermes config check 预览）
```

**③ 确认它真的调用工具取数并据此作答**（`chat -q` 会把工具调用/结果也显示在 transcript 里）
```sh
hermes chat -q "我今天运动达标了吗？"
# 期望：Hermes 调用 mcp_scores_get_today_scores，读到 :4100 的当天数据后回答达标与否。
```

**④ 范围查询（顺带验第二个工具）**
```sh
hermes chat -q "把 2026-06-01 到 2026-06-06 我的运动和阅读情况按天说一下。"
# 期望：调用 mcp_scores_get_scores_range(start=2026-06-01,end=2026-06-06)。
```

**交互式等价做法**：直接 `hermes` 进会话 → `/reload-mcp` → 问「列出你能用的工具」/「我今天运动达标了吗」。

> 改了 mock 数据想让回答变化？另开终端：
> ```sh
> curl -X POST http://localhost:4100/scores/today -H "Content-Type: application/json" \
>   -d '{"exercise":{"value":0.3},"reading":{"value":0.2}}'
> ```
> 再问一次「我今天达标了吗」，Hermes 会取到新值（客观数据走 MCP 实时查，不走记忆）。

---

## 5. 排错速查

| 现象 | 可能原因 / 处理 |
|---|---|
| 工具列表里没有 `mcp_scores_*` | config.yaml 的 `mcp_servers.scores` 没写对 / `enabled: false`；会话内 `/reload-mcp`；`hermes doctor` |
| 工具调用返回 “Cannot reach mock server” | 没开 `npm run mock`（:4100） |
| 模型报鉴权错误 | `~/.hermes/.env` 里 `DEEPSEEK_API_KEY` 还是占位值，换成真 key |
| MCP server 连不上 / 一连就断 | command 必须是 **tsx 绝对路径**，别用 npm/ts-node（banner 污染 stdout / 冷启动超时） |
| 改了路径不生效 | 绝对路径是否正确指向 `node_modules/.bin/tsx` 与 `mcp/server.ts` |

---

## 来源（官方文档，2026-06 核对）

- Hermes 安装：https://hermes-agent.nousresearch.com/docs/getting-started/installation
- Hermes 配置（config.yaml / .env 分工）：https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- Hermes Providers（自定义 OpenAI 兼容 / DeepSeek）：https://hermes-agent.nousresearch.com/docs/integrations/providers
- Hermes MCP 配置参考：https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference
- Hermes 用 MCP 指南：https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes/
- Hermes CLI 命令参考（`-z` / `chat -q` / `--provider` / `-m`）：https://hermes-agent.nousresearch.com/docs/reference/cli-commands
- DeepSeek 官方「接入 Hermes Agent」：https://api-docs.deepseek.com/quick_start/agent_integrations/hermes
