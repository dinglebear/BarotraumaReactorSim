# AIHowTo: Barotrauma reactor circuit simulator

Goal: design circuit-box circuits that run a Barotrauma reactor (and optionally batteries) better than community circuits. The reactor's automatic control is OFF; your circuit is the only controller. Everything runs on Node 18+ with no dependencies.

## 1. The 4 commands you need
```
node sim/cli.js run <circuit> --profile all         # simulate on every test file -> table; logs in logs/
node sim/cli.js run <circuit> --profile <name>      # one test, prints the full log, exports in-game .txt file(s)
node sim/cli.js compare a,b,vanilla --profile all   # side-by-side table (vanilla = game's own auto control)
node sim/cli.js check <circuit>                     # fast syntax/wiring check, no run
```
Other: `decompile <file.txt>` (in-game file -> .circ text), `build <circuit>` (export only), `profiles` (list test files).
Flags: `--batteries N` (0 = off), `--btype battery|supercapacitor`, `--max KW`, `--rods N`, `--fuel uranium|thorium|fulgurium|volatile`, `--link wire|wifi`, `--start warm|cold`, `--duration S`, `--timeline` (also write a 1 Hz CSV), `--battery file.txt`.
Defaults come from `sim.config.json` (the web page's "Save settings" writes this file). The test file supplies the reactor max output and the rod count unless overridden.

`<circuit>` is a name in `circuits/` (no extension), or a path. Results are deterministic: same inputs give the same log.

## 2. Files
| Path | What |
|---|---|
| `circuits/<name>.circ` | YOUR circuits (edit these). A run exports `<name>.txt` (1 box) or `<name>_reactor.txt` + `<name>_battery.txt` (2 boxes) in the in-game Blueprints format. |
| `load_profiles/*.csv` | Test files: the ship's power demand over a round (from the mod in `mod/`, or `synthetic_*`). |
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
`$MAX` in any value is replaced by the reactor max output (kW) of the test. The export bakes in the number and adds an in-game note saying which component to edit for another ship.

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

Other device pins usable via `pin`: `reactor.shutdown`, `reactor.meltdown_warning` (1/0), `battery.charge` (kW·min), `battery.power_value_out`, `battery.load_value_out`, `battery.disable_output`, `battery1.x` (a single battery). `battery.x` means all batteries. With several batteries, each sends its value separately in the same tick, so the last one wins on that pin.

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
- `heat = fission * fuel/100 * 2`. Temperature moves toward `heat - turbine` at ≤ 10 %/s. One uranium rod (fuel 80) gives heat = 1.6 × fission.
- Fission and turbine follow their targets with a ~1 s lag (`x += (target - x)*dt`). Fission is capped at AvailableFuel (80 per uranium rod).
- **Output kW = MaxOutput × clamp(turbine ± tol, ≤ temp/50) / 100**. Below temp 50, output is capped at `temp/50` of max. tol = 1 % of max, or 3 % when turbine is within CTO±2.5 AND temp is 40-60. The reactor does NOT follow load by itself: the turbine must equal `load/max*100`.
- CTO (ideal turbine) = load/max×100, smoothed. It is not sent out; compute it from in1.
- Fuel burn per rod: `fission/100 * 0.2` condition/s, for EVERY rod present. Fewer rods = less burn; more fuel = more heat per % fission. **Fuel efficiency = keep fission as low as the needed heat allows.**
- Danger: temp > 60 for 20 s starts a fire (repeats). Temp > 70 runs the meltdown timer (120 s → meltdown). Temp < 40 is outside the optimal range (no ±3 % bonus).
- Grid: voltage = supply/load. < 0.5 devices shut off, < 0.9 brownout, > 2 junction boxes take random damage.
- Batteries: they supply what the reactor doesn't cover (in proportion to their max output). Charging adds load: `set_rate` % × max recharge, **rounded to 10 % steps**. They output less below 10 % charge. Battery: 2000 kW·min, 500 kW recharge, 1000 kW out, 95 % efficient. Supercapacitor: 20 kW·min, 1000 recharge (squared curve), huge output, 10 % efficient.

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
- `unmet_pct` (% of demand energy not supplied)
- `voltage_mean_abs_dev` (average |V-1|)
- `fluctuation_events` (times V left 0.95-1.05)
- `brownout_s_v_lt_0_9`, `blackout_s_v_lt_0_5`, `overvolt_s_v_gt_1_1`, `junction_overload_s_v_gt_2`, `junction_breaks`
- `temp_max`, `temp_above_optimal_s`, `temp_critical_s`, `fires`, `meltdown_at_s`
- `no_fission_signal_s` / `no_turbine_signal_s` (seconds your circuit wasn't controlling)
- `battery_*`
- `WARNINGS` (wiring problems) and `EVENTS` (brownouts > 1 s, fires, meltdowns, timestamped)

`--timeline` adds a 1 Hz CSV with these columns: t, demand, power, voltage, temp, fission, turbine, tf/tt (targets), cto, fuel, batt.

## 8. Workflow
1. Read the user's goal (e.g. "best fuel efficiency", "no fluctuations").
2. `node sim/cli.js compare vanilla,<community circuits...> --profile all` gives the baseline to beat.
3. Write `circuits/<name>.circ`, then `check`, then `run --profile all`. Read the table and the worst log, change one thing, repeat.
4. Test with batteries when asked (`--batteries 2`; add `box battery`). Two boxes give two .txt files.
5. Report the table vs the baseline, plus the exported .txt path(s). Exported files load in game with the Blueprints mod. The box pins are labelled with what to wire them to in game.

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

`node sim/cli.js decompile <name>` shows it as .circ text.

## 10. Web bench (for the human)
`web/index.html` is the master page. Rebuild it with `node sim/build_web.js` after adding circuits or profiles. It has:
- master settings: batteries on/off, reactor max output, test file, circuit;
- live charts at x1/x5/x10/x25/Max speed (all speeds give the same result);
- an editor for the circuit text;
- saving of the in-game .txt files and the log.
