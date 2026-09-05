import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

async function startApp(botManager) {
  const app = express();
  app.get('/api/bots', (req, res) => {
    res.json(botManager.getAllStatus());
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      resolve({
        close: () => new Promise((done) => server.close(done)),
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

test('bots smoke: list endpoint returns bot statuses', async () => {
  const botManager = {
    getAllStatus() {
      return {
        s1: { id: 's1', connected: true },
        s2: { id: 's2', connected: false }
      };
    }
  };

  const app = await startApp(botManager);
  const response = await fetch(`${app.baseUrl}/api/bots`);
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.s1.connected, true);
  assert.equal(json.s2.connected, false);

  await app.close();
});
