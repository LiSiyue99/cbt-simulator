import 'dotenv/config';
import OpenAI from "openai";

if (!process.env.DASHSCOPE_API_KEY) {
  console.error("缺少 DASHSCOPE_API_KEY 环境变量，请在项目根目录创建 .env，内容：DASHSCOPE_API_KEY=sk-xxx");
  process.exit(1);
}

try {
  const openai = new OpenAI({
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  });
  const completion = await openai.chat.completions.create({
    model: "qwen-flash", 
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "你是谁？" }
    ],
  });
  console.log(completion.choices[0].message.content);
} catch (error) {
  console.log(`错误信息：${error}`);
  console.log("请参考文档：https://help.aliyun.com/zh/model-studio/developer-reference/error-code");
}