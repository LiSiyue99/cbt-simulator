import { chatComplete } from '../client/qwen';
import { loadPrompt } from '../prompts';

export type FullPersona = {
  corePersona: string; // 来自 visitor_templates.core_persona（按类型）
  chatPrinciple: string; // prompts/chat_principle.txt（全局一致）
  longTermMemory: string; // 来自 visitor_instances.long_term_memory（会话后更新）
};

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

/**
 * 负责与用户交互的编排入口：
 * - 统一构建 Full Persona（core + principle + latest LTM）
 * - 以 system 指令注入 persona
 * - 调用 Qwen 完成单轮回复
 */
export async function chatWithVisitor(params: {
  persona: FullPersona;
  messages: ChatTurn[]; // 不含 system
  model?: string;
}): Promise<string> {
  const principle = params.persona.chatPrinciple || (await loadPrompt('chat_principle'));
  const systemPrompt = buildSystemPrompt(params.persona.corePersona, principle, params.persona.longTermMemory);

  const content = await chatComplete({
    model: params.model ?? 'qwen-flash',
    messages: [
      { role: 'system', content: systemPrompt },
      ...params.messages,
    ],
  });
  return content;
}

/**
 * 将 Full Persona 三部分合成为一个简洁的 system 指令
 */
export function buildSystemPrompt(corePersona: string, chatPrinciple: string, longTermMemory: string): string {
  return [
    '你正扮演一个正在接受CBT咨询的AI访客，你和人类咨询师的对话即将/已经进行了好几周，以下是你的完整人格设定：',
    '--- 以下是你的核心人设，这是你人格的基石，不会改变 ---',
    corePersona,
    '--- 以下是你的互动原则，这是你和人类咨询师对话的规则，不会改变 ---',
    chatPrinciple,
    '--- 以下是你的长期记忆，这是你和人类咨询师对话的记忆，会随着对话的进行而改变 ---',
    longTermMemory,
    '请按照上述要求，以自然的方式回应人类咨询师，保持渐进式暴露与阻抗动力学的一致性。',
  ].join('\n');
}


