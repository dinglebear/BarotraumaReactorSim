# AI: start here

This repo lets an AI design and test Barotrauma electrical systems without the game:
- reactor auto-controllers;
- battery management;
- whole-sub rewiring (doors, alarms, terminals, wifi networks).

Everything needed to do it again is in this repo. A human then tests in game, and their logs come back for the next round. Read this page, then the doc for your task.

## Which doc for which job
| Job | Read |
|---|---|
| Design or tune a reactor/battery circuit (one or two circuit boxes) | `AIHowTo.md` (circuit language, device pins, reactor math, logs) |
| Rewire a real sub: add/remove/wire items, build circuit boxes into it | `SUBEDIT.md` (workflow, patch commands, loader rules) |
| **Build a whole submarine from scratch** (rooms, shell, walls, doors, hatches, ladders, waypoints, then machinery) | `SUBBUILD.md` + `sim/subbuild.js` + `ships/scratch/capsule.gen.js` |
| Design sub-wide systems (terminal OS, wifi buses, chat, sensors, door logic, power buses) | `CIRCUIT_PATTERNS.md` (game signal rules, ~50 patterns, lessons from in-game bugs) |
| A complete worked example, built and debugged over 4 in-game rounds | `ships/CAMEL_OVERKILL.md` + `ships/patches/camel_overkill.gen.js` + `circuits/camel/` |
| How community circuits work (HuskOS, Smart Sub Toolkit, LHMRS/DMFSS, Iroh, MK-II door) | `context/circuit_studies/` |
| Exact game code behaviour | `reference/BAROTRAUMA_MECHANICS.md` |

## Tools (all `node sim/cli.js <command>`, Node 18+, no installs)
| Command | What it does |
|---|---|
| `explain <file.sub\|assembly.xml> [regex]` | Any sub or item assembly (community ones too) as a readable netlist: items, non-default settings, wiring, circuit-box insides and notes. **Start every study with this.** |
| `sub list <Sub> [regex]` | Electrical items with ID, position, room and wiring. |
| `sub patch <Sub> <patch>` | Applies a `.subpatch` script and writes `ships/custom/<Name>.sub` (plus the mod folder if there is one). Runs the loader checks and **audit** automatically. |
| `sub catalog <Sub> [regex]` | Every structure (walls, shells, backgrounds, deco) and item you can place, with typical sizes. |
| `sub audit <Sub> --base <Original>` | Everything that has broken in game before: loose items, items inside walls/floors, boxes over 64 parts, moved originals, wires > 5. |
| `sub templates <out.xml> <ids> <files...>` | Adds vanilla item templates (from any sub) so the editor can place those items. |
| `ship <Sub> --transcript [--breach S --breach-hull ID] [--fire S --fire-hull ID] [--type "t:cmd"] [--radio "t:camel cmd"] [--duration S]` | Practice round in the whole-sub mock: power metrics, plus the radio chat, terminal and display text. |
| `check <circuit>` / `run <circuit> --profile all` / `compare a,b,vanilla` | Circuit syntax check (warns on boxes over 64 parts) / score a reactor circuit on test files / side by side. |
| `node sim/test.js` | All tests, including a full Camel Overkill regression (commands, radio, lockdown, flood announcement, oxygen, audit). |
| `node sim/build_web.js` | Rebuilds the web bench (`web/index.html`). The Sub tab runs any sub: press buttons, flood or burn rooms, type into terminals. Its layers show walls, background, props (hitboxes), gaps and AI waypoints: use them to study real subs before building one. |

## How a whole-sub redesign goes (what worked for the Camel)
1. **Study:** `explain` the target sub and any examples the human sends. Read CIRCUIT_PATTERNS §1 (rules) and §4 (lessons).
2. **Design boxes per job:** reactor, power, air, alerts, OS, doors, and so on.
   - Each box gets 64 parts or fewer, with HOW IT WORKS and WIRING notes.
   - Boxes talk over wifi buses: a command bus and a reply bus, one telemetry channel per value, and sensor nodes that send room names.
   - Write each box as a `.circ` file. Wires may name components defined later. `$NAME` placeholders are filled per box (`box ... ROOM=Medbay`).
   - In `.circ`, a backslash escapes the next character: write `[0-9]` instead of `\d` in regexes.
3. **Write a generator script** (`ships/patches/<name>.gen.js`) that emits the `.subpatch`. Loops over rooms/doors and positions computed from the hulls beat hand-written patches.
4. **Patch, audit, test:** `sub patch` (it audits), then `ship --transcript` with breaches, fires, typed and radio commands. Fix until the power metrics are clean and every feature answers.
5. **Tell the human:** what to test in game, what the mock can't check, and that AutoTemp must be OFF. Ask for the logger folder and the console output.
6. **Turn every in-game bug into a tool check or test,** so it can't come back. That's how audit, the 64-part limit, attachment, the wall nudging and the hold timers came about.

## In-game bug history (see CIRCUIT_PATTERNS §4)
1. **Circuit boxes hold 64 components;** the rest are lost on load.
2. **Placed items must be `Attached=True`,** or they fall to the floor.
3. **Room rectangles include floor and ceiling slabs.** Keep fittings out of solid structure (the editor does this now).
4. **Sloshing water flickers detectors.** Hold water and fire signals 5–10 s.
5. **Per-tick wifi on a shared channel drowns it.** Send on change only; give chat wifis long intervals.
6. **Subtracting two readings a tick apart oscillates.** Low-pass the difference; keep loop gains low.
7. **The reactor's AutoTemp isn't saved in the sub.** The crew must switch it off.
8. **The stock relay's MaxPower (1000) exactly equals the outpost oxygen generator's draw.** Give it headroom.
9. **Watch more than a couple of rooms for oxygen.** One detector per room (air nodes).
