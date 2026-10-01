import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 105-016 Sage 兼容静态矩阵 · YAML 探针（零请求）。
 * 用真实 yaml 解析器对装配根逐项做 frontmatter 字段级检查（R01/R02/R03/R09/R10/R11/R14 的静态面），
 * 产出 JSON 供 sage-matrix-make.py 汇总。静态检查不等于原生运行验证。
 *
 * 用法：node sage-matrix-yaml.mjs --root <装配根> --out <probe.json> [--yaml <yaml 模块路径>]
 */
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const root = flag('root');
const out = flag('out');
const yamlPath = flag('yaml') ?? '/Users/lute/.dsh/profiles/lute-shell/node_modules/yaml';
if (!root || !out) {
  process.stderr.write('Usage: node sage-matrix-yaml.mjs --root <dir> --out <json> [--yaml <pkg>]\n');
  process.exit(2);
}
const yaml = require(yamlPath);

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const items = [];
for (const entry of readdirSync(root).sort()) {
  if (entry.startsWith('.')) continue;
  const full = join(root, entry);
  let skillFile = null;
  let kind = null;
  const st = statSync(full);
  if (st.isDirectory()) {
    try {
      const candidate = join(full, 'SKILL.md');
      if (statSync(candidate).isFile()) { skillFile = candidate; kind = 'dir'; }
    } catch { /* 无 SKILL.md 的目录不进探针（由 python 侧布局检查报告） */ }
  } else if (st.isFile() && entry.endsWith('.md')) {
    skillFile = full; kind = 'flat';
  }
  if (!skillFile) continue;

  const text = readFileSync(skillFile, 'utf8');
  const lines = text.split('\n');
  const firstLineOk = lines[0] === '---';                    // 原生不清洗 BOM/前置空白
  let closeIdx = -1;
  if (firstLineOk) {
    for (let i = 1; i < lines.length; i += 1) if (lines[i].trimEnd() === '---') { closeIdx = i; break; }
  }
  let fm = null;
  let parseOk = false;
  if (closeIdx > 0) {
    const block = lines.slice(1, closeIdx).join('\n');
    try {
      const parsed = yaml.parse(block);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fm = parsed; parseOk = true;
      }
    } catch { parseOk = false; }
  }
  const nameVal = fm?.name;
  const descVal = fm?.description;
  const descStr = typeof descVal === 'string' ? descVal : '';
  const switches = {};
  if (fm) {
    for (const key of ['disable-model-invocation', 'user-invocable']) {
      if (Object.prototype.hasOwnProperty.call(fm, key)) switches[key] = fm[key];
    }
  }
  const camelKeys = fm ? ['disableModelInvocation', 'userInvocable'].filter(k => Object.prototype.hasOwnProperty.call(fm, k)) : [];
  items.push({
    dir: entry, kind,
    frontmatterOk: firstLineOk && closeIdx > 0 && parseOk,
    firstLineOk, closeFound: closeIdx > 0, parseOk,
    nameOk: typeof nameVal === 'string' && NAME_RE.test(nameVal),
    name: typeof nameVal === 'string' ? nameVal : null,
    nameTypeOk: typeof nameVal === 'string',
    descTypeOk: typeof descVal === 'string',
    nameLen: typeof nameVal === 'string' ? nameVal.length : 0,
    descLen: descStr.length,
    descBlankOnly: descStr.length > 0 && descStr.trim() === '',
    descJsLen: descStr.replace(/\s+/g, ' ').trim().length,   // R11：压缩空白后的 JS 字符单元数
    topKeys: fm ? Object.keys(fm) : [],
    switches, camelKeys,
  });
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), root, items }, null, 1)}\n`);
console.log(JSON.stringify({ items: items.length, out }));
