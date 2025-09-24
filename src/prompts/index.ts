import { readTextFile } from '../utils/file';

export async function loadPrompt(name: 'diary_generation' | 'activity_generation' | 'longterm_memory' | 'chat_principle'): Promise<string> {
  const map = {
    diary_generation: 'prompts/diary_generation.txt',
    activity_generation: 'prompts/activity_generation.txt',
    longterm_memory: 'prompts/longterm_memory.txt',
    chat_principle: 'prompts/chat_principle.txt',
  } as const;
  return await readTextFile(map[name]);
}


