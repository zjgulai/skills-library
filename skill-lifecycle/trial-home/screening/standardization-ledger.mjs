import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync, lstatSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 库面标准化真值表：把「谁被标准化过」从口头结论变成一条命令能答的东西。
 *
 * 五票各自独立可追溯，任何一个缺失都如实留着，不互相推断：
 *   screened    屏检射程内（顶层下划线目录按装配根规范排除）
 *   judged      有 live 轮次 stage.json 直接指向这个库内目录
 *   writtenBack 有写回备份根装着这个目录的前像（首入件无备份根，见 firstEntry 票）
 *   loaded      L5 装载台账里有它
 *   inLoop      闭环台账（管理圈）登记了它
 * 改名链用 library-backup-rename-<新名>/ 里存的**旧路径**回连，否则旧路径上的票会丢。
 */

const SKILL_MD = 'SKILL.md';
const DSH_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_FIELDS = ['name', 'description'];
const STANDARD_FIELDS = ['name', 'description', 'version', 'license', 'author', 'tags', 'complexity', 'compatibility'];
const RENAMED_ROOT = /^library-backup-rename-(.+?)(?:-\d{4}-\d{2}-\d{2})?(?:-[a-z])?$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readCsv(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').replace(/^/, '').trim().split('\n');
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? '']));
  });
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

function walkLibrary(root, prefix, collected, skippedTopLevel) {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '__pycache__' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // 装配根/历史根是投影基础设施，不是源库技能（装配根规范 §1 扫描防重）：只排除顶层下划线。
      if (!prefix && entry.name.startsWith('_')) { skippedTopLevel.push(rel); continue; }
      walkLibrary(root, rel, collected, skippedTopLevel);
    } else collected.push(rel);
  }
  return collected;
}

function frontmatterKeys(text) {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^/, '').trim() !== '---') return null;
  const keys = new Set();
  let inBlock = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '---') break;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/);
    if (match) { keys.add(match[1]); inBlock = /^[|>][-+]?\d*$/.test(match[2].trim()); }
    else if (inBlock && (line === '' || /^\s/.test(line))) continue;
    else inBlock = false;
  }
  return keys;
}

function frontmatterValue(text, key) {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^/, '').trim() !== '---') return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') break;
    const match = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (match) {
      const value = match[1].trim();
      if (/^[|>][-+]?\d*$/.test(value)) {
        const parts = [];
        for (let next = index + 1; next < lines.length; next += 1) {
          if (lines[next].trim() === '---') break;
          if (!/^\s/.test(lines[next]) && lines[next] !== '') break;
          parts.push(lines[next].trim());
        }
        return parts.join(' ');
      }
      return value.replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

/** 改名链有两个证据源：rename 备份根（根名＝新名，根内＝旧路径），以及写回计划里的 rename-put/remove 对。 */
function readRenameMap(trialHome, specHome) {
  const map = new Map();
  const provenance = new Map();
  for (const entry of readdirSync(trialHome, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = RENAMED_ROOT.exec(entry.name);
    if (!match) continue;
    const newName = match[1];
    const root = join(trialHome, entry.name);
    for (const rel of walkLibrary(root, '', [], [])) {
      if (basename(rel) !== SKILL_MD) continue;
      const oldName = basename(dirname(rel));
      if (oldName !== newName) { map.set(oldName, newName); provenance.set(oldName, entry.name); }
    }
  }
  // 计划文件：LB-8 的改名走的是 writeback 执行器的 rename-put / rename-remove 双计划。
  const plans = [];
  const collect = dir => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) collect(abs);
      else if (/^(plan|writeback-plan)-.*rename.*\.json$/.test(entry.name)) plans.push(abs);
    }
  };
  collect(specHome);
  const byStem = new Map();
  for (const path of plans) {
    const base = basename(path, '.json').replace(/^(plan|writeback-plan)-/, '');
    const bucket = /-rename-remove(?:-.*)?$/.test(base) ? 'remove'
      : /-rename-put(?:-.*)?$/.test(base) ? 'put' : null;
    if (!bucket) continue;
    const key = base.replace(/-rename-(?:put|remove)(?:-.*)?$/, '');
    if (!byStem.has(key)) byStem.set(key, {});
    byStem.get(key)[bucket] = path;
  }
  const skillOf = (path, kind) => {
    let plan; try { plan = readJson(path); } catch { return null; }
    for (const op of plan.ops ?? []) {
      if (op.kind !== kind) continue;
      if (!op.relPath || basename(dirname(op.relPath)) === '.') continue;
      if (basename(op.relPath) !== SKILL_MD) continue;
      return op.relPath;
    }
    return null;
  };
  for (const [key, pair] of byStem) {
    if (!pair.put || !pair.remove) continue;
    const putRel = skillOf(pair.put, 'put');
    const removeRel = skillOf(pair.remove, 'remove');
    if (!putRel || !removeRel) continue;
    const oldName = basename(dirname(removeRel));
    const newName = basename(dirname(putRel));
    if (oldName !== newName && !map.has(oldName)) { map.set(oldName, newName); provenance.set(oldName, key); }
  }
  readRenameMap.provenance = provenance;
  return map;
}

export function buildLedger({ libraryRoot, trialHome, specHome, screenReport, disableRecertVote = false }) {
  const skippedTopLevel = [];
  const libraryFiles = walkLibrary(libraryRoot, '', [], skippedTopLevel);
  const renameMap = readRenameMap(trialHome, specHome);

  // --- 票 1：屏检 ---
  const screened = new Map((screenReport.skills ?? []).map(item => [item.relPath, item]));

  // --- 票 2：live 轮次直接指向库内目录 ---
  const judged = new Map();
  const optRun = join(trialHome, 'opt-run');
  for (const entry of readdirSync(optRun, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^r\d+$/.test(entry.name)) continue;
    const stagePath = join(optRun, entry.name, 'stage.json');
    if (!existsSync(stagePath)) continue;
    let stage;
    try { stage = readJson(stagePath); } catch { continue; }
    if (typeof stage.skill !== 'string' || !stage.skill.startsWith(libraryRoot)) continue;
    const rel = relative(libraryRoot, stage.skill).split('\\').join('/');
    if (!judged.has(rel)) judged.set(rel, []);
    judged.get(rel).push(`r${stage.round}`);
  }

  // --- 票 2b：候选先认证、后写回的批（ZIP 族）---
  // 判者轮次的 stage.json 指向 opt-run 候选目录，上面的「库内路径」匹配看不见它们；
  // 42 件写回后被判空转＝正控-未触达残差报红的根因（2026-10-08 实测）。
  // 接线口径：写回计划的 source 目录 == 该轮 stage.skill，且**计划字节摘要 == 该轮 digests 里的同一文件摘要**
  // ——被评的字节必须就是入库的字节，否则不记票（宁缺不伪）。
  const judgedBy = new Map();
  for (const rel of judged.keys()) judgedBy.set(rel, 'path');
  const planDir = join(trialHome, 'opt-run', 'writeback-zip');
  if (!disableRecertVote && existsSync(planDir)) {
    const stageBySkill = new Map();
    for (const entry of readdirSync(join(trialHome, 'opt-run'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^r\d+$/.test(entry.name)) continue;
      const stagePath = join(trialHome, 'opt-run', entry.name, 'stage.json');
      let stage; try { stage = readJson(stagePath); } catch { continue; }
      if (typeof stage.skill !== 'string' || !/opt-run\/candidates/.test(stage.skill)) continue;
      const key = stage.skill.replace(/\/$/, '');
      const prev = stageBySkill.get(key);
      if (!prev || Number(stage.round) > Number(prev.round)) stageBySkill.set(key, stage);
    }
    for (const file of readdirSync(planDir).filter(name => /^plan-.*\.json$/.test(name))) {
      let plan; try { plan = readJson(join(planDir, file)); } catch { continue; }
      for (const op of plan.ops ?? []) {
        if (op.kind !== 'put' || typeof op.relPath !== 'string' || typeof op.source !== 'string') continue;
        if (basename(op.relPath) !== SKILL_MD) continue;
        const srcDir = op.source.split('/').slice(0, -1).join('/').replace(/\/$/, '');
        const stage = stageBySkill.get(srcDir);
        if (!stage) continue;
        const digest = (stage.digests ?? {})[SKILL_MD] ?? null;
        if (!digest || typeof op.sourceSha256 !== 'string' || !op.sourceSha256.startsWith(digest)) continue;
        const dir = dirname(op.relPath);
        if (!judged.has(dir)) judged.set(dir, []);
        judged.get(dir).push(`r${stage.round}`);
        judgedBy.set(dir, `zip-recert:r${stage.round}`);
      }
    }
  }

  // --- 票 3：写回备份根（覆盖写的前像）；首入件没有前像，单独一票 ---
  const writtenBack = new Map();
  const firstEntry = new Map();
  for (const entry of readdirSync(trialHome, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('library-backup-writeback-')) continue;
    const tag = entry.name.slice('library-backup-writeback-'.length);
    const root = join(trialHome, entry.name);
    const skillRels = walkLibrary(root, '', [], []).filter(rel => basename(rel) === SKILL_MD);
    const target = /first-entry/.test(tag) ? firstEntry : writtenBack;
    if (!skillRels.length) {
      // 首入根是空壳（新件无前像）：按根名记一票。
      const name = tag.replace(/-first-entry-.*$/, '').replace(/-[\w-]*\d{4}-\d{2}-\d{2}.*$/, '');
      if (!target.has(name)) target.set(name, new Set());
      target.get(name).add(tag);
      continue;
    }
    for (const rel of skillRels) {
      const dir = dirname(rel);
      if (!target.has(dir)) target.set(dir, new Set());
      target.get(dir).add(tag);
    }
  }

  // --- 票 4：L5 装载台账 ---
  const loaded = new Map();
  for (const rel of [
    join(specHome, '143-library-normalize/p2-writeback/l5-ledger.csv'),
    join(specHome, '143-library-normalize/lowband-lb8/container3-salvage/l5-ledger.csv'),
    join(specHome, '145-standardization-baseline/zip42-writeback/l5-ledger.csv'),
  ]) {
    const rows = readCsv(rel);
    if (!rows) continue;
    for (const row of rows) {
      const name = row.name ?? row.skill ?? '';
      if (!name) continue;
      if (!loaded.has(name)) loaded.set(name, new Set());
      loaded.get(name).add(row.status ?? row.result ?? 'ledger');
    }
  }

  // --- 票 5：闭环台账（管理圈）---
  const loop = new Map();
  const loopRows = readCsv(join(specHome, '109-loop-ledger/loop-ledger-v3.csv')) ?? [];
  for (const row of loopRows) {
    const raw = (row.sourcePath ?? '').replace(/\\/g, '/');
    if (!raw) continue;
    const dir = raw.endsWith(`/${SKILL_MD}`) ? dirname(raw) : raw;
    if (!loop.has(dir)) loop.set(dir, new Set());
    loop.get(dir).add(row.ledgerId ?? row.name ?? 'row');
  }

  // --- 认证分数（按名，来自各批 results.csv）---
  const scores = new Map();
  const ledgers = [
    '143-library-normalize/fix-plans/p2-wave1-results.csv',
    '143-library-normalize/fix-plans/p2-wave2-results.csv',
    '143-library-normalize/nearmiss-pilot/results.csv',
    '143-library-normalize/nearmiss-pilot2/results.csv',
    ...[1, 2, 3, 4, 5, 6, 7].map(n => `143-library-normalize/lowband-lb${n}/results.csv`),
    ...['wave1-results.csv', 'wave1-final-results.csv', 'wave2a-results.csv', 'wave2b-results.csv',
      'gen2-8-results.csv', 'gen3-results.csv'].map(f => `143-library-normalize/lowband-lb8/${f}`),
    '143-library-normalize/lowband-strip39/results.csv',
  ];
  for (const rel of ledgers) {
    const rows = readCsv(join(specHome, rel));
    if (!rows) continue;
    for (const row of rows) {
      if (!row.name) continue;
      const score = Number(row.score);
      if (!Number.isFinite(score)) continue;
      const best = Math.max(scores.get(row.name) ?? 0, score);
      scores.set(row.name, best);
    }
  }

  const items = [];
  const aliasRescued = [];
  // 只有 library-backup-rename-* 记录的改名对才是有据的跨路径别名；frontmatter name 相同不构成别名。
  // 负控实测抓过：skill-hl 里 brand-narrative 这类同名件会被凭名字捞成「已判读」，那是假绿。
  const aliasByDirName = new Map();
  for (const [oldName, newName] of renameMap) {
    if (!aliasByDirName.has(newName)) aliasByDirName.set(newName, new Set());
    aliasByDirName.get(newName).add(oldName);
  }
  for (const rel of libraryFiles.filter(path => basename(path) === SKILL_MD)) {
    const dir = dirname(rel);
    const dirName = dir === '.' ? '' : basename(dir);
    const abs = join(libraryRoot, rel);
    const text = readFileSync(abs, 'utf8');
    const fmName = frontmatterValue(text, 'name');
    const description = frontmatterValue(text, 'description');
    const keys = frontmatterKeys(text);
    const renameSources = [
      ...(aliasByDirName.get(dirName) ?? []),
      ...(fmName ? [...(aliasByDirName.get(fmName) ?? [])] : []),
    ];
    const names = new Set([dirName, fmName, ...renameSources].filter(Boolean));
    const yes = by => ({ value: true, by });
    const no = { value: false, by: null };
    const judgedDirect = judged.get(dir);
    const judgedViaRename = renameSources
      .map(source => [...judged.keys()].find(key => basename(key) === source))
      .filter(Boolean);
    const writtenHere = writtenBack.has(dir);
    const firstEntryHit = [...names].some(name => firstEntry.has(name));
    const loadedHit = [...names].some(name => loaded.has(name));
    const votes = {
      screened: screened.has(rel) ? yes('path') : no,
      judged: judgedDirect?.length ? yes(judgedBy.get(dir) ?? 'path')
        : judgedViaRename.length ? yes('rename') : no,
      writtenBack: writtenHere ? yes('path')
        : firstEntryHit ? yes('firstEntry-name') : no,
      loaded: loadedHit ? yes('name') : no,
      inLoop: loop.has(dir) || loop.has(rel) ? yes('path') : no,
    };
    if (votes.judged.by === 'rename') aliasRescued.push({ dir, via: judgedViaRename.map(key => basename(key)) });
    const bestScore = Math.max(0, ...[...names].map(alias => scores.get(alias) ?? 0));
    const screen = screened.get(rel);
    const missingFields = keys === null ? STANDARD_FIELDS : STANDARD_FIELDS.filter(field => !keys.has(field));
    const gapAxes = [];
    if (keys === null) gapAxes.push('NO_FRONTMATTER');
    if (!DSH_NAME.test(dirName)) gapAxes.push('NON_KEBAB_DIR');
    if (fmName && fmName !== dirName) gapAxes.push('NAME_FIELD_NE_FOLDER');
    if (fmName && !DSH_NAME.test(fmName)) gapAxes.push('NON_KEBAB_NAME_FIELD');
    if (description && description.length > 1024) gapAxes.push('DESCRIPTION_OVER_1024');
    for (const field of missingFields) gapAxes.push(`FIELD_${field.toUpperCase()}_MISSING`);
    if (!votes.judged.value) gapAxes.push('NEVER_JUDGED');
    items.push({
      rel, dir, batch: rel.split('/')[0], dirName, fmName,
      isAlias: (() => { try { return lstatSync(abs).isSymbolicLink(); } catch { return false; } })(),
      sizeBytes: statSync(abs).size,
      descriptionChars: description ? description.length : 0,
      screenSeverity: screen?.severity ?? null,
      screenFindingCount: screen?.findings?.length ?? 0,
      bestCertifiedScore: bestScore || null,
      votes,
      voteCount: Object.values(votes).filter(vote => vote.value).length,
      gapAxes,
      bucket: classifyBucket(votes, gapAxes),
    });
  }

  return { items, renameMap: [...renameMap], skippedTopLevel, aliasRescued, ledgerCounts: {
    judgedPaths: judged.size, writtenBackDirs: writtenBack.size, firstEntryKeys: firstEntry.size,
    loadedNames: loaded.size, loopDirs: loop.size, scoredNames: scores.size,
  } };
}

function classifyBucket(votes, gapAxes) {
  if (!votes.judged.value && !votes.inLoop.value) return 'untracked';
  if (gapAxes.some(axis => !axis.startsWith('FIELD_') && axis !== 'NEVER_JUDGED')) return 'name-or-structure-gap';
  return 'clean';
}

function controls({ libraryRoot, trialHome, specHome }) {
  const failures = [];
  let checked = 0;
  // 屏检快照不能写死日期：写死后未来的批会静默拿旧快照比对（规则二：会被重建的工件名不写死）。
  const screenDir = join(trialHome, 'screening');
  const screenPick = readdirSync(screenDir).filter(name => /^library-screen-.*\.json$/.test(name)).sort().pop();
  const report = readJson(join(screenDir, screenPick));
  const ledger = buildLedger({ libraryRoot, trialHome, specHome, screenReport: report });
  const byDir = new Map(ledger.items.map(item => [item.dir, item]));
  const expect = (label, condition, detail) => { checked += 1; if (!condition) failures.push(`${label} :: ${detail}`); };

  // 正控一：LB-1 改名件必须靠 library-backup-rename 的旧路径把 judged 票捞回来，且证据记为 rename。
  const renamed = 'skills/kimi/skills/apparel-tech-pack';
  expect('正控-改名回连', byDir.get(renamed)?.votes.judged.by === 'rename',
    `${renamed} 应经旧路径 fashion-sketch-cn 判为已判读（by=rename）`);
  // 正控二：去向②首入件没有写回前像，必须靠 firstEntry 票成立。
  const firstEntryItem = ledger.items.find(item => item.dirName === 'account-health-appeal');
  expect('正控-首入票', firstEntryItem?.votes.writtenBack.value === true,
    'account-health-appeal 首入件应记 writtenBack 票');
  // 正控三：管理圈件必须同时在闭环台账里。
  const managed = '81-Skills/ad-creative';
  expect('正控-管理圈', byDir.get(managed)?.votes.inLoop.value === true, `${managed} 应在 loop-ledger v3 内`);
  // 正控四：覆盖断言——除「本轮授权的新批」和「结构性件」外，未触达残差必须为空集。
  // 这不是把魔数调绿：任何一条改名证据链断掉，都会在这里以件名列的形式暴露。
  const authorizedNewBatch = new Set(['skill-hl']);
  const residual = ledger.items.filter(item => !item.votes.judged.value && !item.votes.inLoop.value
    && !item.isAlias && !authorizedNewBatch.has(item.batch) && !item.dir.includes('/assets/templates/'));
  expect('正控-未触达残差为空', residual.length === 0,
    `残差 ${residual.length} 件：${residual.map(item => item.dir).join(', ') || '（无）'}`);
  const judgedCount = ledger.items.filter(item => item.votes.judged.value).length;
  expect('正控-计票非零', judgedCount > 600, `judged 件数 ${judgedCount} 不应接近 0`);

  // 正控五：ZIP 族首入批（候选先认证、后写回）必须靠写回计划↔判者轮次接上 judged 票，
  // 且**当场重算**「库内现字节 == 计划 sourceSha256 == 该轮 digests 摘要」——不是引用 L1 的结论。
  const zipBatch = ledger.items.filter(item => String(item.votes.judged.by ?? '').startsWith('zip-recert:'));
  const planDirCtl = join(trialHome, 'opt-run', 'writeback-zip');
  let zipByteCheck = 0, zipByteFail = [];
  if (existsSync(planDirCtl)) {
    for (const file of readdirSync(planDirCtl).filter(name => /^plan-.*\.json$/.test(name))) {
      const plan = readJson(join(planDirCtl, file));
      for (const op of plan.ops ?? []) {
        if (op.kind !== 'put' || basename(op.relPath ?? '') !== SKILL_MD) continue;
        const now = createHash('sha256').update(readFileSync(join(libraryRoot, op.relPath))).digest('hex');
        zipByteCheck += 1;
        if (now !== op.sourceSha256) zipByteFail.push(op.relPath);
      }
    }
  }
  const zipFiveVotes = zipBatch.filter(item => item.votes.judged.value
    && item.votes.writtenBack.value === true && item.votes.loaded.value === true && item.votes.screened.value === true);
  const zipNotLoop = zipBatch.filter(item => item.votes.inLoop.value);
  expect('正控-ZIP 首入批五票齐（除管理圈）', zipFiveVotes.length === 42 && zipNotLoop.length === 0,
    `五票齐 ${zipFiveVotes.length}/42｜不应在管理圈却在的 ${zipNotLoop.length} 件：${zipNotLoop.slice(0, 3).map(item => item.dir).join(', ') || '（无）'}`);
  expect('正控-ZIP 首入批 judged 接得上', zipBatch.length === 42 && zipByteCheck === 42 && zipByteFail.length === 0,
    `zip-recert 票 ${zipBatch.length} 件（应 42）｜逐字节复核 ${zipByteCheck} 件，不符 ${zipByteFail.length} 条：${zipByteFail.slice(0, 3).join(', ') || '（无）'}`);
  // 负控-ZIP：摘掉 recert 源后这 42 件必须整体回到未判读——证明那条票确实由该源提供，不是别处蹭来的。
  const noRecert = buildLedger({ libraryRoot, trialHome, specHome, screenReport: report, disableRecertVote: true });
  const stillClaimed = noRecert.items.filter(item => item.batch === 'skills-manus' || item.batch === 'skills-minmaxdesign')
    .filter(item => item.votes.judged.value);
  expect('负控-ZIP 源摘掉即转假', stillClaimed.length === 0,
    `摘掉 recert 源后仍有 ${stillClaimed.length} 件带 judged 票：${stillClaimed.slice(0, 3).map(item => item.dir).join(', ') || '（无）'}`);

  // 负控一：刚重下载、任何台账都没有的批必须整批判未触达。
  const fresh = ledger.items.filter(item => item.batch === 'skill-hl');
  expect('负控-新批未触达', fresh.length === 53 && fresh.every(item => !item.votes.judged.value && !item.votes.inLoop.value),
    `skill-hl ${fresh.length} 件应全部未判读且不在管理圈`);
  // 负控二：同名不得误捞——frontmatter name 撞上已判读件名的新件，judged 仍必须为假。
  const judgedBasenames = new Set(ledger.items
    .filter(item => item.votes.judged.by === 'path').map(item => item.dirName));
  const homonym = fresh.find(item => item.fmName && judgedBasenames.has(item.fmName));
  expect('负控-同名不误捞', homonym ? homonym.votes.judged.value === false : true,
    homonym ? `${homonym.dir} 的 name「${homonym.fmName}」与已判读件同名，仍不得记 judged 票` : '本批无同名样本，控制未覆盖');
  // 负控三：只在屏检里造一个库内不存在的件，不得被造进真值表。
  const ghost = buildLedger({ libraryRoot, trialHome, specHome, screenReport: { skills: [{ relPath: 'does-not-exist/SKILL.md', severity: 'high', findings: [] }] } });
  expect('负控-幽灵件', !ghost.items.some(item => item.rel === 'does-not-exist/SKILL.md'), '库内不存在的件不得被造出来');
  // 负控四：摘掉两票后走同一条分类函数，bucket 必须从 clean 翻成 untracked。
  const sample = byDir.get(managed);
  const flipped = classifyBucket({ ...sample.votes, judged: { value: false, by: null }, inLoop: { value: false, by: null } }, sample.gapAxes);
  expect('负控-bucket 会翻', flipped === 'untracked' && sample.bucket !== 'untracked',
    `摘掉 judged/inLoop 后应转 untracked，实得 ${flipped}（原 ${sample.bucket}）`);
  return { failures, checked, ledger };
}

async function main(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index === -1 ? undefined : argv[index + 1]; };
  const libraryRoot = value('--root') ?? '/Users/lute/project/AgentTools/技能库';
  const repoRoot = value('--repo') ?? process.cwd();
  const trialHome = join(repoRoot, 'skill-lifecycle/trial-home');
  const specHome = join(repoRoot, 'docs/specs/2026-09-25-dsh-skill-lifecycle');

  if (argv.includes('--control')) {
    const { failures, checked, ledger } = controls({ libraryRoot, trialHome, specHome });
    const line = { mode: 'control', at: new Date().toISOString(), checked, failures: failures.length, detail: failures,
      ledgerCounts: ledger.ledgerCounts, items: ledger.items.length,
      renamePairsFromPlans: [...(readRenameMap.provenance ?? {}).values()].filter(v => !v.startsWith('library-backup')).length };
    console.log(JSON.stringify(line, null, 1));
    return failures.length ? 1 : 0;
  }

  const screenPath = value('--screen') ?? join(trialHome, 'screening/library-screen-2026-10-07b.json');
  const ledger = buildLedger({ libraryRoot, trialHome, specHome, screenReport: readJson(screenPath) });
  const buckets = {};
  const gapAxisTotals = {};
  const batchRollup = {};
  for (const item of ledger.items) {
    buckets[item.bucket] = (buckets[item.bucket] ?? 0) + 1;
    for (const axis of item.gapAxes) gapAxisTotals[axis] = (gapAxisTotals[axis] ?? 0) + 1;
    const b = batchRollup[item.batch] ?? { batch: item.batch, items: 0, judged: 0, writtenBack: 0, loaded: 0, inLoop: 0, clean: 0, untracked: 0 };
    b.items += 1;
    if (item.votes.judged.value) b.judged += 1;
    if (item.votes.writtenBack.value) b.writtenBack += 1;
    if (item.votes.loaded.value) b.loaded += 1;
    if (item.votes.inLoop.value) b.inLoop += 1;
    if (item.bucket === 'clean') b.clean += 1;
    if (item.bucket === 'untracked') b.untracked += 1;
    batchRollup[item.batch] = b;
  }
  const result = {
    mode: 'ledger', at: new Date().toISOString(), root: libraryRoot, screen: basename(screenPath),
    totals: { items: ledger.items.length, buckets, gapAxisTotals, ledgerCounts: ledger.ledgerCounts,
      renameAliases: ledger.renameMap.length, aliasRescued: ledger.aliasRescued.length,
      skippedTopLevel: ledger.skippedTopLevel },
    batches: Object.values(batchRollup).sort((a, b) => b.untracked - a.untracked || b.items - a.items),
    items: ledger.items,
  };
  const out = value('--out');
  if (out) {
    writeFileSync(out, JSON.stringify(result, null, 1));
    // 票现在是 {value, by} 对象：直接拼进 CSV 会写成 [object Object]（本轮实测发现，早于本批就存在）。
    // 改为 value 入列、judged 的 provenance 单列（by=rename / zip-recert:rN 这类信息不能只在 json 里）。
    const csv = ['dir,batch,fmName,bucket,votesJudged,votesWrittenBack,votesLoaded,votesInLoop,judgedBy,bestScore,descChars,screenSeverity,findings,gapAxes',
      ...ledger.items.map(i => [i.dir, i.batch, i.fmName ?? '', i.bucket,
        i.votes.judged.value, i.votes.writtenBack.value, i.votes.loaded.value, i.votes.inLoop.value,
        i.votes.judged.by ?? '', i.bestCertifiedScore ?? '', i.descriptionChars, i.screenSeverity ?? '',
        i.screenFindingCount, i.gapAxes.join(';')].map(v => (typeof v === 'string' && (v.includes(',') || v.includes('"')) ? `"${v.replace(/"/g, '""')}"` : v)).join(','))].join('\n');
    writeFileSync(`${out.replace(/\.json$/, '')}.csv`, `${csv}\n`);
  }
  const { items, ...summary } = result;
  console.log(JSON.stringify(summary, null, 1));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
