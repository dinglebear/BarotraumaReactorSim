# Community auto-reactors: benchmark and study

All runs are on the real rounds recorded with the PowerLogger mod (no batteries), using `node sim/cli.js compare <names> --profile <round>`.
- `score` is reliability, 0–100, computed from **avoidable** unmet demand: demand the reactor could have met right then, given its fuel and max output.
- `kWh/rod` is fuel efficiency (higher is better).

| circuit | Dugong score / kWh·rod | Humpback score / kWh·rod | Typhon2 avoidable unmet % / kWh·rod | style |
|---|---|---|---|---|
| vanilla AutoTemp | 39.8 / 325 | 0 / 384 | 5.94 / 1446 | game default |
| basic_reactor | 36.9 / 415 | 8.1 / 427 | 6.30 / 1819 | turbine = load/(max/100), fission = 75·turbine/fuel |
| lammert_arc_hts | 37.8 / 405 | 7.1 / 422 | 4.78 / 1797 | self-calibrating, turbine change limiter |
| overclock_reactor | 32.8 / 277 | **47.8** / 352 | **1.48** / 1205 | runs 1.15× load: almost no brownouts, lots of overvolt, burns fuel |
| overclock_auto_reactor | 0 / 270 | 0.5 / 344 | 6.91 / 1170 | 1.15× while moving, 0.85× stopped (nav terminal) |
| rimuru_autoreactor (lever 1) | 21.8 / 403 | 2.9 / 420 | 6.78 / 1760 | see below |
| rimuru_autoreactor (lever 0) | 0 / 274 | 0 / 294 | 3.31 / 1178 | see below |
| rimuru_fixed (patched) | 37.6 / – | 7.6 / – | 6.25 / – | `circuits/rimuru_fixed.circ` |

Takeaways:
- The "temperature-throttled" designs (basic, Lammert, Rimuru lever 1) are the most fuel efficient, about 25 % better than vanilla. They hold temperature ≈ turbine/2 ≤ 50, so they never make more heat than needed.
- Overclocking (overclock_reactor) meets the most demand because it always overproduces 15 %. That costs about 15 % of fuel, plus constant overvoltage (`overvolt_s` in the hundreds or thousands of seconds).
- Nobody handles rod insertion well. Every design hits 75–100 °C when rods are added, because fission can only fall 5 %/s.

## Rimuru's "Weird autoreactor" (original by Selkn)

Pins: in0 temperature, in1 power, in2 load, in3 fuel, in4 fuel %, **in9 = mode switch** (a lever). Outputs: out0 turbine, out1 fission; out2–out5 drive a fuel/rod display.

How it works:
1. **Auto max-output.** `mem3 = power × 50 / temperature_out`. While output is limited by temperature (output = max × temp/50), this equals max/100. So the circuit needs no per-ship setting.
2. **Turbine** = load / mem3 (clamped 0–100), i.e. load as % of max.
3. **Mode switch (in9).** Three signal checks listen to the lever, which must keep sending its state every tick.
   - **1 = efficiency:** turbine follows load, fission = 75·turbine/fuel → temperature settles at turbine/2.
   - **0 = responsive:** turbine pinned at 100, fission = (25·turbine + 5000)/fuel → output throttled purely by temperature. It reacts faster but burns about 30 % more fuel (274 vs 403 kWh/rod on the Dugong).
   - If the switch is not wired, the signal checks never fire, so the reactor gets no turbine or fission signal at all.
4. **Protection** (two regex checks): fission → 0 if temperature_out > 5000 (50 °C) or if power/load > 1.5.
5. **Fuel display:** uses .NET-only regex (conditional groups), so the simulator can't run it. It has no effect on control.

What goes wrong (seen tick by tick on `synthetic_combat`):
- **The calibration drifts.** power × 50 / temperature equals max/100 only while output is temperature-limited. During ramps it reads 2600–3500 kW on a 5200 kW reactor. Near 0 °C it reads 14 000–50 000 kW, and then turbine = load/huge collapses → output 0 → blackout (t = 114 s, 174 s).
- **The protection trips at full load.** In efficiency mode temperature = turbine/2, which reaches 50 at turbine 100, exactly the protection threshold. At high load it cuts fission to 0 → the reactor cools → brownout (t = 42, 138, 162 s).
- Fission comes from the turbine *target*, not the turbine's actual position, so heat runs ahead of the slow (5 %/s) turbine on big load jumps.

Patches (`circuits/rimuru_fixedmax.circ`, `circuits/rimuru_fixed.circ`):
- Removing the calibration loop (max from `$MAX`) takes Dugong from 21.8 to 35.4 and synthetic_combat avoidable unmet from 21.7 % to 14.2 %.
- Also moving the protection to 60 gives 37.6, level with the best community controllers.
- Remaining weakness, shared with basic_reactor: it still follows the load with a 5 %/s turbine, so fast load swings still brown out. Battery buffering, or predicting with the nav terminal, is where the remaining gains are.
