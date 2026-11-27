import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';

function runtime(fetch = async () => { throw new Error('Unexpected network request'); }) {
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    Request, Response, Headers, performance, setTimeout, clearTimeout,
    atob, btoa, fetch, console, crypto: webcrypto,
  });
  vm.runInContext(source.replace('export default {', 'globalThis.worker = {'), context);
  // Authentication hashing and protocol handlers are outside these routing checks.
  context.MD5MD5 = async () => '0'.repeat(32);
  context.反代参数获取 = async () => ({});
  context.处理WS请求 = async (_request, _uuid, _url, proxy) => new Response(`ws:${proxy.DoHIPv4Only}`);
  context.处理gRPC请求 = async (_request, _uuid, proxy) => new Response(`grpc:${proxy.DoHIPv4Only}`);
  context.处理叉HTTP请求 = async (_request, _uuid, proxy) => new Response(`xhttp:${proxy.DoHIPv4Only}`);
  return context;
}

function request(path, headers = {}, method = 'POST') {
  const result = new Request(`https://node.example${path}`, { method, headers });
  result.cf = { colo: 'SJC' };
  return result;
}

test('merged routing preserves per-request IPv4 settings across WS, gRPC and XHTTP', async () => {
  const context = runtime();
  const [header, key] = context.获取本机标识(uuid);
  const routes = [
    [request('/', { Upgrade: 'websocket' }, 'GET'), 'ws'],
    [request('/', { 'Content-Type': 'application/grpc' }), 'grpc'],
    [request('/', { 'Content-Type': 'application/octet-stream' }), 'xhttp'],
    [request('/', { 'Content-Type': 'application/grpc', [header]: 'padding' }), 'xhttp'],
    [request(`/?${key}=padding`, { 'Content-Type': 'application/grpc' }), 'xhttp'],
  ];
  // Alternate within one isolate to catch a sticky global setting after an opt-out.
  for (const setting of [undefined, 'false', 'true', '0', ' FALSE ', undefined]) {
    const expected = !['false', '0', ' FALSE '].includes(setting);
    for (const [req, route] of routes) {
      const response = await context.worker.fetch(req, { ADMIN: 'test', UUID: uuid, DOH_IPV4_ONLY: setting }, {});
      assert.equal(await response.text(), `${route}:${expected}`);
    }
  }
});

test('version API returns the numeric upstream version', async () => {
  const context = runtime();
  const response = await context.worker.fetch(request(`/version?uuid=${uuid}`, {}, 'GET'), { ADMIN: 'test', UUID: uuid }, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { Version: 20261124194656 });
});

test('generated XHTTP padding matches the inbound header and query identifiers', () => {
  const context = runtime();
  const [header, key] = context.获取本机标识(uuid);
  const config = context.获取传输协议配置({ UUID: uuid, 传输协议: 'xhttp' });
  const extra = JSON.parse(new URLSearchParams(config.type).get('extra'));
  assert.equal(extra.xPaddingHeader, header);
  assert.equal(extra.xPaddingKey, key);
  const padding = 'a'.repeat(200);
  const inHeader = request('/', { [header]: `https://padding.example/?${key}=${padding}` });
  const inQuery = request(`/?${key}=${padding}`);
  for (const req of [inHeader, inQuery]) {
    assert.equal(context.提取叉HTTPPadding值(req, header, key), padding);
    assert.equal(context.校验叉HTTPPadding(req, header, key), true);
  }
  assert.equal(context.校验叉HTTPPadding(request('/', { [header]: 'a' }), header, key), false);
});

test('subscription requests carry the upstream UID/version and preserve optional defaults', async () => {
  const calls = [];
  const context = runtime(async (url, options) => {
    calls.push({ url, options });
    return new Response(url.includes('/sub?') ? btoa('') : '192.0.2.1:443');
  });
  const [uid] = context.获取本机标识(uuid);
  await context.获取优选订阅生成器数据('sub://generator.example', uid);
  await context.请求优选API(['https://api.example/list', 'sub://nested.example'], '443', uid);
  await context.获取优选订阅生成器数据('sub://default.example');
  await context.请求优选API(['https://default.example/list']);
  assert.equal(calls.length, 5);
  for (const { url, options } of calls) {
    const expectedUID = url.includes('default.example') ? '000000' : uid;
    assert.equal(options.headers['User-Agent'],
      `v2rayN/edgetunnel (https://github.com/cmliu/edgetunnel) Uid/0x${expectedUID} Version/20261124194656`);
  }
});

test('XHTTP mux is opt-in and preserves custom connection parameters', () => {
  const context = runtime();
  const xmux = { maxConnections: 8, maxConcurrency: 0, hMaxReusableSecs: 1800 };
  for (const reuse of [undefined, { 启用: false, xmux }, { 启用: true, xmux }]) {
    const config = context.获取传输协议配置({ UUID: uuid, 传输协议: 'xhttp', 连接复用: reuse });
    const extra = JSON.parse(new URLSearchParams(config.type).get('extra'));
    assert.deepEqual(extra.xmux, reuse?.启用 ? xmux : undefined);
    // Legacy WS/gRPC configs can omit the new section too.
    assert.equal(context.获取传输协议配置({ UUID: uuid, 传输协议: 'ws' }).type, 'ws');
    assert.equal(context.获取传输协议配置({ UUID: uuid, 传输协议: 'grpc' }).type, 'grpc&mode=gun');
  }
});

test('stored configs gain mux defaults without losing custom values or enabling old configs', async () => {
  const context = runtime();
  const storage = new Map();
  const env = { KV: { get: async key => storage.get(key) ?? null, put: async (key, value) => storage.set(key, value) } };
  const fresh = await context.读取config_JSON(env, 'node.example', uuid);
  assert.equal(fresh.连接复用.启用, false);
  assert.equal(fresh.连接复用.xmux.maxConnections, 4);
  const defaults = JSON.parse(JSON.stringify(fresh.连接复用.xmux));
  for (const reuse of [undefined, { 启用: true }, { 启用: true, xmux: { maxConnections: 8, hMaxReusableSecs: 0 } }]) {
    storage.set('config.json', JSON.stringify({ ...fresh, 连接复用: reuse }));
    const migrated = await context.读取config_JSON(env, 'node.example', uuid);
    assert.equal(migrated.连接复用.启用, reuse?.启用 ?? false);
    assert.deepEqual(JSON.parse(JSON.stringify(migrated.连接复用.xmux)), { ...defaults, ...reuse?.xmux });
  }
});

test('Telegram session endpoints enforce authentication without entering XHTTP or gRPC', async () => {
  const context = runtime();
  const env = { ADMIN: 'test', UUID: uuid };
  for (const [path, headers, method] of [
    ['/api/v1/session', { 'Content-Type': 'application/grpc' }, 'POST'],
    ['/api/v1/session', {}, 'DELETE'],
    ['/api/v1/ws', { Upgrade: 'websocket' }, 'GET'],
  ]) {
    const response = await context.worker.fetch(request(path, headers, method), env, {});
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '');
  }
});

test('Telegram session creation validates the opening frame and issues a revocable token', async () => {
  const context = runtime();
  const env = { ADMIN: 'test', UUID: uuid };
  // runtime() deliberately stubs MD5MD5; the bootstrap secret is therefore fixed here.
  const headers = { Authorization: `Bearer ${'0'.repeat(32)}`, 'Content-Type': 'application/octet-stream' };
  const post = body => {
    const req = new Request('https://node.example/api/v1/session', { method: 'POST', headers, body });
    req.cf = { colo: 'SJC' };
    return context.worker.fetch(req, env, {});
  };
  assert.equal((await post(new Uint8Array([16]))).status, 404);
  const response = await post(new Uint8Array([16, 0, 0, 0, 0, 0, 0, 1, 1]));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Carrier-Mode'), 'websocket-lanes');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [17, 0, 0, 0, 0, 0, 0, 0]);
  const token = response.headers.get('X-Session-Token');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await context.worker.fetch(request('/api/v1/session', auth, 'DELETE'), env, {})).status, 204);
  const denied = await context.worker.fetch(request('/api/v1/ws', {
    Upgrade: 'websocket',
    'Sec-WebSocket-Protocol': `tproxy-lane-v1.${token}.1`,
  }, 'GET'), env, {});
  assert.equal(denied.status, 409);
});

test('Telegram bridge validates the capability and serves the upstream bridge with security headers', async () => {
  const context = runtime();
  const env = { ADMIN: 'test', UUID: uuid };
  const secret = `dd${uuid.replaceAll('-', '')}`;
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(secret, 'hex'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode('tdesktop-web-proxy-bridge-v1\nnode.example'));
  const cap = Buffer.from(signature).toString('base64url');
  const valid = await context.worker.fetch(request(`/?bridge=${cap}`, {}, 'GET'), env, {});
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('Cache-Control'), 'no-store');
  assert.equal(valid.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(valid.headers.get('Content-Security-Policy'), /frame-ancestors http:\/\/127\.0\.0\.1:\*/);
  assert.match(await valid.text(), /tproxy-init/);
  for (const [capability, method] of [['invalid', 'GET'], [cap, 'HEAD']]) {
    const response = await context.worker.fetch(request(`/?bridge=${capability}`, {}, method), env, {});
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /tproxy-init/);
  }
});
