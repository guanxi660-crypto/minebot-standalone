export function registerSystemRoutes(app, { systemService }) {
  app.get('/api/system/status', (req, res) => {
    res.json(systemService.getStatus());
  });

  app.get('/api/system/memory', (req, res) => {
    res.json(systemService.getMemoryStatus());
  });
}
