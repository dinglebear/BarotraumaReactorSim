# Reactor Power Logger (client-side LuaCs mod)

Records how much power the main submarine asks for and writes one CSV per round. Replay that CSV in the simulator to see how a circuit would have handled the round.

## Install
1. Install **Lua For Barotrauma** (LuaCs) and enable client-side Lua. The Blueprints mod needs the same setup.
2. Copy the `ReactorPowerLogger` folder into `Barotrauma/LocalMods/` and enable it in the mod list.
3. Play a round. The console shows `[PowerLogger] recording <sub> (max N kW) -> ...`.

## Client-side only
Both scripts start with `if SERVER then return end`, so nothing runs on a server. They work in singleplayer and when you join a multiplayer game as a client: your game already simulates the reactor and power grid, and the server corrects it. At round start the console should show `[PowerLogger] recording <sub> ...`. If that line is missing in a multiplayer game, client-side Lua isn't running there.

## Output (v3)
- Files go to `LocalMods/ReactorPowerLogger/Logs/<sub>_roundNNN.csv`, written every 30 s and at round end.
- **Header:**
  - `reactor_max_kw` (the sum of `MaxPowerOutput`), rods and rod type;
  - battery and supercapacitor capacity, plus total engine and pump kW;
  - whether the reactor's fission/turbine inputs are wired to a circuit;
  - singleplayer or multiplayer, level difficulty, biome and missions.
- **Footer:** the duration, and `reactor_max_kw_formula`: max output worked out from `Output(kW) = (Turbine/100) × MaxOutput`, as a check on the saved value. If the header has no max, the simulator uses the same formula.
- **Rows:** a row is written when something changes (at most 20 a second; a demand jump of 50 kW or more always gets one), plus every 5 s. Columns:
  - `demand`: grid load minus battery charging (gun supercapacitors stay in). This is what the simulator replays.
  - `load`, `power`, `voltage`: the main junction box (the reactor's grid).
  - Reactor: `reactor_out`, `turbine`, `fission`, `temp`, `fuel`, `rods`, `avail_fuel`, `autotemp`, `power_on`, `target_fission`, `target_turbine`, `reactor_cond`.
  - Batteries: `batt_in`, `batt_out`, `batt_charge_pct`, `batt_rate_pct`, plus `caps_charge_pct` for the gun supercapacitors.
  - Nav terminal: `nav.velocity_x_out`, `nav.velocity_y_out`, `nav.current_velocity_x`, `nav.current_velocity_y`, `nav.current_position_y`.
  - kW per device group: `engines.load_value_out`, `pumps.load_value_out`, `guns.load_value_out`, `sonar.load_value_out`.
  - The rest of the load: `oxygen_kw`, `fabricators_kw`, `lights_kw`, `other_kw`.
  - Situation: `autopilot`, `enemies_near` (creatures within ~100 m), `flooding_pct`, `jb_broken`.
  - `event`: rods changed, AutoTemp or reactor toggled, temperature over 70, enemies arrived or left, a junction box broke or was repaired.
- `device.pin` columns are values a circuit can read in game. In the simulator they become pins a circuit can wire to, for example to predict spikes from the nav terminal. The other columns are for analysis and building ship models.

## Reactor trace (checking the simulator against the game)
`reactortrace.lua` also writes `<sub>_roundNNN_reactor.csv`. It records the reactor 10× per second with all its internal state: temperature, fission, turbine and their targets, the ideal turbine output, load and output, available fuel, every rod's condition, AutoTemp, power, condition, the meltdown and fire timers, the operator skill factor and the optimal ranges. Events are logged too: rods added/removed, AutoTemp/power toggled, fire started, meltdown.

To test something, for example 4 fuel rods in a 5200 kW reactor on automatic:
1. Play it.
2. Copy the `_reactor.csv` into the simulator's `traces/` folder.
3. Run `node sim/cli.js verify <file>`.

`verify` replays the trace through the simulator's reactor and prints the error for each value, the first moment the temperature differs by more than 5, and the game's events next to the simulator's. Type `reactortrace` in the console to turn it off or on. If a value can't be read, its cell stays empty and the first error is printed to the console and written at the top of the file. Send that line if a trace comes out empty.

`verify` also accepts a normal round file: `node sim/cli.js verify Dugong_round001`. Without a trace it assumes AutoTemp was on.

Copy the CSVs into the simulator's `load_profiles/` folder. Then run `node sim/build_web.js` so they appear on the master page, or load them with the page's "Load CSV…" button.
