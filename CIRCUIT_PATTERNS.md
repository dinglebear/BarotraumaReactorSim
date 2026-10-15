# Circuit patterns: designing whole-sub systems (for AIs)

This is what I learned studying community "smart sub" circuits and building the Camel Overkill with the sub editor. Read it before designing doors, alarms, terminals, wifi networks, power management or anything else sub-wide. Read SUBEDIT.md for how to put a design into a `.sub`.

Sources:
- Full study notes are in `context/circuit_studies/`:
  - HuskOS: a terminal OS.
  - Smart Sub Toolkit: chat commands and wifi buses.
  - LHMRS-SD + DMFSS-1: a mothership that remote-controls its shuttle.
  - The Iroh: a vanilla showpiece sub.
  - The MK-II smart door.
  - The vanilla Camel.
- Worked example: `ships/CAMEL_OVERKILL.md` and `circuits/camel/*.circ`.
- To study any other sub or assembly: `node sim/cli.js explain <file.sub|assembly.xml> [filter]`. It prints every wired or logic item with its non-default settings and wiring, and every circuit box's insides.

## 1. Signal rules that decide whether a design works
Exact code is in `reference/BAROTRAUMA_MECHANICS.md` §3–6.

**Signals:**
- A signal is a string. `""` is never sent: a component whose Output or FalseOutput is `""` stays silent in that state. **Use this everywhere:** a gate that only speaks when it has something to say.
- Logic inputs (And/Or/Xor/Not) treat `"0"` and `""` as false and anything else as true. So a room name like `"Medbay"` counts as true.
- **Many senders on one input:**
  - Forwarding receivers act on every signal they receive: terminal, wifi `signal_in`, delay, relay pass-through, a door's `toggle`.
  - Latching receivers keep only the last value per tick: Update-driven logic, memory, a door's `set_state`, a light's `set_color`, a pump's `set_targetlevel`.
  - So never let two things drive the same `set_state` every tick. Gate one of them, or give it `""` in the idle state.
- **Timing:**
  - Forwarding parts add 0 ticks: relay, not, signal check, mux/demux, wifi, junction box.
  - Update-driven parts add 0–1 tick each: and/or/xor, arithmetic, concat, equals/greater, memory, regex, color, oscillator, delay.
  - A chain of 10 arithmetic parts is ~10 ticks of latency. **Feedback loops through many Update parts must have low gain, or they oscillate** (Camel lesson below).
  - Power changes show up 1 tick later.
- **Box size:** a circuit box holds at most **64 components**.
- **Wire limits:** a connection takes 5 wires when wiring by hand; loading accepts more. To fan a signal out to more than 5 places, use a **relay as a wire hub**: `IsOn=true`, the same source into `signal_in1` and `signal_in2`, giving 5 + 5 outputs. Inside circuit boxes the 5-wire limit does not seem to apply (HuskOS has 7).

**Memory, timers, regex, signal check:**
- `memory` sends its Value **every tick**. It is the standard latch and constant. A one-shot gate into `memory.signal_in` gives a persistent mode.
- `TimeFrame` on And/Or/Xor/Concat/Greater: an input counts as present for that many seconds after it last arrived.
  - `or TimeFrame=N` on a pulse = "hold 1 for N s". Use it for timers, auto-close, debounce and siren mute.
- `delay`:
  - It queues every signal.
  - With `ResetWhenSignalReceived=true` and a continuous input, it fires once N s after the input stops (retriggerable timer).
  - Delay=0 never outputs.
- `regex` (.NET):
  - `(?i)` for case-insensitive matching.
  - `UseCaptureGroup=true Output=1` (or a named group `(?<x>...)` with `Output=x`) outputs the capture.
  - `ContinuousOutput=false` answers **once per received signal**. `set_output` loads the answer from a live value: the "live-value printer".
- `signalcheck`: `set_targetsignal` lets you compare two **dynamic** strings (password = typed line, user == admin).

**Wifi:**
- Transmission is instant and synchronous, to **every other** wifi on the same channel and team within the sender's Range. Wifis in circuit boxes count, positioned at the box.
- A receiver only receives if its `signal_out` is wired (or LinkToChat is on).
- **A wifi fed every tick floods its channel every tick.** Every receiver's latched input sees that value last. On a shared channel (radio chat channel 0, a command bus) only send on events or on change.
- **LinkToChat (radio chat):**
  - A placed wifi with `LinkToChat=true` posts what it transmits into headset radio chat on its channel. Players with headsets on that channel see it.
  - Lines players say on that channel come **out** of its `signal_out`.
  - `MinChatMessageInterval` and `DiscardDuplicateChatMessages` limit the spam.
  - LinkToChat and Range are written in saved subs (seen in HuskOS's 1.7.7 sub), even though the mechanics reference calls them not-saved. **Confirm in game.**

**Relays, power, devices:**
- **Relay:**
  - It is a PowerTransfer between two grids. The input grid sees the output grid's load, up to `MaxPower` (default 1000 kW; it's a saved property, so set it higher for big loads).
  - Pass-through signals `signal_in1..5 → signal_out1..5` flow only while on.
  - It outputs `state_out`, `load_value_out` (= load of the output grid) and `power_value_out` every tick.
  - A relay is the only way to switch power to a device with no on/off input (e.g. `outpostoxygenerator`), and a relay in the power path **measures** what flows through it.
- **Batteries:**
  - `set_rate` is rounded to 10 % steps of MaxRechargeSpeed (50 kW on a 500 kW battery).
  - `load_value_out` is the load of the grid on its `power_out`.
  - The `charge_rate` output is the commanded rate, not the actual one.
- **Reactor:** the automatic control (AutoTemp) is not saved in the sub. The crew must switch it off for a circuit to run the reactor.
- **Text displays and lights:**
  - `textdisplay`: `set_text`, `set_text_color`. Sending `" "` (a space) clears it; `""` is never sent.
  - Lights: `set_color` takes `"R,G,B,A"` (0–255).
  - A `color` component with `UseHSV=true` takes hue 0–360, saturation 0–1, value 0–1, alpha 0–255.
- **Doors:** `set_state` opens on anything but "0", `toggle` flips. A button click is just a toggle, so a circuit that sends `set_state` every tick overrides the buttons.
- **Detectors:**
  - Motion detector: `Target=Human` ignores monsters. Its range and offset are set in the item.
  - Water, smoke and motion detectors send Output/FalseOutput every tick. Set `FalseOutput=""` and they only speak when triggered.
  - A water detector also sends `water_%`.

## 2. Pattern library
Name: recipe. The source is in brackets: H = HuskOS, T = Toolkit, L = LHMRS, I = Iroh, D = MK-II door, C = Camel Overkill (mine).

**Basic building blocks**
- **Constant / register** [all]: `memory Value=X`. It drives every tick, so feed a consumer or latch it.
- **Set/reset latch** [C]: `greater(in > hi) Output=0 FalseOutput=""` and `greater(lo > in) Output=1 FalseOutput=""`, both → `memory.signal_in`. Hysteresis with 3 parts.
- **Hold-for-N-seconds** [C,D]: pulse → `or TimeFrame=N`.
- **Retriggerable one-shot** [I]: continuous signal → `delay N ResetWhenSignalReceived=true`. It fires once N s after the signal stops.
- **Edge pulse** [D]: `xor(x, delay(x, 0.1)) Output=0 FalseOutput=""`. It sends a short "0" burst on each change. Use it to close a door once without holding it closed.
- **Change-only filter** [C]: `equals(x, delay(x, 0.1)) Output=0 FalseOutput=1 → relay.set_state`, with x → `relay.signal_in1`. The value passes only for a few ticks after it changes. Essential before a chat wifi or a shared bus.
- **min/max of two numbers** [C]: `min = (a + b - |a - b|) / 2`, which is sub, abs, add, sub, div. Max uses + instead of the inner -.
- **Selector** [H,C]: `mux` with `set_input` ← an index and constants on `signal_in0..9` (alert level → name/colour/mood). In game, mux `set_input` uses int.TryParse, so send "0"/"1"/"2" and not "1.0".
- **Exclusive A/B** [L,I]: `relayA.state_out → not → relayB.set_state`. Exactly one path is live (local/remote, normal/override).
- **One-sided override** [L,I]: `signalcheck Target=1 Output=0 FalseOutput=""` → `set_state`. It forces off only while the condition holds, and otherwise lets buttons/toggles work.
- **Wire hub** [T,L,I]: a relay with `IsOn=true` to get past the 5-wire limit (0 ticks).
- **Momentary lever** [I]: a lever/switch with `IsToggle=False` → `relay.toggle`. It sends one pulse per press.
- **Counter / cycler** [H,I,L]: `memory ↔ adder` with a pulse into the adder, plus `greater` for wrap-around. Use for selectors, day counters and uptime.
- **First-tick pulse** [I]: `regex Expression="." Output="" FalseOutput="1"` with a looped relay. It gives one "1" at round start.

**Terminals and text (OS)**
- **Command bus + reply bus** [C]: the terminal sends every line raw on one channel (7300). Any box answers on a reply channel (7310), which the OS box prints. New features become new boxes, and nothing else changes. Keep one "unknown command" regex in the core that lists every command.
- **Settings panel** [C]: `regex ^set x ([0-9]+)$` capture → memory → its own wifi channel every tick → the user box's memory (default value inside, so it works without the panel). A `settings` command prints a concat chain of all the memories.
- **Random pick** [C]: a fast oscillator (7 Hz) counts 0..N-1 (memory + adder + modulo) into a mux of answers. The command's regex prints the mux (live-value printer). Use for jokes and the 8-ball.
- **Command regex** [H]: `regex Expression="^(?i)cmd(\s.*)?$" Output="<reply>" FalseOutput="" ContinuousOutput=false`, with the terminal line into `signal_in` and the output into `terminal.signal_in`.
- **Argument capture** [H,L]: `^(?i)cmd (.+)$` with `UseCaptureGroup=true Output=1`.
- **Live-value printer** [H,C]: the value stream → `regex.set_output`, the command → `regex.signal_in`. Use for status lines.
- **Unknown-command catcher** [C]: one regex listing all commands, with `Output="" FalseOutput="Unknown command"`.
- **Command bus** [T,H,C]: the terminal (and chat) sends every line raw onto one wifi channel. Each subsystem decodes only its own commands. Modules stay independent and can be added without touching the OS.
- **Status line** [H,C]: telemetry wifi → memory latches → a `concat` chain with Separators ("kW LOAD ", "% | O2 "...). Broadcast it for displays.
- **Ordered multi-line output** [H,L]: delay chains (0.01 s on a terminal, ≥1 s for chat).
- **Login / permissions** [H]: account rows are `signalcheck(set_targetsignal ← memory user)`. A guarded command is `and(command, signalcheck(user == admin))`. A mode-lock relay reads the next line as data.
- **Ring-buffer log** [H]: mux/demux plus slot memories. It's fragile, so see HuskOS notes §1.6 before copying.

**Radio, wifi and remote control**
- **Chat command input** [T,C]: `wifi Channel=0 LinkToChat=true` → `regex ^(?i)camel (.+)$` capture → the command bus. Players type `camel status` in headset chat.
- **Chat output** [L,C]: a placed `wifi LinkToChat=true` on the crew channel (0). Prefix the messages, e.g. `[CamelOS]`, so command regexes never match your own replies, and send only on events or changes.
- **Telemetry channels** [T,L,C]:
  - One channel per value. Devices transmit, panels, displays and the OS receive.
  - Use a number band per system (e.g. 72xx telemetry, 73xx commands, 74xx sensors).
- **Remote-control bundle** [L]: one channel per signal (nav x/y, sonar transducer, periscope position/trigger), plus an enable channel feeding exclusive A/B relays on the remote side.
- **Sensor node** [C]: a detector with `Output=<RoomName> FalseOutput=""` → `wifi` on a shared channel. Every room reports on one channel and only wet or smoky rooms speak, so the message names the room.

**Doors, flooding and fire**
- **Air node** [C]: oxygen detector → box with `greater(low, o2) Output=<Room>` → wifi "needs air", and `greater(high, o2)` → wifi "not full". Thresholds come from wifi into memories with defaults.
- **Auto-close only (vanilla)** [Camel]: `motion → or(TimeFrame=4, Output="", FalseOutput="0") → door.set_state`.
- **Auto-open for people + flood interlock** [D,I,C]: motion (Target=Human) → `or TimeFrame=3` → relay (blocked while hazard) → `set_state`; plus a hazard edge pulse "0". Crew can still open it by hand during a flood.
- **Lockdown** [C]: a latch from the command bus → `signalcheck Target=1 Output=0 FalseOutput=""` → `set_state` every tick (truly sealed).
- **Auto bilge** [L]: water detector → `pump.set_active`. Add `signalcheck(1 → -100)` → `set_speed` to pump out.
- **Airlock interlock** [Camel,L]: `doorA.activate_out → not → doorB.set_state`, and the reverse.
- **Docking sequencer** [Camel,I]: close the inner hatch before undocking, and open it ~1 s after `on_dock`.

**Power**
- **Battery-only engine bus** [I,C]: the engine (and ballast pumps) take power only from batteries. The reactor only sees their recharge, so throttle spikes never hit the reactor grid.
  - Iroh: recharge = 105 − charge %.
  - Camel: surplus-only charging, below.
- **Surplus-only charging + measured charge tap** [C]:
  - Put all battery charging behind one relay (`MaxPower` raised). Its `load_value_out` is exactly what the batteries draw.
  - Main demand = reactor load − tap, low-passed (×0.9 old + ×0.1 new per tick).
  - Reactor setpoint = demand + what the banks *want*.
  - The batteries get **what the reactor actually makes − demand**, so any reactor lag or load step is absorbed by the charging, not the voltage.
- **Thermometer battery rates** [C]: batteries fill one after another (each takes up to its max of what is left). This gets past the 10 % rate rounding: N batteries give 50 kW resolution instead of N×50.
- **Feed-forward a known big switch** [C]: when a circuit will switch a large load (O2 generator 1000 kW):
  - delay the switch 5 s and warn the reactor during the delay ("pre");
  - send the switch command itself to the power manager so its filter is bypassed. No spike, no brownout.
- **Duty-cycled life support** [C]: the oxygen generator on a relay, ON below 85 % and OFF above 97 % (two oxygen detectors, min). This saves most of its 1000 kW (in the mock it ran ~10 % of the time).
- **Load shedding** [C]: relays on non-essential loads (fabricators, suit lockers) open when the batteries are low. Use a latch with hysteresis, plus manual override modes through a mux.
- **Fire only when full** [L]: `greater(supercap charge %, 99) → relay` gating the trigger.

## 3. Whole-sub architecture that worked (Camel Overkill)
- **Boxes per job**, each with HOW IT WORKS and WIRING notes inside:
  - reactor brain;
  - power manager;
  - governor (air and shedding);
  - alert core;
  - OS;
  - one door brain per door;
  - ballast override.
- **Buses instead of wires across the sub:**

  | Channels | Use |
  |---|---|
  | 7300 | Command bus (terminal and radio lines) |
  | 72xx | Telemetry (7201 O2, 7202 propulsion %, 7203 generator, 7204 shedding, 7205 alert name, 7206 reactor kW, 7207 load, 7208 temperature, 7209 propulsion low, 7210 status line, 7211 propulsion kW, 7212 O2 pre-warning, 7213 O2 relay command) |
  | 7303 / 7304 | Light colour / mood text |
  | 7400 / 7401 | Flood / fire room names |
  | 0 | Radio chat |

- **Sensor network:** each room gets a water and a smoke node. The alert core needs one input per hazard type instead of one per room.
- **Alert level** = 2 × RED + YELLOW → mux → name, colour, mood. Then a manual override (a flag mux) and a party mode (an HSV rainbow from an oscillator).

## 4. Lessons from testing in the mock (things that broke)
- **Per-tick chat spam:**
  - The alert's announcement went to a channel-0 chat wifi every tick, and every channel-0 wifi (including the radio-command receiver) got it every tick.
  - That overwrote the crew's commands before the regex could read them.
  - Fix: a change-only filter before any shared channel.
- **Subtracting two readings that arrive a tick apart oscillates:**
  - `load − tap`, where the reactor's and the relay's values were one tick out of phase, made the rates flip 0/100 % every tick.
  - Fix: low-pass the difference. A 2-sample average did *not* work (the loop had other delays).
- **Fast integrators in long logic chains oscillate:**
  - `rate = current + 0.5 × error` with ~10 ticks of latency through the box was unstable.
  - Keep gains low, or compute open-loop from measured values.
- **Rate rounding:** 10 % battery steps on a light bus cause ±10 % voltage ripple. Use thermometer coding.
- **The 1000 kW relay limit:** the stock relay's MaxPower is exactly the oxygen generator's draw. Raise MaxPower on relays that carry big loads (the charge tap is set to 4000).
- **Circuit boxes hold 64 components (found in game):** two Camel boxes had 68 and 84, and everything past 64 was lost, including the parts that set the battery rates, so the main bus browned out at 0.4 V. Plan boxes at 64 or fewer; the editor and `check` now enforce it.
- **Placed items must be attached (found in game):** a wifi template saved loose made 42 wifi components fall to the floor. The editor now sets `Attached=True` on every placed item.
- **Sloshing water flickers detectors (found in game):** anything driven by a water detector needs a hold, `or TimeFrame=5..10`, or it will flap: doors reopened and closed, and alert announcements repeated. Announce on level changes only, and give chat wifis a long MinChatMessageInterval.
- **Room rectangles include floor and ceiling slabs (found in game):** text displays placed near a room's edge ended up inside the floor. The editor now nudges new fittings out of solid structure.
- **Oxygen per room (found in game):** watching 2 rooms let others run low. Use one air node per room: an oxygen detector into a tiny box that sends the room name below a threshold. The generator is ON when any room asks.
- **Relay headroom:** a stock relay (MaxPower 1000) feeding exactly 1000 kW has no margin. Set MaxPower higher.
- **Backslashes in `.circ`:** the circuit language uses `\` as an escape, so a regex `\d` arrives as `d`. Write `[0-9]` and `[ ]`.
- **Empty values in patch files:** `Key=""` must give an empty value, not a quote character. A stray `"` made every dry water sensor read as flooded. Fixed in the patch parser; tested.

## 5. Checklist before calling a sub design done
1. `node sim/cli.js sub patch <Sub> <patch>`. The loader checks must pass.
2. `node sim/cli.js ship <NewSub> --transcript` with `--breach S --breach-hull ID`, `--fire S --fire-hull ID`, `--type "t:cmd"` and `--radio "t:camel cmd"`. Read the chat, terminal and display lines.
3. Look at the power metrics: unmet %, brownout/overvolt seconds, junction overload, oxygen min %, generator duty.
4. Open it on the bench's Sub tab:
   - press buttons;
   - flood or burn rooms;
   - type into the terminal;
   - watch grids and voltages live.
5. Tell the human what to check in game: AutoTemp off, LinkToChat kept after load, door feel, anything the mock doesn't model (water, crew pathing, item damage).
