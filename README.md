# Barotrauma Workshop

Design, wire and test Barotrauma submarines and circuits outside the game, then take them in game: subs as `.sub` files, circuits through the **[Blueprints](https://github.com/Max112358/Barotrauma-Blueprints)** mod.

Open **[the workshop](https://claude.ai/artifact/H7Y1hxZhsLgqyyr8Gjuyw5)** (or `web/index.html`). It has five pages:
| Page | What it's for |
|---|---|
| **Sub Studio** (`web/subs.html`) | Every sub drawn from the game's own geometry: walls, slopes and stairs as their collision shapes, rooms, items coloured by job, wires along their saved nodes. Filter wires (power, signal, added against the vanilla sub), click anything to see what it's wired to, find by name, ID, wifi channel or room, measure, and run a practice round with floods, fires and fights. Open your own `.sub` too. |
| **Circuit Lab** (`web/sandbox.html`) | Wire circuit boxes, loose parts and devices, script what happens, and get warned about the mistakes that cost a round (unreadable displays, two senders fighting, divide by zero, boxes over 64 parts...). |
| **Drone Range** (`web/world.html`) | The lab with a world: rock, a drone or small sub with the game's buoyancy, drag, engine force and pumps, motion detectors, coilguns, divers and monsters. Examples: flying basics, a smart return-to-position circuit, a drone that escorts a diver and only shoots monsters. |
| **Reactor Bench** (`web/bench.html`) | A reactor circuit against a recorded round's power demand, scored for steady voltage and fuel per rod. |

The simulator runs the reactor, power grid, batteries, junction box and circuit boxes at the game's 60 ticks/s:
- The math comes from the game source, including every limit the game puts on circuit-controlled reactors. Targets move at most 5 %/s, signals expire after 1 s, and `shutdown` triggers on any value.
- The reactor's automatic control is off, so your circuit runs it.
- Recorded rounds replay with under 1 °C average temperature error.

## Design a reactor circuit (Reactor Bench)
Open the **Reactor Bench** page (`web/bench.html`).

1. Pick a **test file**: a recorded round or a synthetic one.
   - Test files only supply the sub's power demand.
   - Rods, rod type and reactor max output are your settings.
   - Batteries are optional: either the sub's own (from the recording) or set by hand.
2. Pick a **reactor circuit** and, if batteries are on, a **battery circuit**. They are two separate circuit boxes, linked by wire or wifi.
3. **Circuit box** tab: see each box like the in-game editor, with live signal values while the test runs.
   - Tick **Edit** to build or change it: add components, drag them, click an output pin then an input pin to wire, set properties, and choose what each box pin connects to.
   - Box pins can read the reactor, junction box, batteries, a lever (`const.1`), the nav terminal (`nav.velocity_x_out` for engine spikes), or the other box.
   - **Apply & test** loads it as "my_circuit".
4. **Start** (x1/x5/x10/x25/Max). The **Log** tab scores it: reliability, demand left unmet, voltage swings, fuel per rod, battery charge kept.
5. **In-game files** tab: save `name.txt` (or `name_reactor.txt` + `name_battery.txt`).

## Paste it into Barotrauma
1. Install **Lua For Barotrauma** (client-side Lua) and the **Blueprints** mod.
2. Put the `.txt` in `Barotrauma/LocalMods/Blueprints_saved_blueprints/`.
3. In game, open a circuit box and load the blueprint by name.
4. Wire the box pins as the pin labels say. They are labelled with what they connect to, e.g. `reactor.load_value_out`. A note label lists any values tied to the reactor size (`$MAX` etc.) to edit on another ship.

Exports follow the mod's loader exactly, and `node sim/test.js` checks every export against it:
- components numbered 0..n-1 in file order;
- `item`/`Class` written the way the mod's own saves write them;
- the same layout as the in-game editor, so positions are node centres with y pointing up.

In-game blueprints load into the bench too: **Load .circ / .txt…**. If a file doesn't say which pin goes where, the bench finds the wiring by trial and error.

## Record real rounds
[`mod/ReactorPowerLogger`](mod/ReactorPowerLogger) is a client-side LuaCs mod. Each round it writes a CSV of the sub's power demand and everything that predicts it: nav terminal, engines, pumps, guns and supercapacitors, sonar, batteries, other loads, enemies near, flooding and events. Copy the CSVs into `load_profiles/` (or use **Load CSV…** on the bench) to test circuits against your real rounds.

## For AI designers
**Start with [`AI_START_HERE.md`](AI_START_HERE.md):** which doc for which job, every tool, and the whole-sub workflow.

Read **[`AIHowTo.md`](AIHowTo.md)** first. It is the compact reference: the `.circ` circuit language, device pins, component behaviour, reactor/battery math, nerfs, how to read a log, and the workflow. The command line runs everything the bench does:
```
node sim/cli.js run <circuit> --profile all          # score a circuit on every test file
node sim/cli.js compare a,b,vanilla --profile all    # side by side
node sim/cli.js run <circuit> --batteries ship       # with the recorded sub's own batteries
node sim/cli.js check <circuit>                      # syntax/wiring check
node sim/test.js                                     # simulator + Blueprints-format tests
node sim/cli.js sandbox world/smart_return          # a Circuit Lab / Drone Range script with its checks
node sim/cli.js sub render Camel_Overkill --base Camel   # a picture of a sub, additions in orange
node sim/build_web.js                                # rebuild the web pages after adding circuits, subs or test files
```
Circuits written as `.circ` export to Blueprints `.txt` on a single-profile `run`. To rewire a whole sub (doors, lights, relays, embedded circuit boxes), see [`SUBEDIT.md`](SUBEDIT.md) (`node sim/cli.js sub list|patch|check`) and the pattern library [`CIRCUIT_PATTERNS.md`](CIRCUIT_PATTERNS.md). `node sim/cli.js explain <file.sub|assembly.xml>` turns any sub or community item assembly into a readable netlist. [`context/reactor_circuits/STUDY.md`](context/reactor_circuits/STUDY.md) benchmarks the community circuits to beat.

## Challenge circuits (each with a test)
| Circuit | Test | What it does |
|---|---|---|
| `circuits/challenges/smart_return.circ` | `sandbox/world/smart_return.sbx` | Press SAVE, drive off, flip RETURN: the sub flies straight back instead of retracing its path, at a speed it can stop from, goes over or under rock its wall sensors find, and holds position at the spot. |
| `circuits/challenges/drone_escort.circ` | `sandbox/world/drone_escort.sbx` | A drone follows a diver using motion detectors, keeps out of the rock, and switches its coilgun's auto-operate on when monsters come near (it never targets the crew or shoots through them). |
| `circuits/challenges/alarm_timer.circ` | `sandbox/alarm_timer.sbx` | A countdown set from a terminal (`set 5:00`, `start`, `pause`, `reset`) or two buttons, zero-padded mm:ss, TIME! and an alarm at zero. |
| `circuits/reactor_modes.circ` | `node sim/test.js` | A lever switches REACTIVE (steadiest voltage) and ECO (11-19 % fewer fuel rods). |
| `circuits/dingle/countdown_padded.circ` | `sandbox/dingle_countdown.sbx` | Dingle's countdown, now `01:09` instead of `1:9`. |

## Camel Overkill
A comedically over-engineered Camel, designed and rewired entirely by Claude with these tools (its auto reactor included). It was tested in game by Dinglebear. It has:
- a battery-only propulsion bus and surplus-only charging;
- an oxygen generator that only runs when needed;
- a sensor network with alert lighting, siren, mood display and radio announcements;
- smart doors with flood interlock and lockdown;
- CamelOS, a terminal OS that also takes commands from radio chat (`camel status`);
- a second chaingun.

See [`ships/CAMEL_OVERKILL.md`](ships/CAMEL_OVERKILL.md) for what each part does and how to test it in game. The sub is `ships/custom/Camel_Overkill.sub` (a ready mod folder is `ships/custom/Camel Overkill/`).

## Folders
| Folder | Contents |
|---|---|
| `circuits/` | circuits made here (`.circ` source + exported Blueprints `.txt`); `challenges/` has the vehicle and timer challenges, `camel/` the Camel Overkill boxes |
| `sandbox/` | Circuit Lab scripts (`*.sbx`), every one a test; `sandbox/world/` the Drone Range ones |
| `context/reactor_circuits/` | community reactor circuits (Blueprints `.txt`, optional `.pins`) and their study |
| `context/blueprints_mod/`, `context/community_circuits/` | Blueprints mod scripts and example circuits (format reference) |
| `load_profiles/` | test files: recorded rounds (`*_roundNNN*.csv`) and synthetic ones (`synthetic_*`, from `sim/make_profiles.js`) |
| `ships/` | vanilla subs used by the mock (`vanilla/`), sub patches (`patches/`), patched subs (`custom/`) and vanilla item templates for the sub editor (`templates/`) |
| `context/circuit_studies/` | study notes on community smart-sub circuits (HuskOS, Smart Sub Toolkit, LHMRS/DMFSS, the Iroh, MK-II doors) |
| `mod/ReactorPowerLogger/` | the client-side logging mod |
| `reference/` | game mechanics from the game source: reactor and devices (`BAROTRAUMA_MECHANICS.md`), vehicles, sensors and turrets (`VEHICLE_MECHANICS.md`), text displays (`TEXT_DISPLAYS.md`) |
| `sim/` | simulator: engine, components, formats, CLI, pin finder, web build |
| `web/` | page sources (`*_app.html`, `shared.css`) and the built workshop (`index.html`, `subs.html`, `sandbox.html`, `world.html`, `bench.html`, `lib/`, `thumbs/`); rebuild with `node sim/build_web.js` |
| `renders/` | pictures from `sub render` (not committed) |
| `logs/`, `traces/` | run results and reactor traces (not committed) |
