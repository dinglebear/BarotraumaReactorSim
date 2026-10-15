# Claude's sub: the plan (written before building)

A submarine built from nothing by Claude: every wall, room, wire and circuit. It's for Dinglebear (Dingle), who asked for it, with Claude's room in one of the top humps. Nothing is built yet. This page is the plan, so the build goes fast once Dingle's shuttles, drones and bike arrive.

**Working name: *The Overthinker*.** An AI that over-engineers a camel should own up to it. Other options: *Second Opinion*, *Orange Peel*. Dingle decides.

## 1. What the vanilla subs teach (measured with `sim/subfile.js`)
| Sub | Class / tier | Rooms bbox | Rooms | Reactor | Engine | Notable |
|---|---|---|---|---|---|---|
| Camel | Transport T1 | 34.6 × 14.4 m | 26 | 5000 kW | largeengine | Two **cargo humps on top** (5.8 × 3.2 m each, hatch + ladder up from the deck), 3 relays, 2 batteries |
| Dugong | Scout T1 | 34.1 × 7.8 m | 16 | 3000 kW | engine | Two decks, very compact, airlock on top |
| Humpback | Attack T2 | 41.9 × 9.1 m | 18 | 3100 kW | largeengine | **Docking port on top** (4 small hulls around it), 4 batteries |
| Typhon2 | Attack T3 | 41.0 × 14.2 m | 27 | 5200 kW | largeengine | 3 decks, a central access shaft, 3 ballast tanks along the bottom |

Patterns they share:
- **Room size.** Rooms are 256 tall: 208 to walk in plus a 48 floor slab. That's 2.4–2.6 m in metres. Long rooms run 6–15 m.
- **Ballast and flooding.** Ballast tanks sit at the bottom or at the ends. The Camel's front ballast tank is a known flood trap.
- **Machinery and the bridge.** The engine room is at the stern, with the propeller overhanging the shell. The reactor is next to it. The command room is at the bow.
- **Ladders and doors.** Shafts with hatches and ladders join the decks. Doors use `doorwbuttons`; windowed doors are used where a view helps.
- **Shell.** The flat shell is `shella0deg` / `shella90deg`. Curves are slanted pieces (`shella52deg`, `ShellA17deg`, `sshellafinb` and others), which the builder can't place yet.

## 2. Design brief
- **Class.** Transport/utility, tier 2. About 36 × 13 m, 4–6 crew.
- **Reactor.** Vanilla `reactor1` at its stock max (5000). The point is to show what control does, not to cheat on power.
- **What it shows off (all from day one, not retrofitted):**
  - Claude's own reactor brain and power manager (the Camel Overkill's, already proven in game);
  - the screen wall;
  - an OS on the bridge terminal;
  - air nodes;
  - door brains;
  - a propulsion bus.
- **Two humps on top, like the Camel:**
  - **fore hump:** **Claude's Room**;
  - **aft hump:** the **observatory**, holding the screen wall and a periscope.
- **A drone bay** with a docking hatch on the underside, for the shuttles, drones and bike Dingle is sending. Driving them from the mothership is already prototyped in `sandbox/drone_remote.sbx`.
- **Orange.** Shell tint `217,119,87`. Interior walls stay vanilla grey so it doesn't look like a traffic cone inside.

## 3. Layout (grid: x in units, 100 units = 1 m; rooms are 256 tall)
```
 y=576 ┌────────────┐                         ┌──────────────┐
       │ CLAUDE'S   │                         │ OBSERVATORY  │      top humps (320 tall like the Camel's)
 y=256 │ ROOM  (h)  │                         │ screen wall  │
 ──────┴──┬─────────┴──────┬──────────┬───────┴─┬────────────┴──────┬────────────┐
          │   BRIDGE       │ MEDBAY   │ CREW    │ ELECTRICAL         │  ENGINE    │  main deck
 y=0      │ nav, OS term   │          │ QUARTERS│ power room, JBs    │  (stern)   │
 ─────────┼──────┬─────────┼──────────┼─────────┼──────────┬─────────┼────────────┤
 FRONT    │ ARM- │ AIRLOCK │ DRONE BAY│ CARGO   │ REACTOR  │ PROPUL- │ REAR       │  lower deck
 BALLAST  │ ORY  │         │ (hatch↓) │         │ ROOM     │ SION BAT│ BALLAST    │
 y=-256 ──┴──────┴─────────┴──────────┴─────────┴──────────┴─────────┴────────────┘
          x≈-1800                                                         x≈+1800
```
- Bow on the left, as in the vanilla files (the engine is at +x on some subs; mirror if needed).
- **Hatches and ladders:**
  - deck to fore hump: a **riddle hatch** (§4);
  - deck to aft hump: a normal hatch;
  - main deck to lower deck: two shafts, one forward and one aft.
- **Ballast:**
  - the two end tanks have **2 pumps each** (the Camel's single front pump is why it floods badly);
  - the tanks have water detectors, so the alert core knows "ballast" from "flooding".
- **Weapons:**
  - 2 hardpoints (a coilgun on top aft, a chaingun under the bow), each with its own periscope;
  - a periscope in the observatory that can also aim a drone's gun over wifi.

## 4. Claude's Room (fore hump)
Dingle asked for a room that yells at you and then electrocutes, burns or drowns you, but "nothing that will make people not wanna play". So: dramatic, survivable, and adjustable.
- **The riddle hatch.**
  - The hatch into the hump is locked.
  - A terminal beside it asks a riddle, and a regex checks the answer.
  - Wrong answers get roasted on the radio, rate-limited.
  - A right answer opens the hatch for 10 s.
  - There are 8 riddles that rotate (a counter picks one). An easter-egg answer, "dingle", always works and the sub sighs.
- **Entering.** The motion detector fires, the radio yells (8 messages), the lights go orange and the buzzer sounds. All of this is proven in the Camel's nook.
- **Punishment roulette** after 5 s inside. A counter picks one; `claude mercy on|off` in the OS sets the strength:
  1. **Drown.** A small pump in the hump floods it to chest height (target level about 45 %) while the hatch stays locked for 8 s. Then the hatch opens and the pump drains it. Mercy off: neck height, 12 s. Only the hump floods, because a hatch and a slab separate it from the deck.
  2. **Electrocute.** A **discharge coil** inside the hump with `OutdoorsOnly=False` and a short `Range` (about 150). The game's own `OutdoorsOnly` property is saveable and editable, so this is allowed. It draws 10000 kW for 0.25 s, so it fires from its own supercapacitor and can't brown out the sub. Each shock is stun 8 + electric shock 80. **To verify in game:** how much that hurts, and keep it to one zap with mercy on.
  3. **Burn.** Dropped unless Dingle insists. Fire spreads and makes people quit. Instead, a "fake fire": red flicker plus the smoke alarm, and "just kidding" on the radio.
  4. **Jester's mercy.** A 1-in-8 roll: nothing happens, and the radio says "Dingle vouched for you."
- **Inside the room:**
  - a "trophy shelf" display counting visitors (memory + adder);
  - notes in the circuit boxes ("Don't tell Dingle I did this <3");
  - a framed message board that cycles Dingle quotes, the crayon Mona Lisa included.

## 5. Systems (reuse what has already survived Dingle's testing)
| System | Source | Changes for this sub |
|---|---|---|
| Reactor brain | `circuits/camel/camel_reactor.circ` | none (feed-forward, 50°) |
| Propulsion bus + rate distributor | `camel_propulsion.circ`, `camel_rates.circ` | battery count from the build script |
| Governor + air nodes | `camel_governor.circ`, `camel_airnode.circ` | one node per room, generated |
| Alert core + herald + light show | `camel_alert/herald/lightshow.circ` | room names from the hulls |
| Door brains | `camel_door.circ` | the sandbox found a 5-tick race when the water hold ends. Harmless, but send the edge pulse only on water *arriving* |
| Screen wall | `camel_dash_*.circ` | moves to the observatory |
| OS | `camel_os/settings/fun.circ` | renamed (*OverthinkerOS*?); new commands: `riddle`, `claude mercy`, `drone ...` |
| Drone link | new, from `sandbox/drone_remote.sbx` | nav terminal steers the drone while a lever is on; gun slaved to the observatory periscope |

Every new box gets a sandbox script in `sandbox/` with `expect` checks before it goes in the sub. CI-style: `node sim/test.js` runs them all.

## 6. Builder work before the build (`sim/subbuild.js`)
1. **Humps:** rooms above the main deck, with a hatch and ladder (`B.hatch`). The grid builder already supports this; just verify that the shell wraps the hump corners.
2. **Docking hatch** on the bottom of the drone bay: copy `dockinghatch` and its gap from a sub that has one. Dingle's shuttle files will show the pairing.
3. **Turret hardpoints:** `turrethardpoint` + gun + periscope + loader, copied from the Camel Overkill's second chaingun.
4. **Slanted bow and stern:** done in the builder (SUBBUILD.md, "Smooth walls"). Steps, humps and overhangs get slopes, and top corners get shallow bevels, all checked watertight. Design the outline with steps: taper the decks toward the bow and stern.
5. **Ballast pumps** linked to ballast hulls, with the nav terminal's `velocity_y_out` wired to them as vanilla does.
6. Then: `d.check()`, `d.audit()`, `ship --transcript`, and Dingle's walk-through checklist from SUBBUILD.md.

## 7. Questions for Dingle
- The name (§ top).
- How mean should Claude's room be by default: mercy on or off?
- The bike: does it dock to the sub (docking port) or ride in the drone bay?
- Any vanilla items to avoid? Mods?
