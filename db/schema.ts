import {
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
  jsonb,
  index,
  uniqueIndex,
  bigint,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

/**
 * =================================================================================
 * TypeScript Type Definitions for JSONB Fields
 * =================================================================================
 */

// 聊天记录结构
export type ChatTurn = {
  speaker: "user" | "ai";
  content: string;
  timestamp: string;
};
export type ChatHistory = ChatTurn[];

// LongTermMemory结构
export type LongTermMemory = {
  thisweek_focus: string;
  discussed_topics: string; // 新增字段
  milestones: string;
  recurring_patterns: string;
  core_belief_evolution: string;
};

export type HomeworkItem = {
  title: string;
  description?: string;
  status: "assigned" | "in_progress" | "completed";
  dueAt?: string; // ISO datetime
  completedAt?: string; // ISO datetime
};

export type PreSessionActivity = {
  summary: string;
  details?: unknown; // 保留弹性给模型输出
};

// 通用作业表单字段定义（全部必填，支持占位与说明）
export type HomeworkFormField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "date" | "boolean";
  placeholder?: string;
  helpText?: string;
};

// 通用作业提交数据结构（日期以 ISO 字符串传输）
export type HomeworkFormData = Record<string, string | number | boolean>;


/**
 * =================================================================================
 * Database Schema Definitions (Drizzle ORM) - Final Version
 * =================================================================================
 */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    name: varchar("name", { length: 256 }),
    email: varchar("email", { length: 256 }).notNull().unique(),
    // 业务层用户唯一标识（学生=学号；助教=工号或自定义）
    userId: bigint("user_id", { mode: 'number' }),
    // 角色：student | assistant_tech | assistant_class | admin
    role: varchar("role", { length: 32 }).notNull().default("student"),
    // 班级编号（student/assistant_class 使用）
    classId: bigint("class_id", { mode: 'number' }),
    // 账户状态：active/inactive
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      uqUserId: uniqueIndex("users_user_id_uq").on(table.userId),
      idxClassRole: index("users_class_role_idx").on(table.classId, table.role),
      idxRoleStatus: index("users_role_status_idx").on(table.role, table.status),
    };
  }
);

// 模板表现在只存储最基础的、不变的模板信息
export const visitorTemplates = pgTable(
  "visitor_templates",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    templateKey: varchar("template_key", { length: 64 }).notNull(),
    name: varchar("name", { length: 256 }).notNull(),
    brief: text("brief").notNull(),
    // 模板级不变数据：Core Persona 与 Chat Principle
    // 统一改为纯文本存储
    corePersona: text("core_persona").notNull(),
    chatPrinciple: text("chat_principle").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      uqTemplateKey: uniqueIndex("visitor_templates_key_uq").on(table.templateKey),
      uqName: uniqueIndex("visitor_templates_name_uq").on(table.name),
    };
  }
);

// 核心人设版本历史已移除（按最新产品决策）

// 用户专属的访客实例：仅包含长期记忆（唯一可变状态）
export const visitorInstances = pgTable(
  "visitor_instances",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    templateId: text("template_id").notNull().references(() => visitorTemplates.id, { onDelete: "restrict" }),
    // 长期记忆明确为JSONB格式，并使用新的类型
    longTermMemory: jsonb("long_term_memory").$type<LongTermMemory>().notNull(),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      uqUserTemplate: uniqueIndex("visitor_instances_user_template_uq").on(
        table.userId,
        table.templateId
      ),
    };
  }
);

// 会话记录表
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    visitorInstanceId: text("visitor_instance_id")
      .notNull()
      .references(() => visitorInstances.id, { onDelete: "cascade" }),
    sessionNumber: integer("session_number").notNull(),

    // 聊天记录明确为JSONB，并使用建议的数组结构
    chatHistory: jsonb("chat_history").$type<ChatHistory>().notNull(),

    // 作业结构化：数组 JSONB，包含状态/时间信息
    homework: jsonb("homework").$type<HomeworkItem[]>(),
    // 会话日志
    sessionDiary: text("session_diary"),
    // 会话正式结束时间（用于限时校验）
    finalizedAt: timestamp("finalized_at"),
    // 会话前生成的 Activity，用于驱动新一轮会话
    preSessionActivity: jsonb("pre_session_activity").$type<PreSessionActivity>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      uqInstanceNumber: uniqueIndex("sessions_instance_number_uq").on(
        table.visitorInstanceId,
        table.sessionNumber
      ),
      idxVisitor: index("sessions_visitor_idx").on(table.visitorInstanceId),
    };
  }
);

// 作业集（按班与第 N 次作业定义动态表单与窗口期）
export const homeworkSets = pgTable(
  "homework_sets",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    classId: bigint("class_id", { mode: 'number' }).notNull(),
    title: varchar("title", { length: 256 }),
    description: text("description"),
    sequenceNumber: integer("sequence_number").notNull(),
    formFields: jsonb("form_fields").$type<HomeworkFormField[]>().notNull(),
    studentStartAt: timestamp("student_start_at").notNull(),
    studentDeadline: timestamp("student_deadline").notNull(),
    assistantStartAt: timestamp("assistant_start_at").notNull(),
    assistantDeadline: timestamp("assistant_deadline").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("published"),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      uqClassSeq: uniqueIndex("homework_sets_class_seq_uq").on(table.classId, table.sequenceNumber),
      idxClass: index("homework_sets_class_idx").on(table.classId),
    };
  }
);

// 学生作业提交（与会话、作业集与学生关联）
export const homeworkSubmissions = pgTable(
  "homework_submissions",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    homeworkSetId: text("homework_set_id").notNull().references(() => homeworkSets.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    studentId: text("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    formData: jsonb("form_data").$type<HomeworkFormData>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      uqSession: uniqueIndex("homework_submissions_session_uq").on(table.sessionId),
      idxSet: index("homework_submissions_set_idx").on(table.homeworkSetId),
      idxStudent: index("homework_submissions_student_idx").on(table.studentId),
    };
  }
);

// 助教-学生-实例 绑定（用于权限与筛选）
export const assistantStudents = pgTable(
  "assistant_students",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    assistantId: text("assistant_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    studentId: text("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    visitorInstanceId: text("visitor_instance_id").notNull().references(() => visitorInstances.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      uq: uniqueIndex("assistant_students_uq").on(table.assistantId, table.studentId, table.visitorInstanceId),
      idxAssistant: index("assistant_students_assistant_idx").on(table.assistantId),
      idxStudent: index("assistant_students_student_idx").on(table.studentId),
      idxInstance: index("assistant_students_instance_idx").on(table.visitorInstanceId),
    };
  }
);

// 长期记忆版本历史，用于审计/回滚
export const longTermMemoryVersions = pgTable("long_term_memory_versions", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  visitorInstanceId: text("visitor_instance_id").notNull().references(() => visitorInstances.id, { onDelete: "cascade" }),
  content: jsonb("content").$type<LongTermMemory>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * =================================================================================
 * Auth & Teaching Interaction Tables (New)
 * =================================================================================
 */

// 验证码表：支持白名单邮箱 + 验证码登录
export const verificationCodes = pgTable(
  "verification_codes",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    email: varchar("email", { length: 256 }).notNull(),
    code: varchar("code", { length: 16 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      idxEmail: index("verification_codes_email_idx").on(table.email),
    };
  }
);

// 白名单邮箱表：由运维或导入程序写入，驱动首登角色与可选的助教邮箱绑定
export const whitelistEmails = pgTable(
  "whitelist_emails",
  {
    email: varchar("email", { length: 256 }).primaryKey(),
    name: varchar("name", { length: 256 }),
    // 业务用户标识（学生=学号；助教=工号/自定义）
    userId: bigint("user_id", { mode: 'number' }),
    role: varchar("role", { length: 32 }).notNull(), // student | assistant_tech | assistant_class | admin
    // 学生/行政助教：班级与学号（学生）
    classId: bigint("class_id", { mode: 'number' }),
    // 学生预分配：模板（1..10）
    assignedVisitor: varchar("assigned_visitor", { length: 8 }),
    // 技术助教负责模板集合与配额统计
    inchargeVisitor: jsonb("incharge_visitor"), // string[] 模板键数组
    studentCount: integer("student_count").default(0),
    // 账户状态
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      uqUserId: uniqueIndex("whitelist_user_id_uq").on(table.userId),
      idxClassRole: index("whitelist_class_role_idx").on(table.classId, table.role),
      idxAssignedVisitor: index("whitelist_assigned_visitor_idx").on(table.assignedVisitor),
      idxRoleStatus: index("whitelist_role_status_idx").on(table.role, table.status),
    };
  }
);

// 学生→助教 提问（按会话归档，多条记录，倒序）
// 旧表 questions/assistant_feedbacks 已被统一聊天替代并删除

// 双向聊天：学生与助教围绕某会话的即时消息
export const assistantChatMessages = pgTable(
  "assistant_chat_messages",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    senderRole: varchar("sender_role", { length: 32 }).notNull(), // 'student' | 'assistant_tech'
    senderId: text("sender_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("unread"), // unread | read
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      idxSession: index("assistant_chat_messages_session_idx").on(table.sessionId),
      idxSender: index("assistant_chat_messages_sender_idx").on(table.senderId),
      idxStatus: index("assistant_chat_messages_status_idx").on(table.status),
    };
  }
);

// 会话级 DDL 覆盖（回合制按会话设置）
export const sessionDeadlineOverrides = pgTable(
  "session_deadline_overrides",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 32 }).notNull(), // 'extend_student_tr' | 'extend_assistant_feedback'
    until: timestamp("until").notNull(), // 绝对时间
    reason: text("reason"),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      idxSession: index("session_deadline_overrides_session_idx").on(table.sessionId),
    };
  }
);

// 审计日志（Admin 关键操作追踪）
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    actorId: text("actor_id").notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 64 }).notNull(),
    targetId: text("target_id").notNull(),
    summary: text("summary"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  }
);

// 每周合规模块快照
export const weeklyCompliance = pgTable(
  "weekly_compliance",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    weekKey: varchar("week_key", { length: 16 }).notNull(), // YYYY-WW
    classId: bigint("class_id", { mode: 'number' }).notNull(),
    studentId: text("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    assistantId: text("assistant_id").references(() => users.id, { onDelete: "set null" }),
    // 标志位
    hasSession: integer("has_session").notNull().default(0),
    hasThoughtRecordByFri: integer("has_thought_record_by_fri").notNull().default(0),
    hasAnyFeedbackBySun: integer("has_any_feedback_by_sun").notNull().default(0),
    locked: integer("locked").notNull().default(0),
    // 时间
    computedAt: timestamp("computed_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      idxWeekClass: index("weekly_compliance_week_class_idx").on(table.weekKey, table.classId),
      idxStudentWeek: index("weekly_compliance_student_week_idx").on(table.studentId, table.weekKey),
    };
  }
);

// 管控策略：全局时间窗（可选，若不存在则使用默认策略）
export const systemConfigs = pgTable(
  "system_configs",
  {
    key: varchar("key", { length: 64 }).primaryKey(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  }
);

// DDL 临时解锁：允许管理员对某学生或某助教在某周放宽限制
export const deadlineOverrides = pgTable(
  "deadline_overrides",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    subjectType: varchar("subject_type", { length: 16 }).notNull(), // 'student' | 'assistant'
    subjectId: text("subject_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    weekKey: varchar("week_key", { length: 16 }).notNull(), // YYYY-WW
    // 允许的操作：'extend_student_tr' | 'extend_assistant_feedback'
    action: varchar("action", { length: 32 }).notNull(),
    // 截止到的时间（ISO）或天数偏移，采用绝对时间
    until: timestamp("until").notNull(),
    reason: text("reason"),
    // 批量标识与作用域（批量创建时写入）
    batchId: text("batch_id"),
    batchScope: text("batch_scope"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "set null" }),
  },
  (table) => {
    return {
      idxSubjectWeek: index("deadline_overrides_subject_week_idx").on(table.subjectId, table.weekKey),
      idxWeek: index("deadline_overrides_week_idx").on(table.weekKey),
    };
  }
);

/**
 * =================================================================================
 * Multi-Role Authorization (User Role Grants)
 * =================================================================================
 */

// 多角色授权表：为用户授予附加角色与可选的班级作用域
export const userRoleGrants = pgTable(
  "user_role_grants",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 32 }).notNull(), // student | assistant_tech | assistant_class | admin
    classId: bigint("class_id", { mode: 'number' }), // 仅 assistant_class 使用
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      idxUser: index("user_role_grants_user_idx").on(table.userId),
      idxUserRole: index("user_role_grants_user_role_idx").on(table.userId, table.role),
    };
  }
);