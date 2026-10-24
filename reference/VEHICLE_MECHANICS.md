# Submarine motion, pumps and navigation (for sim/vehicle.js)

From the game's source, FakeFishGames/Barotrauma @ e6e95da. Paths are relative to `Barotrauma/BarotraumaShared/SharedSource/`. Vanilla values come from the item XML in the community content mirror. `sim/vehicle.js` implements this, and `node sim/test.js` checks the formulas.

## 0. Units and update loop
- **Distances:** 100 display units (px) = 1 sim unit = 1 m (`Physics.DisplayToSimRation = 100`, Physics/Physics.cs:22).
- **Physics units:** velocities in m/s, forces in N, mass in kg.
- **Coordinates:** world y points **up**.
- **Tick:** fixed 60 Hz.
- **Order within one tick** (Screens/GameScreen.cs:265-303):
  1. Items update. Signals propagate synchronously, and engines call `ApplyForce`.
  2. `Submarine.Update` adds buoyancy and drag.
  3. The physics step runs.
- **Integration** is semi-implicit Euler: `v += dt*F/m; x += dt*v`.
  - No gravity: `IgnoreGravity` is set.
  - No rotation: `FixedRotation` is set.
  - Linear damping is 0.

## 1. Submarine body (Map/SubmarineBody.cs)
**Mass** is the sum of fixture density × area:
```
mass = 100*Σ hull area (m²) + 50*Σ wall body area (m²) + 5*(item bodies, doors)
```
Vanilla estimates (±10 %):

| Sub | Mass | Engine MaxForce |
|---|---|---|
| Dugong | 22 400 kg | 270 |
| Humpback | 32 300 kg | 500 |
| Typhon | 47 100 kg | 380 |
| Kastrull drone | 1 550 kg | 50 |
| Remora drone | 2 900 kg | 50 |

**Buoyancy** (:534-570), with water and volume summed over every hull, docked subs included:
```
NEUTRAL = 0.07;  wp = ΣWaterVolume / ΣVolume;  b = NEUTRAL - wp
b = b > 0 ? 2*b : max(b, -0.5);   F_y = b * mass * 10      // a_y from +1.4 to -5 m/s²
```

**Drag** is quadratic per axis (:28-30, 439-458) and only applies when |v|² > 1e-4:
```
F_x -= sign(vx)*vx²*0.01*mass;   F_y -= sign(vy)*vy²*0.05*mass
```
- No speed cap: terminal speed is `sqrt(a/0.01)` horizontally (Humpback ≈ 5.6 m/s ≈ 20 km/h).
- Vertically: about 5.3 m/s rising and 10 m/s sinking.

**Walls:** friction 0.2, restitution 0, so a hit kills the normal velocity component and leaves sliding friction. Damage:
```
s = approach speed (m/s); if s < 3 (or round time < 10 s) no damage; impact = 3*s; wall damage = 9*s in radius 150*s px
```

## 2. Engine (Items/Components/Machines/Engine.cs)
Vanilla values (per-sub instance MaxForce overrides):

| Item | MaxForce | Power |
|---|---|---|
| engine | 300 | 2000 |
| largeengine | 500 | 4000 |
| shuttleengine | 300 | 500 |

All three have minimum voltage 0.5.

**`set_force`** clamps the value to ±100 and keeps the last value forever. The 0.1 s "control lock" only greys out the slider.

Per tick:
```
force = lerp(force, Voltage < MinVoltage ? 0 : target, dt*10)          // τ ≈ 0.09 s
if |force| > 1: F = force * min(Voltage,2)^(2/3) * MaxForce * 0.1 * lerp(0.5, 2, condition)   // × helm skill factor when a character is the sender
```
- **Full thrust** (no user, 100 % condition) is `20*MaxForce` N: 10 000 N for a large engine, 1 000 N for a drone engine.
- **Direction:** horizontal only, applied at the centre of mass.
- **Power:** `(|target|/100)^1.5 * powerConsumption`.

## 3. Pumps and ballast (Pump.cs, Hull.cs)
- **Hull volume** is the rect area in px². WaterVolume is clamped to `[0, 1.05*Volume]`.
- **Vanilla pumps** (subs override MaxFlow):

  | Item | MaxFlow | Power |
  |---|---|---|
  | pump | 600 | 300 |
  | smallpump | 100 | 60 |

**Signals:**
- `set_speed v`: `flow% = clamp(v, ±100)` and clears the target level.
- `set_targetlevel v`: `target = clamp((v+100)/200, 0, 1)*100`, a percentage. Note the input is -100..100.
- `set_active`: off when the value is `"0"`.
- `toggle`: flips on/off.

**Per tick:**
```
if target != null: flow% = round(clamp((target - water%)*10, ±100))
flow = flow%/100 * MaxFlow * min(Voltage,2) * lerp(0.5,1,condition);  WaterVolume += flow*dt*60
```
The water detector's `water_%` output is `ceil(water%)`, sent every tick.

## 4. Nav terminal (Machines/Steering.cs)
The terminal needs power (minimum voltage 0.5). All outputs below are sent every tick:

| Output | Value |
|---|---|
| `velocity_x_out` | Target velocity x, -100..100: a percentage for `set_force`. Negated on a flipped sub. |
| `velocity_y_out` | `lerp((NBL*100-50)*2, -100*sign(ty), |ty|/100)`: a value for pump `set_targetlevel`. NBL = NeutralBallastLevel, default 0.5 (Dugong 0.523, Typhon 0.685). |
| `current_velocity_x` | vx × 3.6, in km/h, formatted `"0.0000"` |
| `current_velocity_y` | −vy × 3.6, in km/h; positive means descending |
| `current_position_x` | x / 100: metres from the level's left edge |
| `current_position_y` | **Depth** in metres, positive downward: `(levelHeight − y + 80000)/100` outside the campaign. This is the only depth signal in the game. |
| `signal_out1`–`signal_out3` | Buttons that send `"1"` |
| `toggle_docking` | Sends `"1"` |
| `condition_out` | Condition as an integer percentage |

The sonar itself has **no signal outputs**.

**`velocity_in "x,y"`**:
- Must be exactly two comma-separated numbers; anything else sets (0,0). Values are clamped to ±100.
- **y is inverted: +y means down.**
- **Manual mode:** the value persists. The target velocity moves toward it at about 15.6 units/s.
- **Autopilot:** `velocity_in` overrides it for 1 s after the last signal.

**Autopilot modes:**
- "Maintain position" steers to the spot each tick and does **not** avoid walls:
  ```
  d = target - pos - v*1000
  steer = |d| > 500 ? norm(d)*100 : d/5
  tv = lerp(tv, steer, 0.1)
  ```
- "Go to start/end" runs A* over the level's tunnel nodes and **avoids walls**.
- **No signal can switch the autopilot on or set its target.** A smart-return circuit therefore has to steer through `velocity_in` itself.

## 5. Level geometry (for test levels)
- **Cells:** Voronoi cells, Solid or Path. Solid cells become static triangle fixtures.
- **Main tunnel:** clearance radius 6500 px (7000–10 000 in some biomes), clamped to [1.15 × sub size, 16 000]. That makes the main path about 130–200 m wide. Side tunnels use a radius of 1000–6000.
- **Level size:** 70 000–300 000 px wide, 50 000–100 000 px tall.
- **Abyss:** below about −5000.
