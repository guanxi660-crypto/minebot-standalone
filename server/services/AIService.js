import OpenAI from 'openai';

export class AIService {
  constructor(configManager) {
    this.configManager = configManager;
    this.openai = null;
    this.conversationHistory = new Map();
    this.maxHistoryLength = 10;
    this.initClient();
  }

  initClient() {
    const config = this.configManager.getConfig();
    const apiKey = config.ai?.apiKey || process.env.OPENAI_API_KEY;
    const baseURL = config.ai?.baseURL || process.env.OPENAI_BASE_URL;

    if (apiKey) {
      this.openai = new OpenAI({
        apiKey,
        baseURL: baseURL || undefined
      });
    }
  }

  getSystemPrompt() {
    const config = this.configManager.getConfig();
    return config.ai?.systemPrompt || `你是一个 Minecraft 服务器中的友好机器人助手。
你的任务是帮助玩家解答问题，提供游戏指导。
请用简洁友好的中文回答，每次回复不超过100字。
你可以回答关于 Minecraft 游戏的问题，也可以进行日常对话。`;
  }

  async chat(message, username = 'Player') {
    if (!this.openai) {
      this.initClient();
      if (!this.openai) {
        throw new Error('AI 服务未配置，请设置 API Key');
      }
    }

    // Get or create conversation history for this user
    if (!this.conversationHistory.has(username)) {
      this.conversationHistory.set(username, []);
    }
    const history = this.conversationHistory.get(username);

    // Add user message to history
    history.push({
      role: 'user',
      content: message
    });

    // Trim history if too long
    if (history.length > this.maxHistoryLength * 2) {
      history.splice(0, 2);
    }

    const config = this.configManager.getConfig();
    const model = config.ai?.model || process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

    try {
      const response = await this.openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: this.getSystemPrompt() },
          ...history
        ],
        max_tokens: 150,
        temperature: 0.7
      });

      const assistantMessage = response.choices[0]?.message?.content || '抱歉，我无法回答这个问题';

      // Add assistant response to history
      history.push({
        role: 'assistant',
        content: assistantMessage
      });

      return assistantMessage;
    } catch (error) {
      console.error('AI Service Error:', error);
      throw new Error(`AI 请求失败: ${error.message}`);
    }
  }

  clearHistory(username) {
    if (username) {
      this.conversationHistory.delete(username);
    } else {
      this.conversationHistory.clear();
    }
  }

  updateConfig() {
    this.initClient();
  }
}
