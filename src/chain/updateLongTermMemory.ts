import { chatComplete } from '../client/qwen';
import { loadPrompt } from '../prompts';
import { extractXmlTag, extractXmlTags } from '../utils/xml';
import { withRetry } from '../utils/retry';

export type UpdateLtmInput = {
  longtermMemoryCurrent: string; // 现有 LTM（XML或文本）
  latestDiaryEntry: string; // 最新日记
  latestActivityLog: string; // 活动日志（应为 JSON 字符串）
};

export type UpdateLtmOutput = {
  scratchpad: string | null;
  longtermMemory: {
    thisweek_focus: string;
    discussed_topics: string;
    milestones: string;
    recurring_patterns: string;
    core_belief_evolution: string;
  };
};

/**
 * 调用 longterm_memory 提示词，解析 <longterm_memory> 下各子标签。
 */
export async function updateLongTermMemory(input: UpdateLtmInput): Promise<UpdateLtmOutput> {
  const tpl = await loadPrompt('longterm_memory');
  const filled = tpl
    .replace('{{longterm_memory_current}}', input.longtermMemoryCurrent)
    .replace('{{latest_diary_entry}}', input.latestDiaryEntry)
    .replace('{{latest_activity_log}}', input.latestActivityLog);

  const content = await withRetry(
    async () =>
      chatComplete({
        messages: [
          {
            role: 'system',
            content:
              '你是一个严格遵循输出格式的助手。必须严格输出<scratchpad>与<longterm_memory>两段，且<longterm_memory>内包含<thisweek_focus>、<discussed_topics>、<milestones>、<recurring_patterns>、<core_belief_evolution>五个子标签，任何一个都不能为空；若确实没有内容，请写“无”。禁止输出除这些标签外的多余解释或前后缀。',
          },
          { role: 'user', content: filled },
        ],
      }),
    (text) => {
      const xml = extractXmlTag(text, 'longterm_memory');
      if (!xml) return false;
      const p = extractXmlTags(xml, [
        'thisweek_focus',
        'discussed_topics',
        'milestones',
        'recurring_patterns',
        'core_belief_evolution',
      ]);
      return Object.values(p).every((v) => typeof v === 'string');
    }
  );

  const scratchpad = extractXmlTag(content, 'scratchpad');
  const ltmXml = extractXmlTag(content, 'longterm_memory') ?? '';
  const parts = extractXmlTags(ltmXml, [
    'thisweek_focus',
    'discussed_topics',
    'milestones',
    'recurring_patterns',
    'core_belief_evolution',
  ]);
  // 尝试解析旧版 LTM，便于缺失时回填
  let prev: Partial<Record<keyof UpdateLtmOutput['longtermMemory'], string>> = {};
  try {
    const parsed = JSON.parse(input.longtermMemoryCurrent || '{}');
    if (parsed && typeof parsed === 'object') prev = parsed;
  } catch (_) {}

  const normalize = (k: keyof UpdateLtmOutput['longtermMemory']): string => {
    const v = (parts[k] ?? '').trim();
    if (v) return v;
    const pv = (prev[k] ?? '').toString();
    return pv || '无';
  };

  return {
    scratchpad,
    longtermMemory: {
      thisweek_focus: normalize('thisweek_focus'),
      discussed_topics: normalize('discussed_topics'),
      milestones: normalize('milestones'),
      recurring_patterns: normalize('recurring_patterns'),
      core_belief_evolution: normalize('core_belief_evolution'),
    },
  };
}


