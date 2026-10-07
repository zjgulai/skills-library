import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 全树凭据前置闸：任何物化／解压／投影动作之前先跑，命中私钥或凭据形态即拒绝放行。
 *
 * 为什么要有它：143 号那条红线扫描只扫「写回后的 463 个文件」，而这座库的全树从来没扫过——
 * 结果 `paper_to_skills/DDDD.pem` 是一份真实 RSA 私钥，一直漏在外面（145 §7）。
 * 判据必须能区分「真私钥」和「技能自带的密钥检测夹具」，否则 16 处假阳性会把闸门变成噪音。
 */

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache', 'venv', '.venv']);
const KEY_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.id_rsa']);
const KEY_FILENAMES = new Set(['id_rsa', 'id_ed25519', '.credentials.yaml', 'credentials', 'service-account.json']);
const PRIVATE_KEY_MARKERS = [
  'BEGIN RSA PRIVATE KEY', 'BEGIN OPENSSH PRIVATE KEY', 'BEGIN PRIVATE KEY',
  'BEGIN EC PRIVATE KEY', 'BEGIN DSA PRIVATE KEY', 'BEGIN ENCRYPTED PRIVATE KEY',
  'BEGIN PGP PRIVATE KEY BLOCK',
];
// 公开材料不算外泄：公钥、证书、示例值。命中这些只降级为 note，不进 blocked。
const PUBLIC_OR_EXAMPLE = [
  /BEGIN (RSA |EC |OPENSSH |)PUBLIC KEY/, /^-----BEGIN CERTIFICATE-----/,
  /AKIAIOSFODNN7EXAMPLE/, /example\.com|localhost|127\.0\.0\.1/,
  /sample[-_]?token|fake[-_]?token|do[-_]?not[-_]?commit|placeholder|xxxx+/i,
];
const SECRET_PATTERNS = [
  { label: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'jwt-like', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: 'password-assignment', pattern: /(?:password|passwd|secret)\s*[:=]\s*["'](?![\s"'$]{0,2}(?:example|sample|changeme|your|dummy|null|<))/i },
];

function walk(dir, rel, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), r, out);
    else out.push(r);
  }
  return out;
}

// 只有「BEGIN…PRIVATE KEY 与 END 之间确有密钥体」才算真密钥。
// 首版按字面标记扫，全树 89 命中里绝大部分是 code-safety-audit、glab-* 密钥检查脚本、
// scan_secrets.py、npm CLI 的 prompt、以及 .gitignore 里那行模式串——判据太宽就等于没有闸。
function realPrivateKeyBody(text) {
  const match = text.match(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----([\s\S]{0,8000}?)-----END [A-Z0-9 ]*PRIVATE KEY-----/);
  if (!match) return null;
  const inner = match[1].replace(/[\s\n]/g, '');
  if (inner.length < 200) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(inner)) return null;
  return { length: inner.length, header: match[0].slice(0, 40) };
}

// 单件分类逻辑与全树扫描共用同一条代码路径，避免「控制测的是另一套逻辑」的假绿。
function classifyOne(rel, text, size) {
  const out = { hits: [], notes: [] };
  const ext = extname(basename(rel)).toLowerCase();
  const looksKey = KEY_EXTENSIONS.has(ext) || KEY_FILENAMES.has(basename(rel)) || /^id_[a-z0-9]+$/.test(basename(rel));
  const keyBody = realPrivateKeyBody(text);
  if (keyBody) {
    out.hits.push({ rel, kind: 'private-key-body', detail: `${keyBody.header} 密钥体 ${keyBody.length} 字符`, size,
      disposition: 'quarantine-and-user-decision' });
    return out;
  }
  const markerOnly = PRIVATE_KEY_MARKERS.some(marker => text.includes(marker));
  if (markerOnly) out.notes.push({ rel, kind: 'private-key-mention', detail: '标记出现但无密钥体（夹具/文档/模式串）', disposition: 'known-false' });
  if (looksKey && !markerOnly) {
    // 公钥不是秘密；examples/ 里的 sample-* 是技能自带的上传夹具。两者都只进 review，不进 blocked。
    // 否则这条闸会因为 glab-securefile 的 sample-upload.p12 之类常年红灯，红灯一常年就没人看。
    const isPublicKey = /BEGIN (RSA |EC |OPENSSH |DSA |)PUBLIC KEY/.test(text);
    const isExample = /(^|\/)examples?\//i.test(rel) && /sample|example|demo|test/i.test(basename(rel));
    if (isPublicKey || isExample) {
      out.notes.push({ rel, kind: 'key-extension-sample', detail: ext || basename(rel),
        disposition: isPublicKey ? 'known-false' : 'review-example' });
      return out;
    }
    out.hits.push({ rel, kind: 'key-extension', detail: ext || basename(rel), size, disposition: 'review' });
    return out;
  }
  for (const { label, pattern } of SECRET_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    if (label === 'aws-access-key' && /AKIAIOSFODNN7EXAMPLE/.test(match[0])) {
      out.notes.push({ rel, kind: label, detail: 'aws-example-key', disposition: 'known-false' });
      continue;
    }
    out.notes.push({ rel, kind: label, detail: match[0].slice(0, 12) + '…', size, disposition: 'review' });
  }
  return out;
}

export function scanCredentials(root, { maxBytes = 2 * 1024 * 1024, files = null } = {}) {
  const relPaths = files ?? walk(root, '', []);
  const hits = [];
  const notes = [];
  for (const rel of relPaths) {
    const abs = join(root, rel);
    let size = 0;
    try { size = statSync(abs).size; } catch { continue; }
    const ext = extname(basename(rel)).toLowerCase();
    const looksKey = KEY_EXTENSIONS.has(ext) || KEY_FILENAMES.has(basename(rel)) || /^id_[a-z0-9]+$/.test(basename(rel));
    if (!looksKey && size > maxBytes) continue;   // 大文件只在「像密钥」时读字节
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const one = classifyOne(rel, text, size);
    hits.push(...one.hits);
    notes.push(...one.notes);
  }
  return { hits, notes, scanned: relPaths.length };
}

function controls({ root }) {
  const failures = [];
  let checked = 0;
  const expect = (label, condition, detail) => { checked += 1; if (!condition) failures.push(`${label} :: ${detail}`); };
  const real = scanCredentials(root);

  // 内存正负对照先行：正控例不能绑库里那个文件——它已被合法移走，绑上就会在处置完成后自己变红。
  const fixture = `-----BEGIN RSA PUBLIC KEY-----\nMIIBCgKCAQEA\n-----END RSA PUBLIC KEY-----\naccess_key = AKIAIOSFODNN7EXAMPLE\ntoken: sample-token-value-do-not-commit\n`;
  const syntheticKey = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(300)}\n-----END RSA PRIVATE KEY-----\n`;
  const injected = scanCredentialsWithString([
    ['fixture-public.pem', fixture],
    ['fixture-example.md', fixture],
    ['synthetic-real-key.pem', syntheticKey],
    ['password-in-doc.md', 'password = "fixture-not-a-real-credential"\n'],
  ]);
  const syntheticCaught = injected.hits.some(hit => hit.rel === 'synthetic-real-key.pem' && hit.kind === 'private-key-body');

  const quarantineDir = process.env.QUARANTINE_DIR ?? join(homedir(), '.local/share/skill-library-quarantine');
  const hasQuarantined = existsSync(join(quarantineDir, 'DDDD.pem'));
  const qScan = hasQuarantined ? scanCredentials(quarantineDir) : null;
  expect('正控-真私钥必须被抓',
    qScan ? qScan.hits.some(hit => hit.rel.endsWith('DDDD.pem') && hit.kind === 'private-key-body') : syntheticCaught,
    qScan ? `隔离副本应被抓到，实得 ${qScan.hits.map(hit => hit.rel).join(', ') || '零命中＝判据失效'}`
      : '隔离位不在盘上，正控改由合成密钥体覆盖');
  expect('正控-合成密钥体判红', syntheticCaught, '300 字符密钥体的合成 PEM 必须进 blocked');
  // 负控：只提标记、没有密钥体的夹具与模式串不得挤进 blocked（首版就是这样扫出 89 命中，绝大部分是噪音）。
  const fixtureLike = real.notes.filter(note => note.kind === 'private-key-mention').map(note => note.rel);
  expect('负控-夹具不进 blocked', !real.hits.some(hit => /(\.gitignore|code-safety-audit|scan_secrets|check_|glab-)/.test(hit.rel))
    && fixtureLike.length >= 5,
    `夹具应降级为 note（实得 note ${fixtureLike.length} 条、blocked 内含夹具 ${real.hits.filter(hit => /(\.gitignore|code-safety-audit|scan_secrets|check_|glab-)/.test(hit.rel)).length} 条）`);
  expect('负控-示例值不判红', injected.hits.every(hit => !hit.rel.startsWith('fixture-')),
    `示例值不得进 blocked：${injected.hits.map(hit => hit.rel).join(', ')}`);
  expect('负控-口令赋值只进 review', injected.hits.every(hit => hit.rel !== 'password-in-doc.md')
    && injected.notes.some(note => note.rel === 'password-in-doc.md'),
    '口令赋值形态在脚本/文档里遍地是占位符，进 review 不进 blocked');
  expect('负控-内存合成不落盘', !real.notes.some(note => note.rel.startsWith('fixture-')), '合成对照不得写进库内结果');
  expect('正控-计数非零', real.scanned > 30000, `全树遍历 ${real.scanned} 个文件，过少说明遍历没跑完`);
  return { failures, checked, real };
}

// 只给控制电池用的内存通道：不落盘、不碰库，走的仍是 classifyOne 同一条判据。
function scanCredentialsWithString(pairs) {
  const hits = [];
  const notes = [];
  for (const [rel, text] of pairs) {
    const one = classifyOne(rel, text, text.length);
    hits.push(...one.hits);
    notes.push(...one.notes);
  }
  return { hits, notes };
}

async function main(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index === -1 ? undefined : argv[index + 1]; };
  const root = value('--root') ?? '/Users/lute/project/AgentTools/技能库';
  if (argv.includes('--control')) {
    const { failures, checked, real } = controls({ root });
    console.log(JSON.stringify({ mode: 'control', checked, failures: failures.length, detail: failures,
      hits: real.hits.length, notes: real.notes.length }, null, 1));
    return failures.length ? 1 : 0;
  }
  const { hits, notes, scanned } = scanCredentials(root);
  console.log(JSON.stringify({
    mode: 'credential-tripwire', at: new Date().toISOString(), root, scanned,
    blocked: hits.length > 0, hits, notes: notes.slice(0, 40), noteCount: notes.length,
    policy: '命中即拦：任何物化／解压／投影动作须先处置 hits；本工具不读也不写凭据内容，只记路径与形态',
  }, null, 1));
  return hits.length ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
