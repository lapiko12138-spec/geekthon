# Mock Scores 服务

端口 **4100**，纯内存，无数据库。重启后数据重置为默认值（exercise=0.5, reading=0.5）。

## 启动

```sh
npx ts-node mock/server.ts
# 或
npm run mock
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/scores/today` | 今天的 `Scores` 对象 |
| GET | `/scores/range?start=YYYY-MM-DD&end=YYYY-MM-DD` | 日期范围内的 `Scores[]`，按日期升序 |
| POST | `/scores/today` | 覆盖今天的 exercise/reading value，petState 自动按规则重算 |

**POST 注意：**
- Body 中的 `petState` 字段会被忽略——服务器始终按规则推导
- `value` 超出 `[0, 1]` 会被自动截断（clamp）
- 只需传需要修改的字段，未传字段保持原值

---

## curl 示例：改数据看状态变化

### 查看当前状态
```sh
curl http://localhost:4100/scores/today | jq
```

### 两项都达标 → petState: thriving
```sh
curl -X POST http://localhost:4100/scores/today \
  -H "Content-Type: application/json" \
  -d '{"exercise":{"value":1.0},"reading":{"value":1.0}}'
```

### 只运动达标 → petState: good
```sh
curl -X POST http://localhost:4100/scores/today \
  -H "Content-Type: application/json" \
  -d '{"exercise":{"value":1.0},"reading":{"value":0.6}}'
```

### 只阅读达标 → petState: good
```sh
curl -X POST http://localhost:4100/scores/today \
  -H "Content-Type: application/json" \
  -d '{"exercise":{"value":0.4},"reading":{"value":1.0}}'
```

### 两项都未达标 → petState: slacking
```sh
curl -X POST http://localhost:4100/scores/today \
  -H "Content-Type: application/json" \
  -d '{"exercise":{"value":0.3},"reading":{"value":0.2}}'
```

### 超出范围的值会被 clamp（1.5 → 1.0，-0.5 → 0.0）
```sh
curl -X POST http://localhost:4100/scores/today \
  -H "Content-Type: application/json" \
  -d '{"exercise":{"value":1.5},"reading":{"value":-0.5}}'
# 结果: exercise.value=1.0 goalMet=true, reading.value=0.0 goalMet=false → good
```

### 查询日期范围
```sh
curl "http://localhost:4100/scores/range?start=2026-06-01&end=2026-06-06" | jq
```

---

## petState 状态规则（来自 docs/CONTRACT.md §3.3）

| 条件（从上往下，命中即止） | petState |
|---|---|
| 夜间（22:00–06:00）或无数据 | `resting` |
| exercise 且 reading 都达标 | `thriving` |
| 二者之一达标 | `good` |
| 二者都未达标 | `slacking` |

`goalMet = value >= 1.0`
