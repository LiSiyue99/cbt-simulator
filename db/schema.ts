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
    corePersona: jsonb("core_persona").notNull(),
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

// 三联表记录保持不变
export const thoughtRecords = pgTable(
  "thought_records",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    triggeringEvent: text("triggering_event").notNull(),
    thoughtsAndBeliefs: text("thoughts_and_beliefs").notNull(),
    consequences: text("consequences").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      idxSession: index("thought_records_session_idx").on(table.sessionId),
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
    // 学生预分配：技术助教 user_id / 行政助教 user_id / 模板（1..10）
    assignedTechAsst: varchar("assigned_tech_asst", { length: 64 }),
    assignedClassAsst: varchar("assigned_class_asst", { length: 64 }),
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
      idxAssignedTech: index("whitelist_assigned_tech_idx").on(table.assignedTechAsst),
      idxAssignedClass: index("whitelist_assigned_class_idx").on(table.assignedClassAsst),
      idxAssignedVisitor: index("whitelist_assigned_visitor_idx").on(table.assignedVisitor),
      idxRoleStatus: index("whitelist_role_status_idx").on(table.role, table.status),
    };
  }
);

// 学生→助教 提问（按会话归档，多条记录，倒序）
export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    studentId: text("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("open"), // open | answered | closed
    dueAt: timestamp("due_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      idxSession: index("questions_session_idx").on(table.sessionId),
      idxStudent: index("questions_student_idx").on(table.studentId),
    };
  }
);

// 助教→学生 文字反馈（按会话归档，多条记录，倒序）
export const assistantFeedbacks = pgTable(
  "assistant_feedbacks",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    assistantId: text("assistant_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("published"), // draft | published
    dueAt: timestamp("due_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return {
      idxSession: index("assistant_feedbacks_session_idx").on(table.sessionId),
      idxAssistant: index("assistant_feedbacks_assistant_idx").on(table.assistantId),
    };
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