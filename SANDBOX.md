# Circuit sandbox (for AIs and humans)

Test any circuit before it goes in a sub: several circuit boxes, loose components and pretend devices, wired together and run at 60 ticks a second on the same component engine as the bench and the sub mock. The components were checked line by line against the game's C# (see `reference/BAROTRAUMA_MECHANICS.md` §4).

- **Command line:** `node sim/cli.js sandbox <file>`. It looks in `sandbox/` and adds `.sbx` if you leave it off. It exits 1 if an `expect` fails or there is an unexpected error.
- **Web:** `web/sandbox.html` (linked from the bench header):
  - edit the script and press Ctrl+Enter;
  - press the buttons, drag the sliders, type into terminals, say things on the radio;
  - watch the boxes live: lit wires carry a value, and you can click a part for its settings and pin values;
  - the dashed red square is the box's 8192 × 8192 area.
- **From a real sub:** in the bench's Sub tab, click a circuit box, then **Open in the sandbox**. Its inputs become sliders and its outputs become probes.
- **Tests:** `node sim/test.js` runs every `sandbox/*.sbx` and requires all of them to pass.

## Script format (.sbx)
```
name <title>
dev <id> <type> [start value] [Prop=value]       pretend devices, see below
part <id> <component> [Prop=value]                a component outside any box (and, mem, regex, wifi, ...)
box <name>                                        a circuit box; .circ lines follow (c / w / note / label)
box <name> file=<path> [box=N] [KEY=value]        load a box from a .circ or Blueprints .txt file, filling $KEY
wire <a> <b> [<c> ...]                            world wires: dev.pin, part.pin, box.in1 / box.out2
at <t> press|set|toggle|type|say <target> [value] scripted input (say ch0 <text> = a crew member on the radio)
watch <endpoint> ...                              trace every change on these pins
expect <t> <target> = | != | > | < | ~ <value>    a check at time t (~ is a regex). Target: a device, a pin,
                                                  or a device state field (gun.shots, eng.force, p.target)
expectwarn <regex> / expecterror <regex>          this run must report a matching warning/error (pitfall demos)
run <seconds>
```
- Box pins are `in0..in9` / `out0..out9`. Current circuit boxes have 10 of each; use 1–8 for portability.
- Inside a box, `c` lines may set a position with `@x,y`. Anything past ±4096 gets pushed to the border, and the sandbox warns.

## Devices
| Type | Pins | Notes |
|---|---|---|
| button | signal_out | `press` sends Output ("1") once |
| switch | signal_out; toggle, set_state | a lever: sends On/Off every tick |
| const | signal_out | sends its value every tick (a slider) |
| terminal | signal_out; signal_in, clear_text | `type <text>` |
| light, display, probe | inputs | show state; a probe shows any signal and logs every change |
| door | state_out; toggle, set_state | |
| motion, water, smoke, oxygen | sensor outputs | `set <value>` (water %, oxygen %, 1/0) |
| periscope | position_out (angle in degrees), trigger_out | `set <deg>`, `press` fires once, `toggle` holds fire |
| turret | position_in, trigger_in, set_auto_operate, toggle_auto_operate | Reload=1 s; counts shots. Mounted on a vehicle it really aims and fires (see World) |
| engine | set_force | -100..100, **kept until the next signal** (Engine.cs): to stop an engine you must send 0 |
| pump | set_speed, set_targetlevel, set_active, toggle | set_targetlevel takes -100..100: level = (v + 100) / 2 % (what the nav terminal's velocity_y_out sends) |
| nav | velocity_x_out, velocity_y_out, current_velocity_x/y, current_position_x/y, toggle_docking; velocity_in | `set x,y` steers (y up); `press` = docking button. velocity_in "x,y" (y positive = down) applies at once |
| dock | state_out, proximity_sensor, on_dock, on_undock; toggle, set_state | `dev d dock 1` starts docked; `set 1` = a port is near |

## World: drones and vehicles (`sim/world.js`, the Drone Range page)
Add rock, a vehicle and characters, and mount devices on the vehicle with `On=<vehicle>`. Formulas and sources: `reference/VEHICLE_MECHANICS.md`.
```
world Top=0                                   # depth reference: current_position_y = (Top - y) / 100 m
rock x0,y0,x1,y1                              # a rectangle of rock (px, y up, 100 px = 1 m)
wall x,y x,y x,y ...                          # a convex polygon of rock
vehicle drone At=0,0 Size=300,150 Mass=1550 Volume=45000 [Tank=0.14 x Volume] [Water=7 % of Volume]
diver player At=0,0 Speed=150 Path="2500,300 3300,700" [Loop=true] [Team=enemy]
monster crawler1 Kind=crawler|mudraptor At=5600,-1100 [Sight=1000]
dev eng engine On=drone MaxForce=50           # 20 x MaxForce N at full thrust
dev bal pump On=drone MaxFlow=100             # fills the ballast tank; half full is neutral
dev nav nav On=drone                          # real velocity and position outputs, velocity_in
dev eye motion On=drone Offset=500,0 RangeX=200 RangeY=150 Target=Wall|Human|Monster [MinimumVelocity=0]
dev gun turret On=drone Offset=0,-60 Kind=coilgun MinAngle=0 MaxAngle=360 [AutoOperate=true] [TargetHumans=false]
at 20 pilot nav 1500,1000                     # a scripted pilot steers toward a point (no rock avoidance)
at 40 goto player 3000,0                      # a diver swims somewhere else
expect 60 drone.dist.player < 1500            # also drone.x .y .speed .depth .impacts .ballast, player.hp .alive, world.kills .friendly
```
What's modelled: buoyancy, quadratic drag and the engine force exactly as `SubmarineBody.cs` / `Engine.cs`; pumps as `Pump.cs`; rock collisions that stop the vehicle and count hits at 3 m/s or more as damage; motion detectors as axis-aligned boxes that see divers and monsters (with MinimumVelocity 0 they're presence detectors) and see rock only while the vehicle moves; coilgun/chaingun aim with the game's spring, reload, bolts at 60.8 m/s that stop at rock, auto-operate that never targets the crew and holds fire while a diver is first in the line; divers on paths; crawlers and mudraptors that chase and bite.
Not modelled: rotation (subs don't rotate in game either), power for the drone's devices, sonar, level generation (you draw the rock), other subs.

| File (`sandbox/world/`) | Shows |
|---|---|
| `drone_basics.sbx` | fly a drone by hand: top speed, the pilot's steering ramp, why hovering by hand is hard |
| `smart_return.sbx` | `circuits/challenges/smart_return.circ`: save a spot, drive off, come back around a pillar and a stalactite |
| `drone_escort.sbx` | `circuits/challenges/drone_escort.circ`: follow a diver, dodge rock, shoot two crawlers and a mudraptor, never the diver |

## What it reports
- **Errors:**
  - unknown parts or pins;
  - an invalid regex;
  - a box over 64 parts;
  - a node outside the box area.
- **Warnings (what has cost an in-game round before):**
  - an AND or arithmetic part with one input wired;
  - `\d` in a .circ regex;
  - an output that goes nowhere;
  - a wifi channel nobody listens to;
  - divide by zero (the game sends nothing);
  - a device that flickers;
  - **an input that got two different values in the same tick** (the game keeps whichever arrives last);
  - parts placed outside the box area;
  - signal chains so long that they spill into the next tick;
  - **a text display a player could never read to the end** (a long text that keeps changing; `reference/TEXT_DISPLAYS.md`).
- **Trace, device log, radio chat, final values, checks.**

## The example scripts (`sandbox/`)
| File | Shows |
|---|---|
| `latch_and_door.sbx` | two boxes and loose parts talking; why a relay can't force a door shut |
| `mini_os.sbx` | a terminal OS split over two boxes: command bus, reply bus, radio chat |
| `pitfalls.sbx` | every classic mistake, and the sandbox catching each one |
| `camel_door.sbx` | the real Camel Overkill door brain, loaded from its file: flood, lockdown, doors auto |
| `bike_aim_drive.sbx` | pre-plan for Dingle's bike: aim the periscope where you want to go, trigger shoots |
| `drone_remote.sbx` | pre-plan for drones: drive one from the mothership's nav terminal over wifi, with a slaved gun and a dock link |
| `claude_room.sbx` | pre-plan for Claude's Room in the new sub: riddle hatch and punishment roulette |
| `text_display.sbx` | the text display trap: a long changing text vs a short value with its own caption |
| `alarm_timer.sbx` | `circuits/challenges/alarm_timer.circ`: set 1:05, start, pause, resume, time's up |
| `dingle_countdown.sbx` | Dingle's countdown before and after zero padding (`1:9` vs `01:09`) |

## What it does not model
- **Power and machines:** power grids are left out (use `ship` for power), as are water physics, crew pathing and item damage.
- **Vehicles:** only when mounted on a `vehicle` (see World). Unmounted engines, pumps and turrets just record what they're told.
- **Wifi:** no range or teams.
- **Chat:** simplified; the rules are in BAROTRAUMA_MECHANICS §6.
