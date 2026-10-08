#!/usr/bin/env python3
"""P1 全库归一化批（143 号）· 执行器（零请求）
① 跨技能相对引用去路径（CROSS_SKILL_RELATIVE_PATH，26 件）
② 短描述增补（SHORT_DESCRIPTION，2 件）
只改 staged 副本；产出写回 plan（put 仅涉及被改文件）。rename 另走 rename 执行器。
"""
import hashlib, json, re
from pathlib import Path

LIB = Path('/Users/lute/project/AgentTools/技能库')
BASE = Path('docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize')
T = json.loads((BASE / 'fix-plans' / 'normalize-targets.json').read_text(encoding='utf-8'))
STAGED = BASE / 'staged'
FAIL = []

def sha(b): return hashlib.sha256(b).hexdigest()

ops = []
edits_log = []

# ① 跨技能去路径
for item in T['items']:
    rel = item['relPath']  # 形如 analytics/SKILL.md（相对技能库根）
    cross = [f for f in item['findings'] if f['code'] == 'CROSS_SKILL_RELATIVE_PATH']
    if not cross:
        continue
    skill_dir = (LIB / rel).parent
    paths = []
    for f in cross:
        p = (f.get('detail') or '').split('：')[0].strip()
        if p and p not in paths:
            paths.append(p)
    if not paths:
        FAIL.append(f"{item['name']}: 无路径明细"); continue
    for src in sorted(skill_dir.rglob('*')):
        if not src.is_file():
            continue
        try:
            text = src.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue
        orig = text
        cnt = 0
        for p in paths:
            base = p.rstrip('/').split('/')[-1]
            c = text.count(p)
            if c:
                text = text.replace(f']({p})', ']（跨技能引用）')
                text = text.replace(f'`{p}`', f'`{base}`（跨技能引用）')
                text = text.replace(p, f'`{base}`（跨技能引用）')
                cnt += c
        if text != orig:
            for p in paths:
                if p in text:
                    FAIL.append(f"{item['name']}/{src.name}: 替换后仍残留 {p}")
            relf = src.relative_to(LIB).as_posix()
            dst = STAGED / relf
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(text, encoding='utf-8')
            ops.append({'kind': 'put', 'relPath': relf, 'source': str(dst),
                        'sourceSha256': sha(text.encode('utf-8')), 'expectSha256': sha(orig.encode('utf-8'))})
            edits_log.append({'item': item['name'], 'file': relf, 'replaced': cnt, 'targets': paths})

# ② 短描述增补
SHORT = {
    'skills-mactt/skills/in-progress/implement-spec/SKILL.md': (
        'description: "Implement a specification in code."',
        'description: "Implement a specification in code. Use when turning a spec with dependency-ordered tickets into a single-branch PR."'),
    'skills-mactt/skills/in-progress/pr/SKILL.md': (
        'description: "Use when writing a PR body."',
        'description: "Use when writing a PR body: fill the standard PR template with context, changes, and verification notes."'),
}
for relf, (old, new) in SHORT.items():
    src = LIB / relf
    text = src.read_text(encoding='utf-8')
    if text.count(old) != 1:
        FAIL.append(f'{relf}: 短描述锚点 {text.count(old)} 处'); continue
    text2 = text.replace(old, new)
    dst = STAGED / relf
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(text2, encoding='utf-8')
    ops.append({'kind': 'put', 'relPath': relf, 'source': str(dst),
                'sourceSha256': sha(text2.encode('utf-8')), 'expectSha256': sha(text.encode('utf-8'))})
    edits_log.append({'item': relf, 'file': relf, 'replaced': 1, 'kind': 'short-desc'})

plan = {
    'record_type': 'library_writeback_plan',
    'at': '2026-10-02',
    'target': str(LIB),
    'candidate': str(STAGED),
    'policy': (BASE / 'fix-plans' / 'norm01-policy.txt').read_text(encoding='utf-8').strip() if (BASE / 'fix-plans' / 'norm01-policy.txt').exists() else 'P1 归一化（143）：跨技能去路径＋短描述增补',
    'evidence': ['normalize-targets.json（105 件 findings 靶单，2026-10-02 屏幕 v）'],
    'ops': ops,
}
(BASE / 'fix-plans' / 'norm01-writeback-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

# 编辑日志与失败
(BASE / 'fix-plans' / 'norm01-edits-log.json').write_text(json.dumps({'edits': edits_log, 'failures': FAIL}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print(f'ops: {len(ops)} 个 put | 涉及件: {len({e["item"] for e in edits_log})} | FAIL: {len(FAIL)}')
for f in FAIL[:10]: print('  FAIL:', f)
