import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { looksOpaque } from '../../control/skill-screen.mjs';

/**
 * 风险命中逐条人判的**只读**预处理：把每条命中连同上下文行取出来，并给一个初判类别。
 *
 * 分类（初判只是给复核者省时间，不是结论）：
 * - `boundary`：屏检已按句内语义降级为 low 的（"拒绝执行…"）；
 * - `in-fence`：命中落在代码围栏里（多为示例/输出样例）；
 * - `example-marker`：上下文行带"示例/例如/不要采用/反例"一类标记；
 * - `unclear`：**需要人看的**——正文以陈述语气写了危险动作，但没有边界语义。
 *
 * 另外做一遍**包内脚本扫描**：正文干净不代表脚本干净（技能常让 agent 去跑 `scripts/*.py`）。
 */
const skipDirs = new Set(['node_modules', '.git']);
const scriptExtensions = ['.py', '.sh', '.js', '.mjs', '.ts', '.bash'];

const riskPatterns = [
  { code: 'DANGEROUS_COMMAND', label: 'rm -rf', pattern: /\brm\s+-rf?\b/ },
  { code: 'DANGEROUS_COMMAND', label: 'sudo', pattern: /\bsudo\b/ },
  { code: 'DANGEROUS_COMMAND', label: 'chmod 777', pattern: /\bchmod\s+[0-7]*777\b/ },
  { code: 'DANGEROUS_COMMAND', label: 'mkfs', pattern: /\bmkfs\b/ },
  { code: 'DANGEROUS_COMMAND', label: 'dd if=', pattern: /\bdd\s+if=/ },
  { code: 'DANGEROUS_COMMAND', label: 'fork bomb', pattern: /:\(\)\s*\{/ },
  { code: 'CREDENTIAL_PATH', label: '.credentials.yaml', pattern: /\.credentials\.ya?ml/ },
  { code: 'CREDENTIAL_PATH', label: 'apiKeyEnv', pattern: /apiKeyEnv/ },
  { code: 'CREDENTIAL_PATH', label: 'ssh private key', pattern: /\.ssh\/id_[a-z]+\b(?!\.pub)/ },
  { code: 'CREDENTIAL_PATH', label: 'aws credentials', pattern: /\.aws\/credentials/ },
  { code: 'CREDENTIAL_PATH', label: 'env secret', pattern: /\$\{?[A-Z_]*(SECRET|TOKEN|API_KEY)[A-Z_]*\}?/ },
  { code: 'NETWORK_EGRESS', label: 'network', pattern: /(?:curl|wget|nc|ssh|scp)\s+[^\n]*https?:\/\/[^\s)]+/ },
  { code: 'SHELL_EXEC', label: 'subprocess/os.system', pattern: /\b(?:subprocess\.(?:run|Popen|call|check_output)|os\.system|child_process)\b/ },
];
const boundaryHint = /拒绝|禁止|不得|不要|不许|不触发|防止|不执行|不做|不予|永不|严禁|不提供|不涉及|不包含|而非|never|avoid|do not|should not|must not|won't|refuse|disallow/iu;
const exampleHint = /示例|例如|比如|反例|不要采用|example|for instance|e\.g\.|such as|示意/iu;

async function walk(root, prefix = '', collected = []) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (skipDirs.has(entry.name) || entry.isSymbolicLink()) continue;
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(root, relPath, collected);
    else if (entry.isFile()) collected.push(relPath);
  }
  return collected;
}

export async function triageRisks(library) {
  const paths = await walk(library);
  const skillFiles = paths.filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'));
  const skillEntries = [];
  for (const relPath of skillFiles) {
    const bytes = await readFile(join(library, relPath));
    if (looksOpaque(bytes.subarray(0, 8))) continue;
    const lines = bytes.toString('utf8').split(/\r?\n/);
    let inFence = false;
    const findings = [];
    lines.forEach((line, index) => {
      const isFence = /^\s*(?:```|~~~)/.test(line);
      const fenced = inFence;
      if (isFence) inFence = !inFence;
      for (const { code, label, pattern } of riskPatterns) {
        if (!pattern.test(line)) continue;
        const context = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join(' ⏎ ').slice(0, 400);
        const boundary = boundaryHint.test(context);
        const example = exampleHint.test(context);
        let verdict = 'unclear';
        if (boundary) verdict = 'boundary';
        else if (fenced || isFence) verdict = 'in-fence';
        else if (example) verdict = 'example-marker';
        findings.push({ code, label, line: index + 1, verdict, snippet: line.trim().slice(0, 200), context });
      }
    });
    if (findings.length > 0) skillEntries.push({ relPath, findings });
  }

  const scripts = [];
  for (const relPath of paths) {
    if (/SKILL\.md$/.test(relPath)) continue;
    if (!scriptExtensions.some(extension => relPath.toLowerCase().endsWith(extension))) continue;
    const bytes = await readFile(join(library, relPath));
    if (bytes.length === 0) continue;
    if (looksOpaque(bytes.subarray(0, 8))) continue;
    const text = bytes.toString('utf8');
    if (text.includes('\u0000')) continue;
    const findings = [];
    text.split(/\r?\n/).forEach((line, index) => {
      for (const { code, label, pattern } of riskPatterns) {
        if (!pattern.test(line)) continue;
        findings.push({ code, label, line: index + 1, snippet: line.trim().slice(0, 200) });
      }
    });
    if (findings.length > 0) scripts.push({ relPath, findings });
  }

  const verdicts = {};
  for (const entry of skillEntries) {
    for (const finding of entry.findings) verdicts[finding.verdict] = (verdicts[finding.verdict] ?? 0) + 1;
  }
  const unclear = skillEntries.flatMap(entry => entry.findings
    .filter(finding => finding.verdict === 'unclear')
    .map(finding => ({ ...finding, relPath: entry.relPath })));
  return { skills: skillEntries, scripts, verdicts, unclear };
}

async function main(argv) {
  const flag = name => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const library = flag('library');
  if (!library) {
    process.stderr.write('Usage: node risk-triage.mjs --library <dir> [--json <out>] [--md <out>]\n');
    return 2;
  }
  const report = await triageRisks(library);
  const jsonPath = flag('json');
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify({ library, at: new Date().toISOString(), ...report }, null, 2)}\n`);
  const mdPath = flag('md');
  if (mdPath) {
    const lines = ['# 风险命中逐条人判（只读预处理）', '',
      `正文命中分布：${Object.entries(report.verdicts).map(([k, v]) => `${k} ${v}`).join(' / ')}`,
      `涉及技能：${report.skills.length}；脚本侧命中：${report.scripts.length} 个文件`, '',
      `## 需人判的 unclear（${report.unclear.length}）`, ''];
    for (const item of report.unclear) {
      lines.push(`- \`${item.relPath}\` L${item.line} · ${item.code}/${item.label}`, `  - ${item.snippet}`, `  - 上下文：${item.context}`, '');
    }
    lines.push('', '## 包内脚本命中（按文件）', '');
    for (const script of report.scripts.sort((a, b) => b.findings.length - a.findings.length)) {
      lines.push(`- \`${script.relPath}\`（${script.findings.length} 条：${[...new Set(script.findings.map(f => f.label))].join('、')}）`);
    }
    await writeFile(mdPath, `${lines.join('\n')}\n`);
  }
  process.stdout.write(`${JSON.stringify({ verdicts: report.verdicts, skills: report.skills.length,
    scriptFiles: report.scripts.length, unclear: report.unclear.length,
    json: jsonPath ? relative(process.cwd(), jsonPath) : null,
    md: mdPath ? relative(process.cwd(), mdPath) : null }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
