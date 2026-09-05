import express from 'express';

const PANEL_UPLOAD_LIMIT = '100mb';

function getPanelUploadErrorMessage(error) {
  if (error?.response) {
    const panelError = error.response.data?.errors?.[0];
    return panelError?.detail || panelError?.title || error.response.statusText || `HTTP ${error.response.status}`;
  }
  return error?.message || '未知错误';
}

export function registerFileRoutes(app, {
  botManager
}) {
  // Set file access type for a bot
  app.post('/api/bots/:id/file-access-type', (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const { type } = req.body;
      const result = bot.setFileAccessType(type);
      res.json(result);
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Send console command via Pterodactyl panel
  app.post('/api/bots/:id/panel-command', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const { command } = req.body;
      const fallback = await bot.sendPanelCommand(command);
      res.json(fallback);
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Send power signal via Pterodactyl panel (start/stop/restart/kill)
  app.post('/api/bots/:id/power', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const { signal } = req.body;
      if (!signal) {
        return res.status(400).json({ success: false, error: '缺少 signal 参数 (start/stop/restart/kill)' });
      }
      const fallback = await bot.sendPowerSignal(signal);
      res.json(fallback);
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ==================== 文件管理 API ====================

  app.get('/api/bots/:id/files', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const directory = req.query.directory || '/';
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      let result;
      if (fileAccessType === 'sftp') {
        result = await bot.listFilesSftp(directory);
      } else {
        result = await bot.listFiles(directory);
      }
      res.json({ ...result, channel: fileAccessType === 'sftp' ? 'sftp' : 'pterodactyl' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/api/bots/:id/files/contents', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const file = req.query.file;
      if (!file) {
        return res.status(400).json({ success: false, error: '缺少 file 参数' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      let result;
      if (fileAccessType === 'sftp') {
        result = await bot.getFileContentsSftp(file);
      } else {
        result = await bot.getFileContents(file);
      }
      res.json({ ...result, channel: fileAccessType === 'sftp' ? 'sftp' : 'pterodactyl' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/bots/:id/files/write', express.text({ limit: '50mb' }), async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const file = req.query.file;
      if (!file) {
        return res.status(400).json({ success: false, error: '缺少 file 参数' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      let result;
      if (fileAccessType === 'sftp') {
        result = await bot.writeFileSftp(file, req.body);
      } else {
        result = await bot.writeFile(file, req.body);
      }
      res.json({ ...result, channel: fileAccessType === 'sftp' ? 'sftp' : 'pterodactyl' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/api/bots/:id/files/download', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const file = req.query.file;
      if (!file) {
        return res.status(400).json({ success: false, error: '缺少 file 参数' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      if (fileAccessType === 'sftp') {
        const result = await bot.getFileDownloadSftp(file);
        if (!result.success) {
          return res.status(400).json(result);
        }
        const fileName = file.split('/').pop();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.send(result.content);
      } else {
        const result = await bot.getDownloadUrl(file);
        res.json(result);
      }
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/api/bots/:id/files/upload', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      if (fileAccessType === 'sftp') {
        res.json({
          success: true,
          type: 'sftp',
          endpoint: `/api/bots/${req.params.id}/files/upload-sftp`
        });
      } else {
        const result = await bot.getUploadUrl();
        res.json({
          ...result,
          type: 'pterodactyl',
          endpoint: `/api/bots/${req.params.id}/files/upload-panel`
        });
      }
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/bots/:id/files/upload-panel', express.raw({ limit: PANEL_UPLOAD_LIMIT, type: '*/*' }), async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const directory = req.query.directory || '/';
      const fileName = req.query.name;
      if (!fileName) {
        return res.status(400).json({ success: false, error: '缺少 name 参数' });
      }

      const uploadInfo = await bot.getUploadUrl();
      if (!uploadInfo.success || !uploadInfo.url) {
        return res.status(400).json({ success: false, error: uploadInfo.error || '无法获取上传链接' });
      }

      const formData = new FormData();
      formData.append('files', new Blob([req.body]), fileName);
      const separator = uploadInfo.url.includes('?') ? '&' : '?';
      const uploadUrl = `${uploadInfo.url}${separator}directory=${encodeURIComponent(directory)}`;

      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const body = await response.text();
        let error = response.statusText || `HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(body);
          error = parsed.errors?.[0]?.detail || parsed.errors?.[0]?.title || parsed.error || error;
        } catch {
          if (body) error = body;
        }
        return res.status(response.status).json({ success: false, error });
      }

      res.json({ success: true, message: '文件已上传' });
    } catch (error) {
      res.status(400).json({ success: false, error: getPanelUploadErrorMessage(error) });
    }
  });

  app.post('/api/bots/:id/files/upload-sftp', express.raw({ limit: PANEL_UPLOAD_LIMIT, type: '*/*' }), async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const directory = req.query.directory || '/';
      const fileName = req.query.name;
      if (!fileName) {
        return res.status(400).json({ success: false, error: '缺少 name 参数' });
      }
      const result = await bot.uploadFileSftp(directory, fileName, req.body);
      res.json(result);
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/bots/:id/files/folder', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const { root, name } = req.body;
      if (!name) {
        return res.status(400).json({ success: false, error: '缺少 name 参数' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      let result;
      if (fileAccessType === 'sftp') {
        result = await bot.createFolderSftp(root || '/', name);
      } else {
        result = await bot.createFolder(root || '/', name);
      }
      res.json({ ...result, channel: fileAccessType === 'sftp' ? 'sftp' : 'pterodactyl' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/bots/:id/files/delete', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const { root, files } = req.body;
      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ success: false, error: '缺少 files 参数' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      let result;
      if (fileAccessType === 'sftp') {
        result = await bot.deleteFilesSftp(root || '/', files);
      } else {
        result = await bot.deleteFiles(root || '/', files);
      }
      res.json({ ...result, channel: fileAccessType === 'sftp' ? 'sftp' : 'pterodactyl' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/bots/:id/files/rename', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const { root, from, to } = req.body;
      if (!from || !to) {
        return res.status(400).json({ success: false, error: '缺少 from 或 to 参数' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      let result;
      if (fileAccessType === 'sftp') {
        result = await bot.renameFileSftp(root || '/', from, to);
      } else {
        result = await bot.renameFile(root || '/', from, to);
      }
      res.json({ ...result, channel: fileAccessType === 'sftp' ? 'sftp' : 'pterodactyl' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/bots/:id/files/copy', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const { location } = req.body;
      if (!location) {
        return res.status(400).json({ success: false, error: '缺少 location 参数' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      let result;
      if (fileAccessType === 'sftp') {
        result = await bot.copyFileSftp(location);
      } else {
        result = await bot.copyFile(location);
      }
      res.json({ ...result, channel: fileAccessType === 'sftp' ? 'sftp' : 'pterodactyl' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/bots/:id/files/compress', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const { root, files } = req.body;
      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ success: false, error: '缺少 files 参数' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      if (fileAccessType === 'sftp') {
        return res.status(400).json({ success: false, error: 'SFTP 模式不支持压缩功能' });
      }
      const result = await bot.compressFiles(root || '/', files);
      res.json({ ...result, channel: 'pterodactyl' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/bots/:id/files/decompress', async (req, res) => {
    try {
      const bot = botManager.bots.get(req.params.id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }
      const { root, file } = req.body;
      if (!file) {
        return res.status(400).json({ success: false, error: '缺少 file 参数' });
      }
      const fileAccessType = bot.status.fileAccessType || 'pterodactyl';

      if (fileAccessType === 'sftp') {
        return res.status(400).json({ success: false, error: 'SFTP 模式不支持解压功能' });
      }
      const result = await bot.decompressFile(root || '/', file);
      res.json({ ...result, channel: 'pterodactyl' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });
}
