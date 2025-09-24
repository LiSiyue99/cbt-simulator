import { extractXmlTag, extractXmlTags } from '../utils/xml';
import { updateLongTermMemory } from '../chain/updateLongTermMemory';

const sample = `
<scratchpad>thinking...</scratchpad>
<longterm_memory>
<thisweek_focus>本周聚焦：拒绝请求的练习</thisweek_focus>
<discussed_topics>作业抗拒；与主任互动</discussed_topics>
<milestones>第一次在会议上提出不同意见</milestones>
<recurring_patterns>反刍；读心术；完美主义</recurring_patterns>
<core_belief_evolution>“我必须完美”开始被挑战</core_belief_evolution>
</longterm_memory>`;

async function run() {
  // 本地提取测试
  const ltmXml = extractXmlTag(sample, 'longterm_memory')!;
  const parts = extractXmlTags(ltmXml, [
    'thisweek_focus',
    'discussed_topics',
    'milestones',
    'recurring_patterns',
    'core_belief_evolution',
  ]);
  console.log('parts:', parts);

  // 端到端：调用 updateLongTermMemory，若模型未返回字段，将回退“无”
  const out = await updateLongTermMemory({
    longtermMemoryCurrent: '{}',
    latestDiaryEntry: '<diary>test</diary>',
    latestActivityLog: '{"week_overview": "test"}',
  });
  console.log('updateLongTermMemory keys:', Object.keys(out.longtermMemory));
}

run().catch((e) => { console.error(e); process.exit(1); });


