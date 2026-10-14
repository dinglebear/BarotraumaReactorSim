# Barotrauma Reactor Circuit Bench

Design and test Barotrauma auto-reactor and battery circuits outside the game, then paste them into the game with the **[Blueprints](https://github.com/Max112358/Barotrauma-Blueprints)** mod.

The simulator runs the reactor, power grid, batteries, junction box and circuit boxes at the game's 60 ticks/s:
- The math comes from the game source, including every limit the game puts on circuit-controlled reactors. Targets move at most 5 %/s, signals expire after 1 s, and `shutdown` triggers on any value.
- The reactor's automatic control is off, so your circuit runs it.
- Recorded rounds replay with under 1 °C average temperature error.

## Design a circuit (web bench)
Open **[the bench](https://claude.ai/artifact/H7Y1hxZhsLgqyyr8Gjuyw5)** (or `web/index.html`).

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
Read **[`AIHowTo.md`](AIHowTo.md)** first. It is the compact reference: the `.circ` circuit language, device pins, component behaviour, reactor/battery math, nerfs, how to read a log, and the workflow. The command line runs everything the bench does:
```
node sim/cli.js run <circuit> --profile all          # score a circuit on every test file
node sim/cli.js compare a,b,vanilla --profile all    # side by side
node sim/cli.js run <circuit> --batteries ship       # with the recorded sub's own batteries
node sim/cli.js check <circuit>                      # syntax/wiring check
node sim/test.js                                     # simulator + Blueprints-format tests
node sim/build_web.js                                # rebuild the bench after adding circuits or test files
```
Circuits written as `.circ` export to Blueprints `.txt` on a single-profile `run`. [`context/reactor_circuits/STUDY.md`](context/reactor_circuits/STUDY.md) benchmarks the community circuits to beat.

## Folders
| Folder | Contents |
|---|---|
| `circuits/` | circuits made here (`.circ` source + exported Blueprints `.txt`) |
| `context/reactor_circuits/` | community reactor circuits (Blueprints `.txt`, optional `.pins`) and their study |
| `context/blueprints_mod/`, `context/community_circuits/` | Blueprints mod scripts and example circuits (format reference) |
| `load_profiles/` | test files: recorded rounds (`*_roundNNN*.csv`) and synthetic ones (`synthetic_*`, from `sim/make_profiles.js`) |
| `mod/ReactorPowerLogger/` | the client-side logging mod |
| `reference/BAROTRAUMA_MECHANICS.md` | game mechanics, from the game source |
| `sim/` | simulator: engine, components, formats, CLI, pin finder, web build |
| `web/` | bench source (`app.html`) and built page (`index.html`) |
| `logs/`, `traces/` | run results and reactor traces (not committed) |
