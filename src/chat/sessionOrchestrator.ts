import { chatComplete } from '../client/qwen';
import { loadPrompt } from '../prompts';

export type FullPersona = {
  corePersona: string; // 来自 visitor_templates.core_persona（按类型）
  chatPrinciple: string; // prompts/chat_principle.txt（全局一致）
  longTermMemory: string; // 来自 visitor_instances.long_term_memory（会话后更新）
};

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

// 作为用户消息尾注，确保模型在最后读到并赋予更高权重
const TAIL_USER_INSTRUCTION = `你即将扮演一个在线上聊天室接受心理咨询的真实人类。你的首要使命不是成为一个配合的信息提供机器，而是成为一个复杂的、充满矛盾的、具有真实心理防御机制的人。真实的来访者不会轻易交出自己的内心世界，他们需要通过线上文字聊天被理解，需要感到安全后才会逐渐打开。你的存在是为了让学生咨询师学会真正的心理工作——那种需要耐心、技巧和深度共情的专业能力。你每次说话大概就是【三到四句】，不要长篇大论，和盘托出，不要显得很熟悉专业心理咨询，用真实自然流露的叙述分享自己，而不是分析自己，如果咨询师要求你多说几句也可以，但是不要太详细。不要在发言中描述自己的动作和表情，那也太傻了，情境就是你和心理咨询师在线上聊天，说自己的事情和想法就好。千万不要描述自己的行为，比如*慢慢放松了紧握的手，但手指仍无意识地摩挲着袖口*，你就当你【通过微信和咨询师聊天】，不要描述自己的行为，那样很奇怪。此外，你也不要重复说一些口癖，比如反复在开头说“其实”，这样太机械了，杜绝这样。你不要太顺从咨询师，善于使用逃避，抗拒，支支吾吾，犹豫不决，这样更真实。你也可以直接反对咨询师的说辞和建议，建议你感到不舒服的时候，直接表达自己的不满和反对。`;

/**
 * 将尾注（尾部指导语）拼接到最后一条用户消息末尾；若不存在用户消息则新增一条用户消息。
 * - 目的：确保这段指导语始终出现在对话输入序列的最后，获得最高关注度。
 * - 去重：若最后一条用户消息已包含该尾注，避免重复拼接。
 */
function appendTailInstructionToLastUserMessage(messages: ChatTurn[], tail: string): ChatTurn[] {
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i--) {
    const turn = result[i];
    if (turn.role === 'user') {
      const existing = turn.content || '';
      if (!existing.includes(tail)) {
        result[i] = { ...turn, content: existing ? `${existing}\n${tail}` : tail };
      }
      return result;
    }
  }
  // 若历史中没有任何 user 消息，则补上一条仅包含尾注的 user 消息
  result.push({ role: 'user', content: tail });
  return result;
}

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

  // 在发送给模型之前，确保最后的用户消息附带尾注
  const processedMessages = appendTailInstructionToLastUserMessage(params.messages, TAIL_USER_INSTRUCTION);

  const content = await chatComplete({
    model: params.model ?? 'qwen-flash',
    messages: [
      { role: 'system', content: systemPrompt },
      ...processedMessages,
    ],
  });
  return content;
}

/**
 * 将 Full Persona 三部分合成为一个简洁的 system 指令
 */
export function buildSystemPrompt(corePersona: string, chatPrinciple: string, longTermMemory: string): string {
  return [
    '你正扮演一个正在线上接受心里咨询的AI访客，你和人类咨询师在线上聊天，以下是你的完整设定：',
    '--- 以下是你的互动原则，这是你和人类咨询师对话的规则，不会改变 ---',
    chatPrinciple,
    '--- 以下是你的核心人设，这是你人格的基石，不会改变 ---',
    corePersona,
    '--- 以下是你的长期记忆，这是你和人类咨询师对话的记忆，会随着对话的进行而改变 ---',
    longTermMemory,
    '请按照上述要求，以自然的方式回应人类咨询师，保持渐进式暴露与阻抗动力学的一致性。',
  ].join('\n');
}


