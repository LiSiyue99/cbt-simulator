import 'dotenv/config';
import { createDb } from '../db/client';

async function check() {
  const db = createDb();
  const tables = [
    'audit_logs',
    'deadline_overrides',
    'session_deadline_overrides',
    'system_configs',
    'assistant_chat_messages',
    'homework_sets',
    'homework_submissions',
    'whitelist_emails',
  ];
  const indexes = [
    ['deadline_overrides', 'deadline_overrides_subject_week_idx'],
    ['deadline_overrides', 'deadline_overrides_week_idx'],
    ['session_deadline_overrides', 'session_deadline_overrides_session_idx'],
    ['homework_submissions', 'homework_submissions_session_uq'],
    ['homework_submissions', 'homework_submissions_set_idx'],
    ['homework_submissions', 'homework_submissions_student_idx'],
    ['assistant_chat_messages', 'assistant_chat_messages_session_idx'],
    ['assistant_chat_messages', 'assistant_chat_messages_sender_idx'],
    ['assistant_chat_messages', 'assistant_chat_messages_status_idx'],
    ['whitelist_emails', 'whitelist_assigned_visitor_idx'],
  ];

  const existsTable = async (name: string) => {
    const rows = await db.execute<any>(`SELECT to_regclass('public.${name}') AS reg` as any);
    const reg = (rows as any)?.[0]?.reg;
    return Boolean(reg);
  };

  const existsIndex = async (table: string, index: string) => {
    const rows = await db.execute<any>(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='${table}' AND indexname='${index}'` as any
    );
    return (rows as any)?.length > 0;
  };

  console.log('=== Tables ===');
  for (const t of tables) {
    const ok = await existsTable(t);
    console.log(`${t}: ${ok ? 'OK' : 'MISSING'}`);
  }

  console.log('=== Indexes ===');
  for (const [table, index] of indexes) {
    const ok = await existsIndex(table, index);
    console.log(`${index} on ${table}: ${ok ? 'OK' : 'MISSING'}`);
  }
}

check().catch((e) => { console.error(e); process.exit(1); });