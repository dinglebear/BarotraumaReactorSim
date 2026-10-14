# AIHowTo: Barotrauma reactor circuit simulator

Goal: design circuit-box circuits that run a Barotrauma reactor (and optionally batteries) better than community circuits. The reactor's automatic control is OFF; your circuit is the only controller. Everything runs on Node 18+ with no dependencies.

## 1. The 4 commands you need
```
node sim/cli.js run <circuit> --profile all         # simulate on every test file -> table; logs in logs/
node sim/cli.js run <circuit> --profile <name>      # one test, prints the full log, exports in-game .txt file(s)
node sim/cli.js compare a,b,vanilla --profile all   # side-by-side table (vanilla = game's own auto control)
node sim/cli.js check <circuit>                     # fast syntax/wiring check, no run
```
Other: `autopins <file.txt>` (find which pin goes where by trial and error, writes `.pins`), `decompile <file.txt>` (in-game file -> .circ text), `build <circuit>` (export only), `profiles` (list test files), `verify <trace.csv>` (replay a reactor trace recorded in game and show where the simulator differs; traces go in `traces/`).
Flags: `--batteries N` (0 = off) or `--batteries ship` (the recorded sub's own batteries, from the test file's `ship_batteries` header), `--btype battery|supercapacitor`, `--max KW`, `--rods N`, `--fuel uranium|thorium|fulgurium|volatile`, `--link wire|wifi`, `--start warm|cold`, `--duration S`, `--timeline` (also write a 1 Hz CSV), `--battery file.txt`.
Defaults come from `sim.config.json` (the web page's "Save settings" writes this file). The test file supplies the reactor max output and the rod count unless overridden.

`<circuit>` is a name in `circuits/` (no extension), or a path. Results are deterministic: same inputs give the same log.

## 2. Files
| Path | What |
|---|---|
| `circuits/<name>.circ` | YOUR circuits (edit these). A run exports `<name>.txt` (1 box) or `<name>_reactor.txt` + `<name>_battery.txt` (2 boxes) in the in-game Blueprints format. |
| `load_profiles/*.csv` | Test files: the ship's power demand over a round. Real ones come from the mod in `mod/`. `synthetic_*` are made by `sim/make_profiles.js` from a ship model calibrated on the real rounds, and they rank circuits like the real rounds do (avoidable unmet: rank correlation 0.98). Use them for fast iteration and confirm on the real ones. |
| `logs/<circuit>__<profile>.log` | Result of each run (read this). |
| `context/reactor_circuits/` | Community reactor circuits (`.txt`, optional `name.pins`) to beat. `compare` can run them by name. |
| `context/community_circuits/` | Non-reactor example circuits (format reference only). |
| `reference/BAROTRAUMA_MECHANICS.md` | Exact game math. Read it only if you need a detail this file doesn't give. |
| `sim/` | Simulator (engine.js, components.js, format.js). You should not need to edit it. |

## 3. Circuit syntax (.circ)
One statement per line. `#` starts a comment.
```
name my_reactor            # output file name
box reactor                # start the reactor box (always present)
c <id> <type> [Prop=Value ...]   # add a component. Values with spaces: Prop="a b"
w <from> <to> [<to> ...]   # wire(s). Pins: inN/outN = box pins; <id>.<pin> = component pin
note "Header" "Body"       # optional in-game label
box battery                # optional 2nd box (needs batteries enabled)
link reactor.out5 battery.in1          # wire between the boxes (or use wifi components inside both)
pin in1 reactor.load_value_out         # optional: override the default pin wiring for this box
```
Component pin shorthand: `1`/`2` = `signal_in1/2`, `in` = `signal_in`, `out` = `signal_out`, plus named pins (`set_output`, `lock_state`, `set_targetsignal`, `set_frequency`, `move_input`, `signal_in3`, `signal_out0`...).
Placeholders in any value, filled from the test settings: `$MAX` (reactor max output kW), `$BATT_KW` (total max recharge kW of all batteries), `$BATT_OUT` (total max output kW), `$BATT_CAP` (total capacity kW·min), `$BATT_N` (battery count). Simple formulas are calculated: `Value=$BATT_KW/50`, `ClampMin=-$BATT_KW/2`. The export bakes in the numbers and adds an in-game note saying which components to edit for another ship.

## 4. Box pins (default wiring)
| reactor box | | battery box | |
|---|---|---|---|
| in1 | reactor.load_value_out (kW, int) | in1 | battery.charge_% (0-100, int) |
| in2 | reactor.power_value_out (kW out, int) | in2 | battery.charge_rate (0-100) |
| in3 | reactor.temperature_out (temp x100, 0-10000) | in3 | junction.load_value_out (grid load kW) |
| in4 | reactor.fuel_out (AvailableFuel: 80 per uranium rod) | in4 | junction.power_value_out (grid supply kW) |
| in5 | reactor.fuel_percentage_left (sum of rod %; 2 full rods = 200) | in5 | reactor.load_value_out |
| in6 | junction.load_value_out | in6 | reactor.power_value_out |
| in7 | junction.power_value_out | out1 | battery.set_rate (0-100 %) |
| out1 | reactor.set_fissionrate (0-100) | | |
| out2 | reactor.set_turbineoutput (0-100) | | |

Any box pin can be rewired with `pin` lines. Any device pin can go to either box, and you can wire whatever you want. Devices:
| device.pin | what (in game) |
|---|---|
| `reactor.load_value_out/power_value_out/temperature_out/fuel_out/fuel_percentage_left/meltdown_warning` | reactor outputs |
| `reactor.set_fissionrate/set_turbineoutput/shutdown` | reactor inputs |
| `junction.load_value_out` / `junction.power_value_out` | **main junction box** (whole reactor grid: total load incl. battery charging / total supply incl. battery output) |
| `battery.charge_%/charge/charge_rate/power_value_out/load_value_out` | battery outputs (`battery1.x` = one battery; `battery.x` = all of them, the last one wins on a shared pin) |
| `battery.set_rate/disable_output` | battery inputs |
| `nav.velocity_x_out` / `nav.velocity_y_out` | **nav terminal** outputs (-100..100) that drive the engines / ballast pumps. Engine kW = (\|velocity_x_out\|/100)^1.5 × engine max, starting 1 tick later. Pump kW = \|flow\|/100 × pump max. **They predict engine and pump load.** |
| `nav.current_velocity_x/y`, `nav.current_position_y` | nav terminal: speed (km/h) and depth |
| `const.<value>` | a lever, switch or any fixed signal, sent every tick (e.g. `pin in9 const.1`). Wire levers this way: a signal-check fed by an unwired lever never fires. |
| `engines.load_value_out`, `pumps.load_value_out`, `guns.load_value_out`, `sonar.load_value_out` | power drawn by that group. In game: a relay or junction box that feeds only that group, wired from its `load_value_out` |

Recorded devices (`nav`, `engines`, `pumps`, `guns`, `sonar`, and any other `device.pin` column in the test file) replay what the PowerLogger mod recorded each tick, formatted like the game sends it. They are open-loop: your circuit can read them but not change them. If a test file lacks a column, the log shows a WARNING and that pin stays silent. The `synthetic_*` files have them all.

## 5. Components (type | pins | props with defaults | timing)
Timing: **U** = outputs every tick in its Update (needs fresh inputs; adds 0-1 tick of latency). **R** = outputs instantly when it receives a signal.
| type | pins | props | timing / behaviour |
|---|---|---|---|
| add sub mul div | 1,2 → out | ClampMin=-999999 ClampMax=999999 TimeFrame=0 | U. Needs BOTH inputs received since its last tick (TimeFrame 0). Divide by ~0 gives no output. float32. |
| and or xor | 1,2,set_output → out | Output=1 FalseOutput=0 TimeFrame=0 | U. Input value "0" does not count as received. An empty Output/FalseOutput sends nothing. |
| greater equals | 1,2,set_output → out | Output=1 FalseOutput=0 TimeFrame=0 | U. Sends while EITHER input is fresh. greater compares numbers, equals compares strings. |
| not | in → out | ContinuousOutput=false | R. "0"/"" → "1", else "0". |
| check (signalcheck) | in,set_output,set_targetsignal → out | Output=1 FalseOutput=0 TargetSignal= | R. Exact string match. |
| mem (memory) | in,lock_state → out | Value= | U. Sends Value every tick. lock_state "1" allows writing, anything else locks. |
| delay | in,set_delay → out | Delay=1 ResetWhenSignalReceived=false ResetWhenDifferentSignalReceived=false | U. Tick queue; Delay is truncated to whole ticks (1/60 s); the queue holds 2×ticks. |
| osc | set_frequency,set_outputtype → out | OutputType=Pulse Frequency=1 | U. Pulse/Sawtooth/Sine/Square/Triangle. |
| mod pow | in,set_modulus / set_exponent → out | Modulus=1 / Exponent=1 | R. |
| round ceil floor abs sqrt factorial | in → out | - | R (round = banker's). |
| sin cos tan asin acos atan | in (+atan: signal_in_x, signal_in_y) → out | UseRadians=false | R (atan x/y: U). |
| relay | signal_in1/2,toggle,set_state → signal_out1/2,state_out | IsOn=true | R pass-through when on. |
| mux / demux | signal_in0-9,set_input,move_input → out / in,set_output,move_output → signal_out0-9 | SelectedConnection=0 WrapAround=true SkipEmptyConnections=true | R. |
| concat | 1,2 → out | Separator= TimeFrame=0 | U. |
| color | signal_r/g/b/a → out | UseHSV=false | U. |
| regex | in,set_output → out | Expression= Output=1 FalseOutput=0 UseCaptureGroup=false ContinuousOutput=true | U. |
| wifi | in,set_channel → out | Channel=1 | R. Instant to every other wifi on the same channel (it can go inside a circuit box). |

Number output format: shortest float32 text (`0.1`, `0.33333334`, `1E-05`). Unparsable numeric input counts as 0. Signals propagate instantly (depth-first). A chain of more than 10 hops is delayed 1 tick.

## 6. Reactor physics (dt = 1/60 s, all % are 0-100)
Checked against real rounds in `load_profiles/`:
- **Dugong** (3000 kW, AutoTemp, 1 → 4 rods): temp RMS 0.04.
- **Humpback** (3100 kW, manual/circuit, rod swaps): temp RMS 0.9.
- **Typhon2** (5200 kW, 64 min, demand up to 8.9 MW in an endworm fight, uranium then fulgurium, `fixitems` refills): temp RMS 0.5.

How to check: `node sim/cli.js verify <round>` drives fission and turbine from the recording and compares the temperature and output. The remaining spikes are game-side events the log doesn't capture: multiplayer server corrections and the player's temperature-boost button. `node sim/test.js` re-checks all three.
- `heat = fission * fuel/100 * 2`. Temperature moves toward `heat - turbine` at ≤ 10 %/s. One uranium rod (fuel 80) gives heat = 1.6 × fission.
- Fission and turbine follow their targets with a ~1 s lag (`x += (target - x)*dt`). Fission is capped at AvailableFuel (80 per uranium rod).
- **Output kW = MaxOutput × clamp(turbine ± tol, ≤ temp/50) / 100**. Below temp 50, output is capped at `temp/50` of max. tol = 1 % of max, or 3 % when turbine is within CTO±2.5 AND temp is 40-60. The reactor does NOT follow load by itself: the turbine must equal `load/max*100`.
- CTO (ideal turbine) = load/max×100, smoothed. It is not sent out; compute it from in1.
- Fuel burn per rod: `fission/100 * 0.2` condition/s, for EVERY rod present. Fewer rods = less burn; more fuel = more heat per % fission. **Fuel efficiency = keep fission as low as the needed heat allows.**
- Danger: temp > 60 for 20 s starts a fire (repeats). Temp > 70 runs the meltdown timer (120 s → meltdown). Temp < 40 is outside the optimal range (no ±3 % bonus).
- **Wear** (as in game): the reactor loses 0.125 condition/s while running, after a random 120-720 s delay, down to 10 %. The fire and meltdown timers run `lerp(2x, 1x, condition)` faster, so a worn reactor catches fire after ~10.5 s above 60 and melts down after ~63 s above 70. `reactor_condition_min_pct` is in the log. The junction box wears too (0.1/s).
- **Test files are about demand.** A test file is the sub's real (or modelled) power demand. Rods and rod type come from the settings (`--rods`, `--fuel`; default 2 uranium), whatever the player had in that round. Rods do not run down during a test, but the fuel burned is still counted (`kwh_per_rod`). To replay a recorded round's own rods and refuelling (for checking the simulator), use `--recorded-rods --fuel-drain`; `verify` does this itself.
- **Real rounds are the real test.** `Dugong_round001`, `Dugong_round002_rimuru`, `Humpback_round001` and `Typhon2_round001` are recorded rounds. Typhon2's demand goes far above the reactor's 5200 kW, so only stored battery energy can cover that. The `synthetic_*` rounds come from a ship model calibrated on them.
- Warm start = sub saved mid-round in a steady state (temp 50, turbine = load). With AutoTemp on, the game's round-start fast sync also runs for the first 5 s.
- Grid: voltage = supply/load. < 0.5 devices shut off, < 0.9 brownout, > 2 junction boxes take random damage.
- Batteries (exactly as in game, all on the reactor's grid):
  - **Shortfall is automatic.** When reactor supply < load, batteries discharge to cover the gap with no signal needed. They share it in proportion to max output, give less below 10 % charge, and stop when empty. `disable_output` (any value except "0") turns this off.
  - **Surplus is NOT automatic.** A battery only charges at `set_rate` % × max recharge, and that draw is added to the grid LOAD, which pulls the voltage back to 1. To soak up overvoltage, the battery box must raise `set_rate` while the reactor makes more than the ship needs.
  - Stored energy = draw × voltage × efficiency, so overvoltage charges faster.
  - `set_rate` is **rounded to 10 % steps** (banker's rounding). Every battery wired to the pin gets the same rate.
  - **Charging and discharging happen at once:** if `set_rate` > 0 during a shortfall, the batteries cover their own charging load and lose 5 % on the round trip (`battery_self_drain_kwh`). Set the rate to 0 when short.
  - Battery charging is part of `load_value_out` (reactor and junction). Ship demand = load − charging, and charging = charge_rate % × `$BATT_KW` / 100. A reactor box that follows the raw load will also chase the battery charging. See `circuits/example_battery.circ`: the battery box computes demand and sends it to the reactor box over a `link`.
  - Battery (vanilla): 2000 kW·min, 500 kW recharge, 1000 kW out, 95 % efficient. **Every sub has a different number and size of batteries.** `--batteries ship` uses the sub's own from the test file (e.g. Dugong 2 × 500 kW·min, Humpback 5 × 412). Never hard-code battery numbers: use `$BATT_N`, `$BATT_KW`, `$BATT_OUT`, `$BATT_CAP`.
  - **A full battery cannot absorb anything.** Keep the charge around **80 %** (a little lower if overvolt is likely, a little higher before expected fights): room to soak surplus, and enough stored to ride out an outage.
  - Supercapacitors power the **guns** (railgun/coilgun). They are not a reactor buffer: their charging is part of demand and shows up on `guns.load_value_out`. Gun fire is a big, sudden load, so watch that pin.

### Battery math (the AI must design this; batteries have no brain of their own)
Goal: batteries absorb the reactor's surplus and cover its shortfalls. They must therefore stay **partly charged**: never full (no room to absorb) and never empty (nothing to cover with).
```
charging_kW = charge_rate% * $BATT_KW / 100        (in2; 0 if the battery is full)
demand_kW   = grid_load - charging_kW              (in3 = junction load_value_out)
surplus_kW  = reactor_output - demand_kW           (in6 = reactor power_value_out; < 0 = shortfall)
set_rate%   = clamp(surplus_kW / $BATT_KW * 100, 0, 100)    -> "suck" exactly the surplus; 0 when short
error%      = TARGET - charge%                     (in1; TARGET ~50-70: room both ways)
bias_kW     = clamp(error% * GAIN, -LIMIT, +LIMIT) (e.g. GAIN = $BATT_KW/50, LIMIT = $BATT_KW/2)
reactor_setpoint_kW = demand_kW + bias_kW          -> send to the reactor box (link); turbine = setpoint/$MAX*100
```
- Too full → negative bias → the reactor makes less than demand → the batteries discharge on their own to fill the gap.
- Too empty → positive bias → the reactor makes more → the surplus is absorbed by `set_rate`.
- Demand above `$MAX` (the reactor can't keep up) can only be covered from stored energy. Raise TARGET when the test has such bursts.
- Stored energy: `charge% /100 * $BATT_CAP` kW·min. Time it lasts at P kW = `stored * 60 / P` seconds.
- The reactor box must follow the setpoint/demand, NOT the raw `load_value_out`, which includes the battery charging. Otherwise the reactor chases its own charging.
- Fission should follow the reactor's ACTUAL turbine (`in2 / $MAX * 100`) plus temperature feedback, e.g. `fission = (actual_turbine + 100 - temp) * 50 / fuel`. Using the turbine TARGET makes temperature overshoot when the setpoint jumps. Using only actual output without temperature feedback can lock up cold (output is capped at temp/50).
- Working example: `circuits/example_battery.circ`. Naive version without charge management: `example_battery_naive.circ`. It drains to ~9 % on `synthetic_longhaul`.

### Nerfs on circuit control (all simulated)
1. `set_fissionrate`/`set_turbineoutput` move the target at most 5 %/s (0→100 takes 20 s), then the ~1 s lag applies on top. **Plan ahead; you cannot step instantly.**
2. You must keep sending (at least every 1 s), or control lapses and the target freezes. Arithmetic chains fed by reactor outputs send every tick, which is fine.
3. Signals are ignored when the reactor is off, and nothing can turn it back on. **`shutdown` triggers on ANY value, including "0". Never wire logic to it.**
4. Operator skill is 0, so you get the narrowest windows (optimal 40-60 °C, turbine tolerance ±2.5).
5. Outputs are truncated integers. The internal CTO, rates and targets are not readable; you only get in1-in7.
6. Latency: ~1 tick from signal to effect, plus 1 tick before the grid sees it.

## 7. Reading a log (`logs/<circuit>__<profile>.log`)
Key lines (`k=v`):
- `score_reliability` (0-100, higher is better)
- `kwh_per_rod` (fuel efficiency, higher is better)
- `unmet_pct` (% of demand energy not supplied), split into `unmet_avoidable_pct` (the controller's fault; the score uses this) and `unmet_unavoidable_pct` (demand above what the reactor's fuel/max plus the batteries could give)
- `voltage_mean_abs_dev` (average |V-1|)
- `fluctuation_events` (times V left 0.95-1.05)
- `brownout_s_v_lt_0_9`, `blackout_s_v_lt_0_5`, `overvolt_s_v_gt_1_1`, `junction_overload_s_v_gt_2`, `junction_breaks`
- `temp_max`, `temp_above_optimal_s`, `temp_critical_s`, `fires`, `meltdown_at_s`
- `no_fission_signal_s` / `no_turbine_signal_s` (seconds your circuit wasn't controlling)
- `battery_*`:
  - `reactor_surplus_kwh` / `reactor_shortfall_kwh`: reactor output above / below ship demand
  - `surplus_into_batteries_pct`: share of that surplus the batteries absorbed (higher is better)
  - `shortfall_covered_by_batteries_pct`: share of the shortfall they covered
  - `battery_self_drain_kwh`: energy cycled by charging while discharging (lower is better)
  - `battery_charge_min/max_pct`, `battery_soc_start/avg/end_pct`
  - `battery_full_s` / `battery_empty_s` and `surplus_lost_while_full_kwh` / `shortfall_while_empty_kwh`: charge management failures
  - `battery_below20_s` / `battery_above90_s`: thin margins
  - `battery_net_kwh` (+ = ended with more stored)
  - `kwh_per_rod_adjusted`: fuel efficiency counting borrowed battery energy, so draining batteries isn't free
  - `score_battery` (0-100): absorbed % and covered %, minus full/empty/low/high time, net drain and self-drain
- `WARNINGS` (wiring problems) and `EVENTS` (brownouts > 1 s, fires, meltdowns, timestamped)

`--timeline` adds a 1 Hz CSV with these columns: t, demand, power, voltage, temp, fission, turbine, tf/tt (targets), cto, fuel, batt.

## 8. Workflow
1. Read the user's goal (e.g. "best fuel efficiency", "no fluctuations").
2. `node sim/cli.js compare vanilla,<community circuits...> --profile all` gives the baseline to beat.
3. Write `circuits/<name>.circ`, then `check`, then `run --profile all`. Read the table and the worst log, change one thing, repeat.
4. Test with batteries when asked (`--batteries 2`; add `box battery`). Two boxes give two .txt files. Battery goal: high `score_battery`. That means high `surplus_into_batteries_pct` and `shortfall_covered_by_batteries_pct`, `battery_self_drain_kwh` near 0, `battery_full_s` = `battery_empty_s` = 0, and `battery_soc_end_pct` not below the start. Always include `synthetic_longhaul` (40 min, quiet stretches plus bursts above the reactor max): it exposes missing charge management.
5. Report the table vs the baseline, plus the exported .txt path(s). Exported files load in game with the Blueprints mod. The box pins are labelled with what to wire them to in game.

### Predicting spikes
The reactor turbine can only move 5 %/s, so every load step it hasn't anticipated becomes a voltage dip or surge until it catches up (or the batteries cover it). Ideas:
- **Pilot's intent:** `nav.velocity_x_out` ramps toward the pilot's input at ~15.6 units/s. While it is still ramping, engine load will keep rising or falling for seconds. Start moving the turbine early (rate of change → lead).
- **Engine load:** predicted engine kW = (|velocity_x_out|/100)^1.5 × engine max. Engine max = `engines.load_value_out` at full throttle; the `synthetic_*` headers list it.
- **Guns:** `guns.load_value_out` jumps when supercapacitors start charging. Let batteries take those bursts rather than chasing them with the reactor.
- **Main junction box:** `junction.load_value_out` − battery charging = the whole ship's demand, the same tick it changes.
- **Sonar monitor / nav terminal x movement:** the most popular prediction. The engine is the sub's #1 power user, and the terminal's steering part sends `velocity_x_out` (the sonar part sends nothing). In the simulator that pin is `nav.velocity_x_out`, whichever terminal it comes from in game. |velocity_x_out| rising means an engine spike is coming.
- **Predict outages with batteries.** Batteries cover a shortfall automatically, as long as they have charge and `disable_output` is off. The best designs:
  - when a spike is predicted (throttle going up, guns charging) and the reactor can't ramp in time, let the batteries carry it: keep `disable_output` off and the charge near 80 %;
  - when a big load drops away (throttle cut), turn recharge ON (`set_rate` up) to soak the reactor's surplus while the turbine winds down, then lower `set_rate` step by step (10 % steps) as the turbine catches up. This avoids overvoltage;
  - demand above `$MAX` can only come from stored energy, so charge up before it (e.g. while stopped).

Tips:
- Feed-forward on turbine (`turbine = load/$MAX*100`) plus feedback on temperature (target ~50 = 5000 on in3) is the usual base.
- Turbine changes are slew-limited (5 %/s), so predicting load changes or adding a battery buffer helps reliability.
- To get the ±3 % tolerance band, keep temp in 40-60 and turbine near CTO.
- Constants are `mem` components (`c k mem Value=50`).

## 9. Community circuits
Put the in-game `.txt` (or a `_reactor.txt` + `_battery.txt` pair) in `context/reactor_circuits/`. Pin wiring comes from, in order:
1. labels written as `reactor.load_value_out`;
2. a `name.pins` file with lines like `reactor in1 reactor.load_value_out`;
3. a guess from the circuit's own labels, reported in WARNINGS (check it).

**Auto pins.** Before running a `.txt`, the CLI tests its pins on a 170 s load-step test (about 0.2 s). If the reactor doesn't follow the load clearly better than vanilla AutoTemp, the CLI moves the pins around by trial and error:
- every source on every input (temp, power, load, fuel, fuel %, `const.1`/`const.0` for levers, none);
- swapped pairs;
- every fission/turbine layout on the outputs.

It keeps the best result and writes it to `name.pins`, backing up any old file as `.pins.bak` and keeping its `prop` lines. This takes 5–60 s once; later runs reuse the file. Pins labelled in the circuit only move for a clear gain. Box links and recorded devices (nav terminal etc.) never move.
- `node sim/cli.js autopins <name> [--force] [--write]`: run the search on its own; `--force` searches even when the pins work.
- `--no-autopins` on `run` or `compare` turns the search off.

`.circ` files are never changed: their pins are yours.

A `.pins` file can also retune a circuit per ship: `prop reactor <componentId> <Property> <value>`. The value may use `$MAX`, e.g. `prop reactor 3 Value $MAX/100`.

`node sim/cli.js decompile <name>` shows it as .circ text.

**Benchmark and analysis of the community circuits: `context/reactor_circuits/STUDY.md`.** Read it before designing. It covers which designs are fuel-efficient, which meet demand, and why each one fails. The current bar to beat:
- reliability: `overclock_reactor` (avoidable unmet 0.4–1.5 %, but heavy overvolt and fuel);
- fuel: `basic_reactor` / `lammert_arc_hts` (~25 % better than vanilla).
Compare with: `node sim/cli.js compare vanilla,basic_reactor,lammert_arc_hts,overclock_reactor,rimuru_autoreactor,<yours> --profile Dugong_round001,Humpback_round001,Typhon2_round001`.

## 10. Web bench (for the human)
`web/index.html` is the master page. Rebuild it with `node sim/build_web.js` after adding circuits or profiles. It has:
- master settings: test file, reactor max output, rods, batteries (the sub's own or set by hand);
- a **reactor circuit** and a separate **battery circuit** dropdown. Any circuit's battery box can pair with any reactor circuit;
- live charts at x1/x5/x10/x25/Max speed (all speeds give the same result);
- a **Circuit box** tab that draws each box with live signal values. Its Edit mode is a visual editor: add/move/delete components, wire pins, set properties and box pin connections, then Apply & test. The result is saved as the "Edited: my_circuit" entry; positions go into the .circ as `@x,y` and into the exported .txt;
- an editor for the circuit text;
- saving of the in-game .txt files and the log.

## 11. Whole-sub practice rounds
`node sim/cli.js ship <Dugong|Humpback|Typhon2|path.sub> [--circuit name] [--battery-circuit name] [--duration s] [--no-fights] [--breach s]`. Add `--summary` to only list what the sub has.

The sub mock (`sim/subfile.js` reads the `.sub`, `sim/ship.js` simulates it) runs every electrical item of a real sub with that sub's own settings and wiring:
- reactor, batteries, supercapacitors, junction boxes, relays (start closed), engines, pumps, nav terminal/sonar;
- turrets and discharge coils on their supercapacitor grids;
- lights, oxygen generator, fabricators, doors, detectors and buttons;
- standalone logic components, and the sub's own circuit boxes.

How the round plays:
- Power is solved per grid. Relays join grids when closed.
- No water or crew. A scenario plays the round: a pilot, fights (gunners fire, sonar goes active), and an optional hull breach (the water detectors in that room read 100 %).
- Without `--circuit`, the crew's automatic control runs the reactor.
- With `--circuit`, the circuit's box pins are wired to the sub's real devices: `reactor.*`, `junction.*` (the main junction box), `battery.*` (all ship batteries), `nav.*` (the nav terminal), `const.N`.
- `$MAX`/`$BATT_*` are filled from the sub. The log has the same metrics as a test-file run.

Each sub sets its own reactor fire/meltdown delays, junction-box overload voltage (1.7) and battery sizes. Test-file headers carry them too (`reactor_fire_delay`, `junction_overload_voltage`, `ship_batteries`).
