export type ChatTurn = { speaker: 'user' | 'ai'; content: string; timestamp?: string };

/**
 * 简单内存缓冲：按 visitorInstanceId 暂存本轮会话的聊天记录。
 * - 追加阶段：仅缓存在内存，不写数据库。
 * - 结束阶段：读取缓冲，调用持久化管道写库，然后清空缓冲。
 */
class InMemoryChatStore {
  private store = new Map<string, ChatTurn[]>();

  append(visitorInstanceId: string, turn: ChatTurn) {
    const list = this.store.get(visitorInstanceId) ?? [];
    list.push({ ...turn, timestamp: turn.timestamp ?? new Date().toISOString() });
    this.store.set(visitorInstanceId, list);
  }

  get(visitorInstanceId: string): ChatTurn[] {
    return this.store.get(visitorInstanceId) ?? [];
  }

  clear(visitorInstanceId: string) {
    this.store.delete(visitorInstanceId);
  }
}

export const chatSessionStore = new InMemoryChatStore();

/** 将结构化对话转换为提示词可读的纯文本 */
export function stringifyChatHistory(turns: ChatTurn[]): string {
  return turns
    .map((t) => `${t.speaker}: ${t.content}`)
    .join('\n');
}

/**
 * 从任意存储格式生成“ai: …\nuser: …”的纯文本。
 * - 如果是数组 [{speaker, content}], 走 stringifyChatHistory
 * - 如果是字符串，直接返回
 */
export function sessionChatToString(chatHistory: unknown): string {
  if (Array.isArray(chatHistory)) {
    return stringifyChatHistory(chatHistory as ChatTurn[]);
  }
  if (typeof chatHistory === 'string') return chatHistory;
  try {
    const arr = JSON.parse(String(chatHistory));
    if (Array.isArray(arr)) return stringifyChatHistory(arr);
  } catch (_) {}
  return '';
}

/**
 * 将按行的 "ai: ...\nuser: ..." 文本解析为结构化数组。
 */
export function parseChatHistoryString(text: string): ChatTurn[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([aA][iI]|[uU]ser)\s*:\s*(.*)$/);
      if (!m) return null;
      const speaker = m[1].toLowerCase() === 'user' ? 'user' : 'ai';
      const content = m[2] ?? '';
      return { speaker, content } as ChatTurn;
    })
    .filter((x): x is ChatTurn => !!x);
}


