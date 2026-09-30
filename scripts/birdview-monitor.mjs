import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validate } from '../.agents/skills/birdview/scripts/validate.mjs';
import { renderArchitecture } from '../.agents/skills/birdview/scripts/render.mjs';
import { renderConstraintCatalog } from '../.agents/skills/birdview/scripts/render-constraints.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = value => createHash('sha256').update(value).digest('hex');
const clientScript = `(() => {
  const version = document.currentScript.dataset.version;
  const bar = document.createElement('div');
  bar.id = 'birdview-sync';
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;padding:8px 12px;background:#142337;color:#f3f6fa;font:12px/1.5 system-ui;border-top:1px solid #60748d';
  document.body.append(bar);
  async function refresh() {
    try {
      const response = await fetch('/status', {cache:'no-store'});
      if (!response.ok) throw new Error('unavailable');
      const state = await response.json();
      if (state.buildId !== version) { location.reload(); return; }
      const warning = state.renderError ? '渲染失败：保留上次有效图谱' :
        state.changedSources.length ? '来源已变化，待人工复核：' + state.changedSources.join('、') : '已引用来源相对本次服务启动未变化';
      bar.textContent = '本地同步 · ' + warning + ' · 图谱 v' + state.mapRevision +
        ' · ' + new Date(state.lastRenderedAt).toLocaleTimeString() + ' · 仅 Agent 声明，不是实时语义分析；重启不等于复核';
    } catch {
      bar.textContent = '本地同步已断开 · 当前图谱为最后快照，请检查监控进程';
    }
    setTimeout(refresh, 1500);
  }
  refresh();
})();`;

function readLocal(root, name, optional = false) {
  if (isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('UNSAFE_PATH');
  }
  const parts = name.split('/');
  let current = root;
  try {
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
        throw new Error('UNSAFE_FILE');
      }
    }
    const resolved = realpathSync(current);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('OUTSIDE_ROOT');
    const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

function sourcePaths(map) {
  const paths = new Set();
  for (const item of [...map.modules, ...map.relationships, ...(map.constraints ?? [])]) {
    for (const source of [...(item.evidence ?? []), ...(item.code ?? [])]) paths.add(source.path);
    for (const owner of item.ownership ?? []) if (owner.kind === 'file') paths.add(owner.path);
  }
  return [...paths].filter(path => !path.startsWith('.birdview/')).sort();
}

export async function startMonitor({ root = projectRoot, port = 4179, intervalMs = 1000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  if (!Number.isInteger(intervalMs) || intervalMs < 20) throw new Error('INVALID_INTERVAL');
  root = realpathSync(root);
  let html = '';
  let sourceHtml = null;
  let lastInputs = null;
  let currentSources = [];
  const baselines = new Map();
  const state = { buildId: '', mapRevision: null, lastRenderedAt: null, renderError: null,
    semanticAnalysis: 'agent-declared', sourceBaseline: 'process-start', changedSources: [],
    watchedSources: [], startedAt: new Date().toISOString() };

  function sourceHash(path) {
    try { return digest(readLocal(root, path)); } catch { return 'unavailable'; }
  }

  function refresh() {
    try {
      const mapText = readLocal(root, '.birdview/architecture.json');
      const activityText = readLocal(root, '.birdview/activity.jsonl', true);
      const rulesText = readLocal(root, '.birdview/project.constraints.json', true);
      const inputDigest = digest(JSON.stringify([mapText, activityText, rulesText]));
      if (inputDigest !== lastInputs) {
        const map = JSON.parse(mapText);
        const events = (activityText ?? '').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
        const catalog = rulesText === null ? undefined : JSON.parse(rulesText);
        const result = validate(map, events, { requireRoles: true });
        if (!result.ok) throw new Error('INVALID_MAP_OR_ACTIVITY');
        const rendered = renderArchitecture(map, events, catalog ? {
          constraintCatalog: catalog, constraintSourceHref: 'project.sources.html',
        } : {});
        const renderedSources = catalog ? renderConstraintCatalog(catalog, undefined, { view: 'sources' }) : null;
        const buildId = digest(rendered);
        html = rendered.replace('</body>', `<script src="/monitor.js" data-version="${buildId}"></script></body>`);
        sourceHtml = renderedSources;
        state.buildId = buildId;
        state.mapRevision = map.revision;
        state.lastRenderedAt = new Date().toISOString();
        currentSources = sourcePaths(map);
        for (const path of currentSources) if (!baselines.has(path)) baselines.set(path, sourceHash(path));
        state.watchedSources = currentSources;
        lastInputs = inputDigest;
      }
      state.renderError = null;
    } catch {
      state.renderError = 'INPUT_OR_RENDER_FAILED';
    }
    state.changedSources = currentSources.filter(path => {
      const current = sourceHash(path);
      return current === 'unavailable' || current !== baselines.get(path);
    });
  }

  refresh();
  if (!html) throw new Error('INITIAL_RENDER_FAILED');
  let origin;
  const server = createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      send(403, 'text/plain; charset=utf-8', 'Forbidden');
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      send(405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    const route = req.url.split('?')[0];
    if (route === '/' || route === '/project.html') send(200, 'text/html; charset=utf-8', html);
    else if (route === '/project.sources.html' && sourceHtml) send(200, 'text/html; charset=utf-8', sourceHtml);
    else if (route === '/monitor.js') send(200, 'text/javascript; charset=utf-8', clientScript);
    else if (route === '/status') send(200, 'application/json; charset=utf-8', JSON.stringify(state));
    else send(404, 'text/plain; charset=utf-8', 'Not found');
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setInterval(refresh, intervalMs);
  return { url: `${origin}/`, server, close: () => new Promise((accept, reject) => {
    clearInterval(timer);
    server.close(error => error ? reject(error) : accept());
    server.closeIdleConnections();
  }) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--port')) throw new Error('Usage: node scripts/birdview-monitor.mjs [--port 4179]');
    const monitor = await startMonitor({ port: args.length ? Number(args[1]) : 4179 });
    console.log(`Birdview local monitor: ${monitor.url}`);
    console.log('Only graph inputs and referenced source files are observed; no model calls or automatic semantic review.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      monitor.close().then(() => process.exit(0), () => process.exit(1));
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
