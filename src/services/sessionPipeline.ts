import { eq, desc } from 'drizzle-orm';
import { createDb } from '../db/client';
import { visitorInstances, visitorTemplates, sessions, longTermMemoryVersions } from '../db/schema';
import { asc } from 'drizzle-orm';
import { buildFullPersonaFromFiles } from './personaLoader';
import { chatWithVisitor } from '../chat/sessionOrchestrator';
import { generateDiary } from '../chain/generateDiary';
import { generateActivity } from '../chain/generateActivity';
import { updateLongTermMemory } from '../chain/updateLongTermMemory';
import { sessionChatToString } from './chatSessionStore';
import { loadPrompt } from '../prompts';

export type RunSessionPipelineInput = {
  visitorInstanceId: string;
  sessionNumber: number;
  chatHistory: string | { speaker: 'user' | 'ai'; content: string }[]; // 结构化或纯文本
  assignment?: string; // 可选
};

export async function runSessionPipeline(input: RunSessionPipelineInput) {
  const db = createDb();
  // 1) 读取实例、模板、LTM
  const [instance] = await db
    .select()
    .from(visitorInstances)
    .where(eq(visitorInstances.id, input.visitorInstanceId));
  if (!instance) throw new Error('visitor instance not found');

  const [template] = await db
    .select()
    .from(visitorTemplates)
    .where(eq(visitorTemplates.id, instance.templateId));
  if (!template) throw new Error('visitor template not found');

  // 2) 组合 persona（核心人设键优先使用 template.templateKey；若为空回退 name）
  const coreKey = (template as any).templateKey || (template as any).name || '1';
  const persona = await buildFullPersonaFromFiles({
    visitorTypeKey: coreKey,
    longTermMemory: JSON.stringify(instance.longTermMemory ?? {}),
  });

  // 3) 与用户对话（这里示例用传入的 chatHistory 最后一句作为用户消息）
  const reply = await chatWithVisitor({
    persona,
    messages: [{ role: 'user', content: '请基于上述设定，简短回应以下对话片段的最后一问：\n' + sessionChatToString(input.chatHistory) }],
  });

  // 4) 生成 Diary
  const diary = await generateDiary({
    personaBlueprint: persona.corePersona,
    diaryHistory: await loadAllDiariesAsString(db, instance.id),
    sessionChat: sessionChatToString(input.chatHistory),
  });

  // 5) 生成 Activity（若无 assignment 则传空）
  const activity = await generateActivity({
    corePersona: persona.corePersona,
    longTermMemory: JSON.stringify(instance.longTermMemory ?? {}),
    sessionChat: sessionChatToString(input.chatHistory),
    assignment: input.assignment ?? '',
  });

  // 6) 更新 LTM
  const ltm = await updateLongTermMemory({
    longtermMemoryCurrent: JSON.stringify(instance.longTermMemory ?? {}),
    latestDiaryEntry: diary.diary,
    latestActivityLog: activity.activityJson,
  });

  // 7) 持久化：写入 session，更新 instance.ltm，并记录版本
  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    visitorInstanceId: input.visitorInstanceId,
    sessionNumber: input.sessionNumber,
    chatHistory: Array.isArray(input.chatHistory) ? (input.chatHistory as any) : sessionChatToString(input.chatHistory),
    homework: input.assignment ? ([{ title: input.assignment, status: 'assigned' }] as any) : undefined,
    sessionDiary: diary.diary,
    preSessionActivity: (() => {
      try {
        const obj = JSON.parse(activity.activityJson || '{}');
        return { summary: '', details: obj } as any;
      } catch {
        return { summary: '', details: activity.activityJson } as any;
      }
    })(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(longTermMemoryVersions).values({
    id: crypto.randomUUID(),
    visitorInstanceId: input.visitorInstanceId,
    content: ltm.longtermMemory as any,
    createdAt: new Date(),
  });

  await db
    .update(visitorInstances)
    .set({ longTermMemory: ltm.longtermMemory as any, updatedAt: new Date() })
    .where(eq(visitorInstances.id, input.visitorInstanceId));

  return {
    modelReply: reply,
    diary: diary.diary,
    activityJson: activity.activityJson,
    ltm: ltm.longtermMemory,
  };
}
async function loadAllDiariesAsString(db: ReturnType<typeof createDb>, visitorInstanceId: string): Promise<string> {
  const rows = await db
    .select({ n: sessions.sessionNumber, d: sessions.sessionDiary })
    .from(sessions)
    .where(eq(sessions.visitorInstanceId, visitorInstanceId))
    .orderBy(asc(sessions.sessionNumber));
  return rows
    .filter((r) => !!r.d)
    .map((r) => `session ${r.n}: ${r.d}`)
    .join('\n');
}



/**
 * 在“结束对话”按钮点击时调用：
 * - 读取指定 session 的 chatHistory
 * - 组合 Full Persona
 * - 生成 Diary 与 Activity
 * - 更新 LTM，并写入历史表
 * - 回写当前 session 的 diary/activity/homework
 */
export async function finalizeSessionById(params: { sessionId: string; assignment?: string }) {
  const db = createDb();

  // 读取 session 基本信息与聊天记录
  const [row] = await db.select().from(sessions).where(eq(sessions.id, params.sessionId));
  if (!row) throw new Error('session not found');

  // 读取实例与模板
  const [instance] = await db
    .select()
    .from(visitorInstances)
    .where(eq(visitorInstances.id, row.visitorInstanceId));
  if (!instance) throw new Error('visitor instance not found');

  const [template] = await db
    .select()
    .from(visitorTemplates)
    .where(eq(visitorTemplates.id, instance.templateId));
  if (!template) throw new Error('visitor template not found');

  // 组合 persona
  const coreKey = (template as any).templateKey || (template as any).name || '1';
  const persona = await buildFullPersonaFromFiles({
    visitorTypeKey: coreKey,
    longTermMemory: JSON.stringify(instance.longTermMemory ?? {}),
  });

  const historyText = sessionChatToString(row.chatHistory);

  // 生成 Diary
  const diary = await generateDiary({
    personaBlueprint: persona.corePersona,
    diaryHistory: await loadAllDiariesAsString(db, row.visitorInstanceId),
    sessionChat: historyText,
  });

  // 回写 session 行：先写 diary/homework/finalizedAt
  await db
    .update(sessions)
    .set({
      homework: params.assignment ? ([{ title: params.assignment, status: 'assigned' }] as any) : row.homework,
      sessionDiary: diary.diary,
      finalizedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, row.id));

  // 异步生成 activity 与更新 LTM（不阻塞响应）
  ;(async () => {
    try {
      // 重新读取最新 instance
      const [instance2] = await db
        .select()
        .from(visitorInstances)
        .where(eq(visitorInstances.id, row.visitorInstanceId));
      const assignmentTitle = Array.isArray(params.assignment) ? '' : (params.assignment ?? ((row as any).homework?.[0]?.title ?? ''));

      const activity = await generateActivity({
        corePersona: persona.corePersona,
        longTermMemory: JSON.stringify((instance2 as any)?.longTermMemory ?? {}),
        sessionChat: historyText,
        assignment: assignmentTitle,
      });

      const ltm = await updateLongTermMemory({
        longtermMemoryCurrent: JSON.stringify((instance2 as any)?.longTermMemory ?? {}),
        latestDiaryEntry: diary.diary,
        latestActivityLog: activity.activityJson,
      });

      // 回写 activity
      await db
        .update(sessions)
        .set({
          preSessionActivity: (() => {
            try {
              const obj = JSON.parse(activity.activityJson || '{}');
              return { summary: '', details: obj } as any;
            } catch {
              return { summary: '', details: activity.activityJson } as any;
            }
          })(),
          updatedAt: new Date(),
        } as any)
        .where(eq(sessions.id, row.id));

      // 写入 LTM 版本并更新实例
      await db.insert(longTermMemoryVersions).values({
        id: crypto.randomUUID(),
        visitorInstanceId: row.visitorInstanceId,
        content: ltm.longtermMemory as any,
        createdAt: new Date(),
      });
      await db
        .update(visitorInstances)
        .set({ longTermMemory: ltm.longtermMemory as any, updatedAt: new Date() })
        .where(eq(visitorInstances.id, row.visitorInstanceId));
    } catch (e) {
      // 忽略后台失败，留待 ensure-outputs 补偿
    }
  })();

  return { diary: diary.diary };
}

/**
 * 开始新对话时的前期准备：生成activity并更新LTM
 * 按照PRD，这些操作要等到学生点击"开始新对话"时才执行
 */
export async function prepareNewSession(sessionId: string): Promise<{ activityJson: string }> {
  const db = createDb();

  // 获取当前session
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) throw new Error('session not found');

  // 获取visitor instance和template
  const [instance] = await db
    .select()
    .from(visitorInstances)
    .where(eq(visitorInstances.id, session.visitorInstanceId));
  if (!instance) throw new Error('visitor instance not found');

  const [template] = await db
    .select()
    .from(visitorTemplates)
    .where(eq(visitorTemplates.id, instance.templateId));
  if (!template) throw new Error('visitor template not found');

  // 获取上一个已完成的session来生成activity (排除当前session)
  const prevSessions = await db
    .select()
    .from(sessions)
    .where(eq(sessions.visitorInstanceId, session.visitorInstanceId))
    .orderBy(desc(sessions.sessionNumber))
    .limit(10);

  // 找到上一个有diary的session（排除当前session）
  const prevSession = prevSessions.find(s =>
    s.id !== sessionId && s.sessionDiary && s.finalizedAt
  );

  if (!prevSession || !prevSession.sessionDiary) {
    throw new Error('No previous completed session found to generate activity from');
  }

  // 组合 persona
  const coreKey = (template as any).templateKey || (template as any).name || '1';
  const persona = await buildFullPersonaFromFiles({
    visitorTypeKey: coreKey,
    longTermMemory: JSON.stringify(instance.longTermMemory ?? {}),
  });

  const prevHistoryText = sessionChatToString(prevSession.chatHistory);
  const prevAssignment = Array.isArray(prevSession.homework) && prevSession.homework.length > 0
    ? prevSession.homework[0].title
    : '';

  // 生成activity（基于上一个session）
  const activity = await generateActivity({
    corePersona: persona.corePersona,
    longTermMemory: JSON.stringify(instance.longTermMemory ?? {}),
    sessionChat: prevHistoryText,
    assignment: prevAssignment,
  });

  // 更新 LTM
  const ltm = await updateLongTermMemory({
    longtermMemoryCurrent: JSON.stringify(instance.longTermMemory ?? {}),
    latestDiaryEntry: prevSession.sessionDiary,
    latestActivityLog: activity.activityJson,
  });

  // 更新当前session的preSessionActivity
  await db
    .update(sessions)
    .set({
      preSessionActivity: (() => {
        try {
          const obj = JSON.parse(activity.activityJson || '{}');
          return { summary: '', details: obj } as any;
        } catch {
          return { summary: '', details: activity.activityJson } as any;
        }
      })(),
      updatedAt: new Date(),
    } as any)
    .where(eq(sessions.id, sessionId));

  // 写 LTM 历史并更新实例
  await db.insert(longTermMemoryVersions).values({
    id: crypto.randomUUID(),
    visitorInstanceId: session.visitorInstanceId,
    content: ltm.longtermMemory as any,
    createdAt: new Date(),
  });

  await db
    .update(visitorInstances)
    .set({ longTermMemory: ltm.longtermMemory as any, updatedAt: new Date() })
    .where(eq(visitorInstances.id, session.visitorInstanceId));

  return { activityJson: activity.activityJson };
}


