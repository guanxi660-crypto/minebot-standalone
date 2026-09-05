import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyService } from '../services/ProxyService.js';

test('proxy config emits native websocket transport for vless nodes', () => {
  const service = new ProxyService();
  const node = service.parseProxyLink('vless://0478303c-d7d2-4156-afba-1ab7e14c47fd@example.com:443?encryption=none&security=tls&type=ws&host=cdn.example&path=%2Fws%3Fed%3D2048&sni=cdn.example#edge');
  service.setNodes([node]);

  const outbound = service.generateConfig().outbounds[0];

  assert.equal(outbound.type, 'vless');
  assert.equal(outbound.tls.server_name, 'cdn.example');
  assert.equal(outbound.transport.type, 'ws');
  assert.equal(outbound.transport.path, '/ws');
  assert.equal(outbound.transport.headers.Host, 'cdn.example');
  assert.equal(outbound.transport.max_early_data, 2048);
  assert.equal(outbound.transport.early_data_header_name, 'Sec-WebSocket-Protocol');
});

test('proxy config preserves imported websocket Host header for IP literal hosts', () => {
  const service = new ProxyService();
  const node = service.parseProxyLink('vless://97d73c57-7ac5-4840-b016-aa7c29a277e8@185.231.136.23:27588?encryption=none&security=none&type=ws&host=185.231.136.23&path=%2F97d73c57#edge');
  service.setNodes([node]);

  const outbound = service.generateConfig().outbounds[0];

  assert.equal(node.headers.Host, '185.231.136.23');
  assert.equal(outbound.transport.type, 'ws');
  assert.equal(outbound.transport.path, '/97d73c57');
  assert.equal(outbound.transport.headers.Host, '185.231.136.23');
});

test('proxy config matches client behavior for shadowsocks websocket query fields', () => {
  const service = new ProxyService();
  const node = service.parseProxyLink('ss://YWVzLTI1Ni1nY206c2VjcmV0@example.com:8388?type=ws&host=cdn.example&path=%2Fws#ss');
  service.setNodes([node]);

  const outbound = service.generateConfig().outbounds[0];

  assert.equal(outbound.type, 'shadowsocks');
  assert.equal(outbound.method, 'aes-256-gcm');
  assert.equal(outbound.password, 'secret');
  assert.equal(outbound.transport.type, 'ws');
  assert.equal(outbound.transport.path, '/ws');
  assert.equal(outbound.transport.headers.Host, 'cdn.example');
  assert.equal(outbound.plugin, undefined);
  assert.equal(outbound.plugin_opts, undefined);
});

test('proxy config preserves imported shadowsocks plugin websocket options', () => {
  const service = new ProxyService();
  const node = service.parseProxyLink('ss://YWVzLTI1Ni1nY206c2VjcmV0@example.com:8388?plugin=v2ray-plugin%3Bmode%3Dwebsocket%3Bhost%3Dcdn.example%3Bpath%3D%2Fws#ss');
  service.setNodes([node]);

  const outbound = service.generateConfig().outbounds[0];

  assert.equal(outbound.plugin, 'v2ray-plugin');
  assert.equal(outbound.plugin_opts, 'mode=websocket;host=cdn.example;path=/ws');
  assert.equal(outbound.transport, undefined);
});
