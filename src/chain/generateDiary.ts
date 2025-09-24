import { chatComplete } from '../client/qwen';
import { loadPrompt } from '../prompts';
import { extractXmlTag } from '../utils/xml';
import { withRetry } from '../utils/retry';

export type GenerateDiaryInput = {
  personaBlueprint: string;
  diaryHistory: string; // 可为空
  sessionChat: string;
};

export type GenerateDiaryOutput = {
  diary: string;
};

/**
 * 基于 persona/历史/本次会话，生成 <diary>...</diary>
 */
export async function generateDiary(input: GenerateDiaryInput): Promise<GenerateDiaryOutput> {
  const tpl = await loadPrompt('diary_generation');
  const filled = tpl
    .replace('{{persona_blueprint}}', input.personaBlueprint)
    .replace('{{diary_history}}', input.diaryHistory || '')
    .replace('{{session_chat}}', input.sessionChat);

  const content = await withRetry(
    async () =>
      chatComplete({
        messages: [
          { role: 'system', content: '你是格式严格的助手，必须输出<diary>…</diary>且不可为空。' },
          { role: 'user', content: filled },
        ],
      }),
    (text) => !!extractXmlTag(text, 'diary')
  );

  const diary = extractXmlTag(content, 'diary') ?? content.trim();
  return { diary };
}


