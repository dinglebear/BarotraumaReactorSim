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
- Columns: `t, demand, load, reactor_out, turbine, fission, temp, fuel, voltage, batt_in, batt_out`.
  - `demand` = grid load minus battery charging. This is what the simulator replays.
  - A row is written when demand changes by 0.5 kW or more, and at least every 5 s. Sampling is every 0.25 s.

Copy the CSVs into the simulator's `load_profiles/` folder. Then run `node sim/build_web.js` so they appear on the master page, or load them with the page's "Load CSV…" button.
