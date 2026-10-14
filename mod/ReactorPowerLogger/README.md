# Reactor Power Logger (client-side LuaCs mod)

Records how much power the main submarine asks for and writes one CSV per round. Replay that CSV in the simulator to see how a circuit would have handled the round.

## Install
1. Install **Lua For Barotrauma** (LuaCs) and enable client-side Lua. The Blueprints mod needs the same setup.
2. Copy the `ReactorPowerLogger` folder into `Barotrauma/LocalMods/` and enable it in the mod list.
3. Play a round. The console shows `[PowerLogger] recording <sub> (max N kW) -> ...`.

## Output
- Files go to `LocalMods/ReactorPowerLogger/Logs/<sub>_roundNNN.csv`, written every 30 s and at round end.
- The header saves `reactor_max_kw` (the sum of `MaxPowerOutput` of the main sub's reactors) and `fuel_rods`. The simulator uses both automatically.
- Each row also has `turbine` and `reactor_out`. If the max isn't saved, the simulator calculates it with `Output(kW) = (Turbine/100) * MaxOutput`.
- It samples every tick (60/s) and writes a row only when something changes (2 kW or 0.5 on a signal), plus every 5 s.
- Columns:
  - `t`
  - `demand`: grid load minus battery charging. Gun supercapacitor charging stays in. This is what the simulator replays.
  - `load`, `power`, `voltage`: the main junction box (the reactor's grid).
  - `reactor_out`, `turbine`, `fission`, `temp`, `fuel`, `rods` (rods in the reactor; the simulator adds or removes rods when it changes), `batt_in`, `batt_out`.
  - `nav.velocity_x_out`, `nav.velocity_y_out`, `nav.current_velocity_x`, `nav.current_velocity_y`, `nav.current_position_y`: the nav terminal's output pins.
  - `engines.load_value_out`, `pumps.load_value_out`, `guns.load_value_out`, `sonar.load_value_out`: kW per device group.
- Every `device.pin` column becomes a pin the simulated circuit can wire to, so circuits can predict power spikes from the nav terminal, engines, guns and so on.

## Reactor trace (checking the simulator against the game)
`reactortrace.lua` also writes `<sub>_roundNNN_reactor.csv`. It records the reactor 10× per second with all its internal state: temperature, fission, turbine and their targets, the ideal turbine output, load and output, available fuel, every rod's condition, AutoTemp, power, condition, the meltdown and fire timers, the operator skill factor and the optimal ranges. Events are logged too: rods added/removed, AutoTemp/power toggled, fire started, meltdown.

To test something, for example 4 fuel rods in a 5200 kW reactor on automatic:
1. Play it.
2. Copy the `_reactor.csv` into the simulator's `traces/` folder.
3. Run `node sim/cli.js verify <file>`.

`verify` replays the trace through the simulator's reactor and prints the error for each value, the first moment the temperature differs by more than 5, and the game's events next to the simulator's. Type `reactortrace` in the console to turn it off or on. If a value can't be read, its cell stays empty and the first error is printed to the console and written at the top of the file. Send that line if a trace comes out empty.

`verify` also accepts a normal round file: `node sim/cli.js verify Dugong_round001`. Without a trace it assumes AutoTemp was on.

Copy the CSVs into the simulator's `load_profiles/` folder. Then run `node sim/build_web.js` so they appear on the master page, or load them with the page's "Load CSV…" button.
