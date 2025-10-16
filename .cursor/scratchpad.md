Background and Motivation

本次需求将“作业（三联/五联/任意表格）”从固定三联表升级为“按班级发包的动态表单作业”，并与会话序号严格对齐：该班第 N 次作业 = 每位学生的第 N 次 session。管理员在 Admin 端新增“作业发布与管理”分区，按班发布作业集（Homework Set），配置表单字段与窗口期；学生在管理员允许的窗口内提交；技术助教在管理员允许的窗口内通过既有“助教-学生聊天”完成批改（无需新增评分页面）。旧“三联表”接口与数据表将被移除，前后端统一迁移到新通用作业机制。

Key Challenges and Analysis

- 映射关系：作业集需与每个班的 sessionNumber 严格对齐（sequenceNumber）。学生 session 的编号仍按“完成的最大编号+1”规则，作业集以 sequenceNumber 标识第几次作业。
- 动态表单：字段支持类型足够通用且简单（全部必填、无需最小长度/选项集），需支持字段的“提示说明/占位文本”。
- 窗口期：与全局"开窗/封窗"策略（timeWindow）解耦，作业集自身具备 studentStartAt/studentDeadline 与 assistantStartAt/assistantDeadline。管理员可直接修改该作业集的 DDL（等价于对该 package 进行时间修改）。
- 批改模型：延续"助教与学生的聊天"作为批改载体，不新增评分/打分 UI。待批改判定逻辑需从"三联表后无助教回复"迁移为"该次作业有提交后，无助教在提交时间之后的聊天"。
- 兼容性改造：彻底移除 `thought_records` 表与相关接口、统计和页面；将所有统计（作业已交、待批改）切换为基于新通用提交。
- 行政助教统计：若现有按班/按周的合规统计未覆盖作业与助教批改，需要补齐"完成率/未交/已批改率/逾期分析"等。

High-level Task Breakdown

1) 数据库与迁移（移除三联表、引入作业集与提交）
   - 成功标准：存在 `homework_sets` 与 `homework_submissions` 两张新表；`thought_records` 被移除；DDL/索引齐备。

2) Admin 后端接口：作业集 CRUD 与 DDL 时间编辑
   - 成功标准：管理员可创建/查询/更新/删除作业集；可随时编辑该 package 的 student/assistant 窗口；带简单权限校验与审计日志。

3) Student 后端接口：提交与查询（按 session ←→ sequenceNumber 映射）
   - 成功标准：在窗口内允许提交动态表单；重复提交策略按"覆盖/单次"之一（初版按单次+可更新）；可按 sessionId 读取自己的提交。

4) Assistant 后端接口与统计：待批改列表/仪表替换逻辑
   - 成功标准：`/assistant/pending-*` 改为基于提交时间与助教聊天的"无回复"判定；仪表盘统计用新数据源。

5) Sessions/Assignments 列表统计替换
   - 成功标准：原 `thoughtRecordCount/hasThoughtRecord` 替换为 `hasSubmission/submissionCount`，返回字段与前端对齐。

6) AssistantClass（行政）统计补齐
   - 成功标准：合规/进度接口包含"作业完成/已批改"维度；可按班/按周聚合；前端页面正确展示。

7) 前端 Services：替换三联表 API 为通用作业 API
   - 成功标准：新增 `homeworkSets.ts/homeworkSubmissions.ts`；移除 `thoughtRecords.ts`；`assignments.ts` 统计字段同步。

8) 前端页面：`dashboard/assignments` 动态表单渲染与窗口状态
   - 成功标准：在开放期展示"去填写"，过期显示"已截止"；渲染管理员设置的字段（全部必填，有占位/说明）；保留既有助教聊天区。

9) 文档同步：`docs/api.md` 与 `web/FRONTEND_API.md`
   - 成功标准：新增/变更端点完整、示例准确，删除旧三联表端点。

10) 测试（TDD）：发包→提交→助教聊天→统计链路
   - 成功标准：核心用例全绿；覆盖窗口校验、映射校验、待批改判定、统计口径。

Design Details

1. 数据模型（Drizzle）

- homework_sets
  - id (text, PK)
  - classId (bigint, not null) 关联 `users.classId` 的班级编号
  - title (varchar)
  - description (text)
  - sequenceNumber (integer, not null) 该班第几次作业（与 sessionNumber 对齐）
  - formFields (jsonb) 数组，元素结构见下
  - studentStartAt (timestamp, not null)
  - studentDeadline (timestamp, not null)
  - assistantStartAt (timestamp, not null)
  - assistantDeadline (timestamp, not null)
  - status (varchar: draft|published|archived) 初版可选
  - createdBy (text, FK users.id)
  - createdAt/updatedAt (timestamp)
  - 索引：classId+sequenceNumber 唯一；按 classId 检索；起止时间查询

- formFields.item 结构（全部必填，无最小长度/选项集，支持提示/占位）：
  - key: string（存储键）
  - label: string（表头/字段名）
  - type: "text" | "textarea" | "number" | "date" | "boolean"（初版足够覆盖常见场景；后续可扩展）
  - placeholder?: string
  - helpText?: string

- homework_submissions
  - id (text, PK)
  - homeworkSetId (text, FK homework_sets.id, onDelete:cascade)
  - sessionId (text, FK sessions.id, onDelete:cascade)
  - studentId (text, FK users.id, onDelete:cascade)
  - formData (jsonb) 记录 { [key]: string|number|boolean|ISODateString }
  - createdAt/updatedAt (timestamp)
  - 索引：sessionId 唯一（每次作业一次提交）；homeworkSetId；studentId

- 删除 thought_records：去除所有引用处。

2. 后端接口（拟）

- Admin（新增）
  - POST /admin/homework/sets
  - GET  /admin/homework/sets?classId=&sequenceNumber?
  - GET  /admin/homework/sets/:id
  - PUT  /admin/homework/sets/:id（允许修改 student/assistant 窗口；等价于对 package 的 DDL 调整）
  - DELETE /admin/homework/sets/:id

- Student（新增）
  - GET  /homework/sets/by-session?sessionId=... → 返回匹配该学生班级、sequence=该 sessionNumber 的作业集（含窗口与字段）
  - POST /homework/submissions { sessionId, homeworkSetId, formData }
  - GET  /homework/submissions?sessionId=... → { item|null }
  - 窗口校验：studentStartAt ≤ now ≤ studentDeadline 方可创建/更新

- Assistant（改造）
  - GET /assistant/pending-homework → 返回"有提交但提交后无助教消息"的会话清单（替代 pending-thought-records）
  - 其它聊天接口保持不变

- Sessions/Assignments（改造）
  - GET /assignments/list：返回每个 session 的 submissionCount/chatCount 等（用 submissions 取代 thought_records）
  - GET /sessions/list：hasSubmission 替换 hasThoughtRecord

- AssistantClass（行政）（改造/补齐）
  - 在既有 `compliance/progress-by-session` 输出中加入 per-session 的 hasSubmission/hasAssistantReplyAfterSubmission 字段与统计。

3. 行为与判定

- 作业与 session 对齐：取学生 `users.classId`，在 `homework_sets` 中查找该班 `sequenceNumber = session.sessionNumber` 的作业集。
- 待批改判定：若 `homework_submissions` 存在，且在 `assistant_chat_messages` 中不存在提交时间之后的助教消息 → 计为待批改。
- 逾期：now > studentDeadline 且无提交；或 now > assistantDeadline 且仍无助教回复。

4. 前端改造

- Services
  - 新增：`web/src/services/api/homeworkSets.ts`、`homeworkSubmissions.ts`
  - 改造：`assignments.ts` 的返回字段（submissionCount / hasSubmission）
  - 移除：`thoughtRecords.ts`

- 页面 `web/src/app/dashboard/assignments/page.tsx`
  - 左侧 session 列表：以 hasSubmission 取代 thoughtRecordCount；仍显示 chatCount。
  - 右侧：根据 `by-session` 返回的 formFields 动态渲染（全部必填）；窗口内显示"提交"按钮，否则只读/禁用并显示"已截止"。
  - 下方"助教互动"聊天区：保留现有实现。

5. 文档与测试

- 文档：更新 `docs/api.md` 与 `web/FRONTEND_API.md`，删除 `/thought-records*` 相关。
- 测试：
  - Admin 创建作业集（指定班级与 sequenceNumber）
  - 学生完成 N 次会话后，提交 N 次作业（窗口内成功，窗口外失败）
  - 助教聊天在提交后发送 → 待批改清单减少
  - 行政统计：完成率/已批改率正确

Project Status Board

- [ ] 更新数据库：移除 thought_records，新增 homework_sets/homework_submissions 表
- [ ] 后端Admin：新增作业集CRUD与DDL窗口接口
- [ ] 后端Student：新增提交与查询接口（按 session 映射 set）
- [x] 后端Assistant：替换"待批改三联表"为"待批改作业提交"，保留聊天（新增 `/assistant/homework/submission`、`/assistant/homework/detail`）
- [ ] 后端Sessions/Assignments：用作业提交统计替换 hasThoughtRecord/计数
- [ ] 后端AssistantClass：合规/进度统计改为基于作业提交与助教聊天
- [ ] 前端Services：移除 thoughtRecords.ts，新增 homeworkSets.ts/homeworkSubmissions.ts
- [ ] 前端页面：重写 dashboard/assignments 为动态表单渲染与窗口状态
- [x] 文档：更新 docs/api.md 与 FRONTEND_API.md（替换三联表端点，补充助教作业接口）
- [ ] 数据与脚本：清理seed/refreshCompliance为新模型，更新统计口径
- [ ] 测试：新增TDD用例覆盖发包→提交→助教聊天→统计链路

Current Status / Progress Tracking

- 模式：Executor 正在实施。
- 已完成：
  - 后端助教端作业接口：`/assistant/homework/submission`、`/assistant/homework/detail`。
  - 文档同步：`docs/api.md`、`web/FRONTEND_API.md`。
  - 前端 services：新增 `getHomeworkSubmission/getHomeworkDetail`。
- 进行中：
  - 将新接口接入助教 UI（`tech-assistant-overview` 跳转至学生详情，学生详情页渲染作业字段+提交值）。

Executor's Feedback or Assistance Requests

- 字段类型初版拟定为：text/textarea/number/date/boolean（全部必填，无选项集）。是否需要文件上传/图片（若需要，需补充上传存储策略）？若暂不需要，将按上述五类落地。
- 逾期策略默认仅用于统计与提示，不阻断助教聊天；如需阻断或灰显入口，请明确。
- 前端助教"学生详情"页面中，是否需要显示"作业集窗口期（studentStartAt/studentDeadline）"与"助教反馈窗口（assistantDeadline）"？目前计划在详情卡片中一并显示。

Lessons

- 现有后端/前端多处直接引用 `thought_records`（计数/待批改/页面表单），迁移需一次性替换，避免双轨并存导致统计口径不一致。

# CBT Simulator – 可用性与并发提升工作台

## Background and Motivation
- 目标：短期内支撑约 80 人并发聊天（单实例或多副本），在上游 LLM（DashScope/Qwen）波动时保持服务可用与可预期的体验。
- 现状：服务端使用 Fastify + Drizzle，聊天走同步请求-响应。AI 调用集中在 `src/client/qwen.ts`，未设置超时/重试/熔断/并发门控，单一提供商；路由层同步等待 LLM 返回；无请求级幂等键。
- 风险：
  - 上游 429/5xx/网络抖动导致单请求失败或长时间挂起；
  - 高峰期触发提供商限流，导致尾部请求级联超时；
  - 前端体验受阻（无流式/无降级），用户感知差；
  - 无内部回退（多提供商/多模型），"备用 API"由前端轮询切换并不可取。

## Key Challenges and Analysis
1) 并发与背压
   - 路由层未对"同时在飞的 LLM 调用"做并发上限与排队；80 并发在一个实例上可能瞬间透传到上游，触发 429。
2) 稳定性
   - 缺少请求超时、指数退避重试（针对可重试的 429/5xx/网络错误）、熔断（持续失败时快速失败并触发降级）。
3) 供给冗余
   - 仅使用 Qwen（DashScope 兼容 API）；无多提供商/多模型回退与健康检查；无权重/轮询策略。
4) 体验
   - 无 SSE/流式返回；长响应期间用户无反馈；失败不区分可重试/不可重试；
5) 正确性
   - `appendMessage` 先写入 user，再调用 LLM；LLM 失败不会落 AI 消息，幂等重试可能造成重复 AI 回复缺少保护；
6) 可观测性
   - 统计/追踪不足（p95 时延、错误率、上游返回码分布、熔断命中率）。

## High-level Task Breakdown
1) 引入提供商无关的 LLM 客户端层（抽象）
   - 成果：`src/client/llm/index.ts` 暴露统一接口（chatComplete），适配 `qwen`, 可选 `openai`/`moonshot` 等，通过环境变量配置可用提供商与权重。
   - 成功标准：保持现有调用点最小改动即可切换；单测覆盖"正常/429/5xx/网络错误"。

2) 请求级稳态控制（超时/重试/抖动/可重试判定）
   - 成果：对单次 LLM 调用设置超时（如 20–25s）、指数退避重试（最多 2–3 次，带抖动），仅对 429/5xx/网络错误重试；
   - 成功标准：在人工注入 429/5xx 时 p95 成功率显著提升，重试上限受控。

3) 并发门控与轻量队列
   - 成果：在进程内引入并发上限（如 16–24）与排队（最大等待时间与队列长度）；溢出快速失败（返回"稍后再试"）；
   - 成功标准：在 80 并发压测时，上游 429 显著下降，总吞吐稳定，尾部延迟可控。

4) 熔断与健康探测
   - 成果：为每个提供商增加熔断器（失败率阈值 + 半开恢复）；定期健康检查与冷却；
   - 成功标准：上游长时间异常期间快速降级，不拖垮请求线程，自动恢复后可平滑切回。

5) 多提供商/多模型回退策略
   - 成果：按权重/优先级路由到主提供商；主失败后快速切换次提供商或次模型；支持"请求拆分与合并"（可选）；
   - 成功标准：主提供商不可用时，用户成功率保持 > 98%。

6) 前端流式与错误体验优化（SSE）
   - 成果：新增 SSE 端点（或保持现有端点但支持流式）；loading 占位及时呈现，错误文案区分可重试与不可重试；
   - 成功标准：用户可见首字节 < 2s（在上游可流式时），失败给出明确提示与自动重试策略（一次）。

7) 幂等与重复保护
   - 成果：`/sessions/{id}/messages` 支持 `idempotencyKey`；后端写 AI 回复前检查最近一次 AI 是否已存在相同 key；
   - 成功标准：网络重试不产生重复 AI 回复或丢失。

8) 速率限制与配额
   - 成果：按用户/IP/会话的软限流（令牌桶/滑动窗口）与拒绝策略；
   - 成功标准：恶意/误触发的突发不会影响整体可用性。

9) 可观测性
   - 成果：指标（p50/p95/p99、错误率、重试次数、熔断计数、队列长度）、结构化日志、采样追踪；
   - 成功标准：Grafana/Logs 能定位失败原因与瓶颈。

10) 压测与回归
   - 成果：k6/Artillery 压测脚本（80 并发），单元/集成测试覆盖关键策略；
   - 成功标准：80 并发下错误率 < 2%，p95 < 6–8s（示例目标，可与产品对齐）。

## Project Status Board
- [ ] 设计并提交 LLM 客户端抽象与配置（含提供商注册表）
- [ ] 为 LLM 调用增加超时/重试（指数退避）
- [ ] 增加并发门控与排队（带上限与快速失败）
- [ ] 接入熔断与健康检查
- [ ] 实现多提供商回退策略（权重/优先/健康）
- [ ] 后端支持 SSE 流式聊天（前端适配）
- [ ] `/sessions/{id}/messages` 增加 `idempotencyKey`
- [ ] 用户/IP 级限流
- [ ] 指标与日志完善（p95、错误率、重试、队列）
- [ ] 压测脚本与门槛（80 并发）

## Cloud Deployment Plan (Aliyun)
目标：将后端与前端部署到阿里云（ECS + RDS/PostgreSQL），绑定自有域名，启用 HTTPS，具备基础可观测与备份，支持后续水平扩展。

### 架构最小可行方案
- 计算：1 台 ECS（Ubuntu 22.04 LTS），部署后端 `cbt-simulator`（Fastify）与前端 `cbt-simulator-front`（Next.js 静态/SSR），使用 Nginx 反向代理与 TLS 终止。
- 数据库：阿里云 RDS for PostgreSQL（专有网络 VPC），开启自动备份，最小规格起步。
- 网络：ECS 与 RDS 位于同一 VPC 子网；RDS 仅允许来自 ECS 安全组的访问；公网仅暴露 80/443。
- 域名与证书：域名 DNS A/AAAA 指向 ECS 公网 IP；Nginx + certbot 申请 Let's Encrypt 证书，强制 HTTPS。
- 运维：pm2 或 systemd 守护 Node 进程；GitHub Actions 进行 CI/CD 自动化部署；阿里云 CloudMonitor 告警。

### 关键参数与环境变量
- `DATABASE_URL`: `postgres://<user>:<password>@<rds_hostname>:5432/<db>?sslmode=require`
- `DASHSCOPE_API_KEY`: Qwen 凭证（保存在服务器环境变量或 Secret Manager）
- 其它：`PORT=3000`、JWT/加密密钥（如有）

### 分步实施（从哪里开始）
1) 选定阿里云地域与创建 VPC/VSwitch（若无则新建），规划网段。
2) 创建 RDS for PostgreSQL：设置计算/存储规格、开启自动备份（PITR 可选），创建数据库与专用用户，配置安全组仅放行 ECS。
3) 本地验证 RDS 连接（临时白名单）并运行迁移：在本地或临时 runner 上执行 Drizzle 迁移以初始化架构。
4) 创建 ECS（Ubuntu 22.04）：绑定到同一 VPC，安全组仅开放 22/80/443；设置 SSH 密钥登录，禁用密码登录。
5) 在 ECS 安装运行时：Node.js LTS、pm2（或 Docker）、git、nginx、certbot。
6) 部署后端：拉取代码，配置 `.env`（仅必要变量），安装依赖，运行迁移（针对 RDS），使用 pm2 启动与开机自启。
7) 部署前端：构建静态产物（或配置 Next.js 运行模式），由 Nginx 提供静态与反向代理到后端 3000 端口。
8) 配置 Nginx 虚拟主机：反向代理、超时、压缩、限速可选；通过 certbot 申请并自动续期证书。
9) 域名 DNS 解析：A/AAAA 记录指向 ECS 公网 IP，验证 HTTP/HTTPS 访问。
10) CI/CD：配置 GitHub Actions，push 到 main 触发 SSH/rsync 或 Artifact 上线，重启 pm2 进程；添加环境分支（可选）。
11) 可观测性：启用 CloudMonitor 指标与告警（CPU、内存、磁盘、带宽、端口存活、HTTP 探针），输出结构化日志；如需，部署 Prometheus/Grafana。
12) 备份/恢复演练：确认 RDS 自动备份策略与保留期；导出冷备；演练单表/整库恢复流程。
13) 安全加固：最小权限账户、fail2ban、定期系统补丁、仅必要端口开放；敏感变量不入仓库。
14) 扩展预案：当并发上升时，前端可 CDN，后端增加 ECS 副本 + SLB 负载均衡；RDS 垂直升级或只读实例分流。

## Current Status / Progress Tracking
- 已完成：现状评估与改造计划初稿。
- 待定：选择 Planner 还是 Executor 进入下一步；确认可用的备选提供商与基础设施（Redis/监控）。

### Migration – RDS (Structure Only)
进行中：收集信息并准备在 RDS 上执行 Drizzle 迁移，仅创建表结构。

所需信息（请提供）
- RDS 内网域名（或内网 IP）与端口（默认 5432）
- 目标数据库名（如 app_db）
- 迁移使用账号（建议业务独立账号，具备 DDL 权限）：用户名与一次性密码
- 连接方式：
  - 方案A：在 ECS 上执行（推荐，内网直连）
  - 方案B：本地通过 SSH 隧道转发至 ECS，再连 RDS 内网

拟执行步骤（获批后执行）
1) 在指定环境（ECS 或本地隧道）设置临时 `.env`：`DATABASE_URL` 指向 RDS。
2) 使用项目内 Drizzle CLI 运行迁移：`npm run drizzle:push` 或等价脚本。
3) 校验：对照 `drizzle/meta/*_snapshot.json` 与 `src/db/schema.ts`，确认表/索引/外键一致；记录迁移版本。
4) 不写入任何业务数据，仅创建结构。

命令准备
- ECS 直连：在 ECS 上执行 `node -v && npm -v`，安装依赖并运行迁移。
- SSH 隧道：`ssh -N -L 5433:<RDS内网域名>:5432 <ecs_user>@<ECS公网IP>`，本地把 `DATABASE_URL` 指向 `localhost:5433`。


## Executor's Feedback or Assistance Requests
1) 备选提供商：是否可以接入任一或多项？（勾选）
   - [ ] OpenAI（`OPENAI_API_KEY`）
   - [ ] Moonshot/Kimi
   - [ ] 继续使用 Qwen（主）并加备份区域/模型（如 `qwen-turbo`）
2) 基础设施：
   - 是否可用 Redis（用于排队/限流/分布式锁）？若暂无，先走进程内方案。
   - 监控/日志栈（Prom/Grafana/ELK）是否已有？没有则先输出本地指标与结构化日志。
3) 体验：前端能否接受 SSE 流式与一次自动重试？
4) 目标阈值：确认 p95 延迟与最大错误率目标（例如 p95 < 8s，错误率 < 2%）。

## Lessons
- 在修改前先读取文件、最小化编辑面。
- 如出现依赖漏洞，先执行 `npm audit` 评估。
- 任何 `git push -f` 操作需提前确认。
- 程序输出包含调试信息便于定位。

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
- New front-end asks: (1) 全量会话历史可浏览；聊天页自动加载"上一条会话的聊天记录"（仅 chat，不返回任何 summary）；(2) 并行教学系统（助教工作台：按"学生→会话"维度浏览、问答与反馈）；(3) 用户与权限：白名单邮箱 + 验证码登录；角色含 student/assistant/admin（teacher 暂缓）。
- Goal: 在不破坏既有会话流水线的前提下，补齐"历史浏览/教学审阅/鉴权与授权"最小可用后端。

Key Challenges and Analysis (Update)
- 聊天页自动加载：`GET /sessions/last?visitorInstanceId=...` 仅返回最近一条会话的 `chatHistory`（以及 `sessionId`/`sessionNumber`），不返回 summary（diary/activity/homework）。
- 助教-学生关联：采用白名单邮箱匹配；支持后续 `/admin/assign-assistant` 管理绑定。
- 教学互动需求：按"学生→会话"组织；无评分，仅文字型反馈；需具备后续加"时间限制（学生提交截止、助教反馈截止）"的可扩展性。

High-level Task Breakdown (Revised Planner Items)
A) 会话历史与聊天页自动加载
- 已有：GET `/sessions/list?visitorInstanceId&page&pageSize`（分页历史清单）。
- 新增：GET `/sessions/:sessionId` → 返回 { chatHistory, sessionDiary, preSessionActivity, homework } 详情（供回看）。
- 明确：GET `/sessions/last?visitorInstanceId` → 返回最近一条会话的 { sessionId, sessionNumber, chatHistory }，仅 chat。
- 文档：更新 `docs/api.md` 覆盖以上三项。

B) 教学系统配套接口（按"学生→会话"视图，MVP）
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
  - 助教：仅可访问 `assistant_students` 绑定范围内数据；辅助提供上述按"学生→会话"的查询。

D) 数据库 Schema（新增/扩展）
- 新增：
  - `verification_codes`：id, email, code, expiresAt, consumedAt, createdAt。
  - `whitelist_emails`：email(unique), role（假定由用户侧提供数据）。
  - `questions`（学生→助教）：id, sessionId(FK), studentId(FK users), content(TEXT), createdAt, updatedAt, dueAt(NULL 可空), status('open'|'answered'|'closed')。
  - `assistant_feedbacks`（助教→学生）：id, sessionId(FK), assistantId(FK users), content(TEXT), createdAt, updatedAt, dueAt(NULL 可空), status('draft'|'published')。
- 说明：
  - 通过 `dueAt` 保留未来"时间限制"扩展能力（学生必须周五前提交、助教必须周二前反馈）。
  - 不包含评分字段，严格文本反馈。
  - 两表均以 `sessionId` 为核心关联，满足"按学生→会话"检索（通过学生的 `visitorInstanceId` 与 `sessions` 关联）。

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
  2) `questions` 与 `assistant_feedbacks` 是否需要"多条记录"支持（同一会话可多轮提问与回复）？（建议支持多条，按时间倒序）。
  3) 是否需要 `/admin/assign-assistant` 作为简易绑定接口（POST）在本迭代一并提供？

Lessons (Update)
- 将"聊天页需求"严格限定为"仅返回最近一条聊天记录"，避免与摘要需求混淆。


---

Background and Motivation (Frontend)
- Goal: 基于现有后端 API，搭建生产级 Next.js 前端（学生/技术助教/行政助教三角色），完成鉴权、会话训练、作业互动与教学审阅的最小可用版本，并具备良好可测试性与可扩展性。

Key Challenges and Analysis (Frontend)
- 角色与路由保护：按 student / assistant_tech / assistant_class / admin 隔离页面与数据请求。
- Token 注入与错误处理：统一 HTTP 客户端，处理 401/403、节流与重试、全局提示。
- 数据依赖与装配：学生页面需要 `visitorInstanceId`。当前后端未提供"查询我自己的 visitorInstanceId"端点（/me 仅返回 userId/email/role），需确定获取方式（建议新增端点，或登录后返回）。
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
   - 成功标准：可完成一轮"开始→聊天→结束→展示日记"，错误态（锁定/格式）有提示。
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
3) 前端是否需要"开发时跳过验证码"的开关（如从 `/auth/verify-code` 一次性拿 token）？

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
  1) 是否接受新增"获取学生自己的 visitorInstanceId"的后端端点或扩展 /me？
  2) 是否同意修正 `/assignments/list` 的角色判断为 `assistant_tech`？
  3) 允许开发期直接在 `/auth/request-code` 返回验证码并在 UI 提示吗？

Lessons (Frontend)
- 前后端角色字符串必须完全一致，避免隐藏的 403。
- 以 `visitorInstanceId` 作为学生数据入口，需在登录后第一时间拿到。

## Planner – 人员分配纠偏（基于 CSV 校准）

Background and Motivation
- 发现 CSV 与系统中"助教负责学生名单"出现错位与扭曲（distortion）。你已修正 CSV（`assigned-output.csv`）。
- 目标：以数据库为准，依据 CSV 的以下两类字段重新校准：
  - 学生（role=student）：按 `assignedVisitor` 的编号（1..10）确保各学生存在且仅存在对应模板的 `visitor_instances`。
  - 技术助教（role=assistant_tech）：按 `inchargeVisitor` 的编号集合（可能多项）确保白名单与运行时权限范围一致；并据此生成/纠正 `assistant_students` 绑定，使每位学生绑定到其 `assignedTechAsst` 指定的助教。

Key Challenges and Analysis
- 历史脏数据：可能存在错误的 `visitor_instances`（模板错位/多余实例）与 `assistant_students` 绑定（错误助教/缺少绑定/重复绑定）。
- 容错输入：CSV 中 `assignedTechAsst` 可能是邮箱或工号；`inchargeVisitor` 为 JSON 字符串（已在导入脚本中 parse）。
- 幂等与安全：纠偏需可重复执行，保持幂等；对将被删除的绑定和实例要谨慎，避免误删有效数据。

High-level Task Breakdown（本轮最小化变更）
1) 对齐 whitelist（已由 importWhitelist.ts 完成）
   - 成功标准：`whitelist_emails` 的 `assignedVisitor`、`inchargeVisitor`、`assignedTechAsst`、`status` 与 CSV 一致。
2) 学生实例纠偏（按 student.assignedVisitor）
   - 为每个学生：
     - 若不存在对应模板实例 → 创建（`visitor_instances`）。
     - 若存在多个实例或模板不符 → 保留目标模板实例，其他模板的实例暂不删除，仅记录告警（保守策略）。
   - 成功标准：每个学生至少有且仅有一个"目标模板实例"；多余实例仅记录，不做物理删除（首轮保守）。
3) 助教绑定纠偏（按 assignedTechAsst）
   - 将学生的"目标模板实例"与其 `assignedTechAsst`（可为邮箱或工号）建立唯一绑定（`assistant_students` 上三唯一约束）。
   - 若存在错误绑定（绑定至错误助教或错误实例）→ 新增正确绑定；错误绑定暂不删除（保守），记录在报告中。
   - 成功标准：每个学生对其目标实例存在至少一个正确的绑定；无重复插入。
4) 技术助教权限范围对齐（inchargeVisitor）
   - 校验技术助教白名单的 `inchargeVisitor` 是否包含其学生所用模板；若不包含，输出告警清单，供后续修订 CSV 或白名单条目（不在本脚本自动改写，以免越权）。
5) 校验与报告
   - 输出：
     - 新创建实例数、新增绑定数
     - 发现的"多余实例"与"错误绑定"列表（仅记录，不删除）
     - 助教模板权限不一致列表（学生模板不在 inchargeVisitor 中）

Success Criteria
- 运行后，任意学生的 `currentVisitor`（首个实例）与 CSV 的 `assignedVisitor` 一致；`/me` 返回的 `assignedVisitorTemplates` 对技术助教可正确反映 `inchargeVisitor`。
- 管理端 `GET /admin/assignments/students` 可看到每个学生存在目标模板实例且至少有一个正确助教绑定。
- 未进行物理删除，风险最小；若需要进一步清理，将另起迭代并有单独审批。

Execution Plan
- 新增 `src/main/reconcileAssignments.ts`：
  - 读取 CSV（路径参数），解析为记录集。
  - 对每个学生：确保目标实例存在并记录多余实例；按 `assignedTechAsst` 建立正确绑定。
  - 对每个技术助教：读取其 `inchargeVisitor`，比对学生实际模板，记录不一致。
  - 打印校验报告（JSON/表格）。
- 仅在用户批准后执行脚本；执行前先 `npm audit`（如有漏洞警告），且绝不使用 `git push -f`/`--force`。

Risks
- CSV 若仍存在个别脏字段（邮箱拼写、工号对不齐）会导致"找不到助教用户"；将记录在报告中，需人工修正 CSV 或补录用户信息。
- 历史多实例/多绑定未删除，可能在个别页面显示重复或统计偏高；本轮仅定位和报告，留待后续清理策略审批后处理。
---

## Planner – 后端云端部署对齐与生产命令方案（后端 `cbt-simulator`）

### Background and Motivation
- 现状：本地开发以 `npm run dev:api`（tsx 直跑 TS）为主，未提供生产构建产物与统一启动命令，Node/NPM 版本未锁定，云端对齐成本高。
- 目标：补齐生产构建与启动脚本、版本与依赖对齐、环境变量清单、迁移与健康检查流程，以及 PM2 与 Docker 两套部署路径的规范文档与命令矩阵。

### Current Findings（只读审计）
- 运行栈：Fastify v5、ESM、TS；开发通过 `tsx` 直接运行 TS；无 `build/start` 生产脚本；未声明 engines/node。
- 数据库与迁移：Drizzle ORM + drizzle-kit；`drizzle.config.ts` 读取 `DATABASE_URL`；已有 `dr:generate`、`dr:migrate` 脚本与 SQL 迁移目录 `drizzle/`。
- 网络：默认监听 `PORT`（缺省 3000）、`HOST`（缺省 `0.0.0.0`）。
- 认证：JWT 使用 `JWT_SECRET`（默认 dev 值），建议生产强制设置。
- 速率限制：`RATELIMIT_MAX`、`RATELIMIT_WINDOW` 可调。
- AI 供应商：DashScope（Qwen 兼容 OpenAI SDK），使用 `DASHSCOPE_API_KEY(S)`。
- 数据库 SSL：可选 `PGSSLROOTCERT` 或 `DATABASE_SSL_CA`（阿里云 RDS 建议开启）。

### 环境变量清单（拟 `.env.example`）
- 必需：
  - `DATABASE_URL=postgres://<user>:<pass>@<host>:5432/<db>?sslmode=require`
  - `JWT_SECRET=请替换为强随机值`
  - `DASHSCOPE_API_KEY=xxxx`（或 `DASHSCOPE_API_KEYS=key1,key2`）
- 可选：
  - `PORT=3000`
  - `HOST=0.0.0.0`
  - `RATELIMIT_MAX=300`
  - `RATELIMIT_WINDOW=1 minute`
  - `PGSSLROOTCERT=/path/to/ca.pem`（或 `DATABASE_SSL_CA=/path/to/ca.pem`）
  - `NODE_ENV=production`

### Key Challenges and Analysis
- 生产可执行物：目前没有构建产物，云端若继续用 `tsx` 直跑 TS，启动简单但冷启动与兼容性较弱；建议改为 `tsc` 产出 `dist/` 后以 Node 启动。
- 版本对齐：未锁定 Node/NPM 版本，易出现"云端编译/运行差异"。
- 运行守护：需 PM2 或 systemd；或采用 Docker 封装运行时环境。
- 健康检查：建议提供 `/health`（进程 + DB ping）与 `/ready`（依赖就绪）用于探针。
- 迁移流程：生产应"先 migrate 再启动"，避免首次启动因缺表失败。

### Success Criteria（验收标准）
1) 仓库新增 `.env.example`，列出所有变量与注释。
2) `package.json`：新增 `engines`、`packageManager`、`build`、`start:prod` 脚本；依赖齐全。
3) 新增 `tsconfig.build.json`，`npm run build` 生成 `dist/`，`npm run start:prod` 以 Node 启动。
4) 新增健康检查路由（/health），DB 可连时返回 200；文档含探针配置建议。
5) 提供两套部署：
   - 非容器（PM2）：`pm2 start dist/server/index.js --name cbt-api` 可稳定运行并自启。
   - 容器（Docker）：提供 `Dockerfile` 与 `docker build/run` 命令；镜像可启动并加载配置。
6) 完整的部署文档（ECS + RDS 场景）：安装、配置、迁移、启动、日志与回滚。

### High-level Task Breakdown（实施计划）
1) 版本与依赖对齐
   - 在 `package.json` 增加：
     - `engines`: `{ "node": ">=20 <23", "npm": ">=10" }`
     - `packageManager`: `"npm@10"`（或按你团队统一的包管器）
   - 仓库新增 `.nvmrc`（如 `v20.17.0`）。
   - 成功标准：`nvm use` 或 CI/云端使用指定 Node 版本无差异。

2) 构建与启动脚本
   - 新增 `tsconfig.build.json`（outDir: `dist`，包含 `src/**`）。
   - 在 `package.json` 增加：
     - `build`: `tsc -p tsconfig.build.json`
     - `start:prod`: `node dist/server/index.js`
   - 成功标准：本地 `npm run build && npm run start:prod` 可启动，日志与路由正常。

3) 健康检查端点
   - 新增 `/health`（GET）：返回 `{ status: 'ok', uptime, db: 'ok'|'down' }`；DB 检查执行 `SELECT 1`。
   - 成功标准：未连上 DB 时返回 503/非 200；连上 DB 返回 200。

4) PM2 与系统服务
   - 新增 `ecosystem.config.js`（`script: 'dist/server/index.js'`，`instances: 1` 起步，可扩展 cluster）。
   - 文档覆盖 `pm2 startup`、`pm2 save`、日志查看、滚动重启、环境变量注入。
   - 成功标准：重启后自启，日志轮转正常。

5) Docker 化（可选但推荐）
   - 新增 `Dockerfile`（多阶段：deps→build→runtime，使用 `node:20-alpine`）。
   - 新增 `.dockerignore`。
   - 成功标准：镜像体积可控，容器内 `npm run start:prod` 正常；支持以 `--env-file` 注入变量。

6) 数据库迁移流程固化
   - 文档明确：生产部署前执行 `npm run dr:migrate`（指向 RDS 的 `DATABASE_URL`）。
   - 若采用容器：在 CI 任务或一次性 Job 中执行迁移，不放到应用启动时自动执行。

7) 文档交付
   - 新增 `docs/ENV.md`（后端环境变量说明）。
   - 新增 `docs/DEPLOYMENT.md`（ECS + RDS + PM2 与 Docker 两条路径的操作手册）。
   - 在 `README.md` 增补"生产启动命令矩阵"。

### 生产命令矩阵（建议）
- 非容器（首次/升级部署）：
  1) 安装依赖：
     ```bash
     npm ci --omit=dev=false
     ```
  2) 构建：
     ```bash
     npm run build
     ```
  3) 迁移：
     ```bash
     DATABASE_URL=postgres://... npm run dr:migrate
     ```
  4) 启动（一次性）：
     ```bash
     npm run start:prod
     ```
  5) 启动（PM2 守护）：
     ```bash
     pm2 start dist/server/index.js --name cbt-api
     pm2 save
     ```

- 容器：
  1) 构建镜像：
     ```bash
     docker build -t cbt-simulator:latest .
     ```
  2) 迁移（Job/一次性容器）：
     ```bash
     docker run --rm --env-file .env.production cbt-simulator:latest \
       sh -lc "npm run dr:migrate"
     ```
  3) 运行：
     ```bash
     docker run -d --name cbt-api -p 3000:3000 --env-file .env.production cbt-simulator:latest
     ```

### 健康检查与可观测性建议
- 探针：
  - Liveness → `/health?probe=liveness`：仅进程与事件循环自检（200 即存活）。
  - Readiness → `/health`：包含 DB ping；失败返回非 2xx。
- 日志：保留 Fastify/pino 默认结构化输出；生产建议 JSON 输出，交由日志系统采集。
- 指标（后续迭代）：暴露 p95/p99、错误率、上游 AI 调用状态。

### 安全与合规
- 强制设置 `JWT_SECRET` 与数据库 SSL CA（RDS/自建开启 SSL）。
- 最小权限：RDS 业务账号仅具 DML/必要 DDL 权限；生产迁移可用临时高权限账号。
- CORS：生产将 `origin` 配置为白名单域名。

### 风险与回滚
- 直接用 `tsx` 运行 TS 在部分云宿主运行良好，但建议统一为构建后启动，降低可变性。
- `moduleResolution: Bundler` 在 TS 构建下通常无碍，但需在执行环境验证 Node ESM 解析；如遇问题可收敛 `module`/`moduleResolution` 于 NodeNext。
- 回滚：保留上一版本镜像/构建产物与迁移版本号，按"先停新→切旧→必要时回滚迁移"流程执行。

### Open Questions（请确认）
1) 首选部署路径：PM2（非容器）还是 Docker？（也可双轨）
2) Node 版本锁定为 20 LTS 是否满足你们的云宿主与 CI？
3) 是否需要多实例（PM2 cluster / K8s HPA）方案与 Nginx/SLB 配置样例？
4) `/health` 是否需要鉴权或内网限定？（通常对外 200 仅返回最小信息）

### Deliverables（本轮实现产物清单）
- `.env.example`（后端）
- `tsconfig.build.json`
- `package.json`：`engines`、`packageManager`、`build`、`start:prod`
- 健康检查路由（`/health`）
- `ecosystem.config.js`（PM2，可选）
- `Dockerfile` 与 `.dockerignore`（可选）
- 文档：`docs/ENV.md`、`docs/DEPLOYMENT.md`、`README.md` 生产启动命令矩阵

### Final Decisions（为减少报错与维护成本，默认选择）
- 部署路径：优先 Docker（避免环境漂移），保留 PM2 作为非容器备选。
- Node 版本：锁定 Node 20 LTS（示例 `v20.17.0`）。
- 健康检查：`/health` 对公网可访问，仅返回最小必要信息；可在反向代理层做限速与缓存。
- 数据库 SSL：生产强制 `sslmode=require`；如需，挂载 RDS CA 文件并通过 `PGSSLROOTCERT`/`DATABASE_SSL_CA` 指定。
- 迁移执行：与应用启动解耦，作为部署流程中的独立步骤（CI/一次性 Job）。

### Project Status Board（Deployment）
- [ ] 新增 `.env.example`
- [ ] 新增 `tsconfig.build.json`
- [ ] 更新 `package.json`（engines/packageManager/build/start:prod）
- [ ] 新增 `/health` 路由（含 DB ping）
- [ ] 新增 `Dockerfile` 与 `.dockerignore`
- [ ]（可选）新增 `ecosystem.config.js`（PM2）
- [ ] 新增并完善 `docs/ENV.md`、`docs/DEPLOYMENT.md`、更新 `README.md`
- [ ] 本地验证：`build → migrate → start` 与 Docker 运行

## Planner – 前端（Next.js）生产部署与对齐方案（`cbt-simulator-front/web`）

### Background and Motivation
- 现状：Next 15 + React 19，使用 Turbopack；`NEXT_PUBLIC_API_BASE_URL` 经 `.env.*` 注入；构建与启动脚本已存在，但未锁定 Node/npm；缺少生产部署文档与容器化文件。
- 目标：对齐后端的版本与部署策略，提供 Docker（推荐）与 PM2（非容器）两条路，以及清晰的 ENV 文档与命令矩阵。

### Current Findings（只读审计）
- `web/package.json`：`dev/build/start` 均带 `--turbopack`；依赖仅 next/react/react-dom；devDeps 有 eslint/tailwind v4。
- `web/next.config.ts`：构建容忍 TS/ESLint 错误；无额外配置。
- `web/src/services/http.ts`：API 基址来自 `NEXT_PUBLIC_API_BASE_URL`，有一次 429 重试与超时。
- `README-ENV.md`：已说明 dev/production 环境变量。

### 环境变量（前端）
- `NEXT_PUBLIC_API_BASE_URL`（必需）：后端 API 基址（生产建议指向 HTTPS 域名）。
- （可选）`NEXT_PUBLIC_SENTRY_DSN` 等观测类变量（如采用）。

### Success Criteria
1) 前端 `web/package.json` 补充 `engines` 与 `packageManager`，与后端一致（Node 20 LTS / npm@10）。
2) 新增 `docs/DEPLOYMENT.md`（前端）与 `README.md` 更新：Docker/PM2 部署、环境变量、命令矩阵。
3) 新增 `Dockerfile` 与 `.dockerignore`（前端），容器内通过 `next start` 提供 3001 端口。
4) 确认 `next.config.ts` 支持生产忽略构建错误仅限早期阶段，后续可收紧；本轮维持现状以降低上线阻力。

### High-level Task Breakdown（前端）
1) `web/package.json`：增加
   - `engines`: `{ node: ">=20 <23", npm: ">=10" }`
   - `packageManager`: `"npm@10"`
   - 确认脚本：`dev/build/start` 已满足需求（生产 `next start -p 3001`）。
2) Docker 化
   - `Dockerfile`（多阶段：deps→build→runtime），`EXPOSE 3001`，`CMD next start -p 3001`。
   - `.dockerignore` 最小化上下文。
3) 文档
   - `web/README.md`：简化"Getting Started"并加入命令矩阵。
   - `README-ENV.md`：保留，补充生产/预发 `.env.production/.env.staging` 样例与与后端端口对齐说明。
   - 新增 `docs/DEPLOYMENT.md`（前端）：部署步骤与 Nginx/反代示例。

### 生产命令矩阵（前端建议）
- 非容器：
  - 构建：`npm run build`
  - 启动：`npm run start`（端口 3001）
- 容器：
  - 构建镜像：`docker build -t cbt-frontend:latest ./web`
  - 运行：`docker run -d --name cbt-web -p 3001:3001 --env-file .env.production cbt-frontend:latest`

### Open Questions（前端）
1) 是否需要集成 Sentry/监控脚本（DSN 来自 `NEXT_PUBLIC_SENTRY_DSN`）？
2) 是否需要将 `eslint/typescript` 构建错误从忽略改为严格（逐步收紧）？


