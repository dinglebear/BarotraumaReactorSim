> Study notes written by Claude from the netlist of the community files (`node sim/cli.js explain <file>`), to learn how they work. The original files are not in this repo. Smart Sub Toolkit by its Steam Workshop author (workshop id 2960676031). Behaviour described from reading the wiring against reference/BAROTRAUMA_MECHANICS.md; not tested in game unless stated.

# Smart Sub Toolkit — circuit study notes

Source: ItemAssembly "Smart Sub Toolkit" (netlist `/tmp/claude-0/exp/Smart_Sub_Toolkit.xml.txt`, raw XML `/tmp/claude-0/ex/Examples/Smart Sub Toolkit.xml`).
Total: 785 items + 60 labels (memory 144, concat 82, signalcheck 76, wifi 64, button 34, regex 29, color 28, relay 27, subtract 24, textdisplay 22, and 18, adder 15, multiply 12, greater 12, light 9, detonator 9, modulo 3, round 3, delay 3).
These are all loose items on the sub (no circuit box) and every module is duplicated 2–3 times. Modules talk only through **wifi**:

| Channel | LinkToChat | Use |
|---|---|---|
| 0–9 (one wifi per channel) | **True** | Chat bridge receivers. These are the normal headset radio channels. |
| 800 | False | The command "bus" for everything. The messages are strings with a namespace: `backup-0/1`, `flush-0/1`, `<PREFIX>-0/1`, `fixfoam-TRIGGER_<X>`, `fixfoam-RESET_<X>` (X = A..H or ALL). |
| 851 | False | Reactor fuel % (a raw number) |
| 852 | False | Battery charge % (a raw number) |
| 853 | False | Flush door hold signal (a constant "1" while on, then a single "0") |

All the wifis have Range=20000 (covers the whole sub), AllowCrossTeamCommunication=False, MinChatMessageInterval=1 and DiscardDuplicateChatMessages=True.
Wifi transmits instantly and synchronously to **every other** wifi on the same channel, and that includes the receivers in the same module. That is why a local button also drives its own module.
Buttons are `button` (Controller, IsToggle=False). Each press sends one "1" pulse on signal_out.

Engine facts the designs rely on (from BAROTRAUMA_MECHANICS.md):
- Memory sends its Value **every tick**.
- Concat, arithmetic and And use TimeFrame=0. An input counts only if it was received since the last Update. So a component with one "every tick" input (a memory) and one pulse input outputs **once, only in the tick the pulse arrives**.
- Regex with ContinuousOutput=False sends **once per received signal**. With UseCaptureGroup=True and Output="1" (default), it sends capture **group 1**.
- SignalCheck is a Recv component: it sends `value==Target ? Output : FalseOutput`, and an empty string sends nothing. `set_targetsignal` changes the target at runtime.
- Greater is always active. It sends whenever either input arrived this tick.
- Relay forwards in1→out1 and in2→out2 only while on. `set_state` "1" turns it on and "0" turns it off.
- Color with UseHSV=True takes r=Hue(0–360), g=Sat(0–1), b=Value(0–1), a=Alpha(0–255). It sends "R,G,B,A" every tick.
- A connection pin holds at most **5 wires** (each fan-out list in this pack stops at 5). That limit is the reason for the relay "pin expander" trick below.

---

## 1. Chat Bridge (radio chat → command bus)  ×2 copies (@168,-1111 and @-200,-1111), 18 parts each

**Purpose:** a crew member types a keyword into normal radio chat on any channel 0–9 and the sub acts on it. No terminal is needed.
| Chat word | Emitted on wifi 800 |
|---|---|
| `flushon` | `flush-1` |
| `flushoff` | `flush-0` |
| `backupon` | `backup-1` |
| `backupoff` | `backup-0` |
| `fixall` | `fixfoam-TRIGGER_ALL` |
(The in-game notes say "backupon - Deactivate backup mode (backup-0)". That is a copy/paste typo: the regex really emits `backup-1`.)

**Parts:** 10 rx wifi (Channel 0,1,2,…,9, **LinkToChat="True"**), 2 relays, 5 regex, 1 tx wifi (Channel 800). Total 18.

**Signal flow:**
1. Ten wifis, one per channel 0..9, all with `LinkToChat=True`. When a player with a headset on that channel types in radio chat, the chat text comes out as a signal on `signal_out`.
2. Merge: channels 0,1,2,3,4 → `relay A.signal_in1`, and channels 5,6,7,8,9 → `relay A.signal_in2`. Relay A has IsOn="True".
3. Re-fan: relay A `signal_out1` and `signal_out2` **each** wire to both `relay B.signal_in1` and `relay B.signal_in2`, so every message reaches both of B's outputs. Relay B has IsOn="True".
4. Relay B `signal_out1` → regex `flushoff`, `flushon`, `fixall`. Relay B `signal_out2` → regex `backupon`, `backupoff`.
5. Each regex has `Expression="<word>" Output="<bus message>" UseCaptureGroup="False" FalseOutput="" ContinuousOutput="False"` and sends to the single tx wifi Channel="800".

**Why it works:**
- LinkToChat wifis turn typed radio chat into signals. (The wifi's `signal_out` must be wired or LinkToChat set, or it doesn't receive.)
- The regex is not anchored, so the word can appear anywhere in the message.
- With FalseOutput="" a non-matching chat line sends nothing. With ContinuousOutput=False a match sends exactly one message per chat line.
- The relays are just **wire hubs**: 10 sources cannot share one 5-wire pin, and 5 regexes cannot hang off one output pin either.

**Gotchas:**
- Pick keywords that do not contain each other: `flushon` vs `flushoff`, `backupon` vs `backupoff` are fine.
- Any chat line containing the word triggers it, including someone quoting it.
- Extending it (per the in-game note): add a regex with Expression=new word and Output=full bus message, wire relay B out → regex → tx wifi 800. If you run out of pins, add another relay or tx wifi.

---

## 2. Two-state Toggle Panel (Backup / Flush / generic `<PREFIX>`) with a status display

Copies: Backup ×2 (@156,-816 and @-232,-936), Flush ×2 (@157,-545 and @-216,-664), Generic ×2 (@168,-264 and @-232,-280).
Each panel has two independently wired halves that only talk over wifi 800: a **sender** (6 parts) and a **display/receiver** (18 parts, or 20 for Flush). There are also stand-alone **remote receivers** (2 parts each).

### 2a. Sender (6 parts: 2 button, 1 memory, 1 signalcheck, 1 concat, 1 wifi)
- `memory Value="backup-"` (or `"flush-"`, or `"<PREFIX>-"` for generic) → `concat.signal_in1`.
- ON button → `concat.signal_in2` **directly**. The button sends "1", so concat gives `backup-1`.
- OFF button → `signalcheck TargetSignal="1" Output="0" FalseOutput=""` → `concat.signal_in2`. This turns the button's "1" into "0", so concat gives `backup-0`.
- `concat.signal_out` → wifi Channel="800" signal_in.
- Why this sends only once: concat (TF=0) needs both inputs in the same tick. The memory provides in1 every tick, but in2 only arrives on a button press, so there is exactly one message per press.

### 2b. Display/receiver (18 parts)
Parts: wifi 800 rx, regex, 2 signalcheck, 2 relay, 2 color (HSV), 8 memory constants, concat, textdisplay.
1. `wifi Channel=800` → `regex Expression="backup-(0|1)$" UseCaptureGroup="True" FalseOutput="" ContinuousOutput="False"`. The regex outputs the bare capture, "0" or "1". (Generic panel: `"<PREFIX>-(0|1)$"`. Flush: `"flush-(0|1)$"`.)
2. Two relays act as a 2-way selector:
   - **ON relay** (`IsOn="False"`): `set_state` ← the regex output directly ("1" turns it on, "0" turns it off). `signal_in1` ← color ON, `signal_in2` ← memory `" on"`.
   - **OFF relay** (`IsOn="True"`, so the panel starts showing "off"). `set_state` ← two signal checks on the regex output:
     - `TargetSignal="1" Output="0" FalseOutput=""`: on "1" it turns the OFF relay off.
     - `TargetSignal="0" FalseOutput=""` (Output default "1"): on "0" it turns the OFF relay on.
     
     Its `signal_in1` ← color OFF, `signal_in2` ← memory `" off"`.
3. Both relays: `signal_out1` → `textdisplay.set_text_color`, and `signal_out2` → `concat.signal_in2`. `concat.signal_in1` ← memory `"Bkup"` (or `"Flush"`, or `"<LABEL>"`). `concat.signal_out` → `textdisplay.set_text`. The display shows "Bkup on" or "Bkup off".
4. The colors use `UseHSV="True"`:
   - OFF: r(hue) ← memory `"100"` (green), g and b ← memory `"1"`, a ← memory `"150"`.
   - ON: hue ← memory `"50"` (yellow), g and b ← `"1"`, a ← `"250"`.
   - The memory `"1"` is shared by g and b of both colors (it fans out to 4 pins).
5. The textdisplay's initial Text is `"Bkup off"` / `"Flush off"` / `"<PLACEHOLDER>"`, so it reads right before any message arrives.

Why it works: memory and color send every tick, so whichever relay is on keeps re-feeding text and color into the display every tick. The display stays latched **in the relay state itself**. The relays are complementary and both are driven by the same regex pulse, so exactly one is on at a time.

### 2c. Flush extra: door hold on wifi 853 (+2 parts → 20)
- Extra `relay IsOn="False"`: `signal_in1` ← memory `"1"` (the same "1" constant used for HSV sat/val). `set_state` ← the regex capture output. `signal_out1` → `wifi Channel=853`.
- The regex output is **also** wired straight into wifi 853.
- Result: flush ON makes the relay pass "1" every tick, so doors and hatches wired to `SET_STATE` are forced open continuously. Flush OFF sends regex "0" once to 853 (which closes the doors) and the relay stops the constant "1". After that the doors behave normally again: a single "0" pulse then silence, so players can still open them by hand.
- Remote end: a bare `wifi Channel=853` (2 placed, unwired at @248,-552 and @-152,-552). Wire its `signal_out` → door `set_state`.

### 2d. Remote receivers (2 parts each)
- `wifi 800` → `regex Expression="backup-(0|1)$" UseCaptureGroup="True" FalseOutput="" ContinuousOutput="False"`, with the output left unwired (@264,-824 and @-120,-824).
- Generic versions use `"<{PREFIX>-(0|1)$"` (@296,-168 and @-152,-168). Note the stray `{`: it is a typo in the pack and must be replaced with the real prefix.
- Use: regex out ("1"/"0") → `relay.set_state` (e.g. a relay between a backup battery POWER_OUT and the grid).

**Install for the generic panel:** set the sender memory `"<PREFIX>-"` (keep the `-`), the display regex `<PREFIX>-(0|1)$`, the receiver regex, the label memory `"<LABEL>"` and the display Text.

**Gotcha:** the `$` anchor plus capture means `flush-1x` is ignored. Because the regex is unanchored at the start, `xflush-1` would still match, so namespaces should not be suffixes of each other.

---

## 3. Fuel % and Battery % displays  ×2 each, 7 parts per display (+1 tx wifi per pair)

- Fuel @168,280 and @-264,168. Battery @184,56 and @-248,-56.
- Tx wifis (Channel 851: @232,280 and @-200,280; Channel 852: @232,56 and @-200,56) are unwired. The user wires reactor `FUEL_PERCENTAGE_LEFT` (or battery `CHARGE_%`) → tx `signal_in`.

Display (7 parts): `wifi 851` (rx), `memory "Fuel  "` (two spaces; battery uses `"Btry  "`), `memory "1"`, `memory "255"`, `concat`, `color UseHSV="True"`, `textdisplay`.
- rx `signal_out` → `concat.signal_in2` **and** `color.signal_r` (hue).
- memory `"Fuel  "` → `concat.signal_in1`, and concat → `textdisplay.set_text`. The display shows e.g. "Fuel  73".
- memory `"1"` → color g and b. memory `"255"` → color a. color → `textdisplay.set_text_color`.

**Trick:** the percentage itself is used as the HSV hue. 0 = red, ~50–60 = yellow, 100 = yellow-green (120 would be pure green). That gives a red→yellow→green gauge with **zero math parts**.

**Gotchas:**
- Concat only fires when the wifi value arrives (TF=0). The source must send every tick, which reactors and batteries do.
- Raw floats show many decimals unless the source is already rounded. Battery `charge_%` is rounded by the game, but fuel may not be. Add a `roundcomponent` before the tx if needed.
- Several batteries: sum their CHARGE_% with adders and divide by N before the tx (per the in-game note).

---

## 4. Fixfoam Detonator Node (round-robin, tagged, remote) ×3 copies (@104,696; @-280,680; @216,824), 32 parts each

**Purpose:** 3 detonators (load fixfoam grenades) near a hull area. Each trigger fires the **next** detonator in turn, so three uses per reload. Triggers come from:
- the local "Press to trigger detonators one after another" button,
- a dashboard button with the same tag (A–H),
- the global TRIGGER_ALL button,
- or chat `fixall`.

Red blinking lights mark the detonators already used. Optionally, nearby doors are held open for 5 s after a detonation so the foam spreads further.

**Parts:** 3 detonator, 3 lightcomponent (`IsOn="False" BlinkFrequency="1" LightColor="255,0,0,255" Range="10"`), 2 button, 2 wifi 800 (1 rx, 1 tx), 2 regex, 8 signalcheck, 4 memory, 2 concat, 2 and, 1 adder, 1 modulo, 1 delay, 1 round.

**Config:** the PINK memory `Value="Change this to one of A,B,C,D,E,F,G,H"` holds the node's tag letter. It feeds every place the tag is needed.

**Local send (trigger and reset):**
- `memory "fixfoam-TRIGGER_"` + tag memory → concat T. `memory "fixfoam-RESET_"` + tag memory → concat R.
- `and FalseOutput=""`: `signal_in1` ← button, `signal_in2` ← concat T, `set_output` ← concat T. The output goes to tx `wifi 800`. The same structure with concat R and the reset button also goes to that wifi.
- Why: And is true only in the tick of the button pulse (concat arrives every tick, the button only on press). `set_output` from the concat makes the And emit the **dynamic string** `fixfoam-TRIGGER_A`. FalseOutput="" keeps it silent otherwise.

**Receive/trigger path:**
1. rx `wifi 800` → `regex Expression="fixfoam-TRIGGER_([A-Z]{1}$|ALL)" UseCaptureGroup="True" FalseOutput="" ContinuousOutput="False"`. The output is the captured `A`…`H` or `ALL`.
2. Two parallel signal checks on the capture, both feeding `adder.signal_in1`:
   - `TargetSignal="ALL" FalseOutput=""` (Output "1").
   - `FalseOutput=""` with `set_targetsignal` ← tag memory (Output "1"). The memory sends every tick, so the target is always the configured tag.
   
   Either match puts a single "1" into the adder.
3. **Counter:** `adder.signal_in2` ← `memory Value="0"`. `adder.signal_out` → `modulo Modulus="3"`. `modulo.signal_out` → the memory's `signal_in` (stores the new count) **and** three signal checks.
   - The adder (TF=0) fires only in the tick in1 arrives, so the count goes up exactly once per trigger. The sequence is 1,2,0,1,2,0…
4. Three dispatch signal checks: `TargetSignal="0"`, `"1"` and `"2"`, all `FalseOutput=""` (Output "1"). Each one's out goes to:
   - its own `detonator.activate`,
   - its own `light.set_state` (turns the red blinker on, meaning "spent"),
   - `round.signal_in`,
   - `signalcheck "door-close" TargetSignal="1" Output="0" FalseOutput=""`.
5. **Door pulse:** that door-close check → `delay Delay="5" ResetWhenSignalReceived="False" ResetWhenDifferentSignalReceived="False"` → `round.signal_in`.
   - The round component's out is left for the user (GREEN round): round out → nearby door/hatch `set_state`.
   - So the doors get "1" immediately and "0" 5 s later.
   - Round is used as a **merge/buffer node**: it forwards numbers unchanged, has one output pin, and costs one part.

**Reset path (lights only):**
- rx wifi → `regex Expression="fixfoam-RESET_([A-Z]{1}$|ALL)" UseCaptureGroup="True" FalseOutput="" ContinuousOutput="False"`.
- Two signal checks, both `Output="0" FalseOutput=""`: one `TargetSignal="ALL"`, the other with `set_targetsignal` ← tag. They send to all 3 `light.set_state`, which turns the blinkers off after reloading.
- The counter is NOT reset, and it doesn't need to be: it is round-robin, so after a reload it keeps rotating.

**Gotchas:**
- `[A-Z]{1}$` forces exactly one letter at the end. The `|ALL` alternative still matches `TRIGGER_ALL` (`[A-Z]$` fails at the "A" of ALL, then `ALL` matches).
- An unset tag ("Change this…") never equals a single letter, so the node responds only to ALL.
- Round-robin assumes all 3 detonators are loaded. A trigger on a node whose next detonator is empty does nothing visible, but still advances the count.

---

## 5. Detonator Dashboard (remote, per-tag counters with remaining-charges display)

Copies: tags A–D ×2 (@104,1048 and @-200..-472,936..1000), tags E–H ×1 (@264,1048). 94 parts each.
Each covers 4 tags, with 4 buttons and 4 textdisplays.

**Purpose:** one button per tag fires the next detonator on every node with that tag. The display next to it shows `AAA 3/3` → `AAA 2/3` → … → `AAA 0/3`, with the color going green→yellow→orange→red. The count stays at 0/3 (saturates) until a RESET for that tag or ALL arrives.

**Per-dashboard shared constants:**
- `memory "fixfoam-TRIGGER_"` (send prefix), `memory "TRIGGER_"` and `memory "RESET_"` (match prefixes).
- `memory "4"` (counter ceiling), `memory "3"` (charges), `memory "/3"` (suffix), `memory "33.3"` (hue step), `memory "100"` (base hue), `memory "200"` (alpha).
- `memory "1"` → a relay (both inputs ← the same memory, `IsOn="True"`). The relay's out1 → g of all 4 colors and out2 → b of all 4 colors. This is the pin expander: one memory pin gives 8 destinations.
- Per tag: a tag-letter memory (`"A"`…; the PINK ones, editable) and a label memory (`"AAA "`, `"BBB "`…; the YELLOW ones, keep the trailing space).

**Send (per tag):** `and FalseOutput=""`: `signal_in1` ← button, `signal_in2` ← tag memory (any non-"0" string counts as "on"), `set_output` ← concat(`"fixfoam-TRIGGER_"` + tag). All 4 Ands → one tx `wifi 800`.

**Receive and decode:**
1. rx `wifi 800` → `regex Expression="fixfoam-([A-Z_]+)" UseCaptureGroup="True" FalseOutput="" ContinuousOutput="False"`. The capture is e.g. `TRIGGER_A` or `RESET_ALL`.
2. Fan-out relay (`IsOn="True"`, in1 and in2 both ← the regex): out1 → 5 trigger checks, out2 → 5 reset checks.
3. Trigger checks (FalseOutput="", Output "1"):
   - one `TargetSignal="TRIGGER_ALL"` → all 4 adders' in1;
   - four with `set_targetsignal` ← concat(`"TRIGGER_"` + tagMem) → their tag's adder in1.
4. Reset checks (`Output="0" FalseOutput=""`):
   - four with `set_targetsignal` ← concat(`"RESET_"` + tagMem) → that tag's `greater.set_output` and count `memory.signal_in` (writes 0);
   - one `TargetSignal="RESET_ALL"` → a fan-out relay (in1 and in2 both ← it) whose out1 and out2 reach all 4 greaters' set_output and all 4 count memories.

**Saturating counter (per tag):**
- `count memory Value="0"`. `adder`: in1 = trigger pulse "1", in2 = count.
- adder out → `greater.signal_in2` **and** `greater.set_output`.
- `greater Output="0" FalseOutput=""`: `signal_in1` ← memory `"4"`, and its out → count `memory.signal_in`.
- So the greater writes the new count only if `4 > newCount`, which caps the count at 3. Feeding the candidate value into `set_output` makes Greater a **"pass value if below limit" gate**.
- Greater is always active and memory "4" arrives every tick, so the greater keeps re-writing its latched Output each tick. That is consistent, because the Output equals the stored count.
- After saturation (Output=4, in2=4) it sends nothing. A reset writes "0" to both the memory and set_output, so the counter recovers.

**Display math (per tag):**
- `subtract`: in1 ← memory `"3"`, in2 ← count, giving remaining.
- concat(label `"AAA "` + remaining) → concat(… + `"/3"`) → `textdisplay.set_text`.
- `multiply`: memory `"33.3"` × count → `subtract`: memory `"100"` − that → `color.signal_r` (HSV hue: 100, 66.7, 33.4, 0.1).
- color g and b ← the relay-expanded "1", a ← memory `"200"`. color → `textdisplay.set_text_color`.

**Gotchas:**
- The dashboard counts button presses / bus messages, not real detonations. It assumes each tag has nodes with 3 charges, so "3/3" is a hard-coded constant.
- If two dashboards exist (the A–D one is duplicated), both decode the same bus, so they stay in sync automatically. This is a nice property of the shared-bus design.
- The count memory and the constant memories send every tick, so subtract, multiply, concat and color recompute every tick. The display always reflects the stored count, with no event needed.

---

## 6. Global Fixfoam Controls  ×2 (@-264,392 and @168,520), 5 parts each

- Button "Trigger ALL detonators" → `signalcheck TargetSignal="1" Output="fixfoam-TRIGGER_ALL" FalseOutput=""` → `wifi 800`.
- Button "Reset ALL detonator counters" → `signalcheck TargetSignal="1" Output="fixfoam-RESET_ALL" FalseOutput=""` → the same wifi.
- **Trick:** a signal check works as a "button → constant string" converter (1 part instead of memory + and).

---

## Reusable patterns

1. **Chat command input**
   - Recipe: `wifi Channel=N LinkToChat=True` (one per channel you want to listen on) → `regex Expression="keyword" Output="<message>" UseCaptureGroup=False FalseOutput="" ContinuousOutput=False` → action / tx wifi.
   - When: give crew text commands over the headset with no terminal. Use a distinct keyword set, because the regex matches anywhere in the line.

2. **Relay as pin expander / wire hub**
   - Recipe: `relay IsOn=True`, with signal_in1 and signal_in2 both ← the same source. That gives 10 destinations instead of 5 (5 wires per pin).
   - Merge variant: up to 5 sources → in1 and 5 → in2. Cross-wire out1 and out2 into a second relay's in1 and in2 so that both of its outputs carry every signal.
   - When: you hit the 5-wires-per-pin limit for fan-out or fan-in. A relay forwards on Recv, so it adds no tick delay.

3. **Namespaced wifi bus with regex capture decode**
   - Recipe: senders emit `"<ns>-<payload>"` on one channel (800). Receivers use `regex Expression="<ns>-(0|1)$"` (or `"<ns>-([A-Z_]+)"`) with `UseCaptureGroup=True FalseOutput="" ContinuousOutput=False`, which outputs just the payload.
   - When: many independent features share one channel without crosstalk, and new consumers can be added anywhere without new wiring.

4. **Prefix + value message builder (pulse-gated concat)**
   - Recipe: `memory "<ns>-"` → concat.in1, and the pulse value → concat.in2 → wifi.
   - Concat TF=0 fires only in the tick the pulse arrives, so there is one message per event.
   - For a "0" from a button: `signalcheck TargetSignal=1 Output=0 FalseOutput=""` between the button and concat.in2.

5. **Button → constant string**
   - Recipe: `signalcheck TargetSignal="1" Output="<string>" FalseOutput=""` fed by the button.
   - Dynamic string variant: `and FalseOutput=""` with in1 ← button, in2 ← any every-tick non-"0" signal, and `set_output` ← a concat that builds the string.

6. **Configurable compare (runtime target)**
   - Recipe: `signalcheck FalseOutput=""` with `set_targetsignal` ← memory (or concat(prefix + memory)). Pair it with a second fixed `TargetSignal="ALL"` check onto the same output to get "my tag OR broadcast".
   - When: one editable memory configures a node's address, or you need to compare two signals for string equality.

7. **Complementary relay pair = latched 2-way selector (status display)**
   - Recipe:
     - relay ON (`IsOn=False`, set_state ← state "1"/"0"), with in1 = color ON and in2 = text ON.
     - relay OFF (`IsOn=True`), whose set_state ← two signal checks on the state: `[Target=1 Output=0 FalseOutput=""]` and `[Target=0 Output=1 FalseOutput=""]`. Its in1 = color OFF and in2 = text OFF.
     - Both out1 → display.set_text_color. Both out2 → concat(label + …) → display.set_text.
   - When: show on/off (or any 2-way) state with text and color. The relay state *is* the memory, and the every-tick constants keep the display refreshed.

8. **Hold-while-on plus single release pulse**
   - Recipe: `relay IsOn=False` with in1 ← memory "1" and set_state ← state. Wire the state directly to the same output as well.
   - The output is "1" every tick while on, and a single "0" when it turns off.
   - When: force doors open (or anything) but give control back afterwards instead of holding "0".

9. **Round-robin dispatcher (modulo counter)**
   - Recipe:
     - pulse "1" → adder.in1; `memory "0"` → adder.in2; adder → `modulo Modulus=N`; modulo → memory.signal_in.
     - Also modulo → N × `signalcheck TargetSignal=k FalseOutput=""` (k = 0..N-1), each one → device k.
   - When: fire N single-use devices one after another from one trigger (detonators, flares, pumps in rotation).

10. **Saturating counter**
    - Recipe: adder(pulse "1", count memory) → `greater.signal_in2` and `greater.set_output`; `greater Output="0" FalseOutput=""` with in1 = memory "LIMIT+1"; greater out → count memory.
    - Reset: a check with `Output="0"` → count memory and `greater.set_output`.
    - When: count uses or charges up to a limit without overflow.

11. **Value → color gauge with HSV**
    - Recipe: `color UseHSV=True` with r(hue) = value, g = b = memory "1", a = memory "255". Out → `textdisplay.set_text_color`.
    - For a percentage, hue = pct gives red→green directly. For a count, hue = `100 - 33.3*count` (multiply + subtract) gives green→red steps.
    - When: color-coded displays without comparators.

12. **Delayed off-pulse (timed hold)**
    - Recipe: event "1" → output (via a round/buffer). In parallel, `signalcheck Target=1 Output=0 FalseOutput=""` → `delay Delay=T Reset*=False` → the same buffer.
    - The output is "1" now and "0" after T seconds.
    - When: open doors or turn something on for a fixed time after an event. A `roundcomponent` makes a cheap 1-pin merge node for numeric signals.

13. **"Used" indicator lights**
    - Recipe: `lightcomponent IsOn=False BlinkFrequency=1 LightColor=255,0,0,255 Range=10`. Set_state ← "1" on use, and set_state ← `signalcheck Output=0` on reset.
    - When: show which consumables need reloading.
