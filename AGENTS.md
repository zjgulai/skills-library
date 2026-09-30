<!-- birdview:mode:start -->
Birdview mode: auto
Birdview foundation: on
For every authorized coding task, even when the Birdview skill is not activated: read related implementations, callers and applicable design decisions before editing. Resolve questions from source; ask only about material unresolved choices. Keep changes focused and avoid abstractions without concrete benefit. For bug fixes, establish reproduction or concrete failure evidence; favor tests of observable behavior. Verify the original request and report actual checks and limitations honestly. When coordinating with other agents, inspect existing shared task records, record time, base commit and scope there, and clear only your own temporary claims on completion.
These foundation rules do not require reading the skill, creating a map or activity records, starting an architecture review, or requesting approval for routine authorized work. Follow the host's instruction precedence and explicit user directions. The mode below controls the architecture-map workflow only.
Use the Birdview skill before every code-changing task, including small edits, and for planning that explicitly analyzes affected modules. Enter the workflow once per task; update activity before each edit group, not each line.
When active, first inspect existing project maps and report the reusable path or checked locations and why a new map is needed. Follow the skill to validate/reuse the map, preview it, and declare affected modules before editing.
After displaying the map and concrete change plan, wait for user confirmation before implementation. Preparing map and plan artifacts is allowed beforehand. Reuse confirmation of the same displayed plan; confirm material scope changes. Auto mode is not approval. Honor an explicit task-specific waiver.
Planning alone does not authorize code edits or fabricated activity. A one-task request overrides this mode for that task without changing this block. If the skill is unavailable, report it rather than claim its workflow ran.
This is agent guidance, not a filesystem write interceptor. Preserve all instructions outside this managed block.
<!-- birdview:mode:end -->

## Project integration

- Birdview source is pinned to Qiuner/birdview commit `11436ff3a6b1df70a3e17ea4e95e335a5304f730` in `.agents/skills/birdview`; preserve its MIT license and third-party notices. Do not update global installations.
- Use `.birdview/architecture.json` and `.birdview/activity.jsonl` as the current map and activity inputs. Review the current source before changing these declarations; activities are not automatic observations.
- From the project root, install renderer dependencies with `npm --prefix .agents/skills/birdview ci --ignore-scripts --no-audit --no-fund`, then run `node .agents/skills/birdview/scripts/birdview.mjs doctor`.
- Start the local viewer from the project root with `node scripts/birdview-monitor.mjs`; open `http://127.0.0.1:4179/` in the in-app Browser. Stop its terminal with Ctrl+C. This is a foreground local process, not an installed login service.
- The viewer watches map/activity/reviewed-rule inputs and referenced source files. It rerenders valid inputs, preserves the last good map on errors, and flags source changes against this process's initial reading. Restarting or rerendering is not semantic approval; new uncited files are outside its coverage.
- Run `node --test scripts/birdview-monitor.test.mjs` for the local monitor. Runtime-dependent experimental tests are separate and must not enable live model calls without a new explicit authorization.
- Keep credentials, provider connection files, sessions, blind mappings, held-out answers, raw business materials, backups and private document exports out of public Git. The external `AgentTools/技能库` tree is not part of this repository. Retain local excluded material; do not delete it to obtain a clean Git status.
- Apply the scoped requirements in [the DSH acceptance contract](docs/specs/2026-09-25-dsh-skill-lifecycle/03-DSH运行与验收契约.md) and [the isolation and budget contract](docs/specs/2026-09-25-dsh-skill-lifecycle/08-P0读取预算与终止控制契约.md). Their historical phase statements are not evidence of current execution or authorization.
