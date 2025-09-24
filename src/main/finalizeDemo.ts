import { createSession, appendChatTurn } from '../services/sessionCrud';
import { finalizeSessionById } from '../services/sessionPipeline';

async function run() {
  const visitorInstanceId = process.env.DEMO_VISITOR_INSTANCE_ID || '';
  if (!visitorInstanceId) throw new Error('请先设置 DEMO_VISITOR_INSTANCE_ID');

  // 1) 开始会话：创建一条空的 session 行
  const sessionId = await createSession({ visitorInstanceId, sessionNumber: Number(process.env.DEMO_SESSION_NO || '1') });

  // 2) 边聊边落库
  await appendChatTurn({ sessionId, speaker: 'user', content: '这周工作有点焦虑。' });
  await appendChatTurn({ sessionId, speaker: 'ai', content: '我听到了，你能说说具体在哪些时刻最强烈吗？' });
  await appendChatTurn({ sessionId, speaker: 'user', content: '每次主任走到我工位旁边。' });

  // 3) 结束对话：统一生成/更新并写库
  const out = await finalizeSessionById({ sessionId, assignment: '记录自动化思维' });
  console.log('FINALIZED:', { diary_head: out.diary.slice(0, 120) + '...' });
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});


