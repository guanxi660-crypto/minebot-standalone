export function registerAuthRoutes(app, { authService, auditService }) {
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const clientIp = req.ip || req.connection.remoteAddress || '0.0.0.0';
    const result = authService.validateCredentials(username, password, clientIp);

    if (result.valid) {
      const token = authService.generateToken(username);
      auditService.loginSuccess(username, clientIp);
      return res.json({
        success: true,
        token,
        expiresIn: 86400,
        user: { username }
      });
    }

    if (result.rateLimited) {
      auditService.loginFailed(username, 'rate_limited', clientIp);
      return res.status(429).json({
        error: result.message,
        code: 'RATE_LIMITED'
      });
    }

    auditService.loginFailed(username, 'invalid_credentials', clientIp);
    res.status(401).json({
      error: result.message || 'Invalid username or password',
      code: 'INVALID_AUTH'
    });
  });

  app.get('/api/auth/check', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.json({ authenticated: false });
    }

    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);

    if (decoded) {
      res.json({
        authenticated: true,
        user: { username: decoded.username }
      });
    } else {
      res.json({ authenticated: false });
    }
  });

  app.post('/api/auth/change-password', (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New passwords do not match' });
    }

    const clientIp = req.ip || req.connection.remoteAddress || '0.0.0.0';
    const currentUser = req.user.username;
    const verifyResult = authService.validateCredentials(currentUser, currentPassword, clientIp);
    if (!verifyResult.valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const updateResult = authService.updateCredentials(currentUser, newPassword);
    if (!updateResult.success) {
      return res.status(400).json({ error: updateResult.message });
    }

    auditService.passwordChanged(currentUser, clientIp);
    res.json({
      success: true,
      message: 'Password changed successfully. Please login again.'
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.json({ success: true, message: 'Logged out successfully' });
  });
}
