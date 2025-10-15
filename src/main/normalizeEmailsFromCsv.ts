import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { createDb } from '../db/client';
import { users, whitelistEmails } from '../db/schema';
import { eq } from 'drizzle-orm';

function cleanEmail(e: string): string {
  return (e || '')
    .replace(/[\u2000-\u200B\u3000]/g, '') // 常见零宽/全角空白
    .trim()
    .toLowerCase();
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

async function main() {
  const csvFile = process.argv[2];
  if (!csvFile) throw new Error('Usage: tsx src/main/normalizeEmailsFromCsv.ts <csv_file_path>');
  const rows = await readCsv(path.resolve(csvFile));
  const db = createDb();

  // 读取现有 users/whitelist
  const allUsers = await db.select().from(users);
  const lowerToUser = new Map<string, any>();
  for (const u of allUsers as any[]) lowerToUser.set(String((u as any).email || '').toLowerCase(), u);

  const allWhite = await db.select().from(whitelistEmails);
  const lowerToWhite = new Map<string, any>();
  for (const w of allWhite as any[]) lowerToWhite.set(String((w as any).email || '').toLowerCase(), w);

  const ops = { usersUpdated: 0, whitelistUpdated: 0 };

  for (const r of rows) {
    const raw = String(r.email || '');
    if (!raw) continue;
    const cleaned = cleanEmail(raw);

    // users 表：若存在大小写不同，则更新为小写
    const u = lowerToUser.get(cleaned);
    if (u && (u as any).email !== cleaned) {
      await db.update(users).set({ email: cleaned } as any).where(eq(users.id as any, (u as any).id));
      ops.usersUpdated += 1;
    }

    // whitelist_emails：若存在大小写不同，则更新 PK 为小写
    const w = lowerToWhite.get(cleaned);
    if (w && (w as any).email !== cleaned) {
      await db.update(whitelistEmails).set({ email: cleaned } as any).where(eq(whitelistEmails.email as any, (w as any).email));
      ops.whitelistUpdated += 1;
    }
  }

  const outDir = path.resolve('.reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'normalize-emails.out.json'), JSON.stringify(ops, null, 2));
  console.log(JSON.stringify(ops));
}

main().catch((e)=>{ console.error(e); process.exit(1); });
