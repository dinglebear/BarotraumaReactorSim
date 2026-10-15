> Study notes written by Claude from the netlist of the community files (`node sim/cli.js explain <file>`), to learn how they work. The original files are not in this repo. LHMRS-SD and DMFSS-1 by Spruceduck (workshop id 3011857010). Behaviour described from reading the wiring against reference/BAROTRAUMA_MECHANICS.md; not tested in game unless stated.

# LHMRS-SD (mothership) + DMFSS-1 (shuttle) by Spruceduck: circuit study notes

Sources: `/tmp/claude-0/exp/LHMRS-SD.sub.txt`, `/tmp/claude-0/exp/DMFSS-1.sub.txt` (netlists from `sim/cli.js explain`).
Raw subs: `/tmp/claude-0/ex/Examples/LHMRS-SD Not-OP Smart Submarine/*.sub` (gzip). LHMRS embeds DMFSS-1 as a
`<LinkedSubmarine filepath="LocalMods/LHMRS-SD/DMFSS-1.sub" linkedto="36">`, docked at LHMRS `dockingport#36`.
Every wifi channel therefore shows up twice in the raw LHMRS file.

Note on the netlist format: the explain tool prints regex backslashes doubled (`\\d`). The raw XML has single ones (`\d`, `[\w ]`).

Marketing names: **SDSmart** = the terminal command system on the mothership. **SDLink** = the wifi remote control of the shuttle.

Logic part totals (LHMRS): relay 173, memory 159, concat 121, signalcheck 90, delay 68, greater 36, regex 31,
wifi 25, not 8, and 4, or 1, round 2, adder 1, oscillator 1. About 60 % of this is the "system.status" scanner.
16 more relays sit in a crate as spares (`relaycomponent#2399..2414` @-75,-208, unwired).
DMFSS: wifi 23, relay 13, not 6, signalcheck 3, plus concat, memory and display.

---------------------------------------------------------------------------------------------------

## 0. Game behaviours these designs depend on (from reference/BAROTRAUMA_MECHANICS.md)

- **Toggle switch** (`switch`, Controller IsToggle=True) sends its state ("1"/"0") continuously. Every switch in
  these subs is saved with `State="False"`, so **the LHMRS starts cold**: engine, lights, O2, guns charge, ballast
  pumps and fab array are all off until the crew flips the breaker panel.
- **Relay** passes signal_in1/2 to signal_out1/2 only while on. `set_state` takes `!= "0"`, and `toggle` flips on any
  non-"0" value. `state_out` is sent **every tick**, so `relay.state_out -> not -> other.set_state` makes a
  continuously enforced complement. The forwarding is synchronous, with 0 latency.
- **Regex** latches its input and re-matches only when the input changes. ContinuousOutput=True sends the result every
  tick, which works as a level or state. ContinuousOutput=False sends once per received signal, which works as an
  event. With UseCaptureGroup=True, `Output` names the group to output.
- **Concat / greater / adder** (TimeFrame 0) output only on ticks when the inputs were received since the last Update.
  Concat needs both inputs. Greater fires if either input is fresh. An empty Output or FalseOutput string means
  nothing is sent.
- **Memory** sends its Value every tick, so it doubles as a string constant. It also latches the last value written to
  signal_in.
- **SignalCheck** works on receive: `value == Target ? Output : FalseOutput`. An empty result sends nothing.
  Output can be any string, so it maps a trigger to a text constant.
- **Delay**: ResetWhenSignalReceived=True restarts the timer on every input. A held (every-tick) input therefore
  produces **one output, Delay seconds after the input stops**, which gives a falling-edge one-shot.
- **Wifi**: transmit is synchronous. Receivers must share the channel and team, be within the *sender's* range, and
  **have their signal_out wired** (an unwired receiver never receives). Every wifi on the channel receives. Wifi
  forwards add stepsTaken. LinkToChat plus AllowCrossTeamCommunication put the text into radio chat.
- **Max 5 wires per connection.** Both subs use always-on relays as **wire hubs** (fan-out and fan-in) to go past
  that limit.
- **PowerContainer `set_rate`** takes 0..100 (%), clamps it, and rounds to 10 % steps (banker's rounding).
- Docking ports and docking hatches pass power through the dock. A `state_out` of a docking port or hatch is 1 while
  docked.

---------------------------------------------------------------------------------------------------

## 1. LHMRS power distribution and breaker panel

**Purpose:** manual "breaker panel" (labels at x=-192, switches at x=-170 in the Captain area) that cuts power to
each subsystem through relays in the power path.

Grid: `reactor1#38.power_out -> junctionbox#41`. The junction boxes 40, 41, 74, 75, 400 and 1031 are wired into a
mesh, so the whole main grid is one grid. `reactor1` has no control circuit; it runs on the vanilla AutoTemp.

| Switch | Label | Drives | Loads behind it |
|---|---|---|---|
| switch#91 | Oxygen Generator | relay#206.set_state | shuttleoxygenerator#152 |
| switch#92 | Aux Systems | relay#94.set_state | O2 tank shelves, diving suit lockers, statusmonitor#147 |
| switch#220 | Engine | relay#161.set_state | engine#39 |
| switch#214 | Ballast Pumps | pump#42/#43.set_active (signal, not power) | |
| switch#218 | Shuttle Charging | relay#2322.set_state | dockingport#36.power (power to the docked DMFSS) |
| switch#216 | Gun Charges | relay#398.set_state | supercapacitor#145, #146 power_in |
| switch#222 | Aux Pumps | relay#388.set_state + smallpump#150.set_active | 5 auto-bilge smallpumps |
| switch#213 | Fab Array | relay#79.set_state | fabricator, 2 deconstructors, medical fabricator |
| switch#212 | Lights | relay#95.set_state + lightfluorescentm01#2743.set_state | 5 fluorescent lights |
| switch#425 | (Array) | relay#412.set_state | output of the "Array" batteries into the grid |

- Status lamps for the Fab Array: `relay#79.state_out -> signalcheck#159 (Target "0") -> lamp#383` (OFF lamp) and
  `-> signalcheck#113 (Target "1") -> lamp#384` (ON lamp). This is the standard **relay state -> two signalchecks ->
  red/green lamp pair** idiom.
- Always-on relays in the power path, with no set_state: relay#93 (SDLink nav terminal), relay#403 (charging feed to
  all batteries), relay#411 (Buffer battery output), relay#1022 (searchlights), relay#2221 (ballast pumps + one
  light), relay#2211 (docking hatch power feed into JB#1031). They split the power wiring, work around the 5-wire
  limit, and give a place to add a breaker later.

**Battery banks:**

- **"Buffer"**: battery#140 and #141. `power_in <- relay#403 <- JB#400`, `power_out -> relay#411 (always on) -> JB#400`.
- **"Array"**: shuttlebattery#142 and #143, on the same charging feed. `power_out -> relay#412` (the switch#425
  breaker) -> JB#400. Their recharge rate is set by the terminal command `set.battery.N` (section 6).
- In effect the Buffer is always online as UPS, and the Array is a reserve the crew connects by hand.

Gotcha: the battery charging feed (relay#403) and the battery outputs feed the same junction box (400). This is the
usual "battery on the same grid" layout. Batteries charge from any surplus and discharge on any deficit, with the
priority rules (reactor first, then relays, then batteries).

Part count: about 10 switches, about 16 relays, 1 lamp pair.

---------------------------------------------------------------------------------------------------

## 2. Reactor low-fuel blinker

- `reactor1#38.fuel_out -> greater#2295.signal_in2` and `memory#2296 "25" -> greater.signal_in1`. The output is "1"
  when 25 > fuel, else "0".
- `greater -> relay#2294.set_state`. `oscillator#2293 (Pulse, Frequency 5) -> relay#2294.signal_in1 -> lightcomponentround#2292.toggle and #2302.toggle`.
- Why it works: 5 pulses/s on `toggle` flip the lamp, which blinks at 2.5 Hz, only while the relay is on. When fuel
  returns above 25, the relay blocks the pulses. **Gotcha:** the lamp freezes in whatever state it was in (it can stay
  lit). A `set_state 0` on the false branch would fix that.
- The reactor condition is also reported by the scanner (section 7).
- Parts: 4 (osc, relay, greater, memory) plus lamps.

---------------------------------------------------------------------------------------------------

## 3. Navigation, depth readout and docking (LHMRS)

- `navterminal#48` (main): `velocity_x_out -> engine#39.set_force`, `velocity_y_out -> pump#42/#43.set_targetlevel`.
  This is vanilla. Pumps are enabled by the "Ballast Pumps" switch through `set_active`.
- Custom buttons on nav#48: `Labels="Fire Depth Charge,Bow Discharge Coil,Stern Discharge Coil"`, `Signals="1;1;1"`.
  - signal_out1 -> depthchargetube#291.trigger_in
  - signal_out2/3 -> discharge-coil interlock (section 4)
- **Depth display**:
  - `nav#48.current_position_y -> roundcomponent#2467 -> delay#2469 (3 s, no reset) -> concat#2468 (+ memory "m") -> textdisplay#2465` ("Current Depth").
    The 3 s delay without reset only adds lag; the run-length queue keeps it cheap.
  - Depth band lamps: `round -> greater#2491 (in1 = mem 4000, in2 = depth)`, `greater#2471 (6000 > depth)` and
    `greater#2475 (10000 > depth)`. Each greater feeds two signalchecks (Target "1" and Target "0") that light a
    green or red lamp: lamps 2486/2485, 2488/2487 and 2489/2490.
  - Gotcha: confirm the sign and units of current_position_y in game before reusing the thresholds.
- **Docking**:
  - `nav#48.toggle_docking -> dockinghatch#85.toggle and dockinghatch#303.toggle` (both hatches; whichever is near
    the outpost docks).
  - `dockinghatch#85.state_out -> hatch#23.set_state`: the inner hatch auto-opens while docked and closes on undock.
  - The hatches' `power` goes through relay#2211 into JB#1031, so outpost power comes in when docked.
  - Shuttle port: `dockingport#36.state_out -> door#34.set_state` (the shuttle door opens when the DMFSS is docked).
    `dockingport#36.toggle <- navterminal#185.toggle_docking (SDLink station)` and `<- wifi#2531 ch7719`.
    **Nothing transmits on 7719** in either sub, so that path is dead (probably meant for a hand-held wifi).
  - Port power comes from relay#2322 (the "Shuttle Charging" breaker).

---------------------------------------------------------------------------------------------------

## 4. Weapons and supercapacitors (LHMRS)

**Supercaps**

- supercapacitor#145 powers chaingun#127, chaingun#128 and dischargecoil#133 (bow, x=1170).
- supercapacitor#146 powers flakcannon#121, chaingun#122 and dischargecoil#134 (stern, x=-1097).
- Both are charged through relay#398 (the "Gun Charges" breaker).
- `charge_% -> textdisplay#2207 / #2196` shows the raw number ("Capacitor Charge"). The charge rate comes from the
  terminal command `set.capacitor.N`, which drives both `set_rate` inputs.

**Discharge coil "only when full" interlock**

- `supercap#145.charge_% -> greater#2306.in1`, with `memory#2307 "99" -> in2`. The output is "1" when charge > 99.
- `greater -> relay#2311.set_state`, and `nav#48.signal_out2 (Bow button) -> relay#2311.signal_in1 -> dischargecoil#133.trigger_in`.
- The stern side is the same with greater#2305 and relay#2308 -> dischargecoil#134.
- Why: firing a discharge coil on a partly charged supercap wastes the charge. The relay only passes the
  nav-terminal button press at 100 %.

**Local gunners plus captain override (4 guns)**

- Each gun has a local periscope wired through its own relay:
  - periscope#118 -> relay#426 -> flak#121
  - periscope#119 -> relay#427 -> chaingun#122
  - periscope#120 -> relay#429 -> chaingun#128
  - periscope#117 -> relay#430 -> chaingun#127
  - Wiring pattern: `periscope.position_out -> relay.signal_in1 -> gun.position_in` and `trigger_out -> signal_in2 -> trigger_in`.
- The captain's periscope#224 (@-366,166) fans out to relays 495, 497, 498 and 499 (one per gun, in parallel with
  the local relays).
- Complement: `relay#426.state_out -> not#500 -> relay#495.set_state` (likewise 427/501/497, 429/610/498 and
  430/613/499). **Exactly one of local or captain controls each gun.**
- Selection comes from the terminal command `gun.override.N` (N = 0..4; section 6). memory#486 holds N (Value "0").
  signalcheck#468..471 (`TargetSignal` 1..4, `Output "0"`, `FalseOutput "1"`) drive the local relays' set_state.
  The selected gun's local relay turns off, so the captain's relay turns on. 0 = every gun local.
- Gunner-station indicator lamps: `relay#42x.state_out -> signalcheck Target "0" -> lamp A` and
  `Target "1" -> lamp B` (lamps 433/434, 443/444, 449/450, 455/456). The gunner sees "overridden" or "yours".
- Why memory: the regex fires once. The memory re-emits N every tick, so the signalchecks and relays hold their state.
- Parts: 8 relays, 4 not, 4 signalchecks, 1 memory, the regex front end, and 8 lamps with 8 signalchecks.

---------------------------------------------------------------------------------------------------

## 5. Flooding: auto bilge pumps, duct blocks and doors (LHMRS); bilge on DMFSS

**Auto bilge pump** (used 6 times on LHMRS and once on DMFSS)

- `waterdetector (Output "1"/FalseOutput "0") -> smallpump.set_active` and
  `-> signalcheck (Target "1", Output "-100", FalseOutput "0") -> smallpump.set_speed`.
- The pump runs at full outward speed only while its room has water.
- Instances: wd#830 -> smallpump#235/#236 (bottom diving airlock), wd#312 -> #239 (fab room), wd#299 -> #392,
  wd#2735 -> #150, wd#2739 -> #2734. On DMFSS: wd#195 -> smallpump#29.
- All LHMRS ones are powered via relay#388 ("Aux Pumps" breaker). smallpump#150 also gets set_active from the switch,
  so the switch and the detector fight over set_active (last write wins each tick).

**Flood-driven duct blocks** (3 instances)

- `relay#843: signal_in1 = wd#299 (upper room, 1 = wet); set_state = wd#300 (lower room, Output "0"/FalseOutput "1", i.e. 1 = DRY) -> ductblock#240.set_state`.
- The duct opens when the upper room is wet and the lower room is dry, and closes when both are dry. While the lower
  room is wet, the relay is off and the duct keeps its last state.
- The same holds for relay#851 (wd298/wd856 -> ductblock#304) and relay#861 (wd311/wd857 -> ductblock#307).
- Intent: let flood water drain down into the lower compartment, where the auto-bilge pumps are. A relay used as an
  AND gate with a "hold" behaviour.

**Doors**

- `wd#856 -> signalcheck#855 (Target "0", FalseOutput "") -> doorwbuttons#53.set_state`: the door is opened ("1") when
  the lower room is wet and is not touched otherwise.
- `wd#311 -> signalcheck#862 (Target "0", FalseOutput "") -> doorwbuttons#51`: the door is opened when the upper room
  is dry.
- Signalchecks with empty FalseOutput give a **one-sided override**. The crew can still use the buttons the rest of
  the time.

**Unfinished leak alarm**

- `and#2185 = wd856(dry) AND (or#2191 = wd299 OR wd298)`, followed by `and#2189` with `NOT wd#301`.
- `and#2186 = wd311 AND wd857`, followed by `and#2190` with `NOT wd#302`.
- The final outputs are **not wired**: dead logic.

**Airlock interlocks**

- LHMRS: hatch#12 is toggled by 3 buttons. `state_out -> not#829 -> hatch#17.set_state`, so the outer bottom hatch is
  always the opposite of the inner one.
- DMFSS: door#20 is toggled by 3 buttons. `state_out -> not#39 -> door#21.set_state`.
- Why: the door `state_out` is continuous, so the NOT keeps forcing the complement every tick. It is a 2-part airlock
  with no pumping cycle.

Other doors:

- LHMRS: hatch#246 and #253 follow switch#267 and #268 directly (a switch as a persistent door state).
- DMFSS: door#19 is toggled by button#312 directly (inside), and by button#303 through relay#69, which is enabled by
  switch#71. This makes a lockable outside button.

---------------------------------------------------------------------------------------------------

## 6. SDSmart terminal command system (LHMRS terminal#148, Captain area)

### 6.1 Bus structure

- Input fan-out: `terminal#148.signal_out` goes to hub relays #541, #923 and #2076 (always on). Each hub fans out to up
  to 5 command blocks:
  - #541: set.mission, mission.status, gun.override, set.capacitor
  - #923: set.battery, say, radio, system.status, welcome
  - #2076: assign.diver, dive.status
- Output fan-in: `terminal#148.signal_in` comes from hub relays #574, #924 and #1050. These are fed by more hubs
  (#1129, #1268, #1270, #1567, #1575, #1576, #2040, #2074).
- Hubs are just relays with only signal_in1 to signal_out1 used. They give 5 x 5 fan-in or fan-out per level.

### 6.2 Command block template ("gate + delayed extractor")

```
hub.out1 -> relayA(signal_in1)                (one more hub level, optional)
relayA.out1 -> regexGate  Expression="^cmd.+$"  UseCaptureGroup=False ContinuousOutput=True   (outputs 1/0)
relayA.out1 -> delayG     Delay=0.25 ResetWhenSignalReceived=True ResetWhenDifferentSignalReceived=True
regexGate   -> relayB.set_state
delayG      -> relayB.signal_in1
relayB.out1 -> regexX  Expression="^cmd.(?<arg>PATTERN)$" UseCaptureGroup=True Output="arg"
                       FalseOutput="ERROR" (or "") ContinuousOutput=False
regexX      -> <device input>  and  -> concat(memory "[Tag] text: ", arg) -> concat(.., memory "%")
            -> delay 0.5 (reset) -> output hub -> terminal.signal_in
```

Why each part matters:

- **The gate is continuous**, so relayB holds "this was the last command". The raw text is delayed 0.25 s so the gate
  has re-evaluated (the regex needs at least 1 Update) before the text arrives. Unrelated commands never reach the
  extractor.
- The extractor can therefore use `FalseOutput="ERROR"` safely. "ERROR" only appears for a malformed version of this
  command, and it is echoed as "...set: ERROR%". A device given "ERROR" ignores it, because set_rate parsing fails.
- The extractor is non-continuous, so it fires exactly once per command, and **re-entering the same command works**
  (once per received signal).
- `.` in `^set.capacitor.` accepts both "set capacitor 50" and "set.capacitor.50".
- The echo is delayed 0.5 s so it prints after the terminal's own echo of the typed line, in a stable order.
- Concat needs both inputs in the same tick. The memory constant is present every tick, so concat fires exactly when
  the extracted value arrives.

### 6.3 Commands (exact regexes)

| Command | Extractor regex | Effect | Echo |
|---|---|---|---|
| `set.capacitor.N` | `^set.capacitor.(?<charge>[0-9]{1,2}\|100)$` (regex#885, FalseOutput ERROR) | supercap#145/#146.set_rate = N | `[System] Capacitor charge rate set: N%` |
| `set.battery.N` | `^set.battery.(?<bcharge>[0-9]{1,2}\|100)$` (regex#905) | shuttlebattery#142/#143.set_rate ("Array" bank) | `[System] Battery charge rate set: N%` |
| `set.mission.M.TEXT` | gate `^set.mission.+$`; regex#547 `^set.mission.(?<missionnum>1\|2).(?<missiontxt>[\w ]+)$`, Output=missionnum; regex#548 same, Output=missiontxt, after a further 0.5 s | demux: signalcheck#544 (Target 1) and #545 (Target 2) set relay#542/#543; the text goes through the open relay to textdisplay#165 (Mission 1) or #164 (Mission 2) | `[Mission Control] Mission M - Updated.` |
| `mission.status.M.(green\|red)` | regex#578 Output=dmission; regex#502 Output=dstatus, +0.5 s | relay#581/#582 selected by M, then signalcheck "red"/"green" to lamps 170/171 (M=1) or 173/175 (M=2). One of the two lamps is lit | `[Mission Control] Mission Status: M ; Updated: status` (M delayed 0.75 s; status latched in memory#1412) |
| `assign.diver.M.S.NAME` | three regexes on one input: #2004 `dmission` (continuous), #2005 `dslot` (continuous, +0.25 s), #2006 `dname` (non-continuous, +0.75 s total) | two-level demux: M picks relay#2007 or #2011, S picks 1 of 3 relays below it, NAME goes to 1 of 6 textdisplays (172/169/163 = mission 1 slots 3/2/1; 176/177/174 = mission 2) | `[Mission Control] Member "NAME" has been assigned as diver #S on mission #M!` |
| `dive.status.T.(red\|green)` | regex#2140 dteam; regex#2141 dstatus (+0.5 s) | lamps 182/183 (team 1) and 180/181 (team 2), "Dive Authorization" | `[Mission Control] Dive Status #T, Status: s` |
| `gun.override.N` (N 0..4) | `^gun.override.(?<gun>[0-4])$` | memory#486 = N, which drives the gun relays (section 4) | `[Gun Controller] Overriding Gun #N` |
| `say.TEXT` | `^say.(?<saychat>.+)$` | wifi#948 ch 0, LinkToChat=True, AllowCrossTeam=True. **The text appears in radio chat** (headsets on channel 0, other teams too) | `[Radio] Message: "TEXT" sent on Freq 0000` |
| `radio NNNN TEXT` (literal spaces) | `^radio (?<freq>\d\d\d\d) (?<radmsg>.+)$`. regex#976 (radmsg) fires immediately; regex#974 (freq) fires 0.5 s later into wifi#960.set_channel | chat message on channel NNNN | `[Radio] On Frequency: NNNN , Sent Message: TEXT` |
| `system.status (all\|main\|critical)` | section 7 | prints a health report | |
| `welcome` | signalcheck#2047 Target "welcome", FalseOutput "" | delay 0.5, then signalcheck#2048 Output "[LHMRS-SD] ", then 4 delays (0.5 / 2.5 / 5 / 7.5 s), each concatenated with a memory string | 4 timed lines: "Welcome, Commander." / "...programmed with SDSmart (TM) Technology." / "All commands are listed on our discord!..." / "Good Luck on your Adventures!" |

Bugs and gotchas:

- **radio**: the message is sent **before** set_channel arrives (0.5 s later), so it goes out on the *previous*
  frequency. Fix: delay the message, not the frequency.
- `[\w ]+` rejects punctuation in mission text.
- set_rate quantises to 10 % steps.
- The extracted N is not range-checked beyond the regex.

### 6.4 Multi-field extraction trick

Several regexes read the same text with different `Output=<group name>`. They are staggered with delays: the
selector fields are continuous and arrive first, and the payload is non-continuous and arrives last. The selector
fields drive `signalcheck(Target=k) -> relay_k.set_state`, so the relays form a **demultiplexer**. When the payload
arrives, only the selected relay passes it to its display or lamp.

Part count per simple command: about 12 (hub relay, 2 regex, 2 relays, 2-3 delays, 2-3 concat, 2-3 memory).
assign.diver: about 35.

---------------------------------------------------------------------------------------------------

## 7. "system.status" scanner (terminal health report)

**Purpose:** the command `system.status main|critical|all` prints the condition of about 25 devices, one line every
0.25 s:

- reactor, O2 generator, engine
- stern/bow ballast pumps, nav terminal
- 4 loaders, 2 supercaps
- 2 Buffer and 2 Array batteries
- 6 junction boxes
- 2 status monitors, deconstructor, fabricator
- 3 airlock / fab-room pumps

**Front end**

1. hub#1056 -> gate `^system.status.+$` -> relay#1059.
2. relay#1059 -> regex#1051 `^system.status (?<statustype>all|main|critical)$` (**continuous**). It feeds
   signalcheck#1055 "main", #1067 "critical" and #1068 "all".
3. Those signalchecks drive the set_state of three parallel banks of trigger relays: main = 1069/1070/1071/1495,
   critical = 1072/1073/1074/1496, all = 1075/1076/1078/1497. They also drive relays 1733/1734/1735, which fan
   set_state out to more banks (1736..1791).
   So the **mode is a continuous selector over relay banks**.
4. A second copy, regex#1053 (non-continuous, +0.5 s), then delay#1091 0.1 s:
   - concat "[SCAN] Beginning Scan... Type: " + type + ", Please Wait..." to the terminal.
   - signalcheck#1106/#1107/#1108 (Target main/critical/all, FalseOutput "") all feed relay#1109. Any valid type
     gives a single "1" **trigger pulse**.
5. The trigger goes to delay#1104 (0.5 s), then signalcheck#1096 `Output="===[SCAN RESULTS]==="`, then the terminal.
   It also goes into the mode banks through hub relays 1109 -> 1170 -> 1176 / 1635 -> 1628 / 1784 / 1798.

**Per-device cell** (reactor example; repeated about 25 times)

```
reactor.condition_out -> memory#1117 (Value "100")        latch condition, re-emitted every tick
memory "40" -> greater#1136.in1 ; memory#1117 -> greater.in2  -> relay#1142.set_state   (1 when condition < 40)
main/all bank relay.out1 ---------------------------> delay#1099 (Delay 1.25, reset)     (unconditional)
critical bank relay.out1 -> relay#1142.in1 ---------> delay#1099                         (only if < 40)
delay -> signalcheck (Target "1", Output "[Scan]: ", FalseOutput "") -> concat(+memory "Reactor, Condition: ")
      -> concat(+memory#1117) -> concat(+memory "%") -> hub -> terminal
```

- The delays are staggered by 0.25 s per device (1.25, 1.5 ... 7.5 s), so the lines print in order like a scan.
- "critical" lists only the devices under 40 %.

**Bugs** (useful for knowing what not to copy):

- The concat outputs for the two status monitors (#1762, #1843) are unwired, so those lines never print.
- delay#1151 uses the default 1.0 s.
- delay#1662.signal_out is wired into relay#1497.signal_out1 (a mis-wire).
- relay#1733.set_state comes from relay#1789.set_state (a mis-wire).
- Some critical-bank relays have no outputs.

**Cost:** about 10 parts per device (4 memories, greater, relay, delay, signalcheck, 3 concats), about 300 parts in
total. A mux or a single concat chain per device would be far cheaper.

---------------------------------------------------------------------------------------------------

## 8. Searchlight selector (LHMRS Engineer station, periscope#207 + switch#1021)

**Purpose:** one periscope aims any of 6 searchlights: 4 on the mothership and 2 on the shuttle, through wifi.

**Counter**

```
periscope#207.trigger_out -> round#517 -> delay#986 (0.1 s, ResetWhenSignalReceived=True)
delay -> adder#988.in1 ; memory#990 (Value "1") -> adder.in2 ; adder.out -> memory#990.in   (count+1)
memory#990 -> greater#987.in1 ; memory#989 "6" -> in2 ; greater (FalseOutput "") -> memory#990.in   (7 -> "1")
```

- **Edge detect:** trigger_out repeats while the button is held. A reset-on-receive delay emits one pulse 0.1 s after
  release, so one press counts +1.
- The adder fires only on the tick the pulse arrives (TF 0, and memory is always present). The count runs 1..6 and
  wraps: when the memory reads 7, the greater writes "1" back.

**Selection**

- memory#990 goes to hub relay#991, which feeds signalcheck Targets 1..4 (#1003, #1001, #992, #1002). These drive the
  set_state of relays 1004, 1009, 1010 and 1011.
- Each of those relays carries `periscope.position_out` (signal_in1) and `switch#1021` (on/off, signal_in2) to one
  searchlight's `position_in` and `set_light`: #1020, #1019, #1018 and #1012.
- Through hub relay#2567: signalcheck Target 5 -> relay#2565 -> wifi 7720 (position) and 7721 (set_light), which
  reach DMFSS searchlight#268. Target 6 -> relay#2562 -> wifi 7722 and 7723, which reach DMFSS searchlight#269.
- relay#2573 duplicates the periscope and switch signals into those two.

**Gotcha:** the slot number is not shown anywhere (no display), so the operator counts presses.

Parts: about 20.

---------------------------------------------------------------------------------------------------

## 9. SDLink: remote operation of DMFSS from the mothership

All logic lives on the **mothership**. The shuttle only has wifi endpoints plus local/remote arbitration relays.
The mothership station is at x≈950..1050 (note "SDLink" @990,28). It has navterminal#185, terminal#205,
periscope#210, button#2327, switch#276, switch#2326 and textdisplay#2338.

Wifi Range attributes are set huge on both sides (1e8 to 1e12; a few at 9999999). Only the sender's range matters.
The reference says Range is "Editable, not saved", which conflicts with it being present in the XML. **Verify in
game**; if it is not loaded, the link only works within the default 20000 units.

### Channel map

| Ch | Direction | Mothership end | Shuttle end | Meaning |
|---|---|---|---|---|
| 7701 | M→S | switch#276 -> wifi#391 | wifi#119 -> relay#104.set_state | **Remote helm enable** |
| 7702 | S→M | wifi#2328 -> navterminal#185.transducer_in | sonartransducer#31.data_out -> wifi#106 | **Shuttle sonar shown on the mothership nav terminal** |
| 7703 | M→S | nav#185.velocity_y_out -> wifi#2329 | wifi#112 -> relay#104.in1 -> smallpump#28/#30.set_targetlevel | remote ballast |
| 7704 | M→S | nav#185.velocity_x_out -> wifi#2330 | wifi#115 -> relay#104.in2 -> engine#23.set_force | remote engine |
| 7705 | S→M and M→M | terminal#205.signal_out -> wifi#2533; parsers wifi#2552 and #2586 | terminal#24.signal_out -> wifi#127 | typed commands (either terminal) |
| 7706 | M→S and M→M | wifi#2534 -> terminal#205.signal_in; parser replies wifi#2551 and #2600 | wifi#122 -> terminal#24.signal_in | replies shown on both terminals |
| 7707 | S→M | wifi#390 -> concat(+"%") -> textdisplay#2338 | battery#27.charge_% -> wifi#128 | shuttle battery % |
| 7708 | S→M | (no receiver) | engine#23.condition_out | unused telemetry |
| 7709 | S→M | (no receiver) | shuttleoxygenerator condition | unused |
| 7710 | M→S | regex#2545 -> wifi#2553 | wifi#143 -> supercapacitor#25.set_rate | shuttle capacitor rate |
| 7711 / 7712 | S→M | (no receiver) | supercap charge_% / condition | unused |
| 7713 / 7714 | M→S | relay#2341 out1/out2 (periscope#210 position/trigger) | relay#90 in1/in2 -> coilgun#52 | remote gun A |
| 7715 / 7716 | M→S | relay#2346 out1/out2 | relay#91 -> coilgun#51 | remote gun B |
| 7717 | M→S | switch#2326 -> wifi#2348 | wifi#95 -> gun arbitration | **Remote gunnery enable** |
| 7719 | none | (receiver only) wifi#2531 -> dockingport#36.toggle | (receiver only) wifi#81 -> dockingport#22.toggle | dead, no transmitter |
| 7720 / 7721 | M→S | searchlight selector slot 5 | searchlight#268 position_in / set_light | |
| 7722 / 7723 | M→S | slot 6 | searchlight#269 | |
| 7724 | M→S | regex#2596 -> wifi#2598 | wifi#274 -> battery#27.set_rate | shuttle battery rate |

### Helm arbitration (shuttle)

- relay#104 is the remote path (wifi 7703/7704 -> pumps/engine), and its set_state comes from 7701.
- relay#105 is the local path (shuttlenavterminal#32 velocity_y/x -> same pumps/engine).
- `relay#104.state_out -> not#116 -> relay#105.set_state` makes the two **mutually exclusive**, enforced every tick.
- The mothership's toggle switch sends 0/1 every tick, so the shuttle follows it continuously.
- Gotcha: if the link drops, relay#104 keeps its last state. With remote on and no signals, the helm is frozen
  (local control stays blocked).

### Gun arbitration (shuttle)

Local:

- `periscope#50 -> relay#74 -> coilgun#52` and `-> relay#89 -> coilgun#51`.
- relay#74 is toggled by button#55 or by the shuttlenavterminal custom button `Labels="Swap Periscope Gun"`
  (signal_out1 -> relay#74.toggle).
- `relay#74.state_out -> not#158 -> relay#94.signal_in1 -> relay#89.set_state`, so the local periscope drives one gun
  at a time.

Remote (wifi#95, ch 7717):

- `-> relay#90/#91.set_state`: the remote paths are enabled when the value is 1.
- `-> signalcheck#93 (Target "1", Output "0", FalseOutput "")` drives relay#89 and relay#74 set_state. When remote is
  on, both local relays are forced off every tick. When remote is off, **nothing is sent**, so the local toggle
  keeps working.
- `-> signalcheck#151 (Target "1", Output "0", FalseOutput "1") -> relay#94.set_state`. This cuts the local
  NOT-complement link while remote is on and restores it when remote is off.

Mothership side:

- `periscope#210 -> relay#2341 (-> 7713/7714)` and `-> relay#2346 (-> 7715/7716)`.
- button#2327 toggles relay#2341, and `not#2345` makes relay#2346 its complement. One periscope aims either shuttle
  gun, with a swap button.

### Remote terminal (SDLink terminal)

- terminal#205 (mothership) and terminal#24 (shuttle) both **transmit on 7705** and **receive on 7706**.
- The command parsers sit on the mothership and listen on 7705 (wifi#2552 and #2586), so commands work from either
  terminal.
- The blocks follow the gate + extractor template: `^shuttle.set.capacitor.+$` / `^shuttle.set.capacitor.(?<charge>[0-9]{1,2}|100)$` -> wifi 7710,
  and `^shuttle.set.battery.(?<charge>...)$` -> wifi 7724.
- Confirmations ("[SHUTTLE] Capacitor charge rate set: N", "[SHUTTLE] Battery charge rate set: N") go out on 7706 and
  appear on **both** terminals.
- Typed text is not mirrored across, because the 7705 transmitter on each side has no wired receiver on the other
  terminal.

### Shuttle power (DMFSS)

- `dockingport#22.power -> battery#27.power_in and junctionbox#26`. While docked, mothership power (through the
  "Shuttle Charging" breaker) charges the battery and feeds the bus.
- `reactor1#188` ("Highly Inefficient Backup Reactor", note) only feeds battery#27.power_in.
- `battery#27.power_out -> relay#78` (master switch#261) -> JB#26.
- JB#26 feeds three always-on relay branches:
  - relay#70: O2, supercap, searchlight 269
  - relay#72: sonar, nav terminal, bilge pump, searchlight 268
  - relay#73: ballast pumps, light, engine
- Local display: `battery#27.charge_% -> concat (+memory "%") -> textdisplay#134`.

DMFSS part count: about 23 wifi, 13 relays, 6 not, 3 signalcheck, a few others. About 50 logic parts.

---------------------------------------------------------------------------------------------------

## 10. Displays and status summary

- Text displays:
  - mission names (2), diver names (6)
  - supercap raw % (2), depth ("NNNNm"), shuttle battery %
  - DMFSS local battery %
- Lamps:
  - fab array on/off, gun override pairs (4)
  - mission red/green (2 pairs), dive authorization (2 pairs)
  - depth bands (3 pairs), low-fuel blinkers (2)
- Status monitors (#147, #211) are vanilla.

---------------------------------------------------------------------------------------------------

## Reusable patterns

1. **Wire-hub relay**
   - Recipe: relaycomponent (IsOn true). Wire the source to signal_in1 and up to 5 targets from signal_out1. Chain
     hubs for more.
   - Fan-in works the same way: up to 5 sources into signal_in1, one wire out.
   - Use: whenever a connection needs more than 5 wires (terminal command buses, broadcast triggers).
   - Cost: 0 ticks, but it adds stepsTaken (more than 10 forwarding hops adds 1-2 ticks).

2. **Terminal command block (gate + delayed extractor)**
   - Recipe:
     - `regexGate(Expression="^cmd.+$", UseCaptureGroup=False, ContinuousOutput=True)` -> relay.set_state.
     - `delay(0.25, ResetWhenSignalReceived=True, ResetWhenDifferentSignalReceived=True)` -> relay.signal_in1.
     - relay.signal_out1 -> `regexX(Expression="^cmd.(?<v>PATTERN)$", UseCaptureGroup=True, Output="v", FalseOutput="ERROR", ContinuousOutput=False)` -> device.
     - Echo: `concat(memory "[Tag] msg: ", v)` -> `concat(.., memory "%")` -> `delay 0.5` -> terminal.signal_in.
   - Use: any typed command with an argument. Unrelated commands are silent, malformed ones are reported, and
     repeated commands re-fire.
   - Use `.` as the separator so both space and dot work.

3. **Regex demultiplexer (multi-field command)**
   - Recipe: N regexes on the same text, each with a different `Output=<group>`. The selector groups are continuous
     and feed `signalcheck(Target=k)` -> `relay_k.set_state` (one relay per destination). The payload regex is
     non-continuous, delayed 0.25-0.75 s more, and feeds every relay_k.signal_in1.
   - Use: one command writing to one of many displays, lamps or devices (`assign.diver.M.S.NAME`).

4. **Persistent selection from a one-shot**
   - Recipe: `regex(non-continuous) -> memory (initial Value)`. The memory re-emits every tick to
     `signalcheck(Target=k, Output="0", FalseOutput="1") -> relay_k.set_state`.
   - Use: a mode or index that must hold after a single command (gun override).

5. **Exclusive A/B control path (local vs remote / gunner vs captain)**
   - Recipe: relayA (path A signals), relayB (path B signals, same targets). `relayA.state_out -> not -> relayB.set_state`.
     Drive relayA.set_state from the selector (a switch, a wifi, or a signalcheck).
   - Use: any two controllers sharing actuators (engine/pumps from two nav terminals, a gun from two periscopes).
   - Gotcha: on loss of the selector signal it holds the last state.

6. **One-sided override with an empty FalseOutput**
   - Recipe: `signalcheck(Target="1", Output="0", FalseOutput="")` -> relay.set_state. It forces off while the
     condition holds and leaves local toggles alone otherwise.
   - Use: overriding without stealing control permanently (the remote gunnery lock-out, flood door auto-open).

7. **Two-lamp state indicator**
   - Recipe: `X -> signalcheck(Target "1") -> lampOn.set_state`, `X -> signalcheck(Target "0") -> lampOff.set_state`,
     where X is a relay.state_out, a greater output or a regex word ("red"/"green" as Targets).
   - Use: status boards and breaker indicators.

8. **Threshold-gated trigger ("fire only when full")**
   - Recipe: `greater(in1 = supercap.charge_%, in2 = memory "99") -> relay.set_state`, `button -> relay.signal_in1 -> dischargecoil.trigger_in`.
   - Use: any action that should only pass when a level is reached.

9. **Blink alarm**
   - Recipe: `oscillator(Pulse, f) -> relay.signal_in1 -> lamp.toggle`, `greater(memory threshold, value) -> relay.set_state`.
   - Fix to apply: also send `lamp.set_state 0` when the condition clears, or the lamp may stay lit.

10. **Press counter / cyclic selector with edge detect**
    - Recipe: `held trigger -> delay(0.1, ResetWhenSignalReceived=True)` (one pulse per press) -> `adder.in1`,
      `memory(Value "1") -> adder.in2`, `adder -> memory.in`, `memory -> greater.in1`, `memory "N" -> greater.in2`,
      `greater (FalseOutput "") -> memory.in` (wrap to "1"). Then `memory -> signalcheck(Target k) -> relay_k.set_state`
      to route a shared control (periscope position, switch) to the selected device.
    - Use: one control station cycling through many lights, guns or cameras. Add a display of memory for feedback.

11. **Auto bilge pump**
    - Recipe: `waterdetector -> smallpump.set_active`, `waterdetector -> signalcheck(Target "1", Output "-100") -> smallpump.set_speed`.
    - Use: every wet-prone room and airlock. 3 parts.

12. **Flood drain duct (conditional relay hold)**
    - Recipe: `relay.signal_in1 = upperWD (1 = wet)`, `relay.set_state = lowerWD (Output "0", FalseOutput "1")`,
      `relay.signal_out1 -> ductblock.set_state`.
    - Use: open a path only while the destination is dry.

13. **Airlock door interlock**
    - Recipe: `doorA.state_out -> not -> doorB.set_state`. Buttons toggle doorA only.
    - Use: 2-door airlocks without pumps.

14. **Wifi remote-control bundle (SDLink)**
    - Recipe: one channel per signal, with direction fixed by which side has the transmitter and which side has a wired
      receiver:
      - nav velocity_x/y out (M) -> engine set_force / pump set_targetlevel (S), through a remote relay that is
        enabled by an "enable" channel (toggle switch, sent continuously).
      - sonartransducer.data_out (S) -> navterminal.transducer_in (M), so the remote pilot gets the remote sonar.
      - periscope position/trigger (M) -> gun (S).
      - telemetry: charge_% / condition_out (S) -> display (M).
      - text: a shared "commands" channel (all terminals transmit) and a shared "replies" channel (all terminals
        receive). The parsers live on one side only.
    - Use: drones, shuttles, remote turrets. Remember: only wired receivers receive, range is the sender's, and use the
      same team.

15. **Terminal-to-radio-chat bridge**
    - Recipe: `regex ^say.(?<t>.+)$` -> `wifi(Channel 0, LinkToChat=True, AllowCrossTeamCommunication=True).signal_in`.
    - For a variable frequency, send the channel to set_channel **before** the text (delay the text, not the
      frequency).

16. **Timed multi-line terminal output**
    - Recipe: trigger -> `signalcheck(Target "1", Output "<prefix>", FalseOutput "")` (a string constant on trigger) ->
      several `delay(t_i)` -> `concat(.., memory "line i")` -> terminal.
    - Use: welcome banners and staged report lines (scan output with 0.25 s steps).

17. **Health scanner (cheaper redesign suggested)**
    - Per device: `condition_out -> memory latch`; `greater(memory "40", latch) -> relay` gates the critical-only
      mode; a staggered delay trigger -> label concat -> terminal.
    - Use: when the crew wants a single report command. Expect about 10 parts per device in the original style.
