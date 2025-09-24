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
