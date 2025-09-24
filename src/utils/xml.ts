/**
 * 从形如 <tag>...content...</tag> 的文本中提取第一个匹配内容。
 * 使用非贪婪匹配，并允许跨行。
 */
export function extractXmlTag(text: string | null | undefined, tag: string): string | null {
  if (!text) return null;
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i');
  const match = text.match(pattern);
  if (!match) return null;
  const raw = match[0];
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  return raw.slice(open.length, raw.length - close.length).trim();
}

/**
 * 批量提取多个标签
 */
export function extractXmlTags(
  text: string,
  tags: string[]
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const t of tags) out[t] = extractXmlTag(text, t);
  return out;
}


