import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startMonitor } from './birdview-monitor.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'birdview-monitor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.birdview'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/main.mjs'), 'export const value = 1;\n');
  const map = {
    schemaVersion: 1, mapId: 'monitor-test', revision: 1, language: 'zh',
    project: { id: 'test-project', name: '监控测试' },
    modules: [{ id: 'main', name: '主模块', role: 'backend', kind: 'local',
      responsibility: '测试模块', ownership: [{ kind: 'directory', path: 'src' }],
      evidence: [{ path: 'src/main.mjs', line: 1, note: '测试来源' }],
      status: 'supported', openQuestions: [], layout: { row: 0, column: 0 } }],
    relationships: [],
  };
  await writeFile(join(root, '.birdview/architecture.json'), JSON.stringify(map));
  const monitor = await startMonitor({ root, port: 0, intervalMs: 25 });
  assert.ok(monitor, 'startMonitor must provide a running loopback monitor');
  t.after(() => monitor.close());
  return { root, map, monitor };
}

async function until(read, matches) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('monitor did not converge within five seconds');
}

function rawRequest(url, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(new URL(url), { path, headers, method }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the real map on loopback with live status and no public source route', async t => {
  const { monitor } = await fixture(t);
  assert.equal(monitor.server.address().address, '127.0.0.1');
  const page = await fetch(monitor.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /监控测试/);
  const status = await (await fetch(new URL('/status', monitor.url))).json();
  assert.equal(status.mapRevision, 1);
  assert.equal(status.renderError, null);
  assert.equal(status.semanticAnalysis, 'agent-declared');
  assert.deepEqual(status.changedSources, []);
  assert.equal((await fetch(new URL('/src/main.mjs', monitor.url))).status, 404);
});

test('updates rendered HTML after a valid map edit and preserves the last good page on invalid input', async t => {
  const { root, map, monitor } = await fixture(t);
  const readStatus = async () => (await fetch(new URL('/status', monitor.url))).json();
  map.revision = 2;
  map.project.name = '更新后的项目';
  await writeFile(join(root, '.birdview/architecture.json'), JSON.stringify(map));
  await until(readStatus, state => state.mapRevision === 2);
  assert.match(await (await fetch(monitor.url)).text(), /更新后的项目/);
  await writeFile(join(root, '.birdview/architecture.json'), '{');
  const state = await until(readStatus, value => value.renderError !== null);
  assert.equal(state.mapRevision, 2);
  assert.match(await (await fetch(monitor.url)).text(), /更新后的项目/);
  await writeFile(join(root, '.birdview/architecture.json'), JSON.stringify(map));
  await until(readStatus, value => value.renderError === null);
});

test('flags evidence changes without changing the authored map or approving them on rerender', async t => {
  const { root, map, monitor } = await fixture(t);
  const readStatus = async () => (await fetch(new URL('/status', monitor.url))).json();
  await writeFile(join(root, 'src/main.mjs'), 'export const value = 2;\n');
  await until(readStatus, state => state.changedSources.includes('src/main.mjs'));
  map.revision = 2;
  await writeFile(join(root, '.birdview/architecture.json'), JSON.stringify(map));
  const state = await until(readStatus, value => value.mapRevision === 2);
  assert.deepEqual(state.changedSources, ['src/main.mjs']);
  assert.equal(JSON.parse(await readFile(join(root, '.birdview/architecture.json'))).revision, 2);
});

test('rejects traversal, cross-origin requests, foreign Host headers and write methods', async t => {
  const { monitor } = await fixture(t);
  for (const path of ['/../AGENTS.md', '/%2e%2e/AGENTS.md', '/.env', '/.git/config', '/architecture.json']) {
    assert.equal((await rawRequest(monitor.url, path)).status, 404, path);
  }
  assert.equal((await rawRequest(monitor.url, '/', { host: 'evil.invalid' })).status, 403);
  assert.equal((await rawRequest(monitor.url, '/status', { origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await rawRequest(monitor.url, '/status', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await rawRequest(monitor.url, '/', {}, 'POST')).status, 405);
});

test('does not follow a symlinked map input', async t => {
  const { root, monitor } = await fixture(t);
  const outside = join(root, 'private.txt');
  await writeFile(outside, 'PRIVATE_SENTINEL');
  await rm(join(root, '.birdview/architecture.json'));
  await symlink(outside, join(root, '.birdview/architecture.json'));
  const state = await until(async () => (await fetch(new URL('/status', monitor.url))).json(), value => value.renderError !== null);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_SENTINEL/);
  assert.doesNotMatch(await (await fetch(monitor.url)).text(), /PRIVATE_SENTINEL/);
});
