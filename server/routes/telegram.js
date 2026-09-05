export function registerTelegramRoutes(app, { configManager }) {
  app.get('/api/config/telegram', (req, res) => {
    const config = configManager.getConfig().telegram || {};
    res.json(config);
  });

  app.post('/api/config/telegram', (req, res) => {
    try {
      const { enabled, botToken, chatId } = req.body;
      const currentConfig = configManager.getFullConfig();
      const currentTelegram = currentConfig.telegram || {};

      const newTelegram = {
        enabled: enabled !== undefined ? enabled : currentTelegram.enabled,
        chatId: chatId !== undefined ? chatId : currentTelegram.chatId,
        botToken: (botToken && botToken !== '***') ? botToken : currentTelegram.botToken
      };

      configManager.updateConfig({ telegram: newTelegram });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
