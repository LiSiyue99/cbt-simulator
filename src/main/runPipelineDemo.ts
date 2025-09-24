import { runSessionPipeline } from '../services/sessionPipeline';

async function run() {
  // 假设你已创建一个 visitor_instance，并知道其 ID
  const visitorInstanceId = process.env.DEMO_VISITOR_INSTANCE_ID || '';
  if (!visitorInstanceId) {
    throw new Error('请在环境变量 DEMO_VISITOR_INSTANCE_ID 中提供一个 visitor_instances.id');
  }
  const out = await runSessionPipeline({
    visitorInstanceId,
    sessionNumber: Number(process.env.DEMO_SESSION_NO || '1'),
    chatHistory: '示例对话：今天感觉好一些，但想到周会还是紧张。',
    assignment: '记录一周的自动化思维',
  });
  console.log('PIPELINE RESULT:', {
    diary: out.diary.slice(0, 120) + '...',
    ltm_focus_head: out.ltm.thisweek_focus?.slice(0, 60) ?? null,
  });
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});


