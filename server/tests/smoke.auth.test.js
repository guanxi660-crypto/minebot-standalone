import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../services/AuthService.js';

function createConfigManager(initial = {}) {
  const state = { ...initial };
  return {
    getFullConfig() {
      return state;
    },
    updateConfig(next) {
      Object.assign(state, next);
      return state;
    }
  };
}

test('auth smoke: update credentials, login, token verify', () => {
  const configManager = createConfigManager({});
  const authService = new AuthService(configManager);

  const updated = authService.updateCredentials('admin', 'StrongPass1!');
  assert.equal(updated.success, true);

  const login = authService.validateCredentials('admin', 'StrongPass1!', '127.0.0.1');
  assert.equal(login.valid, true);

  const token = authService.generateToken('admin');
  const decoded = authService.verifyToken(token);
  assert.equal(decoded.username, 'admin');
});

test('auth smoke: weak password is rejected', () => {
  const configManager = createConfigManager({});
  const authService = new AuthService(configManager);

  const updated = authService.updateCredentials('admin', '123456');
  assert.equal(updated.success, false);
  assert.match(updated.message, /Password too weak/i);
});

test('auth smoke: repeated failures trigger rate limit', () => {
  const configManager = createConfigManager({});
  const authService = new AuthService(configManager);
  authService.updateCredentials('admin', 'StrongPass1!');

  let lastResult = null;
  for (let i = 0; i < 6; i += 1) {
    lastResult = authService.validateCredentials('admin', 'WrongPass1!', '10.0.0.8');
  }

  assert.equal(lastResult.valid, false);
  assert.equal(lastResult.rateLimited, true);
});
