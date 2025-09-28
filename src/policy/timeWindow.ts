export function getBeijingNow(): Date {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

export function formatWeekKey(d: Date): string {
  // ISO week-like simple approach: year-weekNumber based on Monday start
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) as any;
  // set to nearest Thursday
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1)) as any;
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

export function getStudentDeadline(weekKey: string): Date {
  // 周五 24:00 北京时间
  const [year, ww] = weekKey.split('-').map(Number);
  return endOfWeekdayBeijing(year, ww, 5);
}

export function getAssistantDeadline(weekKey: string): Date {
  // 周日 24:00 北京时间
  const [year, ww] = weekKey.split('-').map(Number);
  return endOfWeekdayBeijing(year, ww, 7);
}

// 学生窗口开放时间：周二 00:00 （北京时间）
export function getStudentOpenTime(weekKey: string): Date {
  const [year, ww] = weekKey.split('-').map(Number);
  // Tuesday is weekday=2
  const [openYear, openWw] = [year, ww];
  const monday = endOfWeekdayBeijing(openYear, openWw, 1); // Monday 24:00 = Tuesday 00:00
  // endOfWeekdayBeijing(weekday=1) returns Monday 24:00 (next day 00:00)
  return monday; // 即周二 00:00
}

// 读取系统配置的“学生窗口开启 weekday”（1..7），默认 2（周二）。
export async function getConfiguredStudentOpenTime(weekKey: string): Promise<Date> {
  try {
    const { createDb } = await import('../db/client');
    const { systemConfigs } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const db = createDb();
    const [row] = await db.select().from(systemConfigs).where(eq(systemConfigs.key as any, 'student_open_weekday' as any));
    const wk = Number((row as any)?.value || 2);
    const [year, ww] = weekKey.split('-').map(Number);
    // open at weekday W 00:00 => previous day 24:00
    const prev = wk === 1 ? 7 : (wk - 1);
    return endOfWeekdayBeijing(year, ww, prev);
  } catch {
    return getStudentOpenTime(weekKey);
  }
}

// 会话级覆盖：若存在，返回 until，否则返回 null
export async function getSessionOverrideUntil(sessionId: string, action: 'extend_student_tr' | 'extend_assistant_feedback'): Promise<Date | null> {
  const { createDb } = await import('../db/client');
  const { sessionDeadlineOverrides } = await import('../db/schema');
  const { eq, and, desc } = await import('drizzle-orm');
  const db = createDb();
  const rows = await db.select().from(sessionDeadlineOverrides).where(and(eq(sessionDeadlineOverrides.sessionId as any, sessionId), eq(sessionDeadlineOverrides.action as any, action))).orderBy(desc(sessionDeadlineOverrides.createdAt as any)).limit(1);
  return (rows as any[]).length ? new Date((rows[0] as any).until) : null;
}

/**
 * 按周级的学生豁免查询。
 * 场景：管理员在“周级 DDL 解锁”中为某学生创建 `extend_student_tr` 记录时，
 *       我们希望该豁免同时放开“开始新会话”的周五锁定限制。
 * 返回：若存在匹配记录，返回其 until 时间；否则返回 null。
 */
export async function getWeeklyOverrideUntil(subjectUserId: string, weekKey: string, action: 'extend_student_tr' | 'extend_assistant_feedback'): Promise<Date | null> {
  const { createDb } = await import('../db/client');
  const { deadlineOverrides } = await import('../db/schema');
  const { eq, and, desc } = await import('drizzle-orm');
  const db = createDb();
  const rows = await db
    .select()
    .from(deadlineOverrides)
    .where(and(
      eq(deadlineOverrides.subjectId as any, subjectUserId),
      eq(deadlineOverrides.weekKey as any, weekKey),
      eq(deadlineOverrides.action as any, action)
    ))
    .orderBy(desc(deadlineOverrides.createdAt as any))
    .limit(1);
  return (rows as any[]).length ? new Date((rows[0] as any).until) : null;
}

function endOfWeekdayBeijing(year: number, weekNo: number, weekday: number): Date {
  // weekday: 1..7 => Mon..Sun; return that day's 24:00 (next day 00:00)
  const firstThursday = new Date(Date.UTC(year, 0, 1)) as any;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + ((4 - (firstThursday.getUTCDay() || 7))));
  const weekStart = new Date(firstThursday) as any;
  weekStart.setUTCDate(weekStart.getUTCDate() + (weekNo - 1) * 7 - 3); // Monday of week
  const target = new Date(weekStart) as any;
  target.setUTCDate(target.getUTCDate() + (weekday - 1) + 1); // next day 00:00
  // shift to Beijing
  const ts = target.getTime();
  const withTZ = ts + 8 * 3600000;
  return new Date(withTZ);
}
