import { lstatSync, readlinkSync } from 'node:fs';
import { open, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 通用探针第一遍：对整座技能库做**零请求**静态扫描，回答"哪些技能值得深挖"。
 *
 * 它只报事实（命中位置、命中文本），不判好坏：风险模式只说明"正文里出现了这类操作"，
 * 是否危险要看上下文——这是人/深挖阶段的判断，不是筛查器的。
 */
const maxBodyBytes = 65536;
const minBodyChars = 120;
const minDescriptionChars = 40;
const maxDescriptionChars = 1024;
const clusterThreshold = 0.6;
const evidenceChars = 60;

const dangerousPatterns = [
  { label: 'rm -rf', pattern: /\brm\s+-rf?\b/ },
  { label: 'sudo', pattern: /\bsudo\b/ },
  { label: 'chmod 777', pattern: /\bchmod\s+[0-7]*777\b/ },
  { label: 'mkfs', pattern: /\bmkfs\b/ },
  { label: 'dd if=', pattern: /\bdd\s+if=/ },
  { label: 'fork bomb', pattern: /:\(\)\s*\{/ },
];
const credentialPatterns = [
  { label: '.credentials.yaml', pattern: /\.credentials\.ya?ml/ },
  { label: 'apiKeyEnv', pattern: /apiKeyEnv/ },
  // 公钥不是秘密：`~/.ssh/id_rsa.pub` 只是告知 agent 去哪找公钥，不该与私钥同级。
  { label: 'ssh private key', pattern: /\.ssh\/id_[a-z]+\b(?!\.pub)/ },
  { label: 'aws credentials', pattern: /\.aws\/credentials/ },
  { label: 'env secret', pattern: /\$\{?[A-Z_]*(SECRET|TOKEN|API_KEY)[A-Z_]*\}?/, informational: true },
];
// 回环地址不是出境：`curl http://localhost:3000/health` 是本机自测，不该进出境清单。
const networkPattern = /(?:curl|wget|nc|ssh|scp)\s+[^\n]*https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^\s)]+/;
// 只把"包内约定目录"下的引用当作包内文件；示例里随手写的路径（`docs/x.md`）不在此列，
// 否则一份技能就能凭举例刷出几十条假缺失（首轮实测：744 份里 1151 条，绝大多数是举例）。
const packageDirs = ['references/', 'assets/', 'scripts/', 'templates/', 'examples/', 'resources/'];
const referencedFilePattern = /`((?:\.\/)?[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:md|json|ya?ml|js|mjs|py|sh|csv|txt))`/g;
// 占位/模板引用不是"缺失"：`references/xxx.md` 是**约定说明句里的例子**，
// `references/research/0X-xxx.md` 是**让 agent 自己按此命名新建**的模板——两者都不该进缺失清单。
const placeholderRefPattern = /(?:^|\/)(?:x{2,}|0x(?:[^a-z0-9]|$)|yyy|zzz|your[-_]|name[-_]of)/i;
const fencedBlockPattern = /```[\s\S]*?```/g;
// 跨技能相对引用（`](../其它技能)`）：单独分发/安装时目标不存在，DSH 也会拒读包外路径。
// 评估器（Skill评估师）在本库某技能上抓到过这一类；我的包内引用规则只看 `references/` 这类前缀，`../` 出不了家门。
const crossSkillPattern = /\]\(\.\.\/([^)\s]+)\)/g;

// 二进制容器（技能库里见到的"加密态"）：3 字节魔数 + 变长头 + 高熵正文，正文与明文同长。
// 这类文件不是"作者忘了写 frontmatter"，而是整体不可读——判定必须落在**字节**上：
// 库里有正文与它一模一样的明文孪生，靠正文长相区分不了（见 OPAQUE_CONTAINER 测试的正负对照）。
// DSH 的技能名规则（kebab-case ASCII）：dsh-skill 的 SKILL_NAME 常量。
const dshSkillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const opaqueContainerMagic = Object.freeze([0x88, 0x7d, 0x1c]);

export function looksOpaque(head) {
  if (head === undefined || head === null) return false;
  if (!(head instanceof Uint8Array)) throw failure('INVALID_HEAD');
  return head.length >= opaqueContainerMagic.length &&
    opaqueContainerMagic.every((byte, index) => head[index] === byte);
}

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const severityRank = { high: 0, medium: 1, low: 2 };
// 仓库检出目录的后缀（GitHub 下载常见）：`darwin-skill-master/SKILL.md` 里 `-master` 是仓库后缀，
// 不是技能目录名；拿它跟 frontmatter 的 name 比会造出整类假"不一致"。
const repoDirSuffix = /-(?:main|master)$/;
const repoMarkerNames = new Set(['.git', 'package.json', 'LICENSE', 'README.md', 'README.en.md']);

function normaliseName(value) {
  return String(value).trim().toLowerCase().replace(/_/g, '-');
}

function folderIdentity(relPath, siblingNames) {
  const parts = relPath.split('/');
  const folder = parts.length >= 2 ? parts[parts.length - 2] : '';
  const base = folder.replace(repoDirSuffix, '');
  const looksLikeRepoCheckout = [...repoMarkerNames].some(marker => siblingNames.has(marker));
  return { folder, base, looksLikeRepoCheckout };
}

function finding(code, severity, detail) {
  return { code, severity, detail };
}

const boundaryHintPattern = /拒绝|禁止|不得|不要|不许|不触发|防止|不执行|不做|不予|永不|严禁|不提供|不涉及|不包含|而非|never|avoid|do not|should not|must not|won't|refuse|disallow/iu;

function snippetAround(text, index) {
  const start = Math.max(0, index - 20);
  return text.slice(start, start + evidenceChars).replace(/\s+/g, ' ').trim();
}

// 语义判定要看**整句**，证据只要一小段：命中落在长句尾部时（"不执行…（`rm`、`sudo` 等）"），
// 前 20 字符的窗口根本看不到动词，会把边界清单全判成 high。
function sentenceAround(text, index) {
  const lineStart = Math.max(0, text.lastIndexOf('\n', index) + 1);
  let lineEnd = text.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd).trim();
  if (line.length >= 8) return line.slice(0, 200);
  const previous = text.slice(0, lineStart).trimEnd().split('\n').pop() ?? '';
  return `${previous} ${line}`.trim().slice(0, 200);
}

/**
 * 同一处命中，"拒绝执行 rm -rf"（安全边界声明）与"运行 rm -rf"（直接命令）不是一回事。
 * 句子里带拒绝/禁止语义时降级为参考项：筛查报告的顺序要指向真正需要人看的那些。
 */
function riskFinding(code, label, snippet, sentence, informational = false) {
  const boundary = boundaryHintPattern.test(sentence ?? snippet);
  // 「读凭据文件」与「引用环境变量」不是一个风险等级：后者是 API 技能的正常写法。
  const severity = boundary ? 'low'
    : (informational ? 'medium' : (code === 'NETWORK_EGRESS' ? 'medium' : 'high'));
  return finding(code, severity, `${label}: ${snippet}${boundary ? '（句内含拒绝/禁止语义）' : ''}`);
}

// 81 生态把边界写成「## 安全边界」+ 一句总起（"本技能拒绝以下所有请求…"）+ 若干 bullet；
// bullet 自己往往没有"拒绝"二字——语义在**上方那行**。因此判定要往回扫若干行。
function boundaryNeighbourhood(text, index) {
  const lineStart = Math.max(0, text.lastIndexOf('\n', index) + 1);
  const before = text.slice(0, lineStart).split('\n').slice(-8);
  const hit = before.find(line => boundaryHintPattern.test(line));
  return hit ?? '';
}

function readFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (match === null) return { present: false, body: content, fields: {}, raw: '' };
  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const pair = lines[index].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (pair === null || Object.hasOwn(fields, pair[1])) continue;
    const trimmed = pair[2].trim();
    // YAML 块标量（`description: |` / `>`）：值在**后续缩进行**里，不是本行的那个符号。
    // 库里有 153 份技能这么写；只认单行 `key: value` 会把它们全读成 1 个字符的假"短描述"。
    if (/^[|>][+-]?\d*$/.test(trimmed)) {
      const folded = trimmed.startsWith('>');
      const block = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next];
        if (line.trim() === '') { block.push(''); index = next; continue; }
        const indent = line.match(/^\s*/)[0].length;
        if (indent === 0) break;
        block.push(line.slice(indent));
        index = next;
      }
      while (block.length > 0 && block[block.length - 1] === '') block.pop();
      fields[pair[1]] = (folded
        ? block.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ')
        : block.join('\n')).trim();
      continue;
    }
    fields[pair[1]] = trimmed.replace(/^['"]|['"]$/g, '');
  }
  return { present: true, body: content.slice(match[0].length), fields, raw: match[1] };
}

function normaliseTokens(text) {
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').split(' ')
    .filter(token => token.length >= 3));
}

function jaccard(left, right) {
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function screenOne(file, names) {
  const findings = [];
  if (looksOpaque(file.head)) {
    findings.push(finding('OPAQUE_CONTAINER', 'high',
      `二进制容器头 ${opaqueContainerMagic.map(byte => byte.toString(16).padStart(2, '0')).join(' ')}，非文本`));
    return { findings, name: null, description: '', bodyBytes: 0, bodyChars: 0, tokens: new Set() };
  }
  const front = readFrontmatter(file.content);
  const directory = file.relPath.slice(0, file.relPath.length - 'SKILL.md'.length);
  const siblings = new Set([...names].filter(path => path.startsWith(directory) &&
    !path.slice(directory.length).includes('/')).map(path => path.slice(directory.length)));
  const identity = folderIdentity(file.relPath, siblings);
  const body = front.body;
  const description = front.fields.description ?? '';

  if (!front.present) findings.push(finding('MISSING_FRONTMATTER', 'high', '文件没有 --- frontmatter 块'));
  else if (!front.fields.name) findings.push(finding('MISSING_NAME', 'high', 'frontmatter 缺 name'));
  // DSH 的读取路径是 `yaml.parse(frontmatter)`：未加引号的标量里出现 ": " 会直接抛
  // "Nested mappings are not allowed in compact mappings"，整份技能被静默忽略。
  // 正则读取器自己不会报这个错——必须显式查，否则这类技能在库里是"隐形"的。
  for (const line of front.raw.split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (pair === null) continue;
    const value = pair[2].trim();
    if (/^["'|>{}[]/.test(value)) continue;
    if (value.includes(': ')) {
      findings.push(finding('YAML_UNPARSABLE', 'high',
        `${pair[1]} 的值未加引号且含 ": "，DSH 的 YAML 解析器会拒收整份技能`));
    }
  }
  if (front.present && front.fields.name && identity.folder) {
    const aligned = normaliseName(identity.base) === normaliseName(front.fields.name);
    if (!aligned && !identity.looksLikeRepoCheckout) {
      findings.push(finding('NAME_FOLDER_MISMATCH', 'high',
        `name=${front.fields.name} 与目录 ${identity.folder} 不一致`));
    }
  }
  if (front.present && !description) findings.push(finding('MISSING_DESCRIPTION', 'high', 'frontmatter 缺 description'));
  // DSH 的技能名规则是 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（见 dsh-skill 的 SKILL_NAME 与
  // dsh-skill-filesystem 的 `invalid skill name` 忽略分支）——非 kebab 名（含中文名）会被**逐份忽略**，
  // 技能在 DSH 里等于不存在。这是装载阻断，不是风格问题。
  if (front.present && front.fields.name && dshSkillNamePattern.test(front.fields.name) === false) {
    findings.push(finding('NON_KEBAB_NAME', 'high',
      `name=${front.fields.name} 不是 kebab-case：DSH 会忽略该技能（需在安装时映射成 <英文-kebab>）`));
  }
  if (description && description.length < minDescriptionChars) {
    findings.push(finding('SHORT_DESCRIPTION', 'medium', `${description.length} 字符`));
  }
  if (description.length > maxDescriptionChars) {
    findings.push(finding('DESCRIPTION_TOO_LONG', 'medium', `${description.length} 字符`));
  }
  const bodyChars = body.trim().length;
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyChars < minBodyChars) findings.push(finding('EMPTY_BODY', 'high', `正文 ${bodyChars} 字符`));
  if (bodyBytes > maxBodyBytes) findings.push(finding('HUGE_BODY', 'medium', `${bodyBytes} 字节`));
  if (bodyChars >= minBodyChars && !/^##\s/m.test(body)) {
    findings.push(finding('NO_WORKFLOW_SECTION', 'medium', '正文没有任何 ## 小节'));
  }

  for (const { label, pattern } of dangerousPatterns) {
    const match = body.match(pattern);
    if (match) findings.push(riskFinding('DANGEROUS_COMMAND', label, snippetAround(body, match.index),
      `${boundaryNeighbourhood(body, match.index)} ${sentenceAround(body, match.index)}`));
  }
  for (const { label, pattern, informational } of credentialPatterns) {
    const match = body.match(pattern);
    if (match) findings.push(riskFinding('CREDENTIAL_PATH', label, snippetAround(body, match.index),
      `${boundaryNeighbourhood(body, match.index)} ${sentenceAround(body, match.index)}`, informational));
  }
  const network = body.match(networkPattern);
  if (network) findings.push(riskFinding('NETWORK_EGRESS', 'network', snippetAround(body, network.index),
    `${boundaryNeighbourhood(body, network.index)} ${sentenceAround(body, network.index)}`));

  const proseBody = body.replace(fencedBlockPattern, '');
  for (const match of proseBody.matchAll(referencedFilePattern)) {
    const reference = match[1].replace(/^\.\//, '');
    if (!packageDirs.some(dir => reference.startsWith(dir))) continue;
    if (placeholderRefPattern.test(reference)) continue;
    if (names.has(`${directory}${reference}`) === false) {
      findings.push(finding('REFERENCED_FILE_MISSING', 'medium', reference));
    }
  }
  for (const match of proseBody.matchAll(crossSkillPattern)) {
    findings.push(finding('CROSS_SKILL_RELATIVE_PATH', 'medium',
      `../${match[1]}：跨技能相对引用，单独分发时会断（改用技能标识符）`));
  }
  if (front.fields.name && names.has(`${front.fields.name.replace(/[^a-z0-9._-]/gi, '')}`) === false) {
    // name 只在同库出现两次时才算问题，这里由调用方补齐 DUPLICATE_NAME
  }
  return { findings, name: front.fields.name ?? null, description, bodyBytes, bodyChars,
    tokens: normaliseTokens(description || body) };
}

export function screenSkills({ files, paths } = {}) {
  if (!Array.isArray(files)) throw failure('INVALID_FILES');
  if (paths !== undefined && (!Array.isArray(paths) ||
    paths.some(path => typeof path !== 'string' || !path.trim()))) throw failure('INVALID_PATHS');
  const validated = files.map(file => {
    if (!isRecord(file) || typeof file.relPath !== 'string' || !file.relPath.trim() ||
      typeof file.content !== 'string') throw failure('INVALID_FILE');
    if (file.head !== undefined && !(file.head instanceof Uint8Array)) throw failure('INVALID_FILE');
    return { relPath: file.relPath.replace(/\\/g, '/'), content: file.content, head: file.head };
  });
  // 包内资源的"存在性"要看整棵树的路径：只拿 SKILL.md 的清单去比对，会把每个
  // `references/x.md` 都判成缺失（首轮实测：744 份刷出 1004 条假缺失）。
  const names = new Set((paths ?? validated.map(file => file.relPath)).map(path => path.replace(/\\/g, '/')));
  // 只有 SKILL.md 是被筛查的对象；其余条目只用来判断"正文引用的包内文件是否存在"。
  const screened = validated.filter(file => file.relPath === 'SKILL.md' || file.relPath.endsWith('/SKILL.md'))
    .map(file => ({ file, ...screenOne(file, names) }));

  const byName = new Map();
  for (const entry of screened) {
    if (entry.name) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry.file.relPath]);
  }
  const collisions = [...byName.entries()].filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => ({ name, paths: paths.sort() }));

  const skills = screened.map(entry => {
    const findings = [...entry.findings];
    const collision = collisions.find(item => item.name === entry.name);
    if (collision) findings.push(finding('DUPLICATE_NAME', 'high', `同库 ${collision.paths.length} 处：${collision.paths.join('、')}`));
    const severity = findings.reduce((worst, item) =>
      (worst === null || severityRank[item.severity] < severityRank[worst] ? item.severity : worst), null);
    return { relPath: entry.file.relPath, name: entry.name, descriptionChars: entry.description.length,
      bodyBytes: entry.bodyBytes, findings: findings.sort((left, right) =>
        (severityRank[left.severity] - severityRank[right.severity] || left.code.localeCompare(right.code))),
    severity };
  }).sort((left, right) => left.relPath.localeCompare(right.relPath));

  const clusters = [];
  const withTokens = screened.filter(entry => entry.description.length >= minDescriptionChars);
  for (let i = 0; i < withTokens.length; i += 1) {
    for (let j = i + 1; j < withTokens.length; j += 1) {
      const similarity = jaccard(withTokens[i].tokens, withTokens[j].tokens);
      if (similarity >= clusterThreshold) {
        clusters.push({ members: [withTokens[i].file.relPath.split('/').slice(-2)[0],
          withTokens[j].file.relPath.split('/').slice(-2)[0]].sort(), similarity: Number(similarity.toFixed(3)) });
      }
    }
  }

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const skill of skills) {
    for (const item of skill.findings) bySeverity[item.severity] += 1;
  }
  const byCode = {};
  for (const skill of skills) {
    for (const item of skill.findings) byCode[item.code] = (byCode[item.code] ?? 0) + 1;
  }
  const ranked = [...skills]
    .filter(skill => skill.severity !== null)
    .sort((left, right) => (severityRank[left.severity] - severityRank[right.severity] ||
      right.findings.length - left.findings.length || left.relPath.localeCompare(right.relPath)));

  return freeze({ skills, ranked, collisions, clusters, summary: {
    skills: skills.length, bySeverity, byCode,
    collisions: collisions.length, clusters: clusters.length } });
}

const skippedDirs = new Set(['node_modules', '.git']);

export async function walk(root, prefix = '', collected = []) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    // node_modules/.git 里的 SKILL.md 是第三方 vendored 内容，不算这座库的技能。
    if (entry.isDirectory() && skippedDirs.has(entry.name)) continue;
    // 装配根/回执等顶层下划线目录是投影基础设施，不是源库技能（装配根规范 §1 扫描防重）：
    // 只排除**顶层**，包内 _shared 一类目录仍随所属技能扫描。
    if (entry.isDirectory() && prefix === '' && entry.name.startsWith('_')) continue;
    const relPath = `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`;
    if (entry.isDirectory()) await walk(root, relPath, collected);
    else collected.push(relPath);
  }
  return collected;
}

async function main(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex === -1 || argv[rootIndex + 1] === undefined) {
    process.stderr.write('Usage: node skill-lifecycle/control/skill-screen.mjs --root <dir> [--json <out>]\n');
    return 2;
  }
  const root = argv[rootIndex + 1];
  const allPaths = await walk(root);
  const skillPaths = allPaths.filter(relPath => relPath === 'SKILL.md' || relPath.endsWith('/SKILL.md'));
  const files = [];
  const aliases = [];
  for (const relPath of skillPaths) {
    // 别名目录：SKILL.md 本身是指向另一份实现符号链接（如 facebook/ -> facebook-cli/）。
    // 它不是第二个技能实例，读进来只会造出"重复/名字不一致"的假象。
    if (lstatSync(join(root, relPath)).isSymbolicLink()) {
      aliases.push({ relPath, target: readlinkSync(join(root, relPath)) });
      continue;
    }
    // 头部原始字节要单独读：魔数会在 utf8 解码里变成 U+FFFD，从 content 上认不出来。
    const handle = await open(join(root, relPath), 'r');
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    await handle.close();
    files.push({ relPath, content: await readFile(join(root, relPath), 'utf8'),
      head: head.subarray(0, bytesRead) });
  }
  const report = screenSkills({ files, paths: allPaths });
  const jsonIndex = argv.indexOf('--json');
  if (jsonIndex !== -1 && argv[jsonIndex + 1] !== undefined) {
    await writeFile(argv[jsonIndex + 1], `${JSON.stringify({ root, ...report }, null, 2)}\n`);
  }
  const worst = report.ranked.slice(0, 15).map(skill => {
    const codes = [...new Set(skill.findings.map(item => item.code))].map(code =>
      `${code}×${skill.findings.filter(item => item.code === code).length}`);
    return { relPath: skill.relPath, severity: skill.severity, codes };
  });
  process.stdout.write(`${JSON.stringify({ root, scanned: files.length, aliases: aliases.length,
    files: allPaths.length, aliasDetail: aliases, summary: report.summary,
    worst, collisions: report.collisions, clusters: report.clusters.slice(0, 10) }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
