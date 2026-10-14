# Barotrauma mechanics reference (reactor / power / signals / circuit box)

Source: FakeFishGames/Barotrauma master @ e6e95da (2026-09-02). Paths are relative to `Barotrauma/BarotraumaShared/SharedSource/` unless they start with `Client:` or `Server:`. Snippets are short quotes for exact math only. Vanilla XML values come from a community mirror of the game's `Content/` folder (Xenonition/barotraumaec2, version >= 1.6, because the circuitbox there carries `<Upgrade gameversion="1.6.0.0">`). Anything marked **(uncertain)** has not been checked against the shipped game files.

## 0. Global conventions you must reproduce

- **Fixed tick.** `Timing.Step = 1.0/60` is a double. Every Update gets `deltaTime = (float)Timing.Step = 0.016666668f`. `Timing.TotalTime += Step` before each tick. The client clamps a frame's accumulator to 0.25 s, then runs whole steps.
- **All game math is float32 (C# `float`).** To match bit for bit in JS, wrap each op in `Math.fround`. `Timing.TotalTime` is a double.
- **Order inside one tick** (`GameScreen.Update`, then `MapEntity.UpdateAll`):
  1. Character update.
  2. `StatusEffect.UpdateAll`.
  3. Hulls, walls, gaps.
  4. **`Powered.UpdatePower(dt)`**: the whole grid solve.
  5. `Item.UpdatePendingConditionUpdates`.
  6. **`foreach item in Item.ItemList: item.Update`**, in ItemList (creation) order. Within one item, components update in XML order: `ApplyStatusEffects(Always / OnContained)`, then each component's `Update` if `IsActive || UpdateWhenInactive`. A component on a broken item (condition <= 0) gets `UpdateBroken` instead.
  7. The client's `CoroutineManager.Update` runs later in the same `GameMain` loop iteration.
  - So the power solve uses item states from the previous tick. A reactor change made in tick N reaches the grid in tick N+1.
- **ItemList order** is creation order: XML order when a sub loads, append order for newly spawned items. Items inside a circuit box are ordinary items in ItemList. A mock should make the update order explicit, because it decides 0 vs 1 tick of latency (see §3).
- **`MathHelper.Lerp(a,b,t) = a + (b-a)*t`.** `MathHelper.Clamp(v,min,max)` is `v>max?max:v; v<min?min:v`, so `min` wins when min > max. `Vector2.Lerp` works per component.
- **`MathUtils.NearlyEqual(a,b,eps=0.0001f)`:** returns true if a==b. If either is 0, it tests `|a-b|<eps`. Otherwise it uses a relative error, `|a-b|/(|a|+|b|) < eps`, and also returns true when `|a|+|b| < eps`.
- **Rounding is banker's rounding.** `Math.Round(x)`, `MathF.Round` and `MathUtils.RoundToInt` all use MidpointRounding.ToEven (2.5→2, 3.5→4, -2.5→-2). JS `Math.round` differs. A `(int)x` cast truncates toward 0. `(int)NaN` on x64 .NET 8 gives `int.MinValue` (-2147483648).
- **Float to string.** `float.ToString("G", Invariant)` (or `ToString(Invariant)`) in .NET 8 works like this:
  - It emits the **shortest round-trip float32 digits**, the same as the shortest digits of `Math.fround(x)`. Example: `0.1f→"0.1"`, `1/3f→"0.33333334"`.
  - It switches to scientific when `scale > max(digitCount, 9)` or `scale < -3`, where value = 0.d1d2…×10^scale. So `123456789→"123456789"`, `1e9→"1E+09"`, `0.0001→"0.0001"`, `0.00001→"1E-05"`, `1.5e-5→"1.5E-05"`.
  - The exponent format is `E`, then a sign, then at least 2 digits.
  - **Negative zero prints "-0"** (for example 0 × -5 in a Multiply component). NaN prints "NaN"; infinities print "Infinity" / "-Infinity".
  - A `double.ToString(Invariant)` (Oscillator sine) follows the same rule with 17 in place of 9 and double shortest digits, for example `"1.2246467991473532E-16"`.
- **String to number.**
  - `float.TryParse(s, NumberStyles.Float, Invariant)` allows leading and trailing whitespace, a leading sign, a decimal point and an exponent. It does not allow thousands separators or hex. "NaN", "Infinity" and "-Infinity" parse (case-insensitive). Overflow gives ±Infinity. On failure the out value is **0**, and several components ignore the return value, so garbage input means 0.
  - `NumberStyles.Any` (PowerContainer `set_rate`, Delay `set_delay`) also accepts `,` thousands separators, currency symbols and parentheses.
  - `int.TryParse(s)` (Mux/Demux `set_*`/`move_*`, Wifi `set_channel`) uses the current culture with integer style, so "1.0" **fails**.
- **Truthiness** in most components: `signal.value != "0"`. The empty string counts as true for `!= "0"`, but Not/Boolean components treat "" in their own way (see §4).

## 1. Reactor (`Items/Components/Machines/Reactor.cs`, client `Client:.../Machines/Reactor.cs`, server `Server:.../Machines/Reactor.cs`)

Class `Reactor : Powered` with `Priority = PowerPriority.Reactor (1)`. Its only power connection is `power_out` (an output, maxwires=1). `IsActive=true`.

### 1.1 Serialized properties (C# default / vanilla reactor1 XML)
| Property | Default (C# / XML) | Notes |
|---|---|---|
| MaxPowerOutput | 10000 / **5000** | kW, `alwaysUseInstanceValues`, so each ship's .sub instance value wins. Effective value is `GetMaxOutput() = StatManager(ReactorMaxOutput, MaxPowerOutput)`. Upgrade `increasereactoroutput` gives +3%/level (max 3). |
| FuelConsumptionRate | 0.2 / 0.2 | Condition per second at 100% fission. Talent stat `ReactorFuelConsumption`; upgrade `decreasefuelconsumption` gives -20%/level and also MeltdownDelay +20%. |
| MeltdownDelay | 120 / 120 | s |
| FireDelay | 30 / **20** | s |
| PowerOn, AutoTemp, Temperature, FissionRate, TurbineOutput, TargetFissionRate, TargetTurbineOutput, CorrectTurbineOutput, AvailableFuel, Load, LastUserWasPlayer | saveable | Temperature, FissionRate and TurbineOutput are clamped to 0..100 and reject NaN/Inf. |
| ExplosionDamagesOtherSubs | true | |

Constants: `TemperatureBoostAmount = 25`, `NetworkUpdateIntervalHigh = 0.5`, server `NetworkUpdateIntervalLow = 10`. RequiredSkill is electrical 50.

### 1.2 Fuel
- The reactor's ItemContainer (capacity 4, maxstack 1) holds rods. Each slot's `<Containable>` has `StatusEffect type="OnContaining" target="This" AvailableFuel=X disabledeltatime="true"`:
  - `fuelrod` 80
  - `thoriumfuelrod` 100
  - `fulguriumfuelrod` 150
  - `fulguriumfuelrodvolatile` 150
  - `huskfigurine` 0
- The effect is applied every tick by `ItemContainer.Update` and **adds** X: without `setvalue` it does `curr + value*dt`, and `disabledeltatime` makes dt=1.
- The effect is skipped when the rod's condition <= 0, because RelatedItem `ExcludeBroken` defaults to true (save files show `excludebroken="true"`). So **AvailableFuel = Σ X over rods with condition > 0, regardless of how much condition each rod has left.**
- Reactor.Update runs before ItemContainer.Update inside the same item. It reads the AvailableFuel accumulated last tick, copies it to `prevAvailableFuel`, and sets `AvailableFuel = 0` at the end. Within Reactor.Update, `AvailableFuel` is therefore the current fuel sum.
- Rod max condition (`health`): fuelrod 100 (default), thorium 200, fulgurium 150, volatile 400. `QualityStat Condition +0.1` per quality level, which raises max condition. "Incendium" fuel rods are **not vanilla** (mods only).

### 1.3 `Reactor.Update(dt)`, in exact order
```
if LastAIUser != null && LastAIUser.SelectedItem != item && LastAIUser.CanInteractWith(item): AutoTemp = true; LastAIUser = null
fissionCtl = signalTargetFR.HasValue && lastFRSignalTime > Timing.TotalTime - 1
turbineCtl = signalTargetTO.HasValue && lastTOSignalTime > Timing.TotalTime - 1
if RoundDuration < 5 && lastUser is not player && PowerOn && AutoTemp && !fissionCtl && !turbineCtl:
    UpdateAutoTemp(100, Step*10)                       // round-start fast sync
maxPowerOut = GetMaxOutput()
if fissionCtl: TargetFissionRate = adjustNoOvershoot(TargetFissionRate, signalTargetFR, dt*5) else signalTargetFR = null
if turbineCtl: TargetTurbineOutput = adjustNoOvershoot(TargetTurbineOutput, signalTargetTO, dt*5) else signalTargetTO = null
   // adjustNoOvershoot(c,t,s) = t<c ? max(t,c-s) : min(t,c+s)
prevAvailableFuel = AvailableFuel
ApplyStatusEffects(OnActive)
if !NearlyEqual(maxPowerOut,0): CorrectTurbineOutput += Clamp(Load/maxPowerOut*100 - CorrectTurbineOutput, -20, 20) * dt
tol = Lerp(2.5,10,dos);  optimalTurbine = (CTO-tol, CTO+tol)
tol = Lerp(5,20,dos);    allowedTurbine = (CTO-tol, CTO+tol)
optimalTemp = Lerp((40,60),(30,70),dos);  allowedTemp = Lerp((30,70),(10,90),dos)
optimalFR = Lerp((30, AvailableFuel-20),(20, AvailableFuel-10),dos); optimalFR.X = min(optimalFR.X, optimalFR.Y-10)
allowedFR = Lerp((20, AvailableFuel),(10, AvailableFuel),dos);        allowedFR.X = min(allowedFR.X, allowedFR.Y-10)
heat = fissionRate * (prevAvailableFuel/100) * 2 + temperatureBoost        // GetGeneratedHeat
diff = (heat - turbineOutput) - Temperature
Temperature += Clamp(Sign(diff)*10*dt, -|diff|, |diff|)                    // max 10 %/s, no overshoot
temperatureBoost = adjustNoOvershoot(temperatureBoost, 0, dt)                // decays 1/s
FissionRate  = Lerp(fissionRate, min(TargetFissionRate, AvailableFuel), dt)  // uses OLD fission/turbine (pre-lerp) above
TurbineOutput = Lerp(turbineOutput, TargetTurbineOutput, dt)
if !PowerOn: TargetFissionRate = TargetTurbineOutput = 0
else if autoTemp: UpdateAutoTemp(2, dt)
fuelLeft = 0
for each contained item tagged reactorfuel:
    if fissionRate > 0 && !(connected to friendly outpost): rod.Condition -= fissionRate/100 * GetFuelConsumption() * dt
    fuelLeft += rod.ConditionPercentage        // every rod drains at the same absolute rate (condition units)
(AI sound range update)
SendSignal(((int)(temperature*100f)).ToString(), "temperature_out")   // 0..10000 (temp% ×100, truncated)
SendSignal(((int)-CurrPowerConsumption).ToString(), "power_value_out") // current output kW, truncated
SendSignal(((int)Load).ToString(), "load_value_out")
SendSignal(((int)AvailableFuel).ToString(), "fuel_out")
SendSignal(((int)fuelLeft).ToString(), "fuel_percentage_left")      // SUM of rod condition % (2 full rods = "200")
UpdateFailures(dt)
AvailableFuel = 0
(network sync)
```
- `temperatureFactor` is computed in Update but never used there.
- Steady state:
  - Temperature tends to `fission*fuel/50 - turbine`. With one uranium rod, heat = 1.6×fission.
  - FissionRate and TurbineOutput are first-order lags with gain dt per tick (≈1 s time constant).
- Also sent every tick: `meltdown_warning` ("1"/"0", from UpdateFailures) and `condition_out` (from Repairable; `(int)(Condition/(MaxCondition/MaxRepairConditionMultiplier)*100)`).
- **UpdateBroken** (condition 0) only sends `temperature_out` and does: currPowerConsumption=0; Temperature -= dt*1000; targets -= dt*10 (floored at 0). Nothing else is sent.

### 1.4 `degreeOfSuccess` (dos)
- It is a private field that defaults to **0** and is not saved, so it is 0 at every round start.
- It is set only through the `LastUser` setter: `dos = min(DegreeOfSuccess(user), 1)`; a null user sets dos=0.
- `DegreeOfSuccess = ((avg(skill - required) + 100)/2)/100` with required electrical 50. Electrical skill 50 gives 0.5, 100 gives 0.75, 150 gives 1.0.
- Who sets `LastUser`:
  - A player's actual UI input: slider move, power button, autotemp switch, or arrow keys while the UI is open (client). In MP, the server's `ServerEventRead` sets `LastUser = c.Character`.
  - An AI operating it (`CrewAIOperate`).
  - **Signals never set it.**
- The editor ignores the setter (`Screen.Selected.IsEditor`).

### 1.5 Power interface
- `GetCurrentPowerConsumption(conn)` returns -1 for the power output, which marks the reactor as a source.
```
MinMaxPowerOut(conn, load):
  tolerance = 1; if turbineOutput in (optTurb.X, optTurb.Y) exclusive && temperature in (optTemp.X, optTemp.Y) exclusive: tolerance = 3
  maxPowerOut = GetMaxOutput(); tf = min(temperature/50, 1)
  minOutput = maxPowerOut * Clamp(min((turbineOutput - tolerance)/100, tf), 0, 1)
  maxOutput = maxPowerOut * min((turbineOutput + tolerance)/100, tf)
  minUpdatePowerOut = minOutput; maxUpdatePowerOut = maxOutput
  return PowerRange(minOutput, maxOutput, reactorMax: PowerOn ? maxPowerOut : maxUpdatePowerOut)
GetConnectionPowerOut(conn, power /*grid power from earlier priority groups*/, mm /*group sum*/, load /*grid load*/):
  loadLeft = max(load - power, 0)
  expectedPower = Clamp(loadLeft, mm.Min, mm.Max)
  ratio = max((loadLeft - mm.Min)/(mm.Max - mm.Min), 0); if IsInfinity(ratio): ratio = 0      // 0/0 => NaN is NOT caught
  output = Clamp(ratio*(maxUpdatePowerOut - minUpdatePowerOut) + minUpdatePowerOut, minUpdatePowerOut, maxUpdatePowerOut)
  newLoad = loadLeft; maxOutput = GetMaxOutput()
  if maxOutput != mm.ReactorMaxOutput:            // multi-reactor, OR a single reactor with PowerOn=false
     idealLoad = maxOutput / mm.ReactorMaxOutput * loadLeft
     loadAdjust = Clamp((ratio-0.5)*25 + idealLoad - turbineOutput/100*maxOutput, -maxOutput/100, maxOutput/100)
     newLoad = Clamp(loadLeft - (expectedPower - output) + loadAdjust, 0, loadLeft)
  if newLoad negative: 0
  Load = newLoad; currPowerConsumption = -output; return output
```
- Because the output is confined to [turbine-tol%, turbine+tol%] × max, capped by temperature/50, the reactor **never automatically follows the load** beyond ±1% of max output (±3% when inside the optimal turbine and temperature ranges). It always produces at least `minOutput`, even with zero load, which over-volts the grid.
- **Edge case:** with a cold reactor and zero load, min=max=0 and loadLeft=0, so 0/0 gives NaN output (C# NaN propagation). Mock it explicitly or guard it.

### 1.6 UpdateAutoTemp(speed, dt)
```
desiredTO = (optTurb.X+optTurb.Y)/2                 // == CorrectTurbineOutput
TargetTurbineOutput += Clamp(desiredTO - TargetTurbineOutput, -speed, speed) * dt; clamp 0..100
desiredFR = (optFR.X+optFR.Y)/2
TargetFissionRate += Clamp(desiredFR - TargetFissionRate, -speed, speed) * dt
if temperature > (optTemp.X+optTemp.Y)/2:  TargetFissionRate = min(TargetFissionRate - speed*2*dt, allowedFR.Y)
else if -currPowerConsumption < Load:      TargetFissionRate = min(TargetFissionRate + speed*2*dt, 100)
TargetFissionRate = Clamp(TargetFissionRate, 0, 100)
TargetFissionRate = Clamp(TargetFissionRate, FissionRate - 5, FissionRate + 5)
```
- In normal operation speed is 2 with dt per tick.
- At round start (RoundDuration < 5 s) it uses speed 100 with dt = Step×10 (only if no signal control and no player LastUser).
- AI operate: `UpdateAutoTemp(Lerp(0.5,2,dos), 1.0)` per AI update when dos >= 0.5; otherwise the AI just enables AutoTemp.
- `PowerUpImmediately()` (outposts/NPC subs): PowerOn=AutoTemp=true, then 100 iterations of Update(Step×10) plus UpdateAutoTemp(100, Step×10).

### 1.7 Failures (UpdateFailures)
- **Meltdown timer.** If `temperature > allowedTemp.Y`: send "1" on meltdown_warning, and unless the item is InvulnerableToDamage, `meltDownTimer += Lerp(dt*2, dt, Condition/MaxCondition)`. Above MeltdownDelay this calls `MeltDown()`. Otherwise send "0" and `meltDownTimer = max(0, t - dt)`.
- **Fire timer.** If `temperature > optimalTemp.Y`: `fireTimer += Lerp(dt*2, dt, cond)`. At `fireTimer >= FireDelay` a `new FireSource`, and the timer resets to 0. Otherwise `fireTimer = max(0, t - dt)`.
- **MeltDown** (server/SP only): sets Condition=0, timers=0, MeltedDownThisRound, and every contained rod's condition to 0. The OnBroken explosion (conditional `AvailableFuel gt 1`) is 750 range, plus a radiation/EMP 2000.
- `TemperatureCritical` is `temperature > allowedTemp.Y`.
- Vanilla extras: InWater costs -0.5 condition/s while condition > 10. Repairable deteriorates at 0.125/s after a 120–720 s delay, with a floor of 10.
- Client warning lights:
  - Overheating: `T > optTemp.Y`.
  - LowTemp: `T < optTemp.X`.
  - HighOutput: `out > 1.1·Load`.
  - LowOutput: `out < 0.9·Load`.
  - CriticalOutput: `out > 1.5·Load`.
  - FuelOut: `prevFuel < fission·0.01`.
  - LowFuel: `prevFuel < fission`.
  - Meltdown: `timer > MeltdownDelay·0.5`.
  - SCRAM: `T > 0.1 && !PowerOn`.

### 1.8 Signal inputs (`ReceiveSignal`; applied whenever a signal arrives, at any point in the tick)
- **`shutdown`.** **It does not check the value: any signal, even "0" or "", triggers it**, but only if `TargetFissionRate > 0 || TargetTurbineOutput > 0`. It sets PowerOn=false, AutoTemp=false and both targets to 0.
- **`set_fissionrate` / `set_turbineoutput`.**
  - Only when `PowerOn`.
  - The value must parse as a float (Float style, Invariant). It is clamped to 0..100 and stored as `signalControlledTarget*`, with `lastReceived*SignalTime = Timing.TotalTime`.
  - It does **not** touch Target* directly. In Update the target ramps toward it at **5 %/s** (dt×5 per tick).
  - Control lapses when no signal has arrived for about 1 s (`last > TotalTime - 1`; about 60 ticks). On lapse the stored target is nulled and Target* stays where it was.
  - Several signals in one tick: the last one wins.
- There is no signal input for power on, autotemp, temperature boost or `LastUser`. The vanilla reactor has no other input connections.

### 1.9 Signal outputs
All are sent every tick from Update in the order temperature_out, power_value_out, load_value_out, fuel_out, fuel_percentage_left, meltdown_warning. condition_out comes from Repairable, which updates after Reactor. The values are truncated ints as in §1.3.

### 1.10 Networking quirks
- Client to server: autoTemp, powerOn, TargetFR, TargetTO and boost, each `WriteRangedSingle(0..100, 8 bits)`, so player-set targets are quantized to 100/255 steps. The UI slider Step is 1/255.
- Server to client additionally sends temperature (8 bits) and dos (8 bits).
- The server logs changes after a 1 s delay.

### 1.11 ALL nerfs and limitations affecting signal/circuit-controlled reactors
1. **Ramp-limited set points.** `set_fissionrate` and `set_turbineoutput` move Target* at most 5 %/s (`dt*5`); 0→100 takes 20 s. Players set Target instantly (slider or keys at 20/50/200 %/s). On top of that, the actual FissionRate and TurbineOutput lag their targets by `Lerp(x, target, dt)` (≈1 s time constant).
2. **Signals expire after ~1 s.** The signal must be re-sent at least once a second, or control lapses (target frozen, the signal target nulled, autotemp resumes if it is on).
3. **Ignored while PowerOn=false.** There is **no signal to turn the reactor on**, and `shutdown` also turns AutoTemp off. After any shutdown, a character must press the power button.
4. **`shutdown` fires on ANY value, including "0".** Wiring a 0/1 logic output straight to shutdown will scram the reactor.
5. **Signals do not disable AutoTemp.** If AutoTemp is on, `UpdateAutoTemp(2,dt)` runs after the signal ramp in the same tick and fights it. AutoTemp also clamps TargetFissionRate to FissionRate±5 and caps it at allowedFR.Y when hot.
6. **No round-start fast sync** (UpdateAutoTemp(100, Step·10) during the first 5 s) while signal control is active, so the start of the round may over- or under-volt. Junction boxes cannot overload during the first 5 s of the round anyway.
7. **Skill (dos) is never granted by signals.** A reactor nobody touched this round has dos=0. That gives the narrowest windows:
   - optimal turbine CTO±2.5, allowed ±5
   - optimal temperature 40–60 (fire timer above 60, a fire every FireDelay=20 s)
   - allowed temperature 30–70 (meltdown timer above 70)
   - optimal fission (30, fuel-20), allowed (20, fuel)

   With dos=0, the ±3 % output-tolerance bonus also needs the turbine strictly within CTO±2.5. dos only rises if a player or AI operated it this round (and it stays at that user's value).
8. **The reactor never load-follows on its own.** Output is pinned to turbineOutput±1 % (±3 % in the optimal zone) × MaxPowerOutput, capped by temperature/50. A circuit must track Load itself, using the truncated-int `load_value_out` with 1+ ticks of latency.
9. **Integer-truncated telemetry.** temperature_out is temp×100 truncated; power, load and fuel are truncated kW. CorrectTurbineOutput, the optimal/allowed ranges, FissionRate, TurbineOutput and Target* are **not** output at all.
10. **Fission is capped by fuel.** The lerp target is `min(Target, AvailableFuel)`. AvailableFuel is the rod-type sum (80/100/150), not remaining condition.
11. **Temperature slew is limited to 10 %/s**, and temperatureBoost (±25, UI only) cannot be triggered by signals.
12. **Bots interfere.** An AI that operated the reactor re-enables AutoTemp when it walks away. An AI with an operate order sets PowerOn and AutoTemp, or runs UpdateAutoTemp with dt=1. An AI does not take over from a same-team player who was the last user unless its order is an override.
13. **Latency.** Signal changes are latched in ReceiveSignal and applied in the reactor's next Update (0–1 tick, depending on ItemList order). The grid sees the new turbine and temperature only at the next tick's UpdatePower. Output signals reflect state after the reactor's own Update.
14. Upgrades and talents (MaxPowerOutput, FuelConsumption) apply the same way regardless of control method; these are not nerfs.

## 2. Power grid (`Items/Components/Power/Powered.cs`)

- **Priorities** (`enum PowerPriority`): Default=0, Reactor=1, Relay=3 (RelayComponent, PowerDistributor), Battery=5 (PowerContainer). A source's output Connection.Priority is set to the component's Priority in `OnItemLoaded`. Source groups are kept in a `SortedList`, so the **lowest value supplies first: Default, then reactors, then relays, then batteries**.
- **Update interval:** every tick (`UpdateInterval = Timing.Step`). Nothing runs while `GameSession.RoundEnding`.
- **Grids:** `UpdateGrids()` uses a DFS over `Connection.Recipients`.
  - Two connections connect when `ValidPowerConnection` holds: both are power connections, both items have condition > 0, neither PowerTransfer has `CanTransfer=false`, and **(one side is a junction box or docking port, OR one is an input and the other an output)**.
  - Grids are rebuilt lazily from `ChangedConnections` (wires changed, items broke, etc.).
  - Only connections that have recipients form grids.
  - Junction boxes (PowerTransfer) join everything on their single `power` connection into one grid. Relays and distributors split it into an input grid and output grid(s).
- **`UpdatePower`, per tick:**
  1. Reset every grid: Power=0, Load=0, clear source groups.
  2. For each Powered: `Voltage -= dt` (decay for ungridded devices).
     - `powerIn` (if not also an out): `c = GetCurrentPowerConsumption(powerIn)`. If c >= 0 it is a load: `CurrPowerConsumption = c` and `grid.Load += c`; PoweredByTinkering makes it 0. If c < 0 and the device is in a grid, it is added as a source. Without a grid it is solved alone.
     - Each powerOut: if `c >= 0`, grid.Load += c, else AddSrc. PowerTransfer stores `PowerLoad = c`.
  3. For each grid and each source group in ascending priority:
     - `group.MinMaxPower = Σ device.MinMaxPowerOut(c, grid.Load)` (over every Powered component on the item).
     - `added = Σ device.GetConnectionPowerOut(c, grid.Power, group.MinMaxPower, grid.Load)`.
     - `grid.Power += added`.
     - So `grid.Power` passed to a group is the power already supplied by earlier groups.
  4. `grid.Voltage = min(grid.Power / max(grid.Load, 1e-10), 1000)`, with negative values set to 0.
  5. `GridResolved(c)` for every connection.
- A device's `Voltage` is its `powerIn.Grid.Voltage`. With no powerIn it is the average over its output grids. With no grid it is the decaying field. A device with `PowerConsumption <= 0` returns 1. A broken PowerTransfer returns 0.
- `HasPower = Voltage >= MinVoltage`. MinVoltage defaults to 0.5, and to 0 when PowerConsumption <= 0. `RelativeVoltage = clamp(V/minV, 0, 1)`. `MaxOverVoltageFactor = 2`.
- **Consumers at low voltage** (examples):
  - **Load does not depend on voltage.** A consumer always adds its full demand.
  - Pumps: power = `PowerConsumption*|flow%|/100`; effect × `min(V, 2)`.
  - Engines: power = `(|targetForce|/100)^1.5 * PowerConsumption`; force goes to 0 when `V < MinVoltage`, and scales by `min(V, 2)` when overvolted.
  - Oxygen generator: flow × `min(V, 2)`; nothing below MinVoltage.
  - Lights: brightness `min(V, 1)`, flicker when V < MinVoltage.
  - `Repairable.AdjustPowerConsumption`: below RepairThreshold, power × `Lerp(1.5, 1, cond/max)`.
  - `OnActive` status effects run when `V > minVoltage`, or always when the device draws no power.
- **Base `GetCurrentPowerConsumption`:** 0 when the device has no power connections, or when the connection isn't powerIn, or when the device is inactive. Otherwise it returns `PowerConsumption`. A PowerTransfer returns `PowerConsumption + ExtraLoad`.

### 2.1 Junction box (`PowerTransfer.cs`; items `junctionbox`, `junctionbox_tutorial`)
- Connections: `power` (in and out), `signal_0..3` (pass-through), `condition_out`, `power_value_out`, `load_value_out`.
- Properties: CanBeOverloaded=true, OverloadVoltage=2.0 (minimum 1), FireProbability=0.15, Overload (runtime).
- `ExtraLoad`: an external add-on load. More than 1 s after the last set, it decays toward 0 at 1000/s.
- `Update`: RefreshConnections, UpdateExtraLoad, then return if `!CanTransfer`, then OnActive effects, SendSignals, UpdateOvervoltage.
- **SendSignals, every tick:**
  - `powerReadingOut = powerOut.Grid.Power`, `loadReadingOut = powerOut.Grid.Load` (fallback: `-powerLoad` / ExtraLoad).
  - The string is cached: `if (prev != (int)x || sig == null) { prev = (int)Math.Round(x); sig = prev.ToString(); }`. **The value only refreshes when trunc(x) differs from the last *rounded* value sent** (for example 99.4 then 99.7 stays "99").
  - Sends `power_value_out`, then `load_value_out`.
  - Note that power_value_out is the **total grid supply**, not the box's own share.
- **UpdateOvervoltage:**
  - Skipped if the item has no Repairable or `!CanBeOverloaded`.
  - `Overload = Voltage > max(OverloadVoltage,1) && !(RoundDuration < 5)`. Clients stop here.
  - With a cooldown timer active (5 s after breaking), it just decrements.
  - Otherwise there is a **1 % chance per tick** of `Condition -= dt * Rand(10,500) * Lerp(5, 1, cond/maxCond)`.
  - If that breaks the box (the condition crosses to 0): cooldown = 5 s; with probability `Lerp(FireProbability, FireProbability*0.1, EventManager.CurrentIntensity)` (intensity 0.5 if unknown) a FireSource starts.
- Vanilla: the junction box loses 0.25 condition/s in water while V > 0.1. Repairable 0.1/s after 120–720 s. Its two status lights draw 1 kW each.
- **Signal pass-through:** a signal arriving at a connection whose name starts with "signal" is delivered **synchronously** to every connection reachable from it through chains of active, transferring PowerTransfer items. Other junction boxes on the way are skipped, so the signal is not re-relayed; one call reaches the whole chain. Recipient OnUse connection effects fire when the value is non-"0".

### 2.2 Battery and supercapacitor (`PowerContainer.cs`, Priority Battery=5)
- Units: Capacity and Charge in kW·min; MaxOutPut, MaxRechargeSpeed and RechargeSpeed in kW.
- Defaults: MaxOutPut 10, Capacity 10 (minimum 1), Charge 0, MaxRechargeSpeed 10 (minimum 1), RechargeSpeed 0, ExponentialRechargeSpeed false, Efficiency 0.95 (0..1).
- `adjustedCapacity = StatManager(BatteryCapacity, Capacity)`.
- **RechargeSpeed setter:** clamps to 0..max, then `RoundTowardsClosest(v, max(max*0.1, 1)) = (float)Math.Round(v/div)*div`. That is **10 % steps with banker's rounding**: a requested 45 % can become 40 %, 55 % becomes 60 %, and float error matters.
- **Load** (`GetCurrentPowerConsumption(powerIn)`):
  - If `charge >= cap`, return 0.
  - Broken: 0.
  - Otherwise: `target = rechargeSpeed`. Exponential: `target = (rs/max)^2 * max`. If `missing = cap - charge < 1`, `target *= missing`. Return `clamp(target, 0, MaxRechargeSpeed)`.
  - For the power-out connection: `CurrPowerOutput = 0`, return `charge > 0 ? -1 : 0`.
- **MinMaxPowerOut(out):**
  - OutputDisabled gives Zero.
  - `ratio = prevCharge/cap`. `max = ratio < 0.1 ? max(ratio*10,0)*MaxOutPut : MaxOutPut`, then `max = min(max, prevCharge*60/UpdateInterval)`.
  - Returns (0, max).
- **GetConnectionPowerOut(out):**
  - Applies only when the group max > 0.
  - `CurrPowerOutput = clamp((load - power)/group.Max, 0, 1) * ownMax`. Batteries share the remaining deficit in proportion to their own max.
- **GridResolved:**
  - powerIn: `Charge += CurrPowerConsumption * Voltage / 60 * UpdateInterval * efficiency`. Voltage is the input grid voltage, up to 1000, so **overvolt charges faster**. Charge is clamped by the setter.
  - powerOut: `Charge = clamp(Charge - CurrPowerOutput/60*UpdateInterval, 0, cap); prevCharge = Charge`.
- **Signals in:**
  - `disable_output`: `OutputDisabled = value != "0"`. This is latched (it stays until "0").
  - `set_rate`: Any style. `RechargeSpeed = clamp(v/100, 0, 1) * MaxRechargeSpeed`, then rounded as above.
- **Signals out**, every tick from Update, in this order. All use `(int)Math.Round(...)`, so banker's rounding:
  - `power_value_out`: CurrPowerOutput.
  - `load_value_out`: powerOut.Grid.Load.
  - `charge`: Charge.
  - `charge_%`: Charge/cap×100.
  - `charge_rate`: RechargeSpeed/max×100.
- OnActive effects run when charge > 0. In the vanilla battery these charge contained cells at +2 condition/s when ChargePercentage > 0.01 and output is not disabled.
- Network: the server sends an event when the charge changes by more than 5 %. The rate is synced as an integer 0..10.
- Vanilla:
  - `battery` / `shuttlebattery`: capacity 2000, maxrechargespeed 500, maxoutput 1000, efficiency 0.95 (default).
  - `supercapacitor`: capacity 20, rechargespeed 0, maxrechargespeed 1000, maxoutput 20 000 000, **efficiency 0.1**, exponentialrechargespeed true. Its XML also has `rechargeadjustspeed` and `rechargewarningindicator*`, which the current code does not use.
  - Upgrades: battery capacity +20 %/lvl, supercap capacity +10 %/lvl, recharge speed +10 %/lvl (max 3).

### 2.3 Relay (`Signal/RelayComponent.cs`; `relaycomponent`, also usable in a circuit box) — PowerTransfer, Priority Relay=3
- Properties: MaxPower 1000, IsOn true. Vanilla relaycomponent sets canbeoverloaded=false and vulnerabletoemp=false.
- Pairs: power_in→power_out, signal_in→signal_out, signal_in1..5→signal_out1..5. Inputs `toggle` (non-"0" flips the state) and `set_state` (`!= "0"`).
- Outputs every tick: `state_out` ("1"/"0"), `power_value_out` = round(-PowerLoad), `load_value_out` = round(outGrid.Load).
- **Signals pass synchronously** (`item.SendSignal(signal, out)`, the same Signal, so stepsTaken carries on), only while IsOn.
- If `Voltage > OverloadVoltage && CanBeOverloaded && has Repairable`, it breaks (condition 0).
- Power, with an internal buffer `B` (starts at 2×Max):
  - Input load = `Max` when B <= Max. Otherwise `clamp(B²/(3Max) - 2B + 8Max/3, 0.001, Max)`, smoothed `(cur + prev*0.1)/1.1`. Then `+ExtraLoad`.
  - Output can run only if on, both grids exist, they differ, and B > 0.
  - Output max = `min(min(Max, load)*prevV [*prevV again if prevV<1], min(B, Max))`.
  - `PowerLoad = clamp((load*prevV - power)/max(group.Max,1e-20) * -maxOut, -maxOut, 0)`.
  - The buffer updates once both sides resolve: `B = clamp(B + bufferDiff + add, 0, limit)`, where `add = Vin*(Consumption-Extra)` (with Vin>1 it uses prevV×…, capped at Max).
  - prevV decays by 0.0005/tick toward 1 when above 1.
  - This is only needed if you model relays in the power path.

### 2.4 PowerDistributor (`Power/PowerDistributor.cs`), Priority Relay
- One `power_in` and N power outputs (groups), each with an optional `set_supply_ratio*` input and `supply_ratio_out*` output. The ratio is 0..1 in 1/20 steps, set via signal in % (`DisplayRatio`).
- Load: `Σ groups (shortCircuited ? 0 : group.Load*ratio) + ExtraLoad`. Output per group = `max(group.Load*ratio*Voltage, 0)`.
- Signals: `power_value_out` = RoundToInt(inGrid.Power), `load_value_out` = RoundToInt(own load), then each ratio output.

## 3. Signal system
- `struct Signal { string value; int stepsTaken; Character sender; Item source; float power; float strength=1; double CreationTime }`.
- **`Item.SendSignal(signal, connName)`**:
  1. Sets `source ??= this`.
  2. Clears **this** item's `LastSentSignalRecipients`, then `stepsTaken++`.
  3. If `stepsTaken > 5` and the source's `LastSentSignalRecipients` contains this connection **3+ times**, it drops the signal (loop guard).
  4. If **`stepsTaken > 10`**, it resets stepsTaken to 0 and queues a coroutine unless an identical one (same connection, source, value, sender) is pending. The coroutine is added at StartCoroutine and first stepped at the end of tick N, where it yields. On tick N+1's `CoroutineManager.Update` (after all items updated) it calls `connection.SendSignal`. So it is **delivered at the end of the next tick**, and Update-based consumers see it at N+2.
  5. Otherwise it applies the connection's OnUse effects (when value is non-"0" and non-empty), then calls `connection.SendSignal(signal)`.
- **`Connection.SendSignal`:**
  - For each wire's other end it skips the same item, and skips the recipient if it equals the **last** entry of `source.LastSentSignalRecipients`. Otherwise it appends the recipient to that list and calls `SendSignalIntoConnection`, which **synchronously** calls `ReceiveSignal(signal, conn)` on every component of the recipient item. Recipient connection OnUse effects fire unless value=="0".
  - Then each `CircuitBoxConnection` attached to this connection gets `ReceiveSignal`.
- **Propagation is depth-first, recursive and immediate within the tick.** There is no per-wire buffering. N signals on a wire in one tick reach the recipient N times. Components that latch keep the last value. Delay queues each one. Memory takes the last write.
- `stepsTaken`:
  - +1 per `Item.SendSignal` hop.
  - Components that **forward the received Signal** keep the count: Not, SignalCheck, Modulo, Exponentiation, Function, Trig (non-xy), Relay, Mux/Demux, junction pass-through (no increment), CircuitBox I/O.
  - Wifi forwards with `stepsTaken+1`, then +1 again in SendSignal.
  - Components that emit `new Signal(...)` in Update restart at 0.
  - Practical effect: an **immediate forwarding chain of more than 10 hops gets an extra ~1–2 tick delay** at hop 11, and duplicate identical delayed signals are deduplicated.
- **Latency rules:**
  - (a) Through forwarding components: 0 ticks.
  - (b) Through Update-driven components (And/Or/Xor, arithmetic, Concat, Equals/Greater, Memory, Color, Oscillator, Delay, RegEx, Atan2, continuous Not, Mux/Demux `selected_*_out`, Reactor and batteries): 0 ticks if the receiver's Update comes **after** the sender in ItemList order, otherwise 1 tick.
  - (c) Any feedback loop through Update components therefore has at least 1 tick per loop.
  - (d) Power changes have 1 tick of latency (UpdatePower happens before item updates).

## 4. Circuit components (all are tagged `circuitboxcomponent` in vanilla, so all can go in a circuit box)
Notes that apply to the whole table:
- "Upd" means it outputs in Update, every tick while active. "Recv" means it outputs immediately in ReceiveSignal.
- `IsActive` defaults to false in ItemComponent unless set.
- TimeFrame (TF) semantics (And/Or/Xor/arithmetic/Concat/Equals/Greater):
  - `timeSinceReceived[i]` starts at `max(TF*2, 0.1)`. A received signal sets it to 0.
  - In Update, input i counts if `timeSinceReceived[i] <= TF`, and **then** dt is added.
  - So with **TF=0 an input counts only if it was received since this component's previous Update** (i.e. "every tick").
  - Raising TF via the setter resets both timers to max(TF*2, 0.1).
- MaxOutputLength / MaxValueLength are Editable, not InGameEditable, and not saved. Truncation via Substring happens in the property setters when not loading; `set_output` signals bypass it.

| Item id (class) | Connections | Properties (default; saveable?) | Behavior |
|---|---|---|---|
| andcomponent / orcomponent / xorcomponent (`And/Or/XorComponent : BooleanOperatorComponent`) | in `signal_in1`,`signal_in2`,`set_output`; out `signal_out` | TimeFrame 0, Output "1", FalseOutput "0", MaxOutputLength 200 | **Upd.** Recv: a value of "0" is **ignored** (it does not mark the input); anything else, including "", marks the input and sets IsActive. `set_output` sets output raw. Update: n = number of inputs counting (TF rule). And: n>=2; Or: n>0; Xor: n==1. Sends Output or FalseOutput. If the chosen string is empty, nothing is sent, and the component deactivates when the state is false and both inputs have timed out. A non-empty FalseOutput means "0" is sent every tick forever. |
| addercomponent / subtractcomponent / multiplycomponent / dividecomponent (`Adder/Subtract/Multiply/DivideComponent : ArithmeticComponent`) | `signal_in1`,`signal_in2` → `signal_out` | ClampMax 999999, ClampMin -999999, TimeFrame 0 (all InGameEditable+saved) | **Upd.** Recv: `float.TryParse(..., out recv[i])`, so unparsable means 0; sets timer 0 and IsActive. Update: `IsActive = !(both timed out)`; **returns if EITHER input timed out**. `out = Calculate(a,b)`; if valid (not NaN/Inf) it sends `Clamp(out, ClampMin, ClampMax).ToString("G", Invariant)`. Divide returns NaN (so no output) when `NearlyEqual(b,0)`. Float32 math. |
| modulocomponent (`ModuloComponent`) | `signal_in`,`set_modulus` (alias `modulus`) → `signal_out` | Modulus 1 (InGameEditable, not saved by vanilla Save) | **Recv.** Out = `(v % modulus).ToString("G")` (C# `%`, sign follows the dividend). A modulus that is NearlyEqual 0 becomes 1. Unparsable input means 0. |
| powcomponent (`ExponentiationComponent`) | `signal_in`,`set_exponent` (alias `exponent`) → `signal_out` | Exponent 1 | **Recv.** `(float)Math.Pow(v, exp)` → "G". NaN/Inf **are** sent ("NaN"). |
| roundcomponent, ceilcomponent, floorcomponent, factorialcomponent, abscomponent, squarerootcomponent (`FunctionComponent`, Function set by the prefab XML: Round/Ceil/Floor/Factorial/AbsoluteValue/SquareRoot) | `signal_in` → `signal_out` | Function (not saveable) | **Recv.** Unparsable input means **no output**. Round = `MathF.Round` (**ToEven**), -0 becomes 0. Ceil: -0 becomes 0. Floor: **can output "-0"** for input "-0". Factorial: `(int)min(v,20)` then ulong product → float (v<=0 gives 1). Abs. Sqrt: negative input gives no output. "G" format. |
| sincomponent, coscomponent, tancomponent, asincomponent, acoscomponent, atancomponent (`TrigonometricFunctionComponent`) | `signal_in` (+ atan: `signal_in_x`,`signal_in_y`) → `signal_out` | Function (prefab), UseRadians false (saved) | **Recv**, except atan with x/y. Degrees by default (input converted with ToRadians for sin/cos/tan). Tan: when `NearlyEqual(rad % π, π/2)`, tan is skipped and the **radian-converted input** is sent. Asin/Acos outside [-1,1] **send the raw input value unchanged**. Atan on `signal_in`: atan(v). Atan x/y: latched, and each becomes NaN when not received for more than 0.1 s; Update sends atan2(y,x) when both are valid (**Upd**, always active). |
| greatercomponent (`GreaterComponent : EqualsComponent`) | `signal_in1`,`signal_in2`,`set_output` → `signal_out` | Output "1", FalseOutput "0", TimeFrame 0, MaxOutputLength 200 | **Upd** (always active). Recv parses floats (failure gives 0). Update: if **either** input counts by the TF rule, it sends `val1 > val2 ? Output : FalseOutput` (an empty string is not sent). |
| equalscomponent (`EqualsComponent`) | same | same | **Upd**. String ordinal compare of the last received values (initially null==null). Fires if **either** input counts. |
| signalcheckcomponent (`SignalCheckComponent`) | `signal_in`,`set_output`,`set_targetsignal` → `signal_out` | Output "1", FalseOutput "0", TargetSignal "" | **Recv**: `value == TargetSignal ? Output : FalseOutput`; an empty result sends nothing. Forwards the same Signal. |
| regexcomponent (`RegExFindComponent`) | `signal_in`,`set_output` → `signal_out` | Output "1", FalseOutput "0", Expression "", UseCaptureGroup false, OutputEmptyCaptureGroup false, ContinuousOutput true | **Upd**. Recv latches the input. Update re-matches only when the input changed (.NET Regex, 50 ms timeout; 3 slow matches in a row puts it in "TIMEOUT" state, sent every tick). Exceptions send "ERROR". With UseCaptureGroup, Output is the group *name or number*. Non-continuous mode sends once per received signal. |
| memorycomponent (`MemoryComponent`) | `signal_in`,`lock_state` (alias `signal_store`) → `signal_out` | Value "", Writeable true, MaxValueLength 200 | **Upd: sends Value every tick, including ""**. `signal_in` writes when Writeable. **`lock_state`: Writeable = (value == "1")**, so any other value locks it. |
| delaycomponent (`DelayComponent`) | `signal_in`,`set_delay` → `signal_out` | Delay 1.0 s (0..60), ResetWhenSignalReceived false, ResetWhenDifferentSignalReceived false | `delayTicks = (int)(Delay / Timing.Step)` (truncation; 0.01 s gives 0). Queue cap = `max(delayTicks,1)*2`; extra signals are dropped. Each received signal enqueues {timer=delayTicks, duration=1}. An identical value+strength signal arriving the next tick extends the previous entry's duration (run-length). Update: decrement all timers; while head timer <= 0, send it once (new Signal, value, sender, strength), `duration--`, and dequeue when 0. Result: output appears `max(delayTicks,1)-1` Updates after the first Update following receipt. `set_delay` (Any style, clamp 0..60) clears the queue if the delay changed. Deactivates when the queue is empty. |
| oscillator (`OscillatorComponent`) | `set_frequency` (alias `frequency_in`), `set_outputtype` (alias `set_wavetype`) → `signal_out` | OutputType Pulse, Frequency 1 (clamped 0..240) | **Upd**, always. Pulse: `phase += dt; while phase >= 1/f: send "1", phase -= 1/f` (up to 4 per tick). Sawtooth/Square/Sine/Triangle: `phase = (phase + dt*f) % 1` then send: `phase.ToString(Inv)` / `phase<0.5?"0":"1"` / `Math.Sin(phase*2π)` as **double** string / `4|posmod(phase-0.25,1)-0.5|-1`. `set_outputtype` uses `Enum.TryParse` (case-sensitive name or number). |
| notcomponent (`NotComponent`) | `signal_in` → `signal_out` | ContinuousOutput false | **Recv**: sends "1" if the value is "0" or empty, else "0" (forwarded Signal, power=0). With ContinuousOutput=true it is active, and Update sends "1" if nothing arrived since the last Update. Without it there is no output when nothing arrives. |
| concatcomponent (`ConcatComponent : StringComponent`) | `signal_in1`,`signal_in2` → `signal_out` | Separator "" (InGameEditable, not saveable), TimeFrame 0, MaxOutputLength 256 | **Upd**, same TF and early-return rules as arithmetic. `a + (sep ?? "") + b`, truncated to MaxOutputLength. |
| colorcomponent (`ColorComponent`) | `signal_r,g,b,a` → `signal_out` | UseHSV false | Recv parses (failure gives 0) and rebuilds the string `"R,G,B,A"` with "G" floats. HSV mode converts via HSVToRGB (byte components). **Upd** sends the string every tick (initially "0,0,0,0"). |
| multiplexercomponent (`MultiplexerComponent`) | `signal_in0..9`,`set_input`,`move_input` → `signal_out`,`selected_input_out` | SelectedConnection 0, WrapAround true, SkipEmptyConnections true | **Recv**: forwards a signal from the selected `signal_inK`. `set_input`: int, clamped 0..count-1. `move_input`: ±n with wrap (PositiveModulo) and skip-empty (a connection counts as empty without wires or circuit-box links). Update (active only if `selected_input_out` exists) sends the index every tick. |
| demultiplexercomponent (`DemultiplexerComponent`) | `signal_in`,`set_output`,`move_output` → `signal_out0..9`,`selected_output_out` | same | **Recv**: forwards to `signal_out{sel}`. Upd sends the index. |
| relaycomponent | see §2.3 | IsOn true, MaxPower 1000 | Signal pass-through only while on (**Recv**). |
| wificomponent | see §6 | | **Recv** (transmit). |

Not circuit-box components (no `circuitboxcomponent` tag): terminal, button terminals, light components, detectors (motion, water, oxygen, smoke), sonar, etc. Base `ItemComponent.ReceiveSignal` handles `activate`/`use`/`trigger_in` (Use), `toggle` and `set_active`/`set_state` (IsActive) for components that don't override it.

## 5. Circuit box (`Signal/CircuitBox.cs`, `CircuitBox/*.cs`, client UI `Client:CircuitBox/CircuitBoxUI.cs`)
- **Item `circuitbox`:**
  - ConnectionPanel: `signal_in1..8`, `signal_out1..8`. Mods can add more; one example file has `signal_in0`, `signal_in9`, `signal_out0`, `signal_out9`.
  - ItemContainer[0]: capacity 64, maxstack 1, `Containable items="circuitboxcomponent"`, holding the components.
  - ItemContainer[1]: capacity 10, maxstack 32, `Containable items="wire"`, holding the backing wires.
  - The UI lists every ItemPrefab tagged `circuitboxcomponent`. Placing one in-game consumes one `fpgacircuit` (or the component item itself) as `usedresource`.
- **Routing (no added latency):**
  - External wire → box: `CircuitBox.ReceiveSignal` → `CircuitBoxInputConnection.ReceiveSignal`. For each internally linked target it either goes straight to a box output (`CircuitBox.Item.SendSignal(signal, outConn)`, one hop) or to `Connection.SendSignalIntoConnection` into a component input (no hop).
  - Component output → box output: through `Connection.CircuitBoxConnections` → `CircuitBoxOutputConnection.ReceiveSignal` → `CircuitBox.Item.SendSignal(signal, Connection)` (one hop).
  - Component → component: a **real Wire item** (from container 1) connects the two connections, so it is ordinary wire propagation.
  - **Everything is synchronous.** Components inside are normal items in `Item.ItemList` and update in list order. Box Update only finishes the delayed XML load.
  - A wire between box I/O and a component has **no backing item** (`backingitemid=""`).
- **Vanilla save XML** (inside the `<CircuitBox ...>` component element of the circuitbox `<Item>`):
  ```xml
  <InputNode pos="x,y"><ConnectionLabelOverride name="signal_in1" value="label"/></InputNode>
  <OutputNode pos="x,y">…</OutputNode>
  <Component id="0" position="x,y" backingitemid="slot,stackIndex" usedresource="fpgacircuit"/>
  <Wire id="2" backingitemid="slot,stackIndex|''" prefab="redwire"><From name="signal_out" target="0"/><To name="signal_in1" target="1"/></Wire>
  <Label id="0" color="#RRGGBB" position="x,y" size="w,h" header="…" body="…"/>
  ```
  - `backingitemid` = (slot index, index within the stack) in ContainerA (components) or ContainerB (wires).
  - `target` = component id; an empty target means a box I/O node, with `name` = the box connection name.
  - `ItemContainer contained="id,id,,…"` lists item IDs per slot (`,` separates slots, `;` separates stacked items).
  - Component property values live on the contained items' own `<Item>` elements in the sub file, not in `<Component>`.
  - Positions are clamped to ±PlayableAreaSize/2. Label override length is at most 32.
- **Blueprints mod format** (`context/community_circuits/*.txt`, mod source in `context/blueprints_mod/`):
  - The file is `<Root>` + the full circuitbox `<Item>` XML from `Item.Save`.
  - The contained-item `<Item>`s are **not** included. Each `<Component>` instead gets extra attributes: `Class=` (the first component type name containing "Component"), every **InGameEditable** property, and `item=` (the prefab identifier).
  - Their values are written **unquoted** as `Attr=<<<STRINGSTART>>>value<<<STRINGEND>>>`, which is not valid XML. Label `header`/`body` and `ConnectionLabelOverride value` are written as `"<<<STRINGSTART>>>…<<<STRINGEND>>>"` inside quotes.
  - Literal delimiters inside a value are escaped as `\<<<STRINGSTART>>>`; newlines are stripped.
  - Values are Lua `tostring` of the CLR value: floats appear as **double expansions of float32** (`Delay=0.009999999776482582`, which is 0.01f), bools lowercase `true`/`false`, enums by name (`OutputType=Pulse`).
  - Properties that are not InGameEditable (Function, MaxOutputLength) are absent, so take them from the prefab (e.g. `floorcomponent` → Function=Floor).
  - Component ids are renumbered 0..n-1 sorted, and positions are rounded.
  - **Parse:** non-greedily replace `(\w+)=<<<STRINGSTART>>>(.*?)<<<STRINGEND>>>` with `$1="xmlEscape($2)"`, strip markers inside quoted values, then parse as XML.
  - Examples use `usedresource="fpgacircuit"`, and wires reference `0,0`, `0,1`… in the wire container (32 wires stack per slot).

## 6. Wifi component (`Signal/WifiComponent.cs`; item `wificomponent`, **tagged circuitboxcomponent, so it can be placed inside a circuit box**)
- Connections: `signal_in`, `set_channel` → `signal_out`. `set_range` is handled in code but has no vanilla connection.
- Properties:
  - TeamID: None; set to the sub's team at round start for the main sub.
  - Range: 20000 (Editable, not saved).
  - Channel: 0 (0..10000).
  - AllowCrossTeamCommunication: false.
  - LinkToChat: false (not saved).
  - MinChatMessageInterval: 1 (vanilla 1.0).
  - DiscardDuplicateChatMessages: false (**vanilla XML true**).
  - channelmemory: 10 ints.
- **Transmit (Recv, synchronous, same tick):** on `signal_in`, for every other wifi component w with all of:
  - same channel;
  - same TeamID, or w.AllowCrossTeam;
  - w not jammed;
  - (w.LinkToChat, or w.signal_out connected to wires or a circuit-box link);
  - distance(item.WorldPosition, w.WorldPosition) <= **sender**.range;
  - required contained items present;

  it builds `new Signal(value, stepsTaken+1, sender, source, power 0, strength = s.strength*clamp(1 - dist/w.range, 0, 1))`. If `source.LastSentSignalRecipients` already contains w.signal_in, it stops (loop guard); otherwise it adds it and calls `w.item.SendSignal(s, w.signal_out)`.
  - **No frame delay.**
  - A wifi inside a circuit box uses the box's world position, so two boxes on the same sub at channel 0 talk to each other, and **all wifi components on the same channel and team in range receive**. The default range of 20000 units covers a whole sub.
- `set_channel`: int.TryParse, clamped. Update only counts down the chat cooldown and jam timer, then deactivates.
- Chat: when both ends are LinkToChat and the receiver is in a character inventory, a chat message is created (cooldown MinChatMessageInterval, distance garbling).

## 7. Vanilla item values (from the mirror; see the header)
- **reactor1:** maxpoweroutput 5000, fuelconsumptionrate 0.2, meltdowndelay 120, firedelay 20, RequiredSkill electrical 50, container 4 rods.
  - Per-ship MaxPowerOutput is in each vanilla `.sub` (gzip XML) Reactor instance attribute. **Not checked here (uncertain)**; read it from the sub files.
- **Fuel rods** (AvailableFuel per rod / max condition): fuelrod (uranium) 80/100, thoriumfuelrod 100/200, fulguriumfuelrod 150/150, fulguriumfuelrodvolatile 150/400 (also irradiates nearby characters). The AvailableFuel effect has no other condition gate besides ExcludeBroken (condition > 0).
- **battery:** capacity 2000, maxrechargespeed 500, maxoutput 1000, efficiency 0.95 (default), plus a charging dock for 3 cells.
- **supercapacitor:** capacity 20, maxrechargespeed 1000, maxoutput 2e7, efficiency 0.1, exponentialrechargespeed true.
- **junctionbox:** PowerTransfer defaults (overloadvoltage 2, fireprobability 0.15, canbeoverloaded true).
- **Circuit items:** the XML sets no non-default properties, except oscillator outputtype=Pulse frequency=1, wificomponent MinChatMessageInterval=1 DiscardDuplicateChatMessages=true, relaycomponent canbeoverloaded=false vulnerabletoemp=false, and Function on the function/trig items.
- **chargingdock:** Powered with powerconsumption 200.

## 8. LuaCs (client-side logging mod)
- **API**, confirmed in evilfactory/LuaCsForBarotrauma `luacs-docs` and `LuaCsUtility.cs`:
  - `File.Read(path)`, `File.Write(path, text)`, `File.Exists`, `File.DirectoryExists`, `File.CreateDirectory(path)`, `File.GetFiles`, `File.GetDirectories`, `File.DirSearch`, `File.Delete`, `File.Move`, `File.OpenRead/OpenWrite`.
  - **Write is allowed only under** the LuaCs package path, the game save folder, `LocalMods/`, `WorkshopMods/`, or the mod download folder. Read is allowed under those plus the game directory.
- **Hooks:** `Hook.Add("roundStart", "id", fn)`, `Hook.Add("roundEnd", ...)`, `Hook.Add("think", ...)` (every fixed tick, 60 Hz), `Hook.Add("signalReceived", ...)` / `"signalReceived.<itemIdentifier>"` (signal, connection), `Hook.Add("wifiSignalTransmitted", ...)`, `Hook.Patch(className, method, fn, Hook.HookMethodType.After)`. The `CLIENT` / `SERVER` globals are available.
- **Accessing components:**
  - `item.GetComponentString("Reactor")` (used by the Blueprints mod).
  - Statics: `Components.Reactor`, `Components.Powered`, `Components.PowerContainer`, `Components.PowerTransfer` (LuaCs DefaultLib), or `LuaUserData.CreateStatic("Barotrauma.Items.Components.Powered")`.
  - `Item.ItemList`.
- **Public members to read:**
  - Reactor: `Load` (the load this reactor is trying to meet), `CurrPowerConsumption` (negative = output kW), `MaxPowerOutput`, `TurbineOutput`, `FissionRate`, `TargetFissionRate`, `TargetTurbineOutput`, `CorrectTurbineOutput`, `Temperature`, `AutoTemp`, `PowerOn`, `FuelConsumptionRate`, `TemperatureCritical`, `MeltedDownThisRound`, `LastUser`.
    - `AvailableFuel` is public but is **0 right after the reactor's Update** (it is reset each tick and refilled later in the same tick by the container), so read `prevAvailableFuel` instead.
  - Powered: `Powered.Grids` (public static `Dictionary<int, GridInfo>`), with GridInfo `.Power`, `.Load`, `.Voltage`, `.Connections`; `Powered.PoweredList`; per device `Voltage`, `CurrPowerConsumption`, `PowerConsumption`, `HasPower`.
  - PowerContainer: `Charge`, `ChargePercentage`, `Capacity`, `MaxOutPut`, `CurrPowerOutput`, `RechargeSpeed`, `MaxRechargeSpeed`, `OutputDisabled`, `Efficiency`.
  - PowerTransfer: `PowerLoad`, `ExtraLoad`, `Overload`.
  - Connection: `Grid` (power grid for power connections).
- **Private or protected** (need `LuaUserData.MakeFieldAccessible(Descriptors["Barotrauma.Items.Components.Reactor"], "name")` after `LuaUserData.RegisterType(...)`):
  - Reactor: `degreeOfSuccess`, `optimalTemperature`, `allowedTemperature`, `optimalFissionRate`, `allowedFissionRate`, `optimalTurbineOutput`, `allowedTurbineOutput` (Vector2), `meltDownTimer`, `fireTimer`, `prevAvailableFuel`, `temperatureBoost`, `signalControlledTargetFissionRate`, `signalControlledTargetTurbineOutput`, `lastReceivedFissionRateSignalTime`, `lastReceivedTurbineOutputSignalTime`, `minUpdatePowerOut`, `maxUpdatePowerOut`.
  - Powered: `currPowerConsumption` (protected), `powerIn`, `powerOuts`.
  - PowerContainer: `adjustedCapacity`, `prevCharge`.
- **Suggested demand log:** each `think` (or every N ticks), sum the reactor `Load` and grid `.Load` for the main sub's grids. Be aware that grid Load includes battery recharge demand. Where `think` fires relative to `MapEntity.UpdateAll` was not checked (uncertain). In any case, grid values are from the most recent UpdatePower, which runs at the start of the item phase of each tick.
