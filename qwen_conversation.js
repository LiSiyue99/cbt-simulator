import 'dotenv/config';
import OpenAI from "openai";

const BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const openai = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: BASE_URL,
});

/**
 * 获取一次对话回复
 * @param {Array<{role:string, content:string}>} messages - 对话消息数组
 * @returns {Promise<string>} - 返回模型的文本回复
 */
async function getResponse(messages) {
  const completion = await openai.chat.completions.create({
    model: "qwen-plus",
    messages: messages,
  });
  return completion.choices[0].message.content;
}

async function runConversation() {
  const messages = [];

  // 第 1 轮
  messages.push({ role: "user", content: "推荐一部关于太空探索的科幻电影。" });
  console.log("第1轮");
  console.log("用户：" + messages[0].content);

  let assistant_output = await getResponse(messages);
  messages.push({ role: "assistant", content: assistant_output });
  console.log("模型：" + assistant_output + "\n");

  // 第 2 轮
  messages.push({ role: "user", content: "这部电影的导演是谁？" });
  console.log("第2轮");
  console.log("用户：" + messages[messages.length - 1].content);

  assistant_output = await getResponse(messages);
  messages.push({ role: "assistant", content: assistant_output });
  console.log("模型：" + assistant_output + "\n");
}

runConversation();