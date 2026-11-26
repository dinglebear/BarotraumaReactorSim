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
| **Test any circuit before it goes in a sub** (boxes, loose parts, buttons, terminals, periscopes, engines, docking ports) | `SANDBOX.md` + `sandbox/*.sbx` |
| **Drones and vehicles**: autopilots, return-to-position, following a diver, turrets, in a world with rock, divers and monsters | `SANDBOX.md` (World) + `reference/VEHICLE_MECHANICS.md` + `sandbox/world/*.sbx` + `circuits/challenges/` |
| Anything shown on a text display or terminal | `reference/TEXT_DISPLAYS.md` (a changing value must fit ~7 characters) |
| The next sub: Claude's own, built from scratch | `ships/CLAUDE_SUB_PLAN.md` |
| A complete worked example, built and debugged over 4 in-game rounds | `ships/CAMEL_OVERKILL.md` + `ships/patches/camel_overkill.gen.js` + `circuits/camel/` |
| Exact game code behaviour | `reference/BAROTRAUMA_MECHANICS.md` |

## Tools (all `node sim/cli.js <command>`, Node 18+, no installs)
| Command | What it does |
|---|---|
| `explain <file.sub\|assembly.xml> [regex]` | Any sub or item assembly (community ones too) as a readable netlist: items, non-default settings, wiring, circuit-box insides and notes. **Start every study with this.** |
| `sub list <Sub> [regex]` | Electrical items with ID, position, room and wiring. |
| `sub patch <Sub> <patch>` | Applies a `.subpatch` script and writes `ships/custom/<Name>.sub` (plus the mod folder if there is one). Runs the loader checks and **audit** automatically. |
| `sub catalog <Sub> [regex]` | Every structure (walls, shells, backgrounds, deco) and item you can place, with typical sizes. |
| `sub leaks <Sub>` | Watertight check using the game's own collision shapes: rays from every room must hit a wall. Vanilla subs pass. Run it after any shell work. |
| `sub render <Sub> [--base <Vanilla>] [--crop x0,y0,x1,y1] [--wires all\|added\|none] [--labels all] [--collision] [--no-picture]` | **A picture of the sub** (`renders/<Sub>.png`): the sub's own game picture underneath (the editor saves one in every `.sub`; `sim/preview.js` lines it up), rooms, items coloured by job, wires along their nodes, and what was added in orange (new walls drawn solid: the picture is from the last save in the game's editor). A sub with no picture is drawn from its wall shapes as the sprites cover them. `--collision` adds the hitboxes, dashed pink. **Look at it after every build or patch**: it shows items behind stairs, wires across screens and rooms you forgot. |
| `sub audit <Sub> --base <Original>` | Everything that has broken in game before: loose items, items inside walls/floors, boxes over 64 parts, moved originals, wires > 5. |
| `sub templates <out.xml> <ids> <files...>` | Adds vanilla item templates (from any sub) so the editor can place those items. |
| `ship <Sub> --transcript [--breach S --breach-hull ID] [--fire S --fire-hull ID] [--type "t:cmd"] [--radio "t:camel cmd"] [--duration S]` | Practice round in the whole-sub mock: power metrics, plus the radio chat, terminal and display text. |
| `sandbox <file.sbx>` | Runs a circuit sandbox script: any boxes, loose parts and pretend devices, scripted inputs, `expect` checks, and warnings for the mistakes that cost an in-game round. The same runs live in `web/sandbox.html`. |
| `check <circuit>` / `run <circuit> --profile all` / `compare a,b,vanilla` | Circuit syntax check (warns on boxes over 64 parts) / score a reactor circuit on test files / side by side. |
| `node sim/test.js` | All tests, including a full Camel Overkill regression (commands, radio, lockdown, flood announcement, oxygen, audit). |
| `node sim/build_web.js` | Rebuilds the web workshop in `web/`: Home, **Sub Studio** (any sub drawn like `sub render`: the game picture under rooms, items and wires; wires filtered by power, signal or added; click anything for its wiring and settings; a practice round with floods, fires and fights; circuit boxes open in the lab), **Circuit Lab** (the sandbox), **Drone Range** (the sandbox with the vehicle examples) and the **Reactor Bench**. Shared code and data live in `web/lib/`. |

## How a whole-sub redesign goes (what worked for the Camel)
1. **Study:** `explain` the target sub and any examples the human sends. Read CIRCUIT_PATTERNS §1 (rules) and §4 (lessons).
2. **Prototype each new box in the sandbox** (`sandbox/<name>.sbx` with `expect` lines) until it passes with no warnings you can't explain.
3. **Design boxes per job:** reactor, power, air, alerts, OS, doors, and so on.
   - Each box gets 64 parts or fewer, with HOW IT WORKS and WIRING notes.
   - Boxes talk over wifi buses: a command bus and a reply bus, one telemetry channel per value, and sensor nodes that send room names.
   - Write each box as a `.circ` file. Wires may name components defined later. `$NAME` placeholders are filled per box (`box ... ROOM=Medbay`).
   - In `.circ`, a backslash escapes the next character: write `[0-9]` instead of `\d` in regexes.
4. **Write a generator script** (`ships/patches/<name>.gen.js`) that emits the `.subpatch`. Loops over rooms/doors and positions computed from the hulls beat hand-written patches.
5. **Patch, audit, look, test:** `sub patch` (it audits), then **`sub render <Sub> --base <Vanilla>` and look at the picture** (zoom in with `--crop` on every room you touched: screens clear of stairs and wire bundles, nothing floating, wires along the ceilings), then `ship --transcript` with breaches, fires, typed and radio commands. The transcript warns about text displays nobody could read. Fix until the power metrics are clean and every feature answers.
6. **Tell the human:** what to test in game, what the mock can't check, and that AutoTemp must be OFF. Ask for the logger folder and the console output.
7. **Turn every in-game bug into a tool check or test,** so it can't come back. That's how audit, the 64-part limit, attachment, the wall nudging and the hold timers came about.

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
10. **A long text that changes every second can't be read on a text display** (Dingle's reactor screen): the scroll snaps back on every change. Values of ~7 characters, captions on their own display (reference/TEXT_DISPLAYS.md).

## Found against the game's source while building the Drone Range (no in-game round needed)
- **Engines and pumps keep the last value they got.** A selector that just stops sending leaves the old engine running: send an explicit 0.
- **A pump's set_targetlevel takes -100..100** (level = (v + 100) / 2 %), which is what the nav terminal's velocity_y_out sends.
- **velocity_in applies at once** and stays until the next signal; only a pilot's own steering ramps (15.6 units/s).
- **Keep a feedback loop one arithmetic part long** (memory -> adder -> memory). Two arithmetic parts in a loop run as two counters taking turns, frame by frame.
- **Edge detectors depend on the order parts update in,** which you can't control in game. Prefer designs that are right every frame (a display that says TIME! while the alarm is on, not a one-time message).
