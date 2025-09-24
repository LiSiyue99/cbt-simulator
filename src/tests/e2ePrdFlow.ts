import { createDb } from '../db/client';
import { users, visitorTemplates, visitorInstances, sessions } from '../db/schema';
import { createSession, appendChatTurn } from '../services/sessionCrud';
import { finalizeSessionById } from '../services/sessionPipeline';
import { buildFullPersonaFromFiles } from '../services/personaLoader';
import { chatWithVisitor } from '../chat/sessionOrchestrator';
import { generateMockHumanReply, submitMockThoughtRecord } from './mockHuman';
import { eq, desc } from 'drizzle-orm';

async function seedNewInstance(): Promise<{ visitorInstanceId: string }> {
  const db = createDb();
  // 确保存在 template key=1
  let [tpl] = await db.select().from(visitorTemplates).where(eq(visitorTemplates.templateKey as any, '1')).limit(1);
  if (!tpl) {
    const templateId = crypto.randomUUID();
    await db.insert(visitorTemplates).values({ id: templateId, templateKey: '1', name: '1', brief: 'e2e', corePersona: {}, chatPrinciple: 'see prompts', createdAt: new Date(), updatedAt: new Date() } as any);
    [tpl] = await db.select().from(visitorTemplates).where(eq(visitorTemplates.templateKey as any, '1')).limit(1);
  }
  const userId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `e2e_${Date.now()}@example.com`, createdAt: new Date(), updatedAt: new Date() } as any);
  const instanceId = crypto.randomUUID();
  await db.insert(visitorInstances).values({ id: instanceId, userId, templateId: (tpl as any).id, longTermMemory: {}, createdAt: new Date(), updatedAt: new Date() } as any);
  return { visitorInstanceId: instanceId };
}

export async function runE2EPrdFlow() {
  const { visitorInstanceId } = await seedNewInstance();
  const db = createDb();

  for (let sNo = 1; sNo <= 3; sNo++) {
    // 改为后端自动分配 sessionNumber
    const out = await import('../services/sessionCrud');
    const { createSessionAuto } = out as any;
    const { sessionId, sessionNumber } = await createSessionAuto(visitorInstanceId);

    // 取 persona 组装对话
    const [ins] = await db.select().from(visitorInstances).where(eq(visitorInstances.id, visitorInstanceId));
    const [tpl] = await db.select().from(visitorTemplates).where(eq(visitorTemplates.id, ins!.templateId));
    const coreKey = (tpl as any).templateKey || (tpl as any).name || '1';
    const persona = await buildFullPersonaFromFiles({ visitorTypeKey: coreKey, longTermMemory: JSON.stringify(ins!.longTermMemory ?? {}) });

    // 本次 session 内做若干轮对话
    let lastAi = '';
    for (let turn = 0; turn < 4; turn++) {
      const human = await generateMockHumanReply({ lastAssistantMsg: lastAi });
      await appendChatTurn({ sessionId, speaker: 'user', content: human });
      const ai = await chatWithVisitor({ persona, messages: [{ role: 'user', content: human }] });
      lastAi = ai;
      await appendChatTurn({ sessionId, speaker: 'ai', content: ai });
    }

    // 作业（字符串）
    const assignment = '记录一周的自动化思维（场景、想法、情绪、证据、反证）';
    // 结束会话：生成日记/活动并更新 LTM
    await finalizeSessionById({ sessionId, assignment });
    // 模拟人类填写三联表
    await submitMockThoughtRecord(sessionId);
    console.log(`Session ${sessionNumber} finalized.`);
  }

  // 打印最后一条 session 摘要
  const rows = await db.select().from(sessions).where(eq(sessions.visitorInstanceId, visitorInstanceId)).orderBy(desc(sessions.sessionNumber));
  const last = rows[0];
  console.log('Last session diary head:', String(last.sessionDiary ?? '').slice(0, 120) + '...');
}

// 直接执行
runE2EPrdFlow().catch((e) => { console.error(e); process.exit(1); });


