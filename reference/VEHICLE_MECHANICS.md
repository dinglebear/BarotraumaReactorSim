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
- **The target velocity is set at once** (`TargetVelocity = steeringInput` in `ReceiveSignal`) and persists until the next signal. Only a pilot's own steering ramps: in manual mode the target moves toward the input at 15.6 units/s (`steeringAdjustSpeed` 0.2: (1/0.8)² × 10).
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

## 6. Motion sensor (Items/Components/Signal/MotionSensor.cs; vanilla `motiondetector`)
**Settings:**
- `range="100"`: RangeX = RangeY = 100. These are **half-extents of an axis-aligned rectangle**, editable 0–1000.
- DetectOffset moves the rectangle (clamped to ±range; negated on a flipped sub).
- Target flags: Human=1, Monster=2, Wall=4, Pet=8. The default is Any.
- MinimumVelocity defaults to 0.
- UpdateInterval is 0.1 s; the first check is at a random time in [0, interval).
- Output "1", FalseOutput "0".

**Behaviour:**
- `state_out` sends the latched result every frame. No power is needed.
- **Characters:** a limb circle must overlap the rectangle. Limbs are checked against MinimumVelocity, and with MinimumVelocity 0 the test never fails, so it **works as a presence detector**. "Human" includes human NPCs.
- **Walls:**
  - Detected only if Target includes Wall and the sensor is outside every hull (mounted on the outside of the drone).
  - **Only while the sensor's own sub moves** faster than MinimumVelocity: a drone at exactly 0 m/s sees no walls.
  - A level wall counts when the sensor is inside a solid cell, or a cell edge crosses a side of the rectangle. An edge lying entirely inside the rectangle is missed.
- **Other subs:** detected by relative motion.

## 7. What a circuit can know about the outside
- **No rangefinder exists.** The sonar has no signal outputs, and a transducer only sends a handshake every 0.5 s.
- **No item outputs the position of a character or item.**
- **Position:** the nav terminal is the only source (section 4).
- **Following a player:** use an array of motion detectors (Target Human, MinimumVelocity 0, different DetectOffsets) to get a coarse bearing and distance.
- **Wifi:** range 20 000 px.

## 8. Turrets (Items/Components/Turret.cs) and periscopes (Machines/Controller.cs)
**Angles:**
- Absolute world angle in degrees: barrel direction (cos R, −sin R), so **0° = right, 90° = down, 180° = left, 270° = up**.
- To aim at an offset (dx, dy) with y up: `deg = atan2(-dy, dx)` wrapped to [0, 360).
- `position_in` takes any value in degrees.
- Coilgun and chaingun limits are 180–360 (the upper half). A target outside the limits snaps to the nearer limit.

**Rotation:** a damped spring per frame:
```
ω += (diff*k − ω*c)*dt; clamp ω to ±vmax; R += ω*dt
```
With no character as sender:

| Turret | k | c | vmax |
|---|---|---|---|
| Coilgun | 26 | 5.25 | 4.5 rad/s |
| Chaingun | — | — | 3.0 rad/s (×0.6 when spun up) |

**`trigger_in`** (any value other than "0"):
- **Coilgun:** reload 0.25 s, 4 shots/s, 1000 kW·s (power units) per shot.
- **Chaingun:** charge must build for 1 s first, so the trigger has to be sent **every frame**. Then it fires 10/s at 400 per shot with ±4.75° spread.
- **Power:** comes only from batteries or supercapacitors wired straight to power_in, and needs `Σ min(charge*3600, MaxOutPut/60) ≥ consumption`. One battery is not enough for a coilgun shot; a supercapacitor is.
- **Ammo:** from the linked loader.

**Bolts:**
- Travel at 60.8 m/s (6080 px/s), with almost no drag.
- Live 3 s (coilgun) or 2 s (chaingun).
- The sub's velocity is not added.
- Damage:

  | Bolt | Lacerations | Bleeding |
  |---|---|---|
  | Coilgun | 15 | 1 |
  | Chaingun | 12 | 2 |

**Auto-operate:**
- Set in the sub editor (AutoOperate, AllowAutoOperateWithWiring). `set_auto_operate` / `toggle_auto_operate` only work when wiring is allowed.
- Runs only while no character is using the turret, and only with power to shoot.
- **Targets:** live characters within 3500 px and inside the limits, nearest first. Same-team characters are never targeted. Humans are targeted only when TargetHumans is on and they're not on the friendly team. Monsters are targeted if TargetMonsters is on.
- **Fires** when the aim error is within 10° (coilgun) or 30° (chaingun), and a ray from the turret centre hits the target first.
  - A **friendly diver who is first in the line blocks the shot**.
  - The ray is cached for 0.5 s and ignores the muzzle offset and chaingun spread, so it's not perfect.
- No lead: it aims at the target's current position.

**Periscope:**
- `position_out`: degrees in the same convention, measured from the turret pivot, every frame while someone holds the periscope.
- `trigger_out`: "1" every frame while the fire key is held.

## 9. Creatures (Content/Characters)
| | Swim speed | Health | Attack |
|---|---|---|---|
| Human diver | 1.5 m/s (2.5 sprinting); diving suit ×1, abyss suit ×0.8 | 100 | — |
| Crawler | 4 m/s (8 fast) | 80 | Bite range 150 px, every 3 s, 12 damage + bleeding. Flees below 10 HP. |
| Mudraptor | 2.5 m/s (6.5 fast) | 150 | Armour plates take ×0.1. Bite range 100 px, every 3 s, 30 damage. Never flees. |

- Monsters see roughly 250–1000 px. Firing a coilgun makes noise heard up to 8000 px.

## 10. Docking port (Items/Components/DockingPort.cs)
**Outputs:**
- `state_out`, every frame: "1" when locked.
- `proximity_sensor`, every frame while undocked: "1" when a matching port is within 200×64 (port) or 64×200 (hatch).
- `on_dock` / `on_undock`: "1" once.

**Inputs:**
- `toggle`: any value other than "0" flips the docked state.
- `set_state`: a value other than "0" means docked.

Both have a 0.1 s cooldown. Docking pulls the subs together for up to 1 s, then locks.
