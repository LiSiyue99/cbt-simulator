import 'dotenv/config';
import OpenAI from 'openai';

/**
 * 解析 DashScope 密钥列表：
 * - 优先使用 `DASHSCOPE_API_KEYS`（逗号或空白分隔），第一个为主 Key
 * - 回退到单个 `DASHSCOPE_API_KEY`
 */
let keyRingCache: string[] | null = null;
function getDashscopeKeys(): string[] {
  if (keyRingCache) return keyRingCache;
  const raw = process.env.DASHSCOPE_API_KEYS;
  if (raw && raw.trim().length > 0) {
    keyRingCache = raw
      .split(/[\,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    const single = process.env.DASHSCOPE_API_KEY;
    if (!single) {
      throw new Error('缺少 DASHSCOPE_API_KEY 或 DASHSCOPE_API_KEYS');
    }
    keyRingCache = [single];
  }
  return keyRingCache;
}

function createClientWithKey(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  });
}

/**
 * 创建一个 OpenAI 兼容客户端（指向阿里云 DashScope 兼容模式）
 * - 主 Key 优先：总是使用列表中的第一个密钥
 */
export function createQwenClient(): OpenAI {
  const keys = getDashscopeKeys();
  const primary = keys[0];
  return createClientWithKey(primary);
}

/**
 * 发送对话消息并返回字符串内容
 * - 主 Key 优先：先尝试主 Key；失败才逐个尝试备用 Key
 * - 故障切换条件：429/401/403/408/5xx/网络错误
 */
export async function chatComplete(params: {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
}): Promise<string> {
  const keys = getDashscopeKeys();
  let lastError: any = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]; // 固定顺序：主 Key 在前，备用其后
    try {
      const client = createClientWithKey(key);
      const completion = await client.chat.completions.create({
        model: params.model ?? 'qwen-flash',
        messages: params.messages,
      });
      return completion.choices[0].message.content ?? '';
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const isFailover =
        status === 429 || // 限流/配额
        status === 401 || // 未授权（密钥失效）
        status === 403 || // 禁止（密钥被封/权限不足）
        status === 408 || // 请求超时
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 || // 服务端错误
        status == null; // 网络错误或未知
      if (!isFailover) {
        throw e;
      }
      lastError = e;
      // 继续尝试下一个（备用）密钥
      continue;
    }
  }
  // 所有密钥均失败
  throw lastError ?? new Error('DashScope 所有密钥均不可用或请求失败');
}


