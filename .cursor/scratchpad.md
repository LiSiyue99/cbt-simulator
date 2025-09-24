Background and Motivation
- Goal: Align database schema with PRD v3.0 for AI Visitor loop (Session → Diary → Activity → Long-Term Memory update), and clarify where Core Persona should live.

Key Challenges and Analysis
- Core Persona placement:
  - If Core Persona is immutable and shared by 10 templates, it should live in `visitor_templates`.
  - If per-user slight adjustments may occur, keep an optional per-instance `corePersonaOverride` (JSONB) storing deltas; effective persona = template.corePersona merged with override.
- PRD data needs:
  - Store Diary per session.
  - Store Activity simulation output tied to the upcoming session.
  - Track Homework as structured data with status.
  - Long-Term Memory is the only evolving state; consider version history for audit/rollback.

High-level Task Breakdown
1) Schema refactor plan (no execution yet)
   - Move canonical `corePersona` to `visitor_templates` (JSONB, not null).
   - Add `chatPrinciple` to `visitor_templates` (TEXT/JSONB) from prompt.
   - In `visitor_instances` remove `corePersona`; add nullable `corePersonaOverride` (JSONB).
   - Keep `longTermMemory` in `visitor_instances` (JSONB, not null).
   - In `sessions`:
     - Keep `chatHistory` (JSONB).
     - Keep `sessionDiary` but allow JSON/Text; ensure not null after pipeline.
     - Replace `assignedHomework` (TEXT) with `homework` (JSONB array with status, dueAt, completedAt).
     - Replace `weeklyActivityReport` with `preSessionActivity` (JSONB) to store Activity output generated before this session.
   - Add `long_term_memory_versions` table for audit (id, visitorInstanceId, content JSONB, createdAt).
   - Indexes: FK indexes on `sessions.visitorInstanceId`; unique on `visitor_templates.name`.
2) Migration steps (to run later with approval)
   - Generate new Drizzle migration.
   - Data backfill: copy existing `visitor_instances.corePersona` into `visitor_templates.corePersona` where templates are known; then drop old column.
   - Transform `assignedHomework` to structured `homework` (best-effort parse or set empty array).
   - Rename/replace `weeklyActivityReport` → `preSessionActivity`.
3) Runtime composition
   - Build a helper to load Full Persona: merge(template.corePersona, instance.corePersonaOverride) + template.chatPrinciple + instance.longTermMemory.

Project Status Board
- [ ] Approve schema refactor plan
- [ ] Implement schema changes in `db/schema.ts`
- [ ] Generate and run migrations
- [ ] Backfill/migrate existing data (if any)
- [ ] Verify Drizzle Studio reflects new schema

Executor's Feedback or Assistance Requests
- Need decision: Do you foresee per-user Core Persona tweaks? If yes, we keep `corePersonaOverride`; if no, we omit it for simplicity.
- Confirm replacing `weeklyActivityReport` with `preSessionActivity` aligns with your Activity output格式。

Lessons
- Keep PRD terms aligned with schema names to reduce cognitive mapping.


---

Background and Motivation (Update)
- New front-end asks: (1) 全量会话历史可浏览；聊天页自动加载“上一条会话的聊天记录”（仅 chat，不返回任何 summary）；(2) 并行教学系统（助教工作台：按“学生→会话”维度浏览、问答与反馈）；(3) 用户与权限：白名单邮箱 + 验证码登录；角色含 student/assistant/admin（teacher 暂缓）。
- Goal: 在不破坏既有会话流水线的前提下，补齐“历史浏览/教学审阅/鉴权与授权”最小可用后端。

Key Challenges and Analysis (Update)
- 聊天页自动加载：`GET /sessions/last?visitorInstanceId=...` 仅返回最近一条会话的 `chatHistory`（以及 `sessionId`/`sessionNumber`），不返回 summary（diary/activity/homework）。
- 助教-学生关联：采用白名单邮箱匹配；支持后续 `/admin/assign-assistant` 管理绑定。
- 教学互动需求：按“学生→会话”组织；无评分，仅文字型反馈；需具备后续加“时间限制（学生提交截止、助教反馈截止）”的可扩展性。

High-level Task Breakdown (Revised Planner Items)
A) 会话历史与聊天页自动加载
- 已有：GET `/sessions/list?visitorInstanceId&page&pageSize`（分页历史清单）。
- 新增：GET `/sessions/:sessionId` → 返回 { chatHistory, sessionDiary, preSessionActivity, homework } 详情（供回看）。
- 明确：GET `/sessions/last?visitorInstanceId` → 返回最近一条会话的 { sessionId, sessionNumber, chatHistory }，仅 chat。
- 文档：更新 `docs/api.md` 覆盖以上三项。

B) 教学系统配套接口（按“学生→会话”视图，MVP）
- 助教负责范围：
  - GET `/assistant/visitors` → 当前助教负责的 visitor 实例与学生数。
  - GET `/assistant/students?visitorInstanceId=...` → 学生列表（每个包含最近会话时间、会话次数）。
  - GET `/assistant/students/:studentId/sessions` → 该学生的会话清单（含状态聚合：是否有三联表、是否有助教反馈、是否有学生提问）。
- 学生/助教互动（仅文字，无评分）：
  - 学生提问：POST `/questions`、GET `/questions?sessionId=...`。
  - 助教反馈：POST `/assistant/feedback`、GET `/assistant/feedback?sessionId=...`。
  - 后续可加入截止时间校验逻辑（见下文 schema 设计的 `dueAt` 字段）。

C) 鉴权与授权（白名单 + 验证码）
- 表：
  - `users(id, email [unique], name, role: student|assistant|admin, createdAt, updatedAt)`（已在 schema）
  - `verification_codes(id, email, code, expiresAt, consumedAt, createdAt)`（新增）
  - `whitelist_emails(email [unique], role)`（用户将提供；用于开白名单与角色指定）
  - `assistant_students(id, assistantId, studentId, visitorInstanceId, createdAt)`（已在 schema）
- 接口：
  - POST `/auth/request-code` { email } → 发送验证码（dev: 直接返回 code；prod: 发邮件）。
  - POST `/auth/verify-code` { email, code } → 校验并登录/注册，role 来自 `whitelist_emails`；返回 JWT。
  - GET `/me` → 返回当前用户与绑定信息。
- 授权：
  - 学生：仅可访问自己 `visitorInstanceId` 相关数据。
  - 助教：仅可访问 `assistant_students` 绑定范围内数据；辅助提供上述按“学生→会话”的查询。

D) 数据库 Schema（新增/扩展）
- 新增：
  - `verification_codes`：id, email, code, expiresAt, consumedAt, createdAt。
  - `whitelist_emails`：email(unique), role（假定由用户侧提供数据）。
  - `questions`（学生→助教）：id, sessionId(FK), studentId(FK users), content(TEXT), createdAt, updatedAt, dueAt(NULL 可空), status('open'|'answered'|'closed')。
  - `assistant_feedbacks`（助教→学生）：id, sessionId(FK), assistantId(FK users), content(TEXT), createdAt, updatedAt, dueAt(NULL 可空), status('draft'|'published')。
- 说明：
  - 通过 `dueAt` 保留未来“时间限制”扩展能力（学生必须周五前提交、助教必须周二前反馈）。
  - 不包含评分字段，严格文本反馈。
  - 两表均以 `sessionId` 为核心关联，满足“按学生→会话”检索（通过学生的 `visitorInstanceId` 与 `sessions` 关联）。

E) 文档与联调
- 更新 `docs/api.md`：
  - 新增 `/sessions/:sessionId`、完善 `/sessions/list`、明确 `/sessions/last` 行为（仅 chat）。
  - 新增鉴权 3 个端点与请求/响应示例。
  - 新增教学相关端点（助教范围、学生列表、学生会话、问答与反馈）。
- 回滚与兼容：新端点不破坏现有；`/sessions/last` 保持当前实现语义。

Project Status Board (Revised)
- [ ] 评审会话历史接口设计（list/detail/last-仅chat）
- [ ] 评审教学系统 MVP 接口范围与字段（无评分，按学生→会话）
- [ ] 评审鉴权流（白名单 + 验证码 + role 守卫）
- [ ] 同意后实施：schema 扩展（questions/assistant_feedbacks/verification_codes/whitelist_emails）、路由与服务层实现、文档更新、迁移生成

Executor's Feedback or Assistance Requests (Updated)
- 待确认：
  1) `/assistant/students/:studentId/sessions` 响应是否需要附带每条会话的三种状态聚合字段：`hasThoughtRecord`、`hasStudentQuestion`、`hasAssistantFeedback`（前端可直接渲染）。
  2) `questions` 与 `assistant_feedbacks` 是否需要“多条记录”支持（同一会话可多轮提问与回复）？（建议支持多条，按时间倒序）。
  3) 是否需要 `/admin/assign-assistant` 作为简易绑定接口（POST）在本迭代一并提供？

Lessons (Update)
- 将“聊天页需求”严格限定为“仅返回最近一条聊天记录”，避免与摘要需求混淆。


---

Background and Motivation (Frontend)
- Goal: 基于现有后端 API，搭建生产级 Next.js 前端（学生/技术助教/行政助教三角色），完成鉴权、会话训练、作业互动与教学审阅的最小可用版本，并具备良好可测试性与可扩展性。

Key Challenges and Analysis (Frontend)
- 角色与路由保护：按 student / assistant_tech / assistant_class / admin 隔离页面与数据请求。
- Token 注入与错误处理：统一 HTTP 客户端，处理 401/403、节流与重试、全局提示。
- 数据依赖与装配：学生页面需要 `visitorInstanceId`。当前后端未提供“查询我自己的 visitorInstanceId”端点（/me 仅返回 userId/email/role），需确定获取方式（建议新增端点，或登录后返回）。
- 后端角色命名一致性：`/assignments/list` 中后端判断了 `payload.role === 'assistant'`，与全局角色 `assistant_tech` 不一致，导致技术助教无法调用该端点；需统一为 `assistant_tech`。
- API 对齐：会话流与 PRD 一致；`/sessions/last` 仅返回 chatHistory；历史详情 `/sessions/:sessionId` 已实现。

High-level Task Breakdown (Frontend)
1) 初始化工程与基础设施
   - 新建 Next.js 15 + React 19 + TS 工程；集成 Tailwind v4 与 shadcn/ui。
   - 建立 `services/http.ts`（Token 注入、错误封装、超时、重试）与 `services/api/*` 分层。
   - 建立 `contexts/auth` 与 `components/shared/auth`（路由守卫、基于角色渲染）。
   - 成功标准：能启动本地开发，完成登录态保存/清除，受保护路由能正确跳转。
2) 登录与鉴权
   - 页面：`/login`（请求验证码/提交验证码），登录成功持久化 token 与 role，渲染导航。
   - 成功标准：/me 能正常返回，受保护页能进入；401/403 统一提示与跳转。
3) 学生 - 对话训练（/dashboard/conversation）
   - 自动加载最近一条聊天（`GET /sessions/last`）。
   - 开始会话（`POST /sessions/start`）；对话轮次发送消息（`POST /sessions/{id}/messages`）。
   - 结束会话（`POST /sessions/{id}/finalize`，带 assignment 文本），展示 diary。
   - 成功标准：可完成一轮“开始→聊天→结束→展示日记”，错误态（锁定/格式）有提示。
4) 学生 - 作业互动（/dashboard/assignments）
   - 列表（`GET /assignments/list`）、三联表（`POST/GET /thought-records`）、学生提问（`POST/GET /questions`）。
   - 成功标准：按会话分组展示互动项，提交/回显正常。
5) 助教 - 对话历史与反馈
   - 负责实例（`GET /assistant/visitors`）、实例学生列表（`GET /assistant/students`）、学生会话列表与历史（`GET /assistant/students/:id/sessions|history`）、助教反馈（`POST/GET /assistant/feedback`）。
   - 成功标准：仅能访问绑定范围；能为某会话创建反馈并回显。
6) 行政助教 - 班级监控
   - 学生列表、会话列表、周合规报告（`/assistant-class/*`）。
   - 成功标准：仅本班数据可见；合规报告可选 week 查询。
7) 测试与质量
   - 单元：HTTP 客户端与权限组件；集成：鉴权流/关键页面；e2e：登录→学生会话流。
   - 成功标准：CI 可运行测试；关键流 90%+ 通过率。

Open Questions (Frontend)
1) 学生端如何获得 `visitorInstanceId`？建议：
   - A) 扩展 `/me` 返回用户的 `visitorInstanceId`（常为 1 个）；或
   - B) 提供 `GET /students/me/instance`（后端新增）
2) 是否同意将后端 `/assignments/list` 中 `assistant` 统一改为 `assistant_tech`？
3) 前端是否需要“开发时跳过验证码”的开关（如从 `/auth/verify-code` 一次性拿 token）？

Project Status Board (Frontend)
- [ ] 规划确认（本节）
- [ ] 初始化 Next 工程与 UI 基础设施
- [ ] 实现登录与鉴权
- [ ] 学生-对话训练页（start/messages/finalize/last）
- [ ] 学生-作业互动页（assignments/thought-records/questions）
- [ ] 助教-工作台（visitors/students/sessions/history/feedback）
- [ ] 行政助教-班级监控（students/sessions/compliance）
- [ ] 路由守卫与角色渲染
- [ ] 测试（unit/integration/e2e）与基本 CI

Executor's Feedback or Assistance Requests (Frontend)
- 请确认：
  1) 是否接受新增“获取学生自己的 visitorInstanceId”的后端端点或扩展 /me？
  2) 是否同意修正 `/assignments/list` 的角色判断为 `assistant_tech`？
  3) 允许开发期直接在 `/auth/request-code` 返回验证码并在 UI 提示吗？

Lessons (Frontend)
- 前后端角色字符串必须完全一致，避免隐藏的 403。
- 以 `visitorInstanceId` 作为学生数据入口，需在登录后第一时间拿到。
