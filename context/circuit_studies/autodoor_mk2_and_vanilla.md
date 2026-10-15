> Study notes written by Claude from the netlists (`node sim/cli.js explain <file>`). The original files are not in this repo. "Smart Windowed-Auto Door MK-II" (LS/RS variants: same circuit, box on the left/right) is a community item assembly; the vanilla parts are from the Camel. Not tested in game.

# Auto doors: Smart Windowed-Auto Door MK-II, and the vanilla Camel's door, airlock and docking logic

## MK-II smart auto door (10 logic parts in one circuit box + 4 detectors + 4 lamps)
Parts outside the box:
- 1 motion detector above the door: `Target=Human RangeX=120 RangeY=100 DetectOffset=0,-100 UpdateInterval=0.1`, Output 1, FalseOutput 0.
- A smoke detector and a water detector on each side of the door. Each detector also drives its own small light (`IsOn=False`) as a local hazard indicator.

Inside the box:
- `hazard = OR(OR(smokeL, waterL), OR(smokeR, waterR))`: any smoke or water on either side.
- `relay6` (IsOn True) passes the motion signal (1/0 every tick) straight to door `set_state`, so the door opens while a person is in range and closes when they leave.
  - `relay6.set_state ← NOT(hazard)`: with a hazard, the relay blocks and motion no longer opens the door.
- Hazard edge close: `xor4(in1 = delay(hazard, 0.1 s), in2 = hazard)` with `Output="0" FalseOutput=""`. It sends one short "0" burst when the hazard starts or ends, so the door shuts once. Crew can still open it by hand during a hazard, because nothing keeps forcing it closed.
- Delayed close after people leave: `NOT(motion) → delay 4 s → AND(NOT(motion), delayed)` with `Output="0" FalseOutput=""`. It sends "0" only after 4 s with nobody there. This is a backup for the case where the relay is blocked.

Why it works:
- Signals of "" are never sent, so an `Output=""`/`FalseOutput=""` gate is silent in that state. Only the active path drives the door.
- The door takes the last `set_state` each tick, so only one path should speak at a time.

The Camel Overkill door brain (`circuits/camel/camel_door.circ`) is a re-design of this idea:
- the room water-sensor nodes instead of extra detectors;
- `OR TimeFrame=3` instead of the delay/AND pair;
- plus a lockdown latch from the CamelOS command bus that sends a steady "0".

## Vanilla Camel (what the stock sub does)
- **Auto-close doors:** door `set_state ← OR(TimeFrame=4, Output="", FalseOutput="0") ← motion detector (Target Any)`. With nobody around for 4 s the door gets "0" every tick (closed). While someone is there the OR sends nothing (Output ""), so the buttons work normally. It never auto-opens.
- **Airlock:**
  - Inner door and outer hatch interlock: `hatch.set_state ← NOT ← door.activate_out` and `door.set_state ← NOT ← hatch.activate_out`. Opening one closes the other.
  - The airlock pump runs `AND(water_%, NOT(hatch.state_out))`, so it pumps out only while the hatch is closed.
  - A buzzer is driven by a motion detector.
- **Docking box (9 parts):** the nav terminal's `toggle_docking` closes the inner hatch before undocking and opens it 0.6 s after docking. It uses `on_dock`/`on_undock` from the docking hatch.
- **Status box:** `greater(condition, 30)` for the pump, engine and O2 generator, and `greater(reactor power, 1)`, light four warning lamps on the bridge.
- **Ducts:** each duct block is driven straight from a water detector (open when wet, so water can drain).
- **Power:**
  - The reactor goes to JB112, then out to the junction-box tree.
  - Two batteries (2000 kW·min, 1000 kW out, 500 kW recharge) power only the nav terminal, status monitor and the supercapacitor (guns), so those keep working through a blackout.
  - Relays switch the light group and the two locker rows.
