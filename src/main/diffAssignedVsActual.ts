import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { createDb } from '../db/client';
import { users, visitorInstances, visitorTemplates } from '../db/schema';
import { eq } from 'drizzle-orm';

function cleanEmail(e: string): string { return (e||'').replace(/[\u2000-\u200B\u3000]/g,'').trim().toLowerCase(); }
function normKey(v: any): string | null { const m = String(v||'').trim().match(/(\d{1,2})/); return m ? String(Number(m[1])) : null; }

async function readCsv(filePath: string): Promise<any[]> {
  const content = fs.readFileSync(filePath, 'utf8');
  return new Promise((resolve, reject) => {
    parse(content, { columns: true, trim: true, relaxQuotes: true, skipEmptyLines: true, bom: true }, (err, records: any[]) => {
      if (err) return reject(err);
      resolve(records);
    });
  });
}

async function main() {
  const csvFile = process.argv[2];
  if (!csvFile) throw new Error('Usage: tsx src/main/diffAssignedVsActual.ts <csv_file_path>');
  const rows = await readCsv(path.resolve(csvFile));
  const db = createDb();

  // 模板映射
  const tplRows = await db.select().from(visitorTemplates);
  const templateIdToKey = new Map<string,string>();
  for (const t of tplRows as any[]) templateIdToKey.set((t as any).id, (t as any).templateKey);

  const diffs: Array<{ name: string|null; email: string; assigned: string|null; actual: string|null }>=[];
  const ok: Array<{ name: string|null; email: string; templateKey: string }>=[];

  for (const r of rows) {
    if (String(r.role).trim() !== 'student') continue;
    const email = cleanEmail(r.email);
    const assigned = normKey(r.assignedVisitor);

    const [u] = await db.select().from(users).where(eq(users.email as any, email));
    if (!u) { diffs.push({ name: r.name||null, email, assigned, actual: null }); continue; }

    const instRows = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (u as any).id));
    const keys = new Set<string>();
    for (const iv of instRows as any[]) { const k = templateIdToKey.get((iv as any).templateId); if (k) keys.add(k); }
    const actual = keys.size ? Array.from(keys)[0] : null; // 清理后应仅 1 个

    if (!assigned || !actual || assigned !== actual) {
      diffs.push({ name: (u as any).name || r.name || null, email, assigned, actual });
    } else {
      ok.push({ name: (u as any).name || r.name || null, email, templateKey: actual });
    }
  }

  const outDir = path.resolve('.reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'assigned-vs-actual.diff.json'), JSON.stringify({ diffs, okCount: ok.length, diffCount: diffs.length }, null, 2));

  // CSV for diffs
  const csvHeader = 'name,email,assigned,actual\n';
  const csvBody = diffs.map(d => `${d.name||''},${d.email},${d.assigned||''},${d.actual||''}`).join('\n');
  fs.writeFileSync(path.join(outDir, 'assigned-vs-actual.diff.csv'), csvHeader + csvBody + '\n');

  console.log(JSON.stringify({ ok: ok.length, diff: diffs.length }));
}

main().catch((e)=>{ console.error(e); process.exit(1); });
