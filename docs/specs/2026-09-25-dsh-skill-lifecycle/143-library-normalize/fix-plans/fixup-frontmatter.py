#!/usr/bin/env python3
"""候选 frontmatter 补字段（零请求）：把缺失的顶层字段插入到 `name:` 行之后。

用法：python3 -B fixup-frontmatter.py <table.json>
table.json = {"items": [{"name": "...", "add": {"version": "1.0.0", "complexity": "medium",
              "compatibility": "..."}   // 值：str→单行；list/dict→块形式
            }, ...], "base": "nearmiss-pilot2"|"lowband-lb1"}
已有字段一律不动；找不到 name 行或 frontmatter 即拒。
"""
import json
import re
import sys
from pathlib import Path

CAND = Path('skill-lifecycle/trial-home/opt-run/candidates')


def yaml_lines(key, value):
    if isinstance(value, str):
        v = value if re.match(r'^[\w.\- /]+$', value) else json.dumps(value, ensure_ascii=False)
        return [f'{key}: {v}']
    if isinstance(value, list):
        return [f'{key}:'] + [f'  - {json.dumps(x, ensure_ascii=False)}' for x in value]
    if isinstance(value, dict):
        out = [f'{key}:']
        for k, v in value.items():
            if isinstance(v, (dict, list)):
                out.append(f'  {k}: {json.dumps(v, ensure_ascii=False)}')
            else:
                out.append(f'  {k}: {json.dumps(v, ensure_ascii=False)}')
        return out
    raise SystemExit(f'unsupported value type for {key}')


def add_fields(path, adds):
    t = path.read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n', t, re.S)
    if not m:
        return 'NO_FRONTMATTER'
    block = m.group(1)
    lines = block.split('\n')
    present = {ln.split(':', 1)[0].strip() for ln in lines if re.match(r'^[A-Za-z][\w-]*\s*:', ln)}
    to_add = [k for k in adds if k not in present]
    if not to_add:
        return 'NOOP'
    # 插到 name 行之后
    idx = next((i for i, ln in enumerate(lines) if ln.startswith('name:')), None)
    if idx is None:
        return 'NO_NAME'
    ins = []
    for k in to_add:
        ins.extend(yaml_lines(k, adds[k]))
    new_block = '\n'.join(lines[:idx + 1] + ins + lines[idx + 1:])
    new_t = t[:m.start(1)] + new_block + t[m.end(1):]
    path.write_text(new_t, encoding='utf-8')
    return 'ADDED:' + ','.join(to_add)


def main():
    table = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    base = table.get('base', 'nearmiss-pilot2')
    suffix = table.get('suffix', 'gen1')
    for it in table['items']:
        p = CAND / f"{it['name']}-{suffix}" / 'SKILL.md'
        if not p.exists():
            print(f"{it['name']}: MISSING {p}")
            continue
        r = add_fields(p, it['add'])
        print(f"{it['name']}: {r}")


if __name__ == '__main__':
    main()
