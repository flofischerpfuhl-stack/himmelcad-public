/**
 * The in-app agent endpoint's trust boundary: off by default, loopback
 * only, refuses requests without the per-session token, from browsers
 * (Origin) or with a foreign Host, and forgets the token when stopped.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';

import { AutomationServer } from '../../electron/automationServer.js';

function post(
  port: number,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const RPC = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'api.hello', params: {} });

void test('the endpoint is off by default and serves only with the session token', async () => {
  const seen: string[] = [];
  const server = new AutomationServer(async (body) => {
    seen.push(body);
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });
  assert.equal(server.running, false);
  assert.equal(server.endpoint, null);

  const info = await server.start();
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/rpc$/);
  assert.ok(info.token.length >= 43, 'at least 256 bits of token');

  const missing = await post(info.port, RPC, {});
  assert.equal(missing.status, 401);
  assert.equal(JSON.parse(missing.body).error.data.code, 'permissionDenied');
  const wrong = await post(info.port, RPC, { Authorization: `Bearer ${info.token.slice(1)}x` });
  assert.equal(wrong.status, 401);
  const browser = await post(info.port, RPC, {
    Authorization: `Bearer ${info.token}`,
    Origin: 'https://evil.example',
  });
  assert.equal(browser.status, 403);
  const rebinding = await post(info.port, RPC, {
    Authorization: `Bearer ${info.token}`,
    Host: `evil.example:${info.port}`,
  });
  assert.equal(rebinding.status, 403);
  assert.deepEqual(seen, [], 'no refused request reached the command layer');

  const ok = await post(info.port, RPC, { Authorization: `Bearer ${info.token}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body).result, { ok: true });
  assert.deepEqual(seen, [RPC]);

  await server.stop();
  assert.equal(server.running, false);
  await assert.rejects(post(info.port, RPC, { Authorization: `Bearer ${info.token}` }));

  const again = await server.start();
  assert.notEqual(again.token, info.token, 'a new token per session');
  const stale = await post(again.port, RPC, { Authorization: `Bearer ${info.token}` });
  assert.equal(stale.status, 401);
  await server.stop();
});

void test('only POST /rpc is served, and notifications get no body', async () => {
  const server = new AutomationServer(async () => null);
  const info = await server.start();
  const notification = await post(info.port, RPC, { Authorization: `Bearer ${info.token}` });
  assert.equal(notification.status, 204);
  const other = await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: '/',
        method: 'GET',
        headers: { Authorization: `Bearer ${info.token}` },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(other, 404);
  await server.stop();
});
