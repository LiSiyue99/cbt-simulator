import fs from 'node:fs/promises';
import path from 'node:path';

/** 读取文本文件（utf-8） */
export async function readTextFile(filePath: string): Promise<string> {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  return await fs.readFile(abs, 'utf-8');
}


