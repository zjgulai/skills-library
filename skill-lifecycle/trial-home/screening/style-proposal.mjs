import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * ②⑤ 风格/结构项的**只读**建议清单：把屏检报告里剩余的四类逐条摊开，附可执行的处置建议。
 * 只产建议，不改技能库——内容改动一律要人拍板。
 */
const library = '/Users/lute/project/AgentTools/技能库';

const flag = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const screenPath = flag('screen');
if (!screenPath) {
  process.stderr.write('Usage: node style-proposal.mjs --screen <screen.json> [--json <out>] [--md <out>]\n');
  process.exit(2);
}
const screen = JSON.parse(readFileSync(screenPath, 'utf8'));

const group = code => screen.skills
  .filter(skill => skill.findings.some(item => item.code === code))
  .map(skill => ({ relPath: skill.relPath, name: skill.name,
    descriptionChars: skill.descriptionChars, bodyBytes: skill.bodyBytes,
    detail: skill.findings.find(item => item.code === code).detail }));

const mismatches = group('NAME_FOLDER_MISMATCH').map(entry => {
  const folder = entry.relPath.split('/').slice(-2, -1)[0] ?? '';
  return { ...entry, folder,
    proposal: /^artifact[-_]/.test(entry.name) || /^artifacts\//.test(entry.relPath)
      ? '命名空间（artifacts/* 里是 artifact_*）：建议保留并登记——统一的代价大于收益'
      : '逐个人工确认：目录名与 name 哪个是对的，改另一个' };
});
const shortDescriptions = group('SHORT_DESCRIPTION').map(entry => ({
  ...entry,
  proposal: entry.relPath.includes('/in-progress/')
    ? 'in-progress 目录（未发布草稿）：建议不动，等它定稿'
    : '描述是坏值（`">"`）：需按正文重写一句触发式描述（要你批文本）',
}));
const tooLong = group('DESCRIPTION_TOO_LONG').map(entry => ({ ...entry,
  proposal: '超 1024 字符是**规格建议**、DSH 不限制：建议不改（除非你要统一到规格内）' }));
const emptyBodies = group('EMPTY_BODY').map(entry => ({ ...entry,
  proposal: '正文为空：要么补写正文，要么按"未完成"登记' }));
const noWorkflow = group('NO_WORKFLOW_SECTION').map(entry => ({ ...entry,
  proposal: '正文没有 `##` 小节：多数是"纯参考型"技能；建议只在正文明显该分段时补标题' }));

const report = { library, screen: screenPath, at: new Date().toISOString(),
  groups: { mismatches, shortDescriptions, tooLong, emptyBodies, noWorkflow } };

const jsonPath = flag('json');
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const mdPath = flag('md');
if (mdPath) {
  const lines = ['# ②⑤ 风格/结构项建议（只读；内容改动待拍板）', ''];
  const section = (title, list, field) => {
    lines.push(`## ${title}（${list.length}）`, '');
    for (const entry of list) {
      lines.push(`- \`${entry.relPath}\` — ${field(entry)}`, `  - 建议：${entry.proposal}`, `  - 屏检读数：${entry.detail}`);
    }
    lines.push('');
  };
  section('目录名与 name 不一致', mismatches, entry => `name=\`${entry.name}\`，目录=\`${entry.folder}\``);
  section('描述过短', shortDescriptions, entry => `${entry.descriptionChars} 字符`);
  section('描述超 1024（规格建议项）', tooLong, entry => `${entry.descriptionChars} 字符`);
  section('正文为空', emptyBodies, entry => `${entry.bodyBytes} 字节`);
  section('正文没有任何 ## 小节', noWorkflow, entry => `${entry.bodyBytes} 字节`);
  writeFileSync(mdPath, `${lines.join('\n')}\n`);
}
process.stdout.write(`${JSON.stringify({ counts: Object.fromEntries(Object.entries(report.groups)
  .map(([key, value]) => [key, value.length])),
  json: jsonPath ? pathToFileURL(jsonPath).pathname.replace(process.cwd() + '/', '') : null,
  md: mdPath ? mdPath.replace(`${process.cwd()}/`, '') : null }, null, 2)}\n`);
