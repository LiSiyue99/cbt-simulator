import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

/**
 * 创建 Drizzle DB 客户端
 */
export function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('缺少 DATABASE_URL');
  const pool = new Pool({ connectionString: url });
  return drizzle(pool);
}


