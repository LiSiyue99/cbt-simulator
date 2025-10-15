import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { createDb } from '../db/client';
import { users, visitorInstances, visitorTemplates } from '../db/schema';
import { eq } from 'drizzle-orm';

/**
 * 强制“一生一模板”：按 CSV 的 assignedVisitor 为准，删除学生多余实例
 * 影响：删除非目标模板的 visitor_instances（将级联删除 sessions/ltm_versions/assistant_students 等外键关联）
 * 输出：.reports/cleanup-instances-report.json
 *
 * 用法：
 * npx tsx src/main/cleanupWrongInstances.ts assigned-output.csv [--dry-run]
 */

// SAFETY GUARD: disabled by default to avoid accidental destructive runs
if (process.env.ALLOW_DANGEROUS_SCRIPTS !== 'true') {
  console.error('Disabled: set ALLOW_DANGEROUS_SCRIPTS=true to run cleanupWrongInstances');
  process.exit(1);
}

async function readCsv(filePath: string): Promise<any[]> {
  const content = fs.readFileSync(filePath, 'utf8');
  return new Promise((resolve, reject) => {
    parse(content, { columns: true, trim: true, relaxQuotes: true, skipEmptyLines: true, bom: true }, (err, records: any[]) => {
      if (err) return reject(err);
      resolve(records);
    });
  });
}

function normalizeTemplateKey(v: any): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  const m = s.match(/(\d{1,2})/);
  return m ? String(Number(m[1])) : null;
}

async function main() {
  const csvFile = process.argv[2];
  if (!csvFile) throw new Error('Usage: tsx src/main/cleanupWrongInstances.ts <csv_file_path> [--dry-run]');
  const dryRun = process.argv.includes('--dry-run');
  const rows = await readCsv(path.resolve(csvFile));
  const db = createDb();

  // 模板映射
  const tplRows = await db.select().from(visitorTemplates);
  const templateIdToKey = new Map<string, string>();
  const templateKeyToId = new Map<string, string>();
  for (const t of tplRows as any[]) {
    templateIdToKey.set((t as any).id, (t as any).templateKey);
    templateKeyToId.set((t as any).templateKey, (t as any).id);
  }

  // 学生 desired 模板
  const desiredByEmail = new Map<string, string>();
  for (const r of rows) {
    if (String(r.role).trim() !== 'student') continue;
    const k = normalizeTemplateKey(r.assignedVisitor);
    if (!k) continue;
    desiredByEmail.set(String(r.email).trim().toLowerCase(), k);
  }

  const report = {
    dryRun,
    totalStudentsInCsv: Array.from(desiredByEmail.keys()).length,
    processed: 0,
    createdInstances: 0,
    deletedInstances: 0,
    items: [] as Array<{ email: string; keptInstanceId: string; keptTemplateKey: string; deletedInstanceIds: string[] }>,
    skippedNoUser: [] as string[],
    errors: [] as Array<{ email: string; error: string }>,
  };

  for (const [email, desiredKey] of desiredByEmail.entries()) {
    try {
      const [u] = await db.select().from(users).where(eq(users.email as any, email));
      if (!u) { report.skippedNoUser.push(email); continue; }
      const userId = (u as any).id as string;

      const instRows = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, userId));

      // 选择保留实例：优先已有目标模板的任意一个；若无则创建一个
      let keepInstanceId: string | null = null;
      for (const iv of instRows as any[]) {
        const key = templateIdToKey.get((iv as any).templateId);
        if (key === desiredKey) { keepInstanceId = (iv as any).id; break; }
      }
      if (!keepInstanceId) {
        if (!dryRun) {
          const templateId = templateKeyToId.get(desiredKey);
          if (!templateId) throw new Error(`templateKey ${desiredKey} not found`);
          const id = crypto.randomUUID();
          await db.insert(visitorInstances).values({
            id,
            userId,
            templateId,
            longTermMemory: {
              thisweek_focus: '无',
              discussed_topics: '无',
              milestones: '无',
              recurring_patterns: '无',
              core_belief_evolution: '无',
            } as any,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any);
          keepInstanceId = id;
          report.createdInstances += 1;
        } else {
          // dry-run: 假设新建一个占位ID
          keepInstanceId = 'DRYRUN_NEW_INSTANCE';
        }
      }

      // 计算要删除的实例（除保留外全部删除）
      const toDelete = (instRows as any[]).filter(iv => (iv as any).id !== keepInstanceId).map(iv => (iv as any).id as string);
      if (!dryRun && toDelete.length) {
        // 逐个删除（级联）
        for (const id of toDelete) {
          await (db as any).delete(visitorInstances).where(eq(visitorInstances.id as any, id));
          report.deletedInstances += 1;
        }
      }

      report.items.push({ email, keptInstanceId: keepInstanceId!, keptTemplateKey: desiredKey, deletedInstanceIds: toDelete });
      report.processed += 1;
    } catch (e:any) {
      report.errors.push({ email, error: e?.message || String(e) });
    }
  }

  const outDir = path.resolve('.reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'cleanup-instances-report.json'), JSON.stringify(report, null, 2));
  console.log('Wrote report:', path.join(outDir, 'cleanup-instances-report.json'));
}

main().catch((e)=>{ console.error(e); process.exit(1); });
