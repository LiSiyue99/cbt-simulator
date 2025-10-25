import { chatComplete } from '../client/qwen';
import { loadPrompt } from '../prompts';
import { extractXmlTag } from '../utils/xml';
import { withRetry } from '../utils/retry';

export type GenerateActivityInput = {
  corePersona: string;
  longTermMemory: string; // 最新 LTM（文本/JSON 字符串）
  sessionChat: string;
  assignment: string;
};

export type GenerateActivityOutput = {
  scratchpad: string | null;
  activityJson: string; // JSON string
};

/**
 * 基于 core persona / latest LTM / chat / assignment 生成一周活动日志。
 * prompt 要求输出 <scratchpad> 与 <activity>，其中 activity 为 JSON 文本。
 */
export async function generateActivity(input: GenerateActivityInput): Promise<GenerateActivityOutput> {
  const tpl = await loadPrompt('activity_generation');
  const filled = tpl
    .replace('{{core_persona}}', input.corePersona)
    .replace('{{longterm_memory}}', input.longTermMemory)
    .replace('{{session_chat}}', input.sessionChat)
    .replace('{{assignment}}', input.assignment);

  const content = await withRetry(
    async () =>
      chatComplete({
        messages: [
          { role: 'system', content: '你是格式严格的助手，必须按要求输出<scratchpad>与<activity>，其中<activity>内部包裹的为合法JSON文本。' },
          { role: 'user', content: filled },
        ],
      }),
    (text) => {
      const json = extractXmlTag(text, 'activity');
      if (!json) return false;
      try { JSON.parse(json); return true; } catch { return false; }
    }
  );

  const scratchpad = extractXmlTag(content, 'scratchpad');
  const activity = extractXmlTag(content, 'activity') ?? content.trim();
  return { scratchpad, activityJson: activity };
}


