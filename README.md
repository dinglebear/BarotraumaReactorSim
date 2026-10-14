# BarotraumaMockReactorSim

A playground for testing Barotrauma auto-reactor circuits outside the game. It simulates the reactor, the power grid, batteries, junction boxes and circuit boxes at the game's 60 ticks/s. The math is taken from the game source, including every limit the game puts on signal-controlled reactors. The reactor's automatic control is off, so the circuit box runs it.

- **AIs:** read [`AIHowTo.md`](AIHowTo.md). It covers how to write, run and read the logs for circuits.
- **Master page:** `web/index.html` (open in a browser, or use the published artifact).
  - Settings: batteries on/off, reactor max output, test file and circuit.
  - Live charts at x1/x5/x10/x25/Max speed.
  - Save the in-game `.txt` files and the logs.
- **Power logger mod:** [`mod/ReactorPowerLogger`](mod/ReactorPowerLogger). It records each round's power demand. Put the CSV into `load_profiles/` to replay that round.
- **Game mechanics reference:** [`reference/BAROTRAUMA_MECHANICS.md`](reference/BAROTRAUMA_MECHANICS.md).

```
node sim/cli.js compare example_feedforward,vanilla --profile all
node sim/test.js          # sanity tests
node sim/build_web.js     # rebuild web/index.html after adding circuits or test files
```

Circuit files use the format of the **Blueprints** workshop mod: one `.txt` per circuit box, so 2 files when the battery box is used. The Blueprints mod scripts are in `context/blueprints_mod/` for reference. The example circuits that were in the repo root are in `context/community_circuits/`.

| Folder | Contents |
|---|---|
| `circuits/` | AI-made circuits (`.circ` source + exported `.txt`) |
| `load_profiles/` | test files (power demand per round) |
| `logs/` | run results (not committed) |
| `context/reactor_circuits/` | community reactor circuits to compare against |
| `context/community_circuits/` | other example circuits (format reference) |
| `sim/` | simulator (engine, components, file formats, CLI, web build) |
| `web/` | master page source (`app.html`) and built page (`index.html`) |
