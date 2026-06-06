# 桌面 AI 伴侣 — 项目构建计划 (MVP)

> 本文件是项目的**唯一总纲与事实源**。Claude Code 在执行任何任务前，必须先读本文件。
> 数据契约一旦冻结即不可更改；如需变更，必须先改本文件再改代码。

---

## 0. 一句话定义

一个活在 macOS 桌面上、由 **Hermes Agent** 驱动的 AI 桌宠 + 对话框。桌宠状态反映你今天的运动 / 阅读达标情况；对话框里能问 Hermes 你的数据情况。**MVP 阶段数据全部为假数据（mock），不接数据库、不接真实源。**

---

## 1. PRD（当前 MVP 版本）

### 1.1 MVP 只验证两件事
1. **闭环跑通**：mock 分值 → 桌宠按状态换表情。
2. **问答通路**：问 Hermes「我今天动得够吗」，它经 MCP 读到（假）数据后能回答。

### 1.2 本期范围（In Scope）
- macOS 桌面桌宠：**自写极简 Tauri 应用**（透明置顶窗口），形象用 **Codex 生成的「Bow Kitty」16 行精灵图集**。
- 桌宠 7 状态：`thriving / good / slacking / resting / angry / eyestrain / sick`，由 `petState` 驱动（外加成就撒花、数据异常提示）。
- 对话框，后端接 **Hermes Agent**，模型用**云端**（Claude / GPT，tool-call 最稳）。
- Hermes 通过 **MCP** 暴露的两个工具自取数据：`get_today_scores()`、`get_scores_range(start,end)`。
- 数据为 **mock**：MCP server 直接返回假数据。

### 1.3 明确不做（Out of Scope，留待后续）
- 工作台 / 嵌入外部网站（Phase 2）
- 真实数据库（Git 冷库 + SQLite 热库 + indexer）（Phase 2）
- HealthKit / knowledgeC.db / CLI 真实采集器（Phase 3）
- 本地 LLM、WebSocket 实时推送、换皮、达标推送通知（后续）

### 1.4 验收标准（MVP Done 的定义）
1. 手动改 mock 文件里的 `petState`（或改 value 触发规则），桌宠表情随之切换。
2. 对话框问「我今天运动达标了吗」，Hermes 调用 `get_today_scores()` 并据此作答。
3. 全程无任何真实数据接入、无数据库。

---

## 2. 架构与分工

```
[评分服务 / mock]  --> 规则算出契约形状的 scores (petState / achievements)
      |  (本地服务 :4100)
      v
[MCP server] --(暴露 get_today_scores / get_scores_range)--> [Hermes Agent (脑·云端 DeepSeek)]
      |                                                                  |
      |  (桌宠每 5s 轮询 scores)                       (Hermes API :8642 · OpenAI 兼容)
      v                                                                  v
[Tauri 桌宠 (身体)] 按 petState 换精灵表情                [桌宠对话框 → Hermes → 经 MCP 取数作答]
```

| 组件 | 动作 | 说明 |
|---|---|---|
| **桌宠** (自写 Tauri) | **从 0 自写** | 透明置顶窗口；轮询 :4100 按 `petState` 切精灵；点击 → 打 Hermes API :8642 对话。原计划 fork AIRI，因过重弃用 |
| **Hermes Agent** (Nous Research) | **跑 / 配置，不改源码** | 接云端 DeepSeek + 挂 scores MCP + 开 OpenAI 兼容 API server (:8642) |
| **数据 / MCP 层** | **从 0 自写** | mock 评分服务（规则→Scores v2） + stdio MCP server |

**核心原则：判定靠规则，表达靠模型。** `petState` 永远由规则算出；大模型只读数据、翻译成人话，绝不参与状态判定。客观数据走 MCP，不走 Hermes 记忆。

---

## 3. 数据契约（v2 · 变更需先改本节）

> 这是各开发阶段之间的「接缝」。mock 与真实数据只要最终产出形状一致，换数据源时前端零改动。
> v2 变更：新增 `screen` 指标与 `achievements` 成就；`petState` 扩到 7 个（加 `angry`/`eyestrain`/`sick`）。完整说明见 `docs/CONTRACT.md`。

### 3.1 `types/contract.ts`

```typescript
// 全项目唯一事实源:数据形状的机器约束。
// 任何组件(mock生成器 / MCP server / AIRI前端 / 评分服务)产出或消费
// scores 数据,都必须符合此处类型。详细规则见 docs/CONTRACT.md。

/**
 * 桌宠状态。由"评分服务"经固定规则算出,前端只做 状态→动画 的映射,
 * 不自行推导;大模型(Hermes)不参与此判定。
 */
export type PetState =
  | "thriving" | "good" | "resting"               // 正面/中性
  | "slacking" | "angry" | "eyestrain" | "sick";  // 负面：蔫/运动过低/屏幕过度/生病

/** 单项健康度。value 0.0–1.0，越高越健康(达标=1.0)；"越少越好"的指标(屏幕)由评分服务反转。 */
export interface MetricScore {
  /** 0.0–1.0 归一化达标进度 */
  value: number;
  /** 是否达标。规则:value >= 1.0 即为 true */
  goalMet: boolean;
}

/** 某一天的评分快照。这是各阶段之间不变的"接缝"。 */
export interface Scores {
  date: string;             // "YYYY-MM-DD"
  exercise: MetricScore;    // 运动(越多越好)
  reading: MetricScore;     // 阅读(越多越好)
  screen?: MetricScore;     // 屏幕时长(越少越好,已反转为健康度;过渡期可选)
  petState: PetState;
  achievements?: string[];  // 今日成就 key(累计),前端 diff 新增项播庆祝
  updatedAt: string;        // ISO 8601
}
```

### 3.2 `mock/scores.sample.json`

```json
{
  "date": "2026-06-06",
  "exercise": { "value": 0.8, "goalMet": false },
  "reading": { "value": 1.0, "goalMet": true },
  "screen": { "value": 1.0, "goalMet": true },
  "petState": "good",
  "achievements": ["reading_2h"],
  "updatedAt": "2026-06-06T09:00:00Z"
}
```

### 3.3 PetState 状态规则（v2）

判定输入：`exercise`、`reading`、`screen`、是否夜间/无数据、是否健康异常。从上往下，命中即止：

| # | 条件 | petState |
|---|---|---|
| 1 | 健康指标明显异常 | `sick` |
| 2 | 无数据 或 夜间（本地 ≥ 22:00） | `resting` |
| 3 | 运动量过低（默认 `exercise.value < 0.25`，约步数<2000） | `angry` |
| 4 | 屏幕严重超标（默认 `screen.value <= 0.3`，约≥8h） | `eyestrain` |
| 5 | 运动+阅读+屏幕都达标 | `thriving` |
| 6 | 运动或阅读至少一项达标 | `good` |
| 7 | 其余 | `slacking` |

`goalMet = (value >= 1.0)`。阈值（运动目标/屏幕预算/过低线）均可调，写在评分服务里。`screen` 缺省时第 4 条不触发、第 5 条视其达标。

**成就**：`achievements` 累计今日已达成 key（如 `steps_goal`/`workout_done`/`reading_2h`），前端 diff 出新增项各播一次庆祝。
**异常**：健康异常→`sick`（信号源 A 接体征 / B 现有源近似，TBD）；数据异常（坏值）→前端显示"疑惑"并标记，**不是 petState**。

此规则归属「评分服务」（MVP 阶段实现在 mock 生成器内），**不属于前端、不属于 Hermes**。`petState` 不得随机、不得调大模型。

### 3.4 MCP 工具签名（冻结）

| 工具 | 参数 | 返回 |
|---|---|---|
| `get_today_scores` | (无) | 当天的 `Scores` 对象 |
| `get_scores_range` | start, end ("YYYY-MM-DD") | `Scores[]`，按日期升序 |

MVP 阶段这两个工具背后返回 mock 数据；Phase 2 改为查 SQLite，签名不变。给模型的是意图明确的工具，不暴露裸 SQL。

---

## 4. 构建顺序

依赖关系：`T0 → (T1, T2, T3) 可并行 → T4 → T5`

**一次只做一个任务，跑到「验收通过」再开下一个，坏了好定位。**

---

## 5. 任务清单

### T0 · 固化契约
**动作：手动建文件（不需 Claude Code 跑）。** 按第 3 节内容创建三个文件：
- `types/contract.ts`
- `mock/scores.sample.json`
- `docs/CONTRACT.md`（写入 3.3 规则表 + 3.4 工具签名 + 第 2 节核心原则）

**验收**：三文件存在；`tsc --noEmit` 通过。完成后 `git commit -m "freeze contract"`。

---

### T1 · Mock 生成器（数据的假来源）
**给 Claude Code 的话术：**
> 读 `docs/CONTRACT.md` 和 `types/contract.ts`。写一个 Node/TS 本地服务（端口 4100）：
> - `GET /scores/today` → 返回符合 `Scores` 的当天对象
> - `GET /scores/range?start=&end=` → 返回 `Scores[]`
> - `POST /scores/today` → 接收一个 `Scores`，存进内存覆盖当天值（供我手动调状态）
>
> 内存存储即可，无数据库。**`petState` 必须由 `exercise.goalMet` 和 `reading.goalMet` 经 CONTRACT.md 里的固定规则推导，不得随机、不得调大模型；`goalMet = value >= 1.0`。** 附 README 写明怎么用 curl 改数据看状态变化。

**验收**：`curl POST` 改 value/状态后，`GET today` 立刻返回按规则算出的新 `petState`。

---

### T2 · MCP server 桩（Hermes 取数据的接口）
**给 Claude Code 的话术：**
> **先查最新 MCP TypeScript SDK 的写法，按当前版本来。** 用 MCP TS SDK 写一个 stdio MCP server，注册两个工具：
> - `get_today_scores`（无参）→ 内部 fetch `http://localhost:4100/scores/today`，原样返回
> - `get_scores_range`（参数 `start`、`end` 字符串）→ fetch range 接口返回
>
> 工具 description 写清用途和返回形状（让模型知道何时调用）。提供 `mcp.config` 示例片段，便于挂到 Hermes。

**验收**：用 MCP inspector 或命令行能列出这两个工具、成功调用并拿到 T1 的数据。

---

### T3 · Hermes 配置（脑子跑起来，不改源码）
**给 Claude Code 的话术：**
> **先查 Nous Research Hermes Agent 的官方安装与配置文档（以官方 docs 为准，别凭记忆）。** 然后产出：
> 1. 安装步骤
> 2. 把模型后端配成**云端**（Claude 或 GPT）的 `config.yaml` 片段 + `.env` 模板（占位 key）
> 3. 把 T2 的 MCP server 挂载进 Hermes 配置的写法
> 4. 一段验证命令：启动后问「列出你能用的工具」，确认 Hermes 能看到 `get_today_scores`
>
> 全部写进 `hermes/RUN.md`。**不要修改 Hermes 源码。**

**验收**：Hermes 启动后能识别并调用那两个 MCP 工具。

---

### T4 · 桌宠（身体 · 自写 Tauri，已替代原 AIRI 方案）
> 原计划 fork moeru-ai/AIRI，但其体量过重；改为**自写极简 Tauri 应用**（见 `pet/`）。两个接入点：
> 1. **对话后端**：点击桌宠 → 输入框 → 打 Hermes 的 OpenAI 兼容端点 `:8642/v1/chat/completions`（经 Tauri http 插件，规避浏览器 CORS）。
> 2. **状态绑定**：每 5s `GET :4100/scores/today` 取 `petState`，按 `contract-state-map.json` 映射到精灵图集对应行（轮询，不上 WebSocket）。
>
> 另含：成就(achievements diff)撒花、数据异常 alert、待机呼吸、拖动走路。形象 = Codex 生成的 16 行图集。

**验收**：①改 mock 的状态，桌宠几秒内换表情；②点桌宠发消息，回复来自 Hermes。✅ 已达成。

---

### T5 · 端到端联调（拼起来验 MVP）
**给 Claude Code 的话术：**
> 写 `docs/RUN_MVP.md`，给出按依赖顺序启动全部组件的命令（mock 评分服务 → MCP server → Hermes → 桌宠），以及两个验收演示：
> - **演示 A**：`curl` 把当天数据改成双双未达标，说明桌宠变为 `slacking`
> - **演示 B**：桌宠对话框问「我今天运动达标了吗？」，展示 Hermes 调用 `get_today_scores` 并据此回答

**验收（= 整个 MVP 的 Done）**：演示 A、B 都通过，全程零真实数据、零数据库。

---

## 6. 给 Claude Code 的全局纪律

1. **契约不可破**：任何任务产出的数据形状必须严格符合 `types/contract.ts`；前端永远不推导 `petState`，只做 状态→动画 映射；`petState` 由规则算出，绝不调大模型。
2. **客观数据走 MCP，不走记忆**：「今天动了多少」这类事实始终从 MCP 实时查；Hermes 记忆只用于对话里的偏好/背景，不保证、不存客观数据。
3. **外部库/框架的当前用法先查官方最新文档再写**（MCP SDK、Hermes 配置、Tauri），不要凭训练记忆，版本可能已变。

---

## 7. 后续阶段（备忘，不在本期）

- **Phase 2**：上真冷热数据库（Git 冷·真相源 + SQLite 热·派生索引 + indexer + 评分服务），仍灌种子数据；加工作台 + 嵌入外部网站。
- **Phase 3**：真采集器逐条接入——HealthKit（Health Auto Export → private Git 仓库）、屏幕时长（macOS `knowledgeC.db`，需 Full Disk Access）、阅读（CLI）。每个都只是「又一个产出契约形状文件的生产者」。
- **风险前置**：HealthKit→Git、knowledgeC.db 读取这两条链路风险最高。本期不接，但建议同期各花 1–2 小时做抛弃式验证，确认「不是不可能」，别等 Phase 3 才发现拿不到。
