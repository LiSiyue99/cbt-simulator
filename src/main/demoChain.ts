import { generateDiary, generateActivity, updateLongTermMemory } from '../chain';
import { loadPrompt } from '../prompts';

/**
 * 演示：按 PRD 的链路执行三步
 */
async function runDemo() {
  const personaBlueprint = await loadPrompt('chat_principle'); // 仅示例，真实应加载模板中的 persona 与原则
  const sessionChat = '示例：与AI访客的一段简短对话...';
  const diaryHistory = '';
  const assignment = '示例作业：记录一周自动化思维';

  const d = await generateDiary({
    personaBlueprint,
    diaryHistory,
    sessionChat,
  });
  console.log('DIARY:', d.diary.slice(0, 120) + '...');

  const a = await generateActivity({
    corePersona: personaBlueprint,
    longTermMemory: '<longterm_memory/>',
    sessionChat,
    assignment,
  });
  console.log('ACTIVITY JSON (HEAD):', a.activityJson.slice(0, 120) + '...');

  const u = await updateLongTermMemory({
    longtermMemoryCurrent: '<longterm_memory/>',
    latestDiaryEntry: d.diary,
    latestActivityLog: a.activityJson,
  });
  console.log('LTM thisweek_focus:', u.longtermMemory.thisweek_focus);
}

runDemo().catch((e) => {
  console.error(e);
  process.exit(1);
});


