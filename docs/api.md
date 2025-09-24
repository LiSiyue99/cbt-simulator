## 会话与记忆 API（生产用）

说明：以下接口均为后端 Fastify 暴露，默认地址 `http://localhost:3000`。所有时间均为服务器时间，所有文本字段均为 UTF-8。

统一约定
- 身份字段：`visitorInstanceId` 标识一个来访者实例；`sessionId` 标识一次具体会话。
- 聊天消息：前端/后端统一使用 `speaker ∈ {"user","ai"}` 与 `content: string`。
- Chat History 标准化：后台会将结构化数组转换为文本 `"ai: ..."/"user: ..."` 以喂给 LLM。
- 安全：建议在生产启用 API Key 鉴权（可后续补充）。

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
- 若需要在“开始对话”前展示上一周 Activity，可使用下文的“读取最近一次已完成会话”接口。

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

响应体
```json
{ "ok": true }
```

语义
- 将一条对话写入 `sessions.chatHistory`（JSONB 数组）。前端每发/每收一次消息都调用一次。

---

### 3) 结束会话（Finalize Session，含严格校验与重试）
POST `/sessions/{sessionId}/finalize`

请求体（满足 PRD 的三处前端交互）
```json
{
  "assignment": "请记录一周的自动化思维（场景、想法、情绪、证据、反证）"
}
```

响应体（核心产物）
```json
{
  "diary": "<diary>...</diary>",
  "activityJson": "{...}",
  "ltm": {
    "thisweek_focus": "...",
    "discussed_topics": "...",
    "milestones": "...",
    "recurring_patterns": "...",
    "core_belief_evolution": "..."
  }
}
```

后端执行（顺序与数据落点，均带“形式化校验+至多3次重试”）
1. 读取该 `sessionId` 的 `chatHistory`，规范化为 `ai:/user:` 文本
2. 生成当次 `Diary` → 校验必须存在 `<diary>` 标签（失败重试≤3）→ 写入 `sessions.sessionDiary`
3. 生成“下一次会话前的 Activity 报告” → 校验 `<activity>` 为合法 JSON（失败重试≤3）→ 写入 `sessions.preSessionActivity`
4. 基于 Diary + Activity + 旧 LTM 生成“新版 LTM” → 校验 `<longterm_memory>` 下 5 个子标签齐全（失败重试≤3）→ 更新 `visitor_instances.longTermMemory`，并追加到 `long_term_memory_versions`
5. 将 `assignment` 以结构化 JSON 写入 `sessions.homework`

保证
- 即使模型表现不稳定，若三次内有一次满足格式即可落库；若全部失败，则仍落库“保底”值（空位回退为“无”），避免出现空字符串。

前端对接要点（紧贴 PRD）
- 作业输入框：将用户输入的整段文本放到 `assignment` 传入 finalize 接口
- 点击“结束本周对话”：调用 finalize，成功后可立即展示 `diary`；系统同时已生成“下一周的 Activity 报告”并写入当前会话的 `preSessionActivity`
- 点击“开始本周对话”：读取“上一条已完成会话”的 `preSessionActivity` 展示给用户（例如最近一条 `sessions` 的该字段）。

---

### 4) 读取最近一次已完成会话（用于“开始本周对话”前展示）
GET `/sessions/last?visitorInstanceId=xxx`

响应体（建议）
```json
{
  "sessionId": "string",
  "sessionNumber": 2,
  "sessionDiary": "...",
  "preSessionActivity": "{...}",
  "homework": [{"title": "...", "status": "assigned"}]
}
```

说明：可选接口（若尚未启用，请按需开启）。用于前端“开始本周对话”前，拉取上一条会话摘要与 `preSessionActivity`。

---

### 2.5）读取最近一次会话（仅聊天内容，供聊天页自动加载）
GET `/sessions/last?visitorInstanceId=xxx`

响应体
```json
{
  "sessionId": "string",
  "sessionNumber": 2,
  "chatHistory": [
    { "speaker": "user", "content": "...", "timestamp": "..." }
  ]
}
```

说明：仅返回最近一条会话的聊天记录，不包含摘要字段（diary/activity/homework）。

---

### 2.6）读取会话历史列表（分页）
GET `/sessions/list?visitorInstanceId=xxx&page=1&pageSize=20`

响应体
```json
{
  "items": [
    {
      "sessionId": "string",
      "sessionNumber": 3,
      "createdAt": "2025-09-01T10:00:00.000Z",
      "hasDiary": true,
      "hasActivity": false
    }
  ],
  "page": 1,
  "pageSize": 20
}
```

语义：用于“历史对话回看”列表页。需要查看详情时，配合下方详情接口。

---

### 2.7）读取单次会话详情
GET `/sessions/{sessionId}`

响应体
```json
{
  "sessionId": "string",
  "sessionNumber": 3,
  "chatHistory": [ { "speaker": "user", "content": "...", "timestamp": "..." } ],
  "sessionDiary": "<diary>...</diary>",
  "preSessionActivity": { "summary": "..." },
  "homework": [ { "title": "...", "status": "assigned" } ]
}
```

语义：用于历史详情回看页面。

---

### 5) 三联表（Thought Records）

用于人类用户在点击“结束本周对话”后填写三联表。

创建
POST `/thought-records`

请求体
```json
{
  "sessionId": "string",
  "triggeringEvent": "string",
  "thoughtsAndBeliefs": "string",
  "consequences": "string"
}
```

响应体
```json
{ "id": "string" }
```

查询（回显/编辑）
GET `/thought-records?sessionId=xxx`

响应体
```json
{ "items": [ { "id": "...", "sessionId": "...", "triggeringEvent": "...", "thoughtsAndBeliefs": "...", "consequences": "..." } ] }
```

---

### 错误约定
- 4xx：校验不通过，如缺少参数/格式错误
- 404：资源不存在（如无效的 `sessionId`）
- 5xx：服务内部错误（记录日志，返回通用错误提示）

---

### 小结：前端典型调用流
1. Start：`POST /sessions/start` → 拿 `sessionId`
2. Chat：每轮消息 → `POST /sessions/{sessionId}/messages`
3. Finish：`POST /sessions/{sessionId}/finalize`（带作业文本）→ 展示 `diary`；下轮 `Activity` 已就绪
4. Next week：读取最近一条 `sessions.preSessionActivity` → 展示给用户后进入新会话

---

## 角色与授权
- 角色：
  - student：学生
  - assistant_tech：技术助教（与学生一对一绑定，负责问答与反馈）
  - assistant_class：行政助教（按班级查看学生完成情况，只读）
  - admin：管理员
- 授权：所有受保护接口需在请求头携带 `Authorization: Bearer <token>`。

---

## 行政助教接口（需 Bearer 且角色 assistant_class/admin）

### 本班学生列表
GET `/assistant-class/students`

响应体
```json
{ "items": [ { "studentId": "...", "name": "...", "email": "...", "userId": "学号或业务编号" } ] }
```

### 本班学生会话列表（按学生）
GET `/assistant-class/students/{studentId}/sessions`

响应体
```json
{ "items": [ { "sessionId": "...", "sessionNumber": 2, "createdAt": "..." } ] }
```

说明：只读视图，后续可在此基础上实现“作业完成度过低告警”。

---

## 学生提问（按会话归档）

创建问题（学生）
POST `/questions`

请求体
```json
{ "sessionId": "...", "content": "老师，这里如何区分自动化思维和核心信念？" }
```

响应体
```json
{ "id": "..." }
```

按会话查询
GET `/questions?sessionId=...`

响应体
```json
{ "items": [ { "id": "...", "sessionId": "...", "studentId": "...", "content": "...", "status": "open" } ] }
```

---

## 助教反馈（按会话归档）

创建反馈（助教）
POST `/assistant/feedback`

请求体
```json
{ "sessionId": "...", "content": "你的三联表识别很到位，建议下次补充证据反证" }
```

响应体
```json
{ "id": "..." }
```

按会话查询
GET `/assistant/feedback?sessionId=...`

响应体
```json
{ "items": [ { "id": "...", "sessionId": "...", "assistantId": "...", "content": "..." } ] }
```

---

## 管理端

绑定助教-学生-实例
POST `/admin/assign-assistant`

请求体
```json
{ "assistantEmail": "ta@example.edu", "studentEmail": "stu@example.edu", "visitorInstanceId": "..." }
```

响应体
```json
{ "ok": true }
```

---

## 作业与互动汇总

### 学生端作业汇总（按实例）
GET `/assignments/list?visitorInstanceId=...`

响应体
```json
{
  "items": [
    {
      "sessionId": "...",
      "sessionNumber": 3,
      "createdAt": "...",
      "homework": [ { "title": "...", "status": "assigned" } ],
      "thoughtRecordCount": 1,
      "questionCount": 2,
      "feedbackCount": 1
    }
  ]
}
```

说明：
- 需要 Bearer 鉴权；学生仅能访问自己的实例；助教仅能访问绑定范围内实例；管理员可访问全部。

---

## 白名单导入与自动分配流程（运维）

- 文件：CSV，字段（建议）：
  - email,name,userId,role,classId,assignedTechAsst,assignedClassAsst,assignedVisitor,inchargeVisitor(studentCount 可选),status
- 导入脚本：
  - 运行：`tsx src/main/importWhitelist.ts <csv_path>`
  - 动作：
    1) upsert 到 `users`（带 userId/classId/role/status）
    2) 学生：若尚无实例，则按 `assignedVisitor`（或随机 1..10）创建 `visitor_instances`
    3) 若提供 `assignedTechAsst`，自动建立 `assistant_students` 绑定
- 字段映射：
  - CSV.userId → users.userId / whitelist_emails.userId（若 CSV 未提供 userId 而提供 studentNo，则以 studentNo 作为 userId 写入 users.userId）
  - CSV.classId → users.classId / whitelist_emails.classId
  - CSV.assignedVisitor → whitelist_emails.assignedVisitor（导入时用于创建实例）
  - CSV.assignedTechAsst → whitelist_emails.assignedTechAsst（导入时用于绑定 TA）
  - CSV.inchargeVisitor → whitelist_emails.inchargeVisitor（技术助教负责的模板集，JSON）
  - CSV.status → users.status / whitelist_emails.status

说明：实际生产可改为管理面板或定时同步，当前提供脚本便于快速落地与回归测试。

---

## 鉴权说明（JWT + 白名单 + 验证码）

- 登录流程
  1) 请求验证码：POST `/auth/request-code` { email }
  2) 校验验证码并登录：POST `/auth/verify-code` { email, code } → 返回 { token, role }
  3) 前端持久化 token（LocalStorage/Storage），后续请求在 Header 携带：
     - Authorization: Bearer <token>
- Token 有效期：默认 7 天；可通过 `.env` 设置 `JWT_SECRET`。
- 角色约束：
  - student：仅访问自己数据
  - assistant_tech：访问所绑定 `assistant_students` 范围
  - assistant_class：按 `classId` 查看本班学生与会话（只读）
  - admin：全局访问
- 错误约定：
  - 401 unauthorized：缺少或非法 token
  - 403 forbidden：角色或数据范围不匹配

请求示例（携带 token）
```http
GET /assignments/list?visitorInstanceId=xxx HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
```

`/me` 响应示例
```json
{
  "userId": "...",
  "email": "student@example.edu",
  "role": "student",
  "visitorInstanceIds": ["vi_123", "vi_456"]
}
```

说明：
- 当 `role === "student"` 时，额外返回 `visitorInstanceIds: string[]`，用于前端基于实例维度访问数据。
- 其他角色该字段可省略或为 `undefined`（保持向后兼容）。

---

### 学生全量历史（助教查看）
GET `/assistant/students/{studentId}/history`

权限：assistant_tech/admin

响应体
```json
{
  "diary": [ { "sessionNumber": 3, "sessionId": "...", "createdAt": "...", "sessionDiary": "<diary>..." } ],
  "activity": [ { "sessionNumber": 3, "sessionId": "...", "createdAt": "...", "preSessionActivity": { "summary": "..." } } ],
  "homework": [ { "sessionNumber": 3, "sessionId": "...", "createdAt": "...", "homework": [ { "title": "...", "status": "assigned" } ] } ],
  "ltm": [ { "createdAt": "...", "content": { "thisweek_focus": "..." } } ]
}
```

---

## 前端对接清单（按页面）

- dashboard/conversation（学生）
  - 开始：POST `/sessions/start`（student）
  - 聊天：POST `/sessions/{id}/messages`（student）
  - 自动加载上一条：GET `/sessions/last?visitorInstanceId=...`（student）
  - 结束：POST `/sessions/{id}/finalize`（student）

- dashboard/assignments（学生）
  - 汇总：GET `/assignments/list?visitorInstanceId=...`（student）
  - 三联表：POST/GET `/thought-records`（student）
  - 提问：POST/GET `/questions`（student）

- dashboard/conversation-history（助教-技术）
  - 助教负责实例：GET `/assistant/visitors`（assistant_tech）
  - 实例下学生列表：GET `/assistant/students?visitorInstanceId=...`（assistant_tech）
  - 学生会话：GET `/assistant/students/{studentId}/sessions`（assistant_tech）
  - 学生历史：GET `/assistant/students/{studentId}/history`（assistant_tech）
  - 助教反馈：POST/GET `/assistant/feedback`（assistant_tech）

- dashboard/review-assignments（助教-技术）
  - 同上，结合 `/thought-records`、`/questions`、`/assistant/feedback`

- dashboard/class-monitor（助教-行政）
  - 本班学生：GET `/assistant-class/students`（assistant_class）
  - 学生会话：GET `/assistant-class/students/{studentId}/sessions`（assistant_class）

- 登录与状态
  - 请求验证码：POST `/auth/request-code`
  - 登录：POST `/auth/verify-code`
  - 当前用户：GET `/me`

说明：所有受保护接口均需 `Authorization: Bearer <token>`；前端按角色路由保护与数据范围渲染。

---

## 限时规则（北京时间）
- 学生：每自然周周五 24:00 前须完成“当周会话 + 提交三联表”；逾期当周关闭“开始会话”权限，计为未交。
- 技术助教：每自然周周日 24:00 前须对当周学生至少一条反馈；逾期计为未完成。
- 周定义：周一 00:00 ~ 周日 24:00（北京时间）。

/sessions/start 可能的错误
```json
{ "error": "forbidden", "code": "student_locked_for_week", "message": "本周已失去开启对话权限（北京时间）" }
```

---

### 行政助教 - 周合规报告
GET `/assistant-class/compliance?week=YYYY-WW`

权限：assistant_class/admin

响应体
```json
{ "items": [ { "weekKey": "2025-39", "classId": 3, "studentId": "...", "assistantId": "...", "hasSession": 1, "hasThoughtRecordByFri": 0, "hasAnyFeedbackBySun": 1, "locked": 1, "computedAt": "..." } ] }
```

语义：返回当前班级的周度合规快照。若不传 week，则计算并返回当前周。

---

## 运维建议（合规模块）
- 每日定时任务（推荐北京时间 00:30 执行）：
  - 命令：`npm run daily:compliance`
  - 功能：刷新所有班级当前周的合规快照 `weekly_compliance`
- 手动刷新：
  - `npx --yes tsx src/main/refreshCompliance.ts`


