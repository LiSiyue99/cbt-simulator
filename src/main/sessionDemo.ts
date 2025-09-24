import { chatWithVisitor } from '../chat/sessionOrchestrator';
import { buildFullPersonaFromFiles } from '../services/personaLoader';

async function run() {
  // 示例：选择第 1 号 persona，LTM 初始可空
  const persona = await buildFullPersonaFromFiles({
    visitorTypeKey: '1',
    longTermMemory: '<longterm_memory/>',
  });

  const reply = await chatWithVisitor({
    persona,
    messages: [
      { role: 'user', content: '你好，最近工作压力怎么样？' },
    ],
  });

  console.log('MODEL:', reply);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});


