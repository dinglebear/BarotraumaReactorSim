# Camel Overkill

The vanilla Camel with all of its electrical systems redesigned and rewired by Claude (Anthropic), using this repo's sub editor. It is deliberately, comedically over-engineered. The hull, the rooms and the reactor's max output (5000 kW) are untouched.
- **Concept, in-game testing and bug reports:** Dinglebear ("Dingle").
- **The auto reactor and power system are Claude's own design** (`circuits/camel/camel_reactor.circ`, `camel_propulsion.circ`, `camel_rates.circ`). They are not a copy of any community circuit.

**Contents:**
- 38 circuit boxes (36 new);
- 6 batteries (4 new);
- 38 new sensors (water, smoke and oxygen in every room);
- 43 wifi components;
- a terminal OS with settings, a fun pack and a radio-chat interface.

**Files:**
- `ships/custom/Camel_Overkill.sub`, plus a ready mod folder `ships/custom/Camel Overkill/` (copy it into `Barotrauma/LocalMods/`).
- Built by `ships/patches/camel_overkill.gen.js`: run `node ships/patches/camel_overkill.gen.js && node sim/cli.js sub patch Camel camel_overkill`. The patch step also refreshes the mod folder and audits the result.
- Circuits: `circuits/camel/*.circ`. Every box carries HOW IT WORKS and WIRING notes you can read in game.

## The boxes
| Box | Where | What it does |
|---|---|---|
| **HUMP-1 Reactor brain** (`camel_reactor`) | reactor room | Feed-forward reactor control: turbine = setpoint / 5000, and fission holds 50 °. Sends reactor kW, load and temperature on wifi. |
| **Screen wall: DASH-1/2/3** (`camel_dash_reactor`, `camel_dash_fuel`, `camel_dash_ship`) | reactor room | 13 text displays. **Reactor:** output and percentage of max, core temperature coloured OPTIMAL/COLD/HOT, fission and turbine, a 10-step output bar. **Fuel:** rod count and type, fuel %, **time left at the current burn**, rods per hour, kWh made this round, kWh per rod. **Ship:** propulsion battery minutes at this throttle, rooms short of air, round clock, a message ticker. The fuel math is the game's own (rod drain = fission % × 0.2 / 100 per s); the prediction matched a real round (1.10 % predicted vs 1.1–1.2 % measured). |
| **HUMP-P Power manager** (`camel_propulsion`) | engine room | Propulsion bus: 4 batteries power only the engine and the ballast pumps. All charging goes through a measured CHARGE TAP relay and only takes the reactor's surplus. Reactor setpoint = main demand + what the banks want. The propulsion target is 80 %, editable with `set battery N`. |
| **HUMP-R Rate distributor** (`camel_rates`) | engine room | Turns the charging shares into battery rates: equal 50 kW steps, with the remainder rotating between batteries so they stay level. |
| **HUMP-2 Governor** (`camel_governor`) | power room | Oxygen generator on a relay (MaxPower 2000). It switches ON when any room's air node reports low air and OFF when no room has been below the high threshold for 10 s. It warns the reactor 5 s before switching on. Also load shedding. |
| **Air nodes** ×12 (`camel_airnode`) | every room | The room's oxygen detector → transmits the room name on 7402 below the low threshold and on 7403 below the high one. |
| **HUMP-3 Alert core** (`camel_alert`) | bridge | GREEN / YELLOW / RED from the sensor network, the reactor, the batteries and oxygen. Drives the light colour, the siren (the bridge button mutes it for 60 s) and the mood display. `alerts off` / `siren off` turn it down. |
| **Herald** (`camel_herald`) | bridge | Radio announcements, only when the alert level changes. `announce off` silences it. |
| **Light show** (`camel_lightshow`) | bridge | Alert colour → every main light, or a rainbow with `lights party`. |
| **HUMP-4 CamelOS core** (`camel_os`) | bridge terminal | Command bus, status line, ship commands and the unknown-command catcher. Also takes `camel <command>` from radio chat. |
| **HUMP-5 Control panel** (`camel_settings`) | bridge | Settings stored in memories and broadcast to the boxes that use them. |
| **HUMP-6 Fun pack** (`camel_fun`) | bridge | Jokes, the 8-ball, uptime and other important features. |
| **Door brains** ×9 (`camel_door`) | at each auto door/hatch | Open for humans, close 3 s after. Flood interlock (water held 5 s against sloshing). `lockdown` seals them; `doors auto off` stops auto-opening. |
| **Spittoon** (`camel_ballast`) | bridge | `spit` blows the ballast for 10 s. |

Also new:
- 12 room sensor nodes (water + smoke, transmitting the room name);
- a wifi receiver on all 11 main lights;
- 4 status displays;
- a mood display;
- a second chaingun on the empty hardpoint (own periscope, loader and supercapacitor);
- 4 bilge pumps;
- the nav terminal's spare buttons are now **BATTLE STATIONS** (`alert red`) and **ALL CLEAR** (`alert auto`).

## CamelOS 2.0 commands
At the bridge terminal, or `camel <command>` in radio chat (channel 0).

| Group | Commands |
|---|---|
| Ship | `status`, `alert red\|yellow\|green\|auto`, `lockdown`, `unlock`, `spit`, `o2 on\|auto`, `shed on\|off\|auto`, `lights party\|normal`, `say <text>` |
| Settings | `settings` (shows them all), `set o2 low N` (85), `set o2 high N` (97), `set battery N` (80, kept 20–95), `alerts on\|off`, `siren on\|off`, `announce on\|off`, `doors auto on\|off` |
| Fun | `help fun`, `lights claude`, `ping`, `joke`, `8ball <question>`, `pet`, `feed`, `coffee`, `dance`, `weather`, `uptime`, `hump`, `whoami`, `credits`, `sudo ...`, `rm ...`, `moo`, `hello` |

**To add a command:**
1. Put a regex on the bus (7300) in any box and send its answer to the reply bus (7310).
2. Add the word to `un` (the unknown-command regex) in `camel_os.circ`.
3. Add it to the help text.

There are also a few commands that aren't in any help text, a room that doesn't like visitors, and notes inside some boxes. Read the boxes.

## Wifi channel map
| Channel | Use |
|---|---|
| 0 | Radio chat (announcements out, `camel ...` in) |
| 7201–7213 | Telemetry: O2 %, propulsion %, generator, shedding, alert name, reactor kW, load, temperature, propulsion low, status line, propulsion kW, O2 pre-warning, O2 relay command |
| 7300 / 7310 | CamelOS command bus / reply bus |
| 7303 / 7304 / 7305 | Light colour (to the lights) / mood text / alert colour (to the light show) |
| 7400 / 7401 | Flood / fire room names |
| 7402 / 7403 | Rooms needing air / rooms not yet full |
| 7405–7411 | Settings: O2 low, O2 high, battery target, alerts, siren, announce, doors auto |

## Mock results (20 min practice round, fights, a breach in the medbay at 10:00, a fire on the bridge at 13:20)
| | Vanilla Camel (crew automatic reactor) | Camel Overkill |
|---|---|---|
| Unmet demand | 5.1 % | **0.08 %** |
| Brownout / overvoltage | 125 s / 142 s | **0.2 s / 3 s** |
| Junction-box overload (> 2 V) | 21 s | **0 s** |
| Fuel | 1.38 rods | **1.14 rods (−17 %)** |
| Oxygen generator running | 100 % of the time | **~10 %** (oxygen never below 84 %) |

In game (Dinglebear's round 3, the 90 s that were logged), the main bus voltage stayed between 0.95 and 1.05 for 99.3 % of the time, and it could not be made to stall under a throttle stress test.

## Fix history
- **Round 1:**
  - Wifi components fell to the floor: the template was saved unattached. The editor now attaches every placed item.
  - Two circuit boxes were over the game's 64-component limit, so their extra parts were lost on load. The boxes were split, and the editor refuses oversized boxes.
- **Round 3:**
  - Chat spam during floods, and doors flapping in sloshing water: added hold timers, and the radio now speaks on level changes only.
  - Screens and sensors sat inside floors: the editor now moves new fittings out of solid structure.
- **Round 5:** reactor screen wall (13 displays: fuel time left, burn rate, efficiency, battery time, air, clock, ticker), easter eggs, Claude's room.
- **Round 4:**
  - Oxygen: the governor only watched 2 rooms. Every room now has an air node, and the generator relay has headroom (MaxPower 2000).
  - CamelOS 2.0: settings, fun pack, reply bus; the nav terminal's buttons are wired.
  - The engine was checked: its position is identical to the vanilla Camel. Its propeller always overhangs the stern.
  - New `sub audit` tool.

- **Round 6 (walls):** the editor now knows each wall's real collision shape (`sim/shellgeom.js`). It found that the light, motion detector and circuit box in Claude's nook sat partly inside the hump's slanted shell. They moved into the nook. Three screen-wall displays also moved into the spots they were meant to have, which the old box-shaped check had wrongly blocked.

## Testing it in game
1. Turn the reactor's **automatic control OFF**. The game doesn't save that switch.
2. Throttle hard: the main bus should stay at ~1.0 V (`status`).
3. Oxygen: the generator runs when any room drops below 85 % and stops once every room is above 97 % (`gen:` in the status line). If air gets bad anyway, use `o2 on` or `set o2 low 90`.
4. Doors: try `lockdown`, `unlock` and `doors auto off`. Flood a room.
5. Radio: `camel status` on channel 0. Announcements come on alert level changes.
6. Nav terminal: BATTLE STATIONS / ALL CLEAR buttons.
7. Run the logger mod and send the round folder.

## Known risks
- **Item placement:** positions were chosen by the editor and audited against walls, but an item may still sit awkwardly. Moving it in the editor is safe.
- **What the mock doesn't model:** water physics, crew pathing and per-room air are approximate there.
- **The 5-wire limit:** the charge-bus junction box in the engine room holds 6 power wires. That loads fine, but you can't add more by hand.
