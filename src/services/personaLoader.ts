import { readTextFile } from '../utils/file';
import { loadPrompt } from '../prompts';
import { FullPersona } from '../chat/sessionOrchestrator';

/**
 * 从 core_persona/{key}.txt 读取核心人设。
 * 兼容 fallback: 若 core_persona 不存在，尝试 origin_persona。
 */
export async function readCorePersonaByKey(key: string): Promise<string> {
  try {
    return await readTextFile(`core_persona/${key}.txt`);
  } catch (_) {
    // fallback 到历史目录名
    return await readTextFile(`origin_persona/${key}.txt`);
  }
}

/**
 * 基于文件与持久化的 LTM 构建 Full Persona
 */
export async function buildFullPersonaFromFiles(params: {
  visitorTypeKey: string; // "1".."10"
  longTermMemory: string; // 最新 LTM 文本
}): Promise<FullPersona> {
  const corePersona = await readCorePersonaByKey(params.visitorTypeKey);
  const chatPrinciple = await loadPrompt('chat_principle');
  return {
    corePersona,
    chatPrinciple,
    longTermMemory: params.longTermMemory,
  };
}


