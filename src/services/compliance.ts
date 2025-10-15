import { createDb } from '../db/client';
import { users, sessions, assistantStudents, weeklyCompliance, visitorInstances, assistantChatMessages, homeworkSubmissions } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getBeijingNow, formatWeekKey, getStudentDeadline, getAssistantDeadline, getSessionOverrideUntil } from '../policy/timeWindow';

export async function computeClassWeekCompliance(classId: number, weekKey?: string) {
  const db = createDb();
  const now = getBeijingNow();
  const wk = weekKey || formatWeekKey(now);
  const studentDeadline = getStudentDeadline(wk);
  const assistantDeadline = getAssistantDeadline(wk);

  // 本班学生
  const students = await db.select().from(users).where(and(eq(users.classId as any, classId), eq(users.role as any, 'student')));
  for (const stu of students as any[]) {
    // 找到该学生实例
    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (stu as any).id));
    let hasSession = 0;
    let hasThoughtRecordByFri = 0;
    let hasAnyFeedbackBySun = 0;
    let locked = 0;
    let assistantId: string | null = null;

    if (inst) {
      const sessRows = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, (inst as any).id));
      hasSession = sessRows.length > 0 ? 1 : 0;

      const trRows = await db.select().from(homeworkSubmissions).where(eq(homeworkSubmissions.sessionId as any, (sessRows[0] as any)?.id));
      // 会话级覆盖优先
      let effStudentDeadline = studentDeadline;
      if (sessRows[0]) {
        const over = await getSessionOverrideUntil((sessRows[0] as any).id, 'extend_student_tr');
        if (over) effStudentDeadline = over;
      }
      hasThoughtRecordByFri = trRows.some((r: any) => new Date(r.createdAt) <= effStudentDeadline) ? 1 : 0;

      const binds = await db.select().from(assistantStudents).where(eq(assistantStudents.studentId as any, (stu as any).id));
      assistantId = (binds[0] as any)?.assistantId || null;

      // 助教反馈改为“助教发送过至少一条消息”
      if (sessRows.length) {
        const chatRows = await db.select().from(assistantChatMessages).where(and(
          eq(assistantChatMessages.sessionId as any, (sessRows[0] as any).id),
          eq(assistantChatMessages.senderRole as any, 'assistant_tech' as any)
        ));
        let effAssistantDeadline = assistantDeadline;
        const over2 = await getSessionOverrideUntil((sessRows[0] as any).id, 'extend_assistant_feedback');
        if (over2) effAssistantDeadline = over2;
        hasAnyFeedbackBySun = chatRows.some((r: any) => new Date(r.createdAt) <= effAssistantDeadline) ? 1 : 0;
      }

      // 锁定逻辑：过了周五且未提交作业
      let lockCheckDeadline = studentDeadline;
      if (sessRows[0]) {
        const over = await getSessionOverrideUntil((sessRows[0] as any).id, 'extend_student_tr');
        if (over) lockCheckDeadline = over;
      }
      if (getBeijingNow() > lockCheckDeadline && hasThoughtRecordByFri === 0) locked = 1;
    }

    await db.insert(weeklyCompliance).values({
      id: crypto.randomUUID(),
      weekKey: wk,
      classId,
      studentId: (stu as any).id,
      assistantId: assistantId || null as any,
      hasSession,
      hasThoughtRecordByFri,
      hasAnyFeedbackBySun,
      locked,
      computedAt: new Date(),
    } as any);
  }
}
