import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';

function runtime(fetch = async () => { throw new Error('Unexpected network request'); }) {
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    Request, Response, Headers, performance, setTimeout, clearTimeout,
    atob, btoa, fetch, console,
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
  assert.deepEqual(await response.json(), { Version: 20261008222327 });
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
      `v2rayN/edgetunnel (https://github.com/cmliu/edgetunnel) Uid/0x${expectedUID} Version/20261008222327`);
  }
});
