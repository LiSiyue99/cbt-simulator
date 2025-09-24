import { createDb } from '../db/client';
import { users, sessions, thoughtRecords, assistantFeedbacks, assistantStudents, weeklyCompliance, visitorInstances } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getBeijingNow, formatWeekKey, getStudentDeadline, getAssistantDeadline } from '../policy/timeWindow';

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

      const trRows = await db.select().from(thoughtRecords).where(eq(thoughtRecords.sessionId as any, (sessRows[0] as any)?.id));
      hasThoughtRecordByFri = trRows.some((r: any) => new Date(r.createdAt) <= studentDeadline) ? 1 : 0;

      const binds = await db.select().from(assistantStudents).where(eq(assistantStudents.studentId as any, (stu as any).id));
      assistantId = (binds[0] as any)?.assistantId || null;

      if (sessRows.length) {
        const fbRows = await db.select().from(assistantFeedbacks).where(eq(assistantFeedbacks.sessionId as any, (sessRows[0] as any).id));
        hasAnyFeedbackBySun = fbRows.some((r: any) => new Date(r.createdAt) <= assistantDeadline) ? 1 : 0;
      }

      // 锁定逻辑：过了周五且未提交三联表
      if (getBeijingNow() > studentDeadline && hasThoughtRecordByFri === 0) locked = 1;
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
