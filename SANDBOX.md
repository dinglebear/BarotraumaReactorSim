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
| turret | position_in, trigger_in | Reload=1 s; counts shots |
| engine | set_force | -100..100; with no signal for 0.1 s it falls back to its manual setting |
| pump | set_speed, set_targetlevel, set_active, toggle | |
| nav | velocity_x_out, velocity_y_out (= -y), toggle_docking | `set x,y` steers; `press` = docking button |
| dock | state_out, proximity_sensor, on_dock, on_undock; toggle, set_state | `dev d dock 1` starts docked; `set 1` = a port is near |

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
  - signal chains so long that they spill into the next tick.
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

## What it does not model
- **Power and machines:** power grids are left out (use `ship` for power), as are water physics, crew pathing and item damage.
- **Vehicles:** engines, pumps and turrets record what they're told. Nothing moves.
- **Wifi:** no range or teams.
- **Chat:** simplified; the rules are in BAROTRAUMA_MECHANICS §6.
