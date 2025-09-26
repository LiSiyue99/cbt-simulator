## 会话与记忆 API（生产用）

说明：以下接口均为后端 Fastify 暴露，默认地址 `http://localhost:3000`。所有时间均为服务器时间，所有文本字段均为 UTF-8。

统一约定
- 身份字段：`visitorInstanceId` 标识一个来访者实例；`sessionId` 标识一次具体会话。
- 聊天消息：前端/后端统一使用 `speaker ∈ {"user","ai"}` 与 `content: string`。
- Chat History 标准化：后台会将结构化数组转换为文本 `"ai: ..."/"user: ..."` 以喂给 LLM。

---

### 1) 开始会话（Start Session）
POST `/sessions/start`

请求体
```json
{
  "visitorInstanceId": "string",
  "auto": true
}
```

响应体
```json
{
  "sessionId": "string",
  "sessionNumber": 3
}
```

语义
- 默认启用“后端自增会话号”，按该实例当前最大 `session_number` 自动 +1。
- 返回 `sessionId` 与实际分配的 `sessionNumber`。随后前端使用该 `sessionId` 追加消息。

---

### 2) 追加一条消息（Append Message）
POST `/sessions/{sessionId}/messages`

请求体
```json
{
  "speaker": "user",
  "content": "我今天有点紧张"
}
```

响应体（增强版）
```json
{
  "ok": true,
  "aiResponse": {
    "speaker": "ai",
    "content": "...",
    "timestamp": "2025-09-24T10:30:00Z"
  }
}
```

语义
- 将一条对话写入 `sessions.chatHistory`（JSONB 数组）。
- 当 `speaker` 为 `"user"` 时，后端自动生成AI回复并同步返回。

---

### 3) 结束会话（Finalize Session，异步生成）
POST `/sessions/{sessionId}/finalize`

请求体
```json
{ "assignment": "..." }
```

响应体
```json
{ "diary": "<diary>..." }
```

行为
1. 写入 `sessionDiary` 与 `homework`，设置 `finalizedAt`。
2. 后台异步生成 `preSessionActivity` 与更新 LTM（同时写入 `long_term_memory_versions`）。

---

### 2.5）读取最近一次会话
GET `/sessions/last?visitorInstanceId=...`

响应体
```json
{ "sessionId": "...", "sessionNumber": 2, "chatHistory": [ ... ], "finalizedAt": "..." }
```

---

### 2.6）会话前准备（回退/补偿用途）
POST `/sessions/{sessionId}/prepare`

响应体
```json
{ "activityJson": "..." }
```

---

### 2.6b）补偿接口：确保上一条会话产物齐备
POST `/sessions/{sessionId}/ensure-outputs`

响应体
```json
{ "ok": true, "regenerated": false, "hasDiary": true, "hasActivity": true, "hasLtm": true }
```

---

### 2.6）读取会话历史列表（分页）
GET `/sessions/list?visitorInstanceId=...&page=1&pageSize=20&includePreview=true`

响应体
```json
{
  "items": [
    { "sessionId": "...", "sessionNumber": 3, "createdAt": "...", "completed": true,
      "messageCount": 15, "hasDiary": true, "hasActivity": false, "hasThoughtRecord": true,
      "lastMessage": { "speaker": "ai", "content": "...", "timestamp": "..." } }
  ],
  "page": 1,
  "pageSize": 20
}
```

---

### 2.7）读取单次会话详情
GET `/sessions/{sessionId}`

响应体
```json
{ "sessionId": "...", "sessionNumber": 3, "chatHistory": [ ... ], "sessionDiary": "...", "preSessionActivity": { ... }, "homework": [ ... ] }
```

---

### 2.8）Dashboard 待办
GET `/dashboard/todos?visitorInstanceId=...`

响应体
```json
{ "items": [ ... ], "summary": { "totalTodos": 3, "urgentTodos": 1, "completedThisWeek": 0, "weeklyProgress": { ... } } }
```

---

## 三联表（Thought Records）

创建：POST `/thought-records`
查询：GET `/thought-records?sessionId=...`

---

## 助教（assistant_tech/admin）

- 负责实例概览：GET `/assistant/visitors`
- 指定实例下学生列表：GET `/assistant/students?visitorInstanceId=...`
- 负责的所有学生：GET `/assistant/all-students`
- 学生会话列表：GET `/assistant/students/{studentId}/sessions`
- 学生历史：GET `/assistant/students/{studentId}/history`
- 仪表板统计：GET `/assistant/dashboard-stats`（返回 `unreadMessages`）
- 未读消息会话：GET `/assistant/unread-message-sessions`
- 待批改三联表：GET `/assistant/pending-thought-records`

### 助教-学生聊天（统一替代 questions/assistant_feedbacks）
- 列表：GET `/assistant/chat?sessionId=...` → `{ items, unreadCount }`
- 发送：POST `/assistant/chat` → `{ id }`
- 标记已读：POST `/assistant/chat/read` → `{ ok: true }`

---

## 行政助教（assistant_class/admin）
- 本班学生：GET `/assistant-class/students`
- 学生会话（只读）：GET `/assistant-class/students/{studentId}/sessions`

---

## Playground（assistant_tech | assistant_class | admin）
- ensure：POST `/playground/ensure`
- 列表：GET `/playground/instances`
- 查看个人实例LTM与历史：GET `/playground/ltm?visitorInstanceId=...`

---

## Admin（管理员）
- 概览：GET `/admin/overview`
- 用户 CRUD：GET/POST/PUT/DELETE `/admin/users`
- 分配：
  - 学生模板：POST `/admin/assignments/assign-template`
  - 设置助教：POST `/admin/assignments/assign-assistant`
  - 批量改派：POST `/admin/assignments/bulk`
- 模板管理（新增）：
  - 列表：GET `/admin/templates` → `{ items: { templateKey, name, brief, corePersona, updatedAt }[] }`
  - 更新：PUT `/admin/templates/{templateKey}` → `{ ok, item }`
- 规则与日历：
  - 时间窗：GET/POST `/admin/policy/time-window`
  - 周级 DDL 解锁：POST `/admin/policy/ddl-override`、GET `/admin/policy/ddl-override`、POST `/admin/policy/ddl-override/batch`、GET `/admin/policy/ddl-override/recent`
  - 会话级 DDL：GET/POST `/admin/policy/session-override`、GET `/admin/policy/session-override/recent`

---

## 备注（清理）
- 旧接口 `/questions` 与 `/assistant/feedback` 已移除，请使用“助教-学生聊天”替代。


