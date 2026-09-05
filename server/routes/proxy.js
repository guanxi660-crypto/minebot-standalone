export function registerProxyRoutes(app, { configManager, proxyService }) {
  app.get('/api/proxy/nodes', (req, res) => {
    const config = configManager.getFullConfig();
    res.json(config.proxyNodes || []);
  });

  app.post('/api/proxy/nodes', async (req, res) => {
    const nodes = req.body;
    if (!Array.isArray(nodes)) {
      return res.status(400).json({ error: 'Nodes must be an array' });
    }

    try {
      configManager.updateConfig({ proxyNodes: nodes });
      await proxyService.restart(nodes);
      res.json({ success: true, message: 'Proxy nodes updated' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/proxy/parse-link', (req, res) => {
    const { link } = req.body;
    const node = proxyService.parseProxyLink(link);
    if (node) {
      res.json(node);
    } else {
      res.status(400).json({ error: 'Failed to parse proxy link' });
    }
  });

  app.post('/api/proxy/sync-subscription', async (req, res) => {
    const { url } = req.body;
    try {
      const nodes = await proxyService.syncSubscription(url);
      res.json(nodes);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/proxy/test/:id', async (req, res) => {
    try {
      const latency = await proxyService.testNode(req.params.id);
      res.json({ success: latency >= 0, latency });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
