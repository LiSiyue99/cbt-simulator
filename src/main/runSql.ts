import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * 用法：
 * npx tsx src/main/runSql.ts drizzle/0016_cleanup_whitelist.sql
 */
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: tsx src/main/runSql.ts <sql_file_path>');
  const sqlPath = path.resolve(file);
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('缺少 DATABASE_URL');

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('SQL executed successfully:', path.basename(sqlPath));
  } catch (e:any) {
    await client.query('ROLLBACK');
    console.error('SQL execution failed:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
