> Study notes written by Claude from the netlist of the community files (`node sim/cli.js explain <file>`), to learn how they work. The original files are not in this repo. [VH] The Iroh by its author (vanilla items only). Behaviour described from reading the wiring against reference/BAROTRAUMA_MECHANICS.md; not tested in game unless stated.

# [VH] The Iroh: circuit study notes

Source: `/tmp/claude-0/exp/_VH__The_Iroh.sub.txt` (explain netlist), raw `/tmp/claude-0/ex/Examples/[VH] The Iroh.sub`.
Sub facts: Scout class, tier 3, game version 1.2.7.0, 5751x2465, crew 3–6, price 25999. The tagline "Per aspera, ad astra" is also written on in-world labels.

## Mods / non-vanilla
- `requiredcontentpackages=""`, so the sub is **vanilla**. "VH" is the author's tag; it shows up as in-world labels, not as a mod.
- Every identifier in the netlist is a vanilla item (`op_*`, `opdeco_*`, `banditprop*` and `shop_decoration*` are vanilla outpost decorations). The only one I could not confirm is `pulselaserammoboxtrilaser`, a pulse-laser ammo variant; check it if you need strict vanilla.
- **Item properties edited in the sub editor** (needed if you want to reproduce the behaviour):
  - reactor1: MaxPowerOutput **6500** (vanilla 5000), AutoTemp=True. No reactor control circuit exists.
  - battery#933 and #945 (engine buffers): Capacity 1500, MaxOutPut 1500, MaxRechargeSpeed 1500.
  - battery#27 (reserve): Capacity **10000**, MaxOutPut 4000, MaxRecharge 500.
  - shuttlebattery#692 (safe room): vanilla 2000/1000, RechargeSpeed 500.
  - supercapacitor#801/#802: MaxRecharge 500, RechargeSpeed 250. #803: 100/50. #2534 (discharge coil): Capacity **90**, MaxRecharge 1000, RechargeSpeed 500.
  - largeengine: MaxForce 740, PowerConsumption 3000. Ballast pumps: MaxFlow 500, 300 kW. Small pumps: MaxFlow 300, 180 kW.
  - Steering NeutralBallastLevel 0.3768.
- **Switch/lever trick:** every lever or switch wired to a `toggle` pin has `IsToggle="False"` (momentary, so it acts like a button and sends once per press). Switches wired to `set_state`/`set_active` have `IsToggle="True"` (latched, continuous output). A latched switch on a `toggle` pin would flip the relay every tick, so you must copy this setting.
- There is a stash of spare parts, 8 of each logic component (relay, and, or, xor, delay, greater, memory, signalcheck, subtract, adder, oscillator) plus 8 wifi, inside a cabinet at (-1257,147). A loose, empty `circuitbox` item sits next to it. They are unwired supplies, not circuits.
- Adder pairs #2955–#2975 sit outside the hull with wires running out→out. They do nothing as logic. They are **decorative cables**: wires strung between hidden dummy components.

---

## 1. Power distribution (≈16 JB + ≈20 relays)
- reactor1#115 → **JB#211** (reactor junction). JB#211 → JB#219, JB#220, JB#221 and relay#3114 (docking power).
- The main grid is a 2×6 mesh of junction boxes (#94–#104 and #770, at y=153 and y=252, labelled "Electrical"). Each JB is linked to its neighbours, so the grid has redundant paths and one destroyed JB does not black out the sub.
- **Every JB and relay power pin carries at most 5 wires.** The designer works around the 5-wires-per-connection cap with **relay fan-out trees**:
  - Oxygen and suit-locker power: JB#97 → relay#1005 ("Oxygen + Relay") → relay#959 (4 lockers/shelves) and relay#2476 → relays #806, #956, #957, #958, #960 → about 24 divingsuitlocker/oxygentankshelf2.
  - Small pumps: JB#101 → relay#2484 → 5 small pumps.
  - Deconstructors: JB#96 → relay#3475.
  - Searchlights: JB#98 → relay#20 → 5 searchlights. Exterior: JB#98 → relay#2904 → searchlight#2902 and a light.
  - Lighting: six relays in a row at (-2599…-2519, 34), labelled "Lights" with the floor legend "1 - 1 - 2 - 2 - 3 - 3" (two relays per floor): #886 and #16 (JB#219), #887 and #44 (JB#221), #45 and #613 (JB#220). They have no signal inputs. They work as per-floor breakers that split the grid, and an electrician can rewire them to a switch.
- **Why relays rather than JBs:** a relay is a small hidden part and passes power while IsOn=True (MaxPower 1000 kW, cannot overload). It splits the grid into input and output sides, which isolates faults.

## 2. Engine battery buffer (proportional recharge), ≈6 parts
- largeengine#17 power_in comes **only** from battery#933 power_out and battery#945 power_out. The engine never sits on the reactor grid.
- battery#933 power_in ← JB#94 and battery#945 power_in ← JB#770 (main grid).
- Rate control: memory#441 `Value="105"` → subtract#935/#946/#951 in1, with each battery's `charge_%` → in2, and the result → that battery's `set_rate`. So **rate% = 105 − charge%**.
  - In game, set_rate is clamp(v/100,0,1)·MaxRecharge, rounded to 10 % steps with banker's rounding. Charge 0–5 % gives 100 % rate (1500 kW). Charge 50 % gives 55 %, which rounds to 60 %. Charge 95 % gives 10 %. Charge 100 % gives 5 %, which rounds to 0.
- **Why it works:** the reactor never sees the engine's step changes, only recharge demand. That demand follows charge%, a slow integral of engine draw, so reactor load ramps gently and AutoTemp keeps up. At steady cruise the charge settles where recharge equals draw (a P-controller). Two 1500 kW·min batteries give about 1 minute of full 3000 kW thrust with no reactor at all.
- One memory constant feeds all three subtractors. The same 105−charge% rule also drives battery#27.

## 3. Reserve battery with manual charge/discharge (≈5 parts)
- battery#27 (10000 kW·min) has two relays:
  - relay#873 (IsOn=True): JB#100/#101/#103 → power_in, power_out → battery#27.power_in. This is the charge path.
  - relay#872 (IsOn=False): battery#27.power_out → power_in, power_out → JB#100/#101/#103. This is the discharge path.
- lever#875 (momentary) → relay#873.toggle and lightcomponent#1858.toggle (blue, BlinkFrequency 1, so it blinks while discharging).
- relay#873.state_out → signalcheck#2019 (Target 1, Output 0, FalseOutput 1) → relay#872.set_state. This is an **interlock**: exactly one path is ever closed, so the battery never charges from itself and stays a pure reserve until someone pulls the lever.
- Gotcha: in charge mode the battery output is disconnected, so it will **not** auto-backup a reactor scram. That is a deliberate manual design.

## 4. Safe room (independent battery island + lockdown blast doors)
- Note at (184,1): "All power to this room goes through its battery (Except for the suit lockers)".
- shuttlebattery#692: power_in ← JB#94. power_out → shuttleoxygenerator#691, smallpump#665 (manual), lightfluorescentl02#359 and statusmonitor#668. The room survives grid loss for a while.
- Lockdown: button#360 (inside) and button#3076 → relay#3139.toggle (IsOn=False, used purely as a T flip-flop). relay#3139.state_out → signalcheck#3136 (Target 1 → "0", else "1") → door#674 and door#688 set_state.
  - The doors are plain `door` with OpeningSpeed/ClosingSpeed **0.5** (slow blast doors) and IsOpen=True. They stay open by default and close on lockdown. Their hulls are named "Safety Door A" and "Safety Door B".
- **Pattern:** relay as flip-flop, then state_out → signalcheck inverter → continuously asserted set_state. Because the relay re-sends state every tick, the door always snaps back to the commanded state.

## 5. Automatic doors (four variants)

### 5a. Flood-aware auto door (7 instances: windoweddoor #142, #176, #338, #432, #1523, #1562, #1672), 12 parts each
Example for door#1523:
- motiondetector#1525: Target=Human, RangeX 115, RangeY 90, DetectOffset 0,-90, Output "1", FalseOutput "0", UpdateInterval 0.1. Its output goes to:
  - signalcheck#1533 (Target "0", Output "0", FalseOutput ""), then door.set_state. Nobody near → close. Someone near → send nothing.
  - relay#1527.signal_in1 (IsOn=True) → signal_out1 → door.set_state. This passes 1 (open) and 0 while enabled.
- Two waterdetectors, one on each side (#1524, #1526) → orcomponent#1529, which goes to:
  - relay#1528.set_state. This is the "manual" relay, IsOn=False: buttons #1535/#1534 → signal_in1/2 → signal_out1/2 → door.toggle. state_out → two lightcomponent90 (red, range 15, beside the buttons) as a "manual mode" indicator.
  - signalcheck#1530 (Target 1 → "0", else "1"), then relay#1527.set_state, which disables motion auto-open when water is present.
- Behaviour:
  - Dry: the door opens on approach and closes when you leave. The buttons are dead.
  - Water on either side: auto-open is disabled and the buttons go live. The red lights come on. The door still auto-closes when nobody is near, because the signalcheck path is never gated.
- Door settings: OpeningSpeed 6.5 (fast open), ClosingSpeed 3.

### 5b. Auto-close door with buttons (windoweddoorwbuttons #11, #246, #247, #1058, #3030)
- motiondetector (Human, e.g. RangeX 140, RangeY 80–100, offset ±60,-80/-100) with **Output="" FalseOutput="0"** → door.set_state.
- Someone in range sends nothing, so the door keeps whatever the buttons did. Nobody in range sends 0, so the door closes. This is a one-part auto-close.

### 5c. Hatch auto-close timer (hatchwbuttons #1520, #2058, #2073, #2081, #2089), 3 parts each
- hatch.state_out → signalcheck (Target "0", Output "0", FalseOutput "") → delay (**Delay 4, ResetWhenSignalReceived=True**) → hatch.set_state.
- While closed, the hatch sends "0" every tick and keeps resetting the delay, so nothing comes out. When someone opens it, the "0" stream stops and the last queued "0" fires 4 s later, closing the hatch.
- **Retriggerable timer:** a continuous stream into a reset-on-receive delay emits once, N s after the stream stops.
- signalcheck#310 and delay#306 are a loose, unwired copy of this.

### 5d. Artifact-hold hatch with hold-open switch (hatchwbuttons#1521)
- motiondetector#1728 (Output "", FalseOutput "0", RangeX 80, RangeY 180) → relay#3041.signal_in1 (IsOn=True) → hatch.set_state. This is an auto-close.
- switch#3043 (IsToggle=True) → relay#3042.set_state. state_out goes to:
  - signalcheck#3045 (T1→"0", else "1"), then relay#3041.set_state, which disables auto-close.
  - signalcheck#3047 (T1→"1", FalseOutput ""), then hatch.set_state 1, which holds the hatch open.
- dockinghatch#3202 sits at the same spot (a second docking port at the artifact hold). It is toggled directly by nav toggle_docking.

## 6. Docking sequencer (top port dockinghatch#2422 + inner hatch#2428), ≈7 parts
- navterminal#326.toggle_docking ("1" pulse) → and#2426.in1, and#2427.in1, and dockinghatch#3202.toggle.
- **Dock:** dockinghatch.state_out → not#2424 (ContinuousOutput=False) → and#2426.in2. and#2426 (FalseOutput "") → dockinghatch.set_state "1". The port is only told to dock when it is currently undocked.
- **Undock:** and#2427 has **Output="0"**, FalseOutput "". Its in2 is dockinghatch.state_out; a "0" there is ignored by the AND, so it only arms when docked. On a toggle_docking pulse while docked it sends "0" to three places:
  - straight to hatch#2428.set_state, which closes the inner hatch now
  - delay#2425 (0.6 s) → dockinghatch.set_state "0", which undocks after the hatch has started closing
  - delay#2423 (1 s, ResetWhenDifferent) → hatch set_state
- **Hatch follows dock:** dockinghatch.state_out → delay#2423 (1 s) → hatch#2428.set_state. The hatch opens 1 s after a good dock and closes on undock.
- Power: JB#211 → relay#3114 → both docking hatches' `power` (power transfer to the docked vessel). switch#3111 (IsToggle=True, default **off**, msg "Docking Hatch power transfer") → relay#3114.set_state.
- **Why:** the hatch closes before undocking and opens only after docking, so you cannot undock with the hatch open and flood the sub.

## 7. "Magnetic Shield" / flood system (relay#75 master), ≈40 parts
The "Magnetic Shield Room" is a group of hulls (#59, #60, #63, #64, #65, #88) along the lower stern. The circuit is labelled "Flood system", "SHIELD CONTROL" and "Authorized personnel only".
- Inputs: lever#19 (momentary, msg "Toggle Magnetic Shield") and navterminal#326 CustomInterface button 1 "Toggle Magnetic Shield" → relay#75.toggle (IsOn=False). relay#75 = 1 means **shield disabled / flooding**.
- relay#75.state_out fans out to four places:
  1. **Immediate alerts.** relay#1767 (IsOn=True, pure fan-out) → signal_out1 →
     - lightcomponent90 #1770 and #1792 set_state (red rotating lights, range 800, PulseFrequency 0.5)
     - emergencysiren#1866 set_state
     - signalcheck#1778 (T1→"0", else "1") → normal lamps #1793/#824 set_state (off while flooding) and relay#1771.set_state (disables the motion auto-close of door#399)
     - signalcheck#1861 (T1→"1", FalseOutput "") → windoweddoorwbuttons#399 set_state 1 (forced open while flooding)
  2. **Slow-on path (5 s warning).** delay#1777: Delay **5**, ResetWhenDifferentSignalReceived=True.
  3. **Fast-off path.** signalcheck#1902 (Target "0", Output "0", FalseOutput "") → delay#1903 (Delay **0.05**, ResetWhenDifferent).
  4. **Display.** signalcheck#2530 (T1 → "Magnetic Shield disabled", else " ") → textdisplay#2529 on the bridge.
- Both delay outputs (2 and 3) drive the same set of targets:
  - relay#1895.set_state → state_out → ductblocks #38, #1761, #1763, #1814 and #1816 set_state (open = flood)
  - signalcheck#1776 (T1→"0", else "1") → blue emergencylights #68–#72 (0,125,255)
  - signalcheck#1886 and #1885 (T1→"1", else "0") → red emergencylights #1879–#1884 (222,0,0), placed at the **same coordinates** as the blue ones, so the colour swaps
  - signalcheck#1868 (T1→"0", else "1") → smallpump#403 and #404 set_active and emergencylight#1809
- Drain pumps: waterdetector#1783 and #1769 with **Output="-100"**, FalseOutput "0" → smallpump set_speed. A pump pumps out at full speed whenever its detector is wet.
- **Why:** turning the flood ON gives a 5 s siren and rotating-light warning before the ducts open and the pumps stop. Turning it OFF closes the ducts and restarts the pumps within 0.05 s.
  - The trick is two delays fed by the same state. The "0" branch passes through a signalcheck that drops "1"s, so only the 0→ transition takes the short delay. ResetWhenDifferent on the long delay discards stale "1"s.

## 8. Ballast + "Ballast Flora mode" (relay#3028 master), ≈20 parts
- **Normal ballast:** navterminal#326.velocity_y_out → relay#911.signal_in1 (IsOn=True) → signal_out1 → five pumps (#34, #35, #36, #37, #500, all in the single ballast hull #180) set_targetlevel.
- **Flora mode** (instructions are on a wall label): lever#745 (momentary) or nav button 2 "Toggle B. Flora mode" → relay#3028.toggle (IsOn=False). state_out goes to both signal_in1 and signal_in2 of relay#2885, which is used only as a **fan-out** (5 wires per output). Its outputs:
  - out1 → signalcheck#2843 (T1→"0", else "1") → ballast lamps #712–#715 set_state, so normal lamps go off
  - out1 → signalcheck#2850 (T1→"1", else "0") → lightcomponent90 #2832–#2835 (red pulsing, same positions as the lamps)
  - out1 → signalcheck#2865 (T1→"0", else "1") → relay#911.set_state, which disconnects nav from the pumps
  - out1 → signalcheck#2866 (**Output "-100"**, FalseOutput "", T1) → all pumps set_speed −100 (pump out)
  - out1 → signalcheck#913 (T1→"1", FalseOutput "") → forces in1 of the ballast duct XORs (see §9)
  - out2 → relay#2877.set_state. relay#2877 passes waterdetector#2870.water_% → all pumps set_active. "0" means the tank is empty, so the pump stops.
  - out2 → signalcheck#2897 (T1 → "Ballast Flora Mode engaged", else " ") → textdisplay#2896 on the bridge
- **Exit re-arm:** relay#2877.state_out → signalcheck#2883 (T1→"1", FalseOutput "") → delay#2880 (Delay 2, **ResetWhenSignalReceived=True**) → pumps set_active.
  - While flora mode is on, the continuous "1" keeps resetting the delay. When it ends the stream stops, and one "1" fires 2 s later, switching all pumps back on.
  - This is the same retriggerable-timer trick as the hatch, used as a falling-edge one-shot.
- After flora mode ends, set_targetlevel from nav resumes and pumps return to auto ballast.
- Labels in-world: "Pumps ON/OFF", "Lamps ON/OFF", "Lights OFF/ON", "Ducts ON/OFF", "pumpspeed -100", "Nav signal_in".

## 9. Duct-block air/water logic (11 units + 2 variants), 5 parts each
Each unit sits on a floor with a ductblock between a lower hull L and an upper hull U. Example #1376 (Engine Room below, reactor room above):
- waterdetector A, in L near its **ceiling**: signal_out → xor.in1. It is wet only when L is nearly full.
- waterdetector B, in U: **water_%** → xor.in2. "0" is ignored by gates, so any water marks the input.
- oxygendetector in L → greater.in2. The threshold 60 → greater.in1. greater (FalseOutput "") → xor.in2 when O2 < 60.
- xor → ductblock.set_state.
- **Wired-OR on a gate input:** several sources are wired to the same xor.in2 pin. Logic gates ignore "0", so any non-zero source marks the pin.
- Truth table: duct open ⇔ (L nearly full) XOR (U has water OR L O2 < 60).
  - Normal state: closed.
  - U wet: open (drains down into L), unless L is already full.
  - L short of air: open (air comes in from above), unless L is full.
  - Both conditions: closed.
- Threshold source: memory#3254 `Value="60"` → relay#3253 signal_in1 and in2 → out1 to 5 greaters, out2 to 5 greaters. The relay is a fan-out, labelled "Mem shared between ducts". Two units use their own memory 60 (#1443 and #2031). Unit #1363 also has a second O2 detector in the command room on in2.
- Ballast-side units (#1444, #1481, #1494; L is the ballast tank, U is the mess hall, safe room or crew quarters): in flora mode signalcheck#913 forces in1=1, so the duct opens only while U is dry **and** ballast O2 ≥ 60. That keeps upper-room water away from crew working in the ballast.
- Variant AND (#2518, Safety Door A over cargo): and(in1 = A water_%, in2 = waterdetector#2515 with Output "0" and FalseOutput "1", i.e. "cargo dry") with FalseOutput "".
  - The duct opens to drain A into a dry cargo hold. **Gotcha:** with FalseOutput "" it never re-closes.
- Variant #2861 (Safety Door B over the ballast): xor(B water_%, ballast-full detector#2526 (Output 1, FalseOutput "") plus flora force).

## 10. Small utility pumps (≈15 parts)
- Auto-drain: waterdetector Output="-100", FalseOutput "0" → smallpump.set_speed. The pump pumps out whenever its detector is wet. A switch (IsToggle=True, "Turn the pump ON/OFF") → set_active enables it.
  - Instances: airlock #929/#925/#928, artifact room #1060/#1063/#1061, airlock #1735/#1733/#1734.
- Shield-room and cargo pumps #403/#404 get set_active from the shield logic (§7).

## 11. Weapons (4 periscopes + captain's multi-periscope), supercaps
- Supercaps on JB#104:
  - #801 → pulselaser#2502, chaingun#3025, largeturrethardpoint#3152
  - #802 → chaingun#3024, pulselaser#3026
  - #803 → pulselaser#3027 (cargo gun)
  - JB#95 → supercap#2534 → dischargecoil#2566
  - No rate control circuit. Fixed RechargeSpeed values were set in the editor.
- Gunnery compartment: periscopes #232, #234, #235 and #237 → turret position_in and trigger_in. They also feed **position_out → orcomponent (single input, defaults) → turret.set_light**.
  - The periscope sends position only while manned, so the OR outputs "1" while manned and "0" otherwise. **The turret light is on only while someone is aiming.**
  - The same pattern is used for the large turret hardpoint (blankperiscope#3340 → or#3316).
- Discharge coil triggers: nav#326 button 3 "Electrical Discharge Coil" and nav#2572 button 1 "Discharge Coil".
- Depth charges: nav#2572 button 2 "Deploy Depth Charge" → depthchargetube#1958.trigger_in.
- **Gotcha:** nav#2572 button 3 "Toggle External lights" is **not wired**. relay#2904 has no control.

## 12. Captain's periscope: searchlight channel cycler / cargo gun switch (≈20 parts)
- periscope#21 position_out and trigger_out → both relay#1966 and relay#1967 (signal_in1 and signal_in2).
- Mode select: switch#1980 (IsToggle=True, default ON, msg "Switch between the searchlights and the Cargo Room gun") → relay#1966.set_state. relay#1966.state_out → signalcheck#1510 (Target "0" → "1", else "0") → relay#1967.set_state. This is a complementary pair.
- **Gun mode** (relay#1967 on): out1/out2 → pulselaser#3027 position_in and trigger_in.
- **Searchlight mode** (relay#1966 on):
  - out1 (position) → wifi#1950 (transmitter). Its channel is set every tick by memory#1939 (initial Value "500") → set_channel.
  - out2 (trigger) → wifi#1951 on ch 400 → wifi#1949 on ch 400 → delay#1961 (Delay 0.2, **ResetWhenSignalReceived=True**, a debounce that emits one "1" 0.2 s after the trigger is released) → adder#1940.in2.
  - Counter: memory#1939 → adder#1940.in1. adder → memory#1939.signal_in, so each trigger press increments the channel by 1.
  - Wrap: adder → signalcheck#1944 (Target "505", **Output "500"**, FalseOutput "") → delay#1945 (0.05 s) → memory#1939. The delay makes the 500 land after the 505 write. Channel 505 is live for only 0.05 s and nobody listens on it.
  - Receivers: wifi ch 500→searchlight#2453, 501→#1836, 502→#2454, 503→#2459, 504→#2458 (position_in). Each receiver also → or (single input) → searchlight.set_light, so the selected light is on only while aimed.
- **Why:** one seat controls 5 searchlights around the hull. Pull the trigger to hop to the next light. Arithmetic components output only while both inputs are fresh, so the adder emits once per debounced press even though memory sends every tick.

## 13. Displays / status
- **Reactor online text:** reactor.power_value_out → orcomponent#2979 (Output "Online", FalseOutput " ") → relay#2981 (pass-through) → textdisplay#2977 at the reactor.
  - An OR treats "0" as unmarked, so it acts as a **nonzero detector**. It shows " " when the output is 0 and "Online" otherwise.
- **Meltdown warning:** reactor.meltdown_warning → signalcheck#2978 (T1 → "Reactor Meltdown", else " ") → textdisplay#117 on the bridge.
- **Bridge status texts:** shield (#2529), flora (#2896), meltdown (#117) and day counter (#2561), all near statusmonitor#8 and navterminal#326.
- **Gunners' tally:** memory#1981 (Value 0) feeds adder#1982.in1, subtract#1983.in1 and textdisplay#1984. button#1993 "+" → adder.in2. button#1994 "−" → subtract.in2 (**ClampMin 0**). Both results go back to memory. This is a persistent kill counter.
- **Day counter** (labelled "Day counter"): regex#3206 with Expression ".", Output "", FalseOutput "1", ContinuousOutput=True. Its signal_out → relay#3207.signal_in1 → signal_out1 → regex.signal_in (a feedback loop through a relay, because you cannot wire a part to itself). It also → adder#2560.in1, with in2 from memory#2559; the sum → memory#2559 → textdisplay#2561.
  - At round start the regex input is empty, "." does not match, and it sends "1". That "1" is fed back as its input and now matches, but Output "" sends nothing, so it goes silent for the rest of the round.
  - Net effect: **exactly +1 per round load**, and memory persists across campaign saves.
  - orcomponent#2558 (TF 0.1) nearby is unwired.
- statusmonitor#668 is in the safe room.

## 14. Bed name tags (terminal-driven), ≈25 parts
- terminal#2357 has saved help lines `msg0`/`msg1`, which are displayed in the terminal as instructions. signal_out → relay#2389 in1 and in2 (fan-out). out1 → 5 bed relays, out2 → 1 bed relay.
- Each bed has a relay (IsOn=False), whose signal_out1 → textdisplay.set_text ("Assignable bed"), plus a switch (IsToggle=False, momentary) that toggles both that relay and a green lightcomponent90 indicator (0,255,0).
- Usage: toggle the bed's switch (green light), type a name in the terminal, toggle it off. Every bed whose light is on receives the text.
- **Pattern:** a selectable broadcast. A terminal fans out through gated relays and the relay state picks the targets.

## 15. Chaser / warning light strip (≈20 parts)
- oscillator#254 (Square, 0.5 Hz) → relay#366.signal_in1. switch#370 (momentary) → relay#366.toggle.
- relay out1 → delay#249 (0.2 s), #258 (0.4), #363 (0.6), #365 (0.8). Each delay drives 3 emergencylights (IsOn=False, blue, range 10). The square wave **sweeps across 4 groups in 0.2 s steps**, which gives a running-light effect.
- Clean-up pulse: switch#370 also → delay#1744 (0.2) → signalcheck#1738 (Target "1", **Output "0"**, FalseOutput "") → all four delays. Every press queues a "0" behind the wave, so when the chaser is toggled off every group ends dark.

## 16. Misc
- Oxygen generator, fabricators, medical fabricator and deconstructors are plainly powered.
- Lamps under the ballast are switched by flora mode.
- No sonar-specific circuitry.
- **No reactor automation.** AutoTemp is on. The engine battery buffer (§2) is the only load management.

## Rough part counts (logic/signal parts only)
| System | Parts |
|---|---|
| Doors | ≈7×12 + 5×1 + 5×3 + 5 ≈ 110 |
| Ducts | ≈60 |
| Shield/flood | ≈40 |
| Flora/ballast | ≈20 |
| Searchlight cycler | ≈20 |
| Bed tags | ≈25 |
| Chaser | ≈20 |
| Batteries | ≈10 |
| Docking | ≈7 |
| Displays/counters | ≈15 |

---

# Reusable patterns

1. **Momentary lever/switch.** Set `Controller IsToggle="False"` on a lever or switch and wire it to `relay.toggle`. It sends once per press like a button. Use when you want a lever look with a toggle (T flip-flop) function. Never put an IsToggle=True switch on a `toggle` pin, because it flips every tick.

2. **Relay flip-flop + inverter interlock.** Momentary input → relayA.toggle; relayA.state_out → signalcheck(Target 1, Output 0, FalseOutput 1) → relayB.set_state. A and B are always opposite. Use for charge/discharge battery paths, gun/searchlight mode, or any "exactly one of two" choice.

3. **Proportional battery recharge.** memory(105) → subtract.in1; battery.charge_% → subtract.in2; subtract → battery.set_rate. Put the high-transient load (engine) **only** on the battery output. Use to hide engine spikes from the reactor; the reactor sees a slow ramp.

4. **Relay fan-out past the 5-wire cap.** Signal: source → relay.signal_in1 and in2 → out1 (5 wires) and out2 (5 wires). Power: relay chains (one power_out feeds 5 relays). Use for one constant or state feeding more than 5 targets, or power for many lockers.

5. **Retriggerable timer / falling-edge one-shot.** A continuous signal (e.g. a signalcheck that outputs only in state X, FalseOutput "") → delay(N s, ResetWhenSignalReceived=True). It fires once, N s after the stream stops.
   - Hatch auto-close: state_out → signalcheck(T0, Out "0", False "") → delay 4 s reset → set_state.
   - Re-enable pumps 2 s after a mode ends.
   - Trigger debounce: delay 0.2 s reset on a held trigger.

6. **Slow-on / fast-off.** state → delay(5 s, ResetWhenDifferent) → targets, plus state → signalcheck(T0, Out "0", False "") → delay(0.05 s) → the same targets. Use for a warned activation with an instant safe-state return (flooding, lockdown).

7. **Auto-close door.** motiondetector(Human, Output "", FalseOutput "0") → door.set_state. One part. Buttons still work; the door closes when the area is empty.

8. **Flood-aware auto door.** motion → signalcheck(T0, Out 0, False "") → door.set_state (always auto-close). Motion → relayM(on) → door.set_state (auto-open). Water detectors on both sides → OR → relayB.set_state (enables buttons → door.toggle, plus indicator lights) and → signalcheck(T1→0 else 1) → relayM.set_state. Use for watertight doors that are convenient when dry and deliberate when flooded.

9. **Wired-OR on gate inputs.** Gates ignore "0", so several sources can be wired to one input pin, e.g. water_% (any water) plus greater(threshold > O2) with FalseOutput "". Use for cheap OR merges without an extra gate.

10. **Nonzero detector / string label.** orcomponent with a single input, Output "Online" (or "1"), FalseOutput " ". It outputs when the input is any value except "0". Use it for "reactor online", or with periscope position_out → turret/searchlight set_light (light only while manned).

11. **State → text.** signalcheck(Target 1, Output "Some status text", FalseOutput " ") → textdisplay.set_text. A single space clears the display, whereas an empty string would send nothing.

12. **Counter with memory loop.** memory → adder.in1, button → adder.in2, adder → memory; subtract with ClampMin 0 for decrement; memory → textdisplay. Arithmetic outputs only while both inputs are fresh, so you get one step per press. Use for tallies, channel selectors, or cycling with signalcheck(Target N → Output start) → delay(0.05) → memory to wrap.

13. **Wifi channel cycler.** memory(channel) → wifiTX.set_channel; the counter from pattern 12 steps the channel; receivers on consecutive channels each drive one device. Use for one controller and N devices selected by pressing a button or trigger.

14. **First-tick pulse / per-round increment.** regex(Expression ".", Output "", FalseOutput "1", ContinuousOutput true) with signal_out → relay → its own signal_in. It emits a single "1" at round start. Feed it into a memory+adder loop for a day counter, or use it as an init pulse.

15. **Docking sequencer.** toggle_docking → AND(in2 = NOT(dock.state)) (False "") → dock.set_state 1. toggle_docking → AND(in2 = dock.state, Output "0", False "") → hatch.set_state 0 now and → delay 0.6 → dock.set_state 0. dock.state_out → delay 1 s → hatch.set_state. Use to close the hatch before undocking and open it after docking.

16. **Floor duct auto valve.** xor(in1 = lower-hull ceiling water detector, in2 = upper water_% + (60 > lower O2)) → ductblock.set_state. Use for passive drainage and air top-up that stops when the lower hull is full.

17. **Colour-swap alarm.** Place two emergency lights (blue and red) at the same coordinates and drive them with complementary signalchecks. Use for status colour without a color component.

18. **Chaser lights.** oscillator(Square, 0.5 Hz) → gate relay → delays at 0.2/0.4/0.6/0.8 s → light groups, plus a clean-up "0" injected 0.2 s after each toggle press. Use for directional warning strips.
