# Camel Overkill

The vanilla Camel, rewired by Claude with the sub editor (`sim/subedit.js`), on purpose far more complicated than it needs to be. The hull, rooms and the reactor's max output (5000 kW) are untouched. Everything electrical was redesigned:
- **19 circuit boxes;**
- **6 batteries** (4 new);
- **a sensor network of 24 detectors;**
- **a terminal operating system with a radio-chat interface.**

- **Sub file:** `ships/custom/Camel_Overkill.sub`. A ready mod folder is `ships/custom/Camel Overkill/` (copy it into `Barotrauma/LocalMods/`).
- **How it's built:** `ships/patches/camel_overkill.gen.js` writes `camel_overkill.subpatch`; `node sim/cli.js sub patch Camel camel_overkill` applies it.
- **The circuits:** `circuits/camel/*.circ`. Each box also carries HOW IT WORKS and WIRING notes you can read in game.

## The humps (systems)
| Box | Where | What it does |
|---|---|---|
| **HUMP-1 Reactor brain** (`camel_reactor`) | reactor room | Feed-forward reactor control: turbine = setpoint / 5000; fission holds 50 °. Sends reactor kW, load and temperature on wifi. |
| **HUMP-P Power manager** (`camel_propulsion`) | engine room | **Propulsion bus:** 4 new batteries power only the large engine and the two ballast pumps, so throttle spikes never reach the reactor. All battery charging (propulsion and the 2 vanilla "critical" batteries for nav and guns) flows through a measured CHARGE TAP relay and only takes the reactor's surplus. The reactor setpoint is the main demand plus what the banks want (propulsion ~80 %, critical full). Equal 50 kW-step charging, with the remainder rotating between batteries every 30 s. |
| **HUMP-R Rate distributor** (`camel_rates`) | engine room | Second half of the power manager (a box holds at most 64 parts): turns the charging shares into battery rates. |
| **HUMP-2 Governor** (`camel_governor`) | power room | **Oxygen generator on a relay**: on below 85 %, off above 97 % (2 oxygen detectors). It warns the reactor 5 s before switching it on. **Load shedding**: fabricator, deconstructor and suit lockers are cut when the propulsion batteries drop below 20 %. |
| **HUMP-3 Alert core** (`camel_alert`) | bridge | GREEN / YELLOW / RED from the sensor network, reactor temperature, propulsion battery and oxygen. It drives the light colour of every main light, the siren (the bridge button now mutes it for 60 s), a mood display ("(O_O) PANICKING CAMEL") and radio announcements. |
| **Light show** (`camel_lightshow`) | bridge | Passes the alert colour to the lights, or a rainbow with `lights party`. |
| **HUMP-4 CamelOS** (`camel_os`) | bridge terminal | A terminal OS. Every line goes onto a command bus that all systems listen to. It also answers commands typed in **headset radio chat** that start with `camel `. |
| **Door brains** ×9 (`camel_door`) | at each auto door/hatch | Open for people (motion set to humans), close 3 s after they leave. A flood on either side blocks auto-open and closes the door once (it can still be opened by hand). `lockdown` seals them all. |
| **Spittoon** (`camel_ballast`) | bridge | Between the nav terminal and the ballast pumps. `spit` blows the tanks for 10 s. |
| **Sensor network** | 12 rooms | A water and a smoke detector per room that transmit the room's name (wifi 7400/7401) only while wet or smoky. |
| **Alert lighting** | 11 main lights | A wifi receiver on each light takes its colour from the alert core (7303). |
| **Status displays** | bridge, reactor room, engine room, medbay | The live status line: `PWR 1779kW LOAD 1784kW \| PROP 80% \| O2 98% gen:0 shed:0 \| ALERT GREEN`. |
| **Second chaingun** | the empty top hardpoint | It replaced the hardpoint, with its own periscope, loader and supercapacitor. |
| **Bilge pumps** | workshop, medbay, power room, bridge | Small pumps run by the room's water detector, on their own junction box. |

## CamelOS commands
Type them at the bridge terminal, or in radio chat as `camel <command>`.

| Command | Effect |
|---|---|
| `help` | list the commands |
| `status` | the live status line |
| `alert red` / `yellow` / `green` / `auto` | force the alert level, or go back to automatic |
| `lockdown` / `unlock` | seal every door / release them |
| `o2 on` / `o2 auto` | force the oxygen generator on / back to automatic |
| `shed on` / `off` / `auto` | load shedding |
| `spit` | blow the ballast tanks for 10 s (the camel rises) |
| `lights party` / `normal` | rainbow lights |
| `say <text>` | post `[CamelOS] <text>` to radio chat |
| `hump`, `whoami` | important |

## Wifi channel map
| Channel | Use |
|---|---|
| 0 | Radio chat (announcements out, `camel ...` commands in) |
| 7201 / 7202 / 7203 / 7204 / 7205 | O2 % / propulsion charge % / O2 generator state / shedding / alert name |
| 7206 / 7207 / 7208 / 7209 | Reactor kW / reactor load / temperature / propulsion low |
| 7210 / 7211 / 7212 / 7213 | Status line / propulsion kW / O2 pre-warning / O2 relay command |
| 7300 | CamelOS command bus |
| 7303 / 7304 / 7305 | Light colour (to the lights) / mood text / alert colour (to the light show) |
| 7400 / 7401 | Flood / fire room names |

## Mock results (20 min practice round, fights, a breach in the medbay at 10:00, a fire on the bridge at 13:20)
| | Vanilla Camel (crew automatic reactor) | Camel Overkill |
|---|---|---|
| Unmet demand | 5.1 % | **0.08 %** |
| Brownout / overvoltage | 125 s / 142 s | **0.2 s / 3 s** |
| Junction-box overload (> 2 V) | 21 s | **0 s** |
| Fuel | 1.38 rods | **1.14 rods (−17 %)** |
| Oxygen generator running | 100 % of the time | **10 %** (oxygen never below 84 %) |

The oxygen model is an approximation (one value for the whole sub; crew use and generator rate are guesses). The logger can measure the real numbers.

## Round 1 fixes
- **Wifi on the floor:** the wifi template was saved unattached, so 42 wifi components and their wires fell. Every placed item is now attached.
- **Circuit box errors in the console:** two boxes were over the game's 64-component limit (alert core 68, power manager 84). The lost parts were the ones that set the battery rates, so the batteries charged at their saved speed and the main bus sat at 0.4 V. Both boxes are split now; the editor refuses boxes over 64.

## Testing it in game (please report back)
1. **Install and open it.** Copy `ships/custom/Camel Overkill/` into `Barotrauma/LocalMods/`, enable it, and **open it in the sub editor first**. If it doesn't load, send the error. Keep your original Camel.
2. **Reactor: turn automatic control OFF.** The game doesn't save AutoTemp, so HUMP-1 only takes over once it's off.
3. **Watch power.**
   - Throttle hard: the engine runs from the propulsion batteries (engine room). The main bus should stay at ~1.0 V.
   - Check the status displays and `status`.
4. **Oxygen.** After a minute the O2 generator should switch off (gen:0) and come back below 85 %.
   - If air gets bad, type `o2 on`.
   - **I can't predict the real drain rate.**
5. **Doors.**
   - Walk up to doors (they open for humans only). Type `lockdown`, then `unlock`.
   - Flood a room (or wait for a breach): its doors should close once, and crew can still open them by hand.
6. **Radio.**
   - Does `[CamelOS] ALERT GREEN | flood: none | fire: none` appear in radio chat at round start?
   - Type `camel status` in radio chat on channel 0.
   - If nothing appears, LinkToChat may not survive loading: check the bridge wifi components in the editor.
7. **Alert.** Breach or fire → RED: siren, red lights, PANICKING CAMEL, and a radio announcement. The bridge button mutes the siren for 60 s.
8. **Weapons.** The new top chaingun has a periscope on the bridge (where the blank one was) and a loader next to the other loaders.
9. **Run the logger mod** and send the round folder, so the next version can use the real numbers.

## Known risks (not testable in the mock)
- **Untested placements:** new item positions were chosen from the room boxes. Something may sit oddly, overlap, or be unreachable. Moving it in the editor is safe; wires follow.
- **No physics, water or pathing in the mock:**
  - pump flow, real oxygen levels and bot behaviour are untested;
  - motion detector ranges are unchanged from vanilla.
- **Item templates came from other subs** (wifi, terminal, displays, oxygen detectors). If the game version changed one of them, the editor may complain.
- **Five-wire limit:** the charge-bus junction box in the engine room holds 6 power wires. Loading accepts that; you just can't add more there by hand.
