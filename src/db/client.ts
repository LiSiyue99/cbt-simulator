import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import fs from 'node:fs';

/**
 * 创建 Drizzle DB 客户端
 */
export function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('缺少 DATABASE_URL');
  const sslCaPath = process.env.PGSSLROOTCERT || process.env.DATABASE_SSL_CA;
  const sslConfig = sslCaPath
    ? { rejectUnauthorized: true, ca: fs.readFileSync(sslCaPath, 'utf8') }
    : undefined;
  const pool = new Pool({ connectionString: url, ssl: sslConfig });
  return drizzle(pool);
}


