import 'dotenv/config';
import OpenAI from 'openai';

/**
 * 创建一个 OpenAI 兼容客户端（指向阿里云 DashScope 兼容模式）
 */
export function createQwenClient(): OpenAI {
  if (!process.env.DASHSCOPE_API_KEY) {
    throw new Error('缺少 DASHSCOPE_API_KEY');
  }
  return new OpenAI({
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  });
}

/**
 * 发送对话消息并返回字符串内容
 */
export async function chatComplete(params: {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
}): Promise<string> {
  const client = createQwenClient();
  const completion = await client.chat.completions.create({
    model: params.model ?? 'qwen-flash',
    messages: params.messages,
  });
  return completion.choices[0].message.content ?? '';
}


