> Study notes written by Claude from the netlist of the community files (`node sim/cli.js explain <file>`), to learn how they work. The original files are not in this repo. HuskOS by its Steam Workshop author (workshop id 3337411715). Behaviour described from reading the wiring against reference/BAROTRAUMA_MECHANICS.md; not tested in game unless stated.

# HuskOS: design notes for building a different circuit OS

Sources: `/tmp/claude-0/ex/Examples/HuskOS 2.3.3/` (raw), netlists in `/tmp/claude-0/exp/*.txt`. Mechanics are from
`/home/user/BarotraumaMockReactorSim/reference/BAROTRAUMA_MECHANICS.md` and the sim (`sim/components.js`).
Component names like `regex21` refer to `[regex21]` inside the box being described.
"Upd" means the component outputs in its Update (at most one value per tick, 0-1 tick of latency that depends on
ItemList order). "Recv" means it outputs synchronously when the signal arrives.

Items marked **(analysis)** come from reading the wiring against the mechanics reference. I did not run them in the
game or the sim. Items marked **(uncertain)** depend on game behaviour that the reference does not pin down.

---

## 1. Main assembly: HuskOS 2.3.3 'Main' (`HuskOS.xml`)

### 1.1 Physical layout (outside the boxes)

| Item | Settings that matter | Wiring |
|---|---|---|
| `terminal#860` | WelcomeMessage `OS Version 2.3.3 'Main'`, LineStartSymbol `HuskOS > `, UseMonospaceFont, TextColor 59,167,123 | `signal_out` → CORE.in1 and the clear regex. `signal_in` ← CORE.out6 and the clear regex. `clear_text` ← clear regex |
| `regexcomponent#861` (clear) | Expr `^(?i)^clear(.*)?$`, Output `OS Version 2.3.3 'Main'`, FalseOutput "", ContinuousOutput False | out → `terminal.clear_text`, then `terminal.signal_in` (in that wire order, so it clears and then reprints the welcome line) |
| `signalcheckcomponent#1328` | Target "", Output "", FalseOutput `clear` | Any non-empty value from a module (login box out4, accounts box out3) becomes the literal `clear` and is sent into the clear regex. This is a "request clear" bus |
| `oscillator#859` Square 0.4 Hz → `signalcheck#1327` (Target `1`, Out `HuskOS> \|`, False `HuskOS>`) → `textdisplay#855.set_text` | | Blinking cursor on a side display. Cosmetic only |
| `lightcomponent90#858` | IsOn False | `set_state` ← syslog box out2: "Limit Reached" turns it on. The steady "0" stream keeps it off |

There are six circuit boxes (box I/O labels below are from the showcase sub):

| Box | Role | Inputs | Outputs |
|---|---|---|---|
| `#1263` CORE | parser, channel select, echo/listen, pwd/whoami/os-release/sudo error, output merge | in1 Terminal Input, in2 Module Feedback (from every module), in6 Superuser Name, in7 Who's logged in, in8 CLI-input toggle | out1 "Recommended modules" (to NTP), out2 "Non-essential" (to custom and syslog), out6 Terminal Feedback, out7 to the login module (commands), out8 raw terminal text (to the login module) |
| `#1126` LOGIN | login/su, logout, tmout, current-user register | in1 CMD, in2 raw input, in3 feedback from accounts, in4 set current user | out1 feedback, out2 usernames, out3 passwords (to ACCOUNTS), out4 clear terminal, out7 logged-in user (continuous), out8 CLI-input toggle |
| `#995` ACCOUNTS | user/password table and check | in1 username query, in2 password query | out1 feedback, out2 update user, out3 clear terminal, out8 superuser name (continuous) |
| `#1041` NTP | uptime clock, `time` command, broadcasts 120-124 | in1 CMD | out1 feedback |
| `#1191` CUSTOM | example commands, neofetch | in1 CMD, in2 current user, in8 superuser (unused inside) | out1 feedback, out2 clear (unused inside) |
| `#862` SYSLOG | 10-slot command log | in1 CMD, in2 user, in8 superuser | out1 feedback, out2 "Limit Reached" |

Every module's out1 goes into CORE.in2, which is wired straight to CORE.out6 and the terminal. So feedback is a
fan-in bus: modules never need their own terminal wire.

### 1.2 Input pipeline in CORE (#1263): the exact path of one typed line T

1. The terminal sends T on `signal_out` when the player presses Enter (once per line).
2. CORE.in1 sends T to:
   - out8 (raw text to the login box's "input system"),
   - `relay10` in1 and in2 (both pins).
3. `relay10` (IsOn True) is the **command lock**. While the login box is collecting a username or password, it is
   toggled off. Those lines then reach only the raw path, so they are not parsed, logged, or echoed.
   - It is toggled by CORE.in8 through `delay15` (0.01 s). The source is login-box out8: the login regex match, and
     then the password line.
   - out1 → `relay30`.in1. out2 → `relay30`.in2 and CORE.out7 (commands to the login box).
4. `relay30` (IsOn True) is the **require-login lock**. Its `set_state` comes from `signalcheck31` (Target `No User`,
   Output default "1", FalseOutput "1"), which is fed the current user every tick.
   - Shipped default: login is NOT required, because both outputs are "1".
   - Setting Output to "0" closes the parser while the user is "No User". The login path stays open because it taps
     relay10.out2 before relay30.
5. Numbers versus commands. relay30.out1 sends T to `regex2` (`^[0-9]+$`) on both `signal_in` and `set_output`, so the
   regex outputs T itself when T is all digits. relay30.out2 sends T to:
   - `wifi1.set_channel`: changes the "current channel" (404 by default). Non-integers are ignored by int.TryParse.
   - `xor16.signal_in1` and `xor16.set_output`: Xor TimeFrame 0.01, initial Output "hi :3".
   - regex2.out (only when T is numeric) goes to `xor16.in2`, `memory34` (remembers the channel for "listen") and
     `regex8.set_output` (pwd).
   - So the Xor emits T only when in1 arrives without in2, which means T is not a number. The **Xor is the "else"
     branch**: numbers select a channel, everything else is a command.
6. Xor out → `relay7` in1 and in2 (IsOn True; it is used as a two-way splitter):
   - out1 → `regex21` (sudo error).
   - out2 → every command regex in CORE, plus CORE.out1 (NTP) and CORE.out2 (custom and syslog).
7. All CORE command results merge into `relay22` (IsOn True, never toggled; a tidy junction) and go out on CORE.out6
   to the terminal.

### 1.3 Commands (complete list for 2.3.3)

Regex commands use `^(?i)^name(.*)?$` (case-insensitive; any suffix, so `clearxyz` also matches) or `(\s.*)?`
(the suffix must start with whitespace). SignalCheck commands are exact and case-sensitive.

| Command | Where | Match | Behaviour / output |
|---|---|---|---|
| `<number>` | CORE regex2 | `^[0-9]+$` | Sets `wifi1.Channel` (the "current channel"). No feedback. Updates pwd and listen's "From N" |
| `echo <text>` | CORE regex4 | `^(?i)echo (.+)$`, UseCaptureGroup True, Output default "1" (= group 1) | Builds concat3 (`memory12` "HuskOS Echo from " + current user) + `": "` + text, giving `HuskOS Echo from huskos: text`, and transmits it on the current channel through wifi1. Nothing is printed locally |
| `listen` | CORE regex29 | `^(?i)^listen(.*)?$`, Output `Listening to current channel. To check channel, type "pwd".` | Toggles `relay13` (IsOn False). While on, `wifi1.signal_out` → relay13 → concat33 = ("From " + memory34) + ":" + msg, giving `From 50:msg` on the terminal. Typing listen again stops it |
| `pwd` | CORE regex8 | `^(?i)^pwd(.*)?$`, Output `404` | Output is overwritten by the last numeric input, so it prints the current channel |
| `whoami` | CORE regex9 | Output set every tick from CORE.in7 (current user) | Prints the user name, or `No User` |
| `os-release` | CORE regex5 | Output `VERSION_ID="HuskOS Version 2.3.2 'Main'"` | Constant (stale version string) |
| `sudo ...` | CORE regex21 | `^(?i)^sudo(\s.*)?$`, Output `Err: You are not a sudoer...` | Goes through `relay37`, whose set_state is `signalcheck23` (Target = superuser name from CORE.in6, Output "0", FalseOutput "1", input = current user). So the error prints only for non-superusers. This only reports the error; it does not block anything |
| `clear` | terminal-side regex#861 | `^(?i)^clear(.*)?$` | clear_text, then reprints the welcome line. It sits on the raw terminal output, so it works even while the parser is locked |
| `login` / `su` | LOGIN regex39 | `^(?i)^(login\|su)(\s.*)?$`, Output `Enter Username` | See 1.4 |
| `logout` | LOGIN signalcheck35 | exact `logout`, Output `No User` | Writes `No User` into the current-user memory7. signalcheck36 (Out "", False `Logged out`) prints `Logged out` through delay37 |
| `sudo tmout on` / `sudo tmout off` | LOGIN signalcheck16/15 | exact | Enables or disables the 60 s inactivity logout (superuser only). See the bugs in section 5 |
| `time`, `time -dh`, `time -dhm`, `time -hms` | NTP regex36/34/35/37 | `^(?i)^time$`, `^(?i)^time -dh(\s.*)?$`, ... | Prints `DD HH:MM:SS`, `DD HH`, `DD HH:MM`, `HH:MM:SS`. Each regex's Output is set every tick by the clock concat |
| `neofetch` | CUSTOM regex15 | `^(?i)^neofetch(.*)?$` | ASCII art (17 lines), then `OS: HuskOS 2.3.2 'Main'`, `User: <user>`, `Uptime: <DD HH:MM:SS>` |
| `sudo syslog reset` | SYSLOG regex42 + superuser | | `Resetting syslog. This won't do anything if your memory is full.` Sets mux to slot 0 and re-enables logging |
| `sudo syslog toggle` | SYSLOG regex5 + superuser | | Toggles logging. Prints `Toggling syslog, state set to: ON/OFF` |
| `info`, `toggle light`, `homework`, `secret` | CUSTOM (examples) | exact | See 1.8 |

### 1.4 Login, accounts, current user, permissions

**Current-user register**: LOGIN `memory7` (Value "No User").
- It outputs every tick on LOGIN.out7, which goes to CORE.in7, CUSTOM.in2 and SYSLOG.in2.
- Writers: `logout` ("No User"), ACCOUNTS.out2 (a successful login, via LOGIN.in4), and the tmout watchdog (relay14 → "No User").

**Login state machine** (LOGIN #1126). Three relays are used as state flags:
- `relay2` (IsOn True): "login allowed".
- `relay1` (IsOn False): "capture the next line as the username".
- `relay4` (IsOn False): "capture the next line as the password".

1. `login` arrives on in1 (the command path) → relay2 → regex39 matches → `Enter Username` goes to:
   - `relay2.toggle` (off; no re-entry),
   - `delay38` (0.05 s) → `relay1.toggle` (on),
   - LOGIN.out8, then CORE.in8, then delay15, then `relay10.toggle`: the **command parser is now locked**,
   - LOGIN.out4: clear the terminal,
   - `delay37` (0.01 s) → out1: print `Enter Username` after the clear.
2. The username line U arrives on in2 (the raw path; the parser is locked) → relay1.out1 →
   - ACCOUNTS.in1 (username query),
   - concat9 = "Enter password for " + U → `signalcheck10.set_output`,
   - `signalcheck3` (Out "", False "1") → "1" goes to:
     - `relay1.toggle` (off),
     - `delay5` 0.05 s → signalcheck10 (Target "1") → prints `Enter password for U` (via delay37),
     - `delay11` 0.1 s → `relay4.toggle` (on).
   - The 0.1 s delay matters. Propagation is depth-first and synchronous. If relay4 opened in the same call chain, U
     would reach `relay4.in1` next (it is the next wire on in2) and be taken as the password.
3. The password line P arrives → relay4.out1 → ACCOUNTS.in2 and `signalcheck6` (False "1") → "1" goes to:
   - LOGIN.out8 (**unlock the parser**),
   - `relay2.toggle` (login allowed again),
   - `relay4.toggle` (off).

**ACCOUNTS (#995)**. Each account is two memories and two signal checks:
- `superuser`: memory0 = `huskos` (username), memory9 = `huskos` (password).
  - `signalcheck2`: Target ← memory0, Output ← memory9. If U == `huskos` it outputs the password, which sets
    `signalcheck1.set_targetsignal` (the expected password) and feeds `signalcheck12`.
  - `signalcheck12`: Target ← memory9, Output ← memory0. Its input is always the password, so it outputs the
    username into `memory3` (the "pending user").
- `user2` / `password`: memory14 / memory13, through signalcheck15 / signalcheck16, the same way.
- Password check: P → `signalcheck1` (Output "1", FalseOutput "0", Target = the expected password).
  - "1" goes to signalcheck5 `Successfully logged in as: ` + memory3 + `" "` → delay19 → feedback, and out3 (clear).
  - "1" also goes to `relay4.toggle`, then `delay8` (0.05 s) → `relay4.toggle` again. relay4 (IsOn False) carries
    the memory3 stream to out2, so this opens a **3-tick window** in which the pending user is written into LOGIN
    memory7 (through LOGIN.in4). The same signal resets the tmout watchdog.
  - "0" (wrong password): `toggle` ignores "0", so the gate never opens. signalcheck6 prints
    `Error, incorrect username or password` (delay17) and clears the terminal (out3).
- Superuser name: memory0 outputs every tick on ACCOUNTS.out8, which goes to CORE.in6, SYSLOG.in8 and CUSTOM.in8.
  - Because commands use `set_targetsignal` from that wire, renaming the superuser memory updates every check.
  - Changelog "Patched superuser spoofing vulnerability": older versions distributed the name on wifi channel 3389,
    so anyone on that channel could redefine the superuser. 2.3.3 wires it.

**Permissions model**:
- There are no privilege levels. A protected command is `AND(command matched, current user == X)`.
- `signalcheck(Target=X)` is fed the current-user stream every tick, so its "1" is always fresh for an And with
  TimeFrame 0.
- An OR of several user checks (or one regex `\b(huskos|user1)\b`) allows multiple users.
- `sudo` is only a naming convention: `sudo syslog reset` is a literal command string. CORE prints the "not a sudoer"
  error separately.

**tmout (inactivity logout)**:
- `delay13` (Delay 60, ResetWhenDifferentSignalReceived True) is fed:
  - `memory12` "No User" every tick,
  - every command (in1),
  - each login (in4).
- A different value clears the queue, so any activity restarts the 60 s countdown.
- After 60 s of only "No User", it starts emitting "No User" every tick → `relay14` (IsOn False; the enable flag) →
  memory7 = "No User".
- Enable: `sudo tmout on` → signalcheck16 → and17 (And with `signalcheck19` = "current user == the name received on
  wifi20, channel 3389") → `relay14.set_state`. and0 → signalcheck18 prints `Login timeout enabled.` / `disabled.`

### 1.5 NTP clock (#1041) and channels 120-124

- **Seconds counter**: `oscillator0` (defaults: Pulse, 1 Hz) → `adder4.in2`. `memory1.out` → `adder4.in1`, and
  `adder4.out` → `memory1.in`.
  - The adder (TimeFrame 0) needs both inputs fresh in the same Update. Memory is fresh every tick; the pulse arrives
    once per second. So it adds exactly once per second: a **memory feedback loop used as a writable register**.
- `memory1` → `wifi2` channel **120**: the raw seconds count, every tick. It is also used by syslog as a timestamp.
- Decomposition, using memories as constants (86400, 3600, 60, "0"):
  - days = floor(s/86400)
  - hours = floor((s mod 86400)/3600)
  - minutes = floor((s mod 3600)/60)
  - seconds = s mod 60
- **Zero padding**: concat("0", n) → regex `(.{2})$` with UseCaptureGroup (group 1), which gives the last two
  characters. FalseOutput is `Error: Regex failiure.`
- Formats are broadcast every tick:
  - `DD HH` → ch **121**
  - `DD HH:MM` → ch **122**
  - `DD HH:MM:SS` → ch **123**
  - `HH:MM:SS` → ch **124**
- The same concats drive `set_output` of the `time` regexes, so each command prints the latest string.
- The neofetch "Uptime" reads ch 123 through CUSTOM `wifi24`.

### 1.6 Syslog (#862): a 10-slot ring buffer of memories

- **Entry**: `relay4` (IsOn True; "logging on") carries the user (in2 → in1 → out1) and the command (in1 → in2 → out2).
  - concat2 = `<seconds from ch120>` + `"  "` + user
  - concat50 = concat2 + `" : "` + command, giving `1234  huskos : neofetch`
- **Slots**: each slot is a `memory` (MaxValueLength 256) plus a `relay` (IsOn True; used only as a 2-lane junction).
  - Read lane: memory.out → relay.in2 → relay.out2 → `multiplexer13.signal_inK`.
  - Write lane: `demultiplexer12.signal_outK` → relay.in1 → relay.out1 → memory.in.
  - Slots 0..9 use memories 1, 15, 31, 32, 28, 27, 29, 30, 25, 26.
- **Append**:
  - The mux forwards the selected memory's value every tick → `concat3.in1` (separator `" | "`).
  - The new entry goes to `concat3.in2`.
  - Concat fires only on ticks when both inputs are fresh, which is only when an entry arrives.
  - `slot + " | " + entry` → `demux.signal_in` → written back into the same slot.
  - The demux selection follows the mux every tick (`mux.selected_input_out` → `demux.set_output`).
- **Advance**: each slot memory also feeds a regex `^.{245,}$` ("almost full"). Output is the next slot index:
  slot 0 → "1" (default Output), slot 1 → "2", ..., slot 8 → "9", slot 9 → `Limit Reached`. These go through
  `relay41` → `mux.set_input`.
- **Full**: `Limit Reached` goes to:
  - SYSLOG.out2 (the indicator light),
  - `signalcheck45` → "0" → `relay4.set_state` (logging off).
- **Monitoring**: `demux.selected_output_out` → concat43 `Current syslog log number: N`. Its output is left unwired
  for the user.
- **Reset / toggle**:
  - `sudo syslog reset`: And(regex42, user == superuser) → `signalcheck9` (FalseOutput "0") → `mux.set_input 0`, and
    `relay4.set_state` on. It does not clear the memories (see weaknesses).
  - `sudo syslog toggle`: And(regex5, superuser) → `relay4.toggle`. The message is built from `relay4.state_out` →
    signalcheck47 (`1`→"OFF", else "ON"); it reads the pre-toggle state, so the label is inverted on purpose.

### 1.7 Neofetch (CUSTOM #1191): a string-splitting loop

- `or16` Output is 17 art lines separated by `}`, exactly **200 chars**: the Or's MaxOutputLength. The art was too
  long, so it is split across `or16` and `or17` (160 chars).
- Loop:
  - `regex15` (neofetch) → `or16.in1` → or16.out → `or19.signal_in1` and `or19.set_output`.
  - or19 is an Or used as an **Update-driven pass-through latch**: it emits whatever string it was just given.
  - or19 → `regex21` (`^((?<output>.*?)\}(?<output2>.*))`, Output `output`) → the head line → terminal.
  - or19 → `regex20` (same expression, Output `output2`) → the tail → back into or19. Each turn takes at least one
    tick, so each line is a separate signal.
  - When the tail has no `}`, both regexes fail with FalseOutput "", and the loop ends.
- **Continuation sentinel**: or16 was truncated at 200, so its tail is the half line `@@@  @@@@ @@@@ @@`.
  `signalcheck18` (Target = that exact fragment) fires `or17`, which restarts the loop with part 2. Part 2 repeats
  the full line.
- **Trailer**: `signalcheck30` (Target = the last art line `            @`) → Out `OS: HuskOS 2.3.2 'Main'` → `delay34`
  (0.01) → terminal and `or22.in1`.
  - or22's Output is set each tick to `User: ` + user (memory28's default `Err: Login module disconnected` shows if
    no user stream arrives).
  - or22 → `delay32` → terminal and or23. or23's Output is `Uptime: ` + ch123 time → `delay31` → terminal.
  - Each delay 0.01 defers one Update, so the trailer lines come out in order.

### 1.8 Example custom commands (CUSTOM)

- `info`: signalcheck0 → `The captain is gay`, and `delay1` (default 1 s) → signalcheck2 (Out "", False `VERY gay!`)
  → a second line 1 s later. Per the label, the 1 s spacing makes it work over radio chat, which allows one message
  per second.
- `toggle light`: signalcheck3 → "1" on `wifi5` ch **50** (a device listens there: the showcase emergency light
  `toggle`), and signalcheck4 → `Toggled light`.
- `homework`: And(signalcheck6 "homework", signalcheck7 user=="huskos") → `(.) (.)`.
- `secret`: And(signalcheck9, Or(user=="huskos", user=="huskos") or regex14 `\b(huskos|user1)\b`) → message.

---

## 2. Extras

### 2.1 HuskOS Bleeding Edge (`HuskOS Bleeding Edge.xml`, version "2.1.0 'Bleeding Edge'", WelcomeMessage `OS Version 2.1.0 Bleeding Edge`)

This is an older, radio-first dev branch. It is not newer than 2.3.3. It has 4 boxes: CORE #665, CUSTOM #874,
LOGIN #821, ACCOUNTS #777. Differences from Main:

- **The terminal is connected over radio, not wires.**
  - terminal ↔ `wificomponent#760` (ch **23**).
  - CORE `wifi0` (ch 23) is both the input and the feedback output. Every result is transmitted on 23.
  - So a player with a headset on channel 23 can type commands in chat and read the replies ("Once you switch to the
    channel, type the commands into the chat").
- **Wireless reconfiguration**:
  - Saying a number on ch **161** sets both the terminal wifi (`wificomponent#763 → #760.set_channel`) and CORE
    `wifi28 → wifi0.set_channel`.
  - ch **587** → `wifi27 → wifi26.set_channel` (the multicast input).
- **Configurable multicast**:
  - Input `wifi26` on ch **25** feeds 5 transmitters (wifi25/24/23/22/21, default channels 0/1/2/3/4).
  - Their channels are set by radio on ch **2200, 2201, 2202, 2203, 2204** (`wifi20..15 → set_channel`).
- **Two-step echo ("command line input system")**:
  - `echo` (regex4 `^(?i)^echo(\s.*)?$`, Output default "1") toggles `relay12` and `relay11` on.
  - `relay12.state_out` → signalcheck3 (Target "1" → "0") → `relay10.set_state 0`, which locks the parser.
  - The next line goes through wifi0 → relay12 → relay11 → `wifi1` (current channel) **raw, with no prefix**.
  - signalcheck14 (False "1") then toggles relay11, relay12 and relay10 back.
  - **(analysis)** Because relay10 is re-enabled synchronously before wifi0's later wires reach relay10.in1, that
    same text probably also gets parsed as a command.
- Login box: `tmout on` / `tmout off` without sudo or a superuser check; they drive `relay14.set_state` directly
  (this works, because set_state accepts "0").
  - The success message is `Successfully logged in as: X | Clear your terminal if you are using one.` There is no
    auto-clear and no clear-request bus.
- `clear`: a plain `signalcheckcomponent#756` (Target `clear`, Output `OS Version 2.1.0 Dev Branch`) → `clear_text`
  and `signal_in`.
- `echo`/`os-release`/`pwd` regexes use `(\s.*)?`. Xor Output is `error, no output`.
- No sudo, NTP/time, neofetch or syslog. CUSTOM: `homework` for huskos, `secret` for user1 OR user2.
- Device: `emergencylight#768.toggle` ← `wificomponent#767` ch 50.

Summary of what 2.3.3 changed relative to this branch:
- wired terminal ("reduced wifi component usage"),
- regex clear plus a module-requested clear,
- login clears the screen (hides the typed password),
- superuser and sudo error,
- superuser name wired instead of on ch 3389,
- NTP, time, neofetch, syslog,
- echo became a one-line capture-group command with a "from user" prefix,
- the radio multicast and reconfiguration moved out into separate assemblies.

### 2.2 HuskOS NTP Clock (`HuskOS NTP Clock.xml`): remote display

- 4 wifis (ch 121, 122, 123, 124) → `multiplexer#806` in0..3 (SelectedConnection 2, i.e. DD HH:MM:SS by default)
  → `textdisplay.set_text`.
- `button` (Output "1", FalseOutput "0") → `mux.move_input`. Each press moves +1 and wraps; a "0" moves 0.
- It works because the clock broadcasts every tick, so the mux always has a fresh value on the selected input.

### 2.3 Multicast system (`Multicast system.xml`): one-to-many radio fan-out

- One box: `wifi0` ch **9** → signal_in of 5 wifis on ch 2, 1 (default), 3, 0, 4.
- Say something on ch 9, and it is re-broadcast on channels 0-4. The channels are physically configured.
- The note says the wirelessly configured version is the Bleeding Edge one.

### 2.4 Configurable Unicast Radio Signal (`Configurable Unicast Radio Signal.xml`)

One box:
- `wifi0` (ch **10**, input) → `wifi1.set_channel` (integers retarget the output; text is ignored),
  `greater2.in1`, `delay3.signal_in`, `signalcheck5` (Target "0").
- `memory4` "0" → `greater2.in2`. Greater has FalseOutput "".
- `delay3`: 0.05 s, **ResetWhenSignalReceived True**.
- greater2 and signalcheck5 outputs also go into delay3 → `wifi1.signal_in`.

Intent ("any signal within 0.05 s cancels"): a number selects the channel and is not forwarded; text is forwarded
to the selected channel after 0.05 s.

**(analysis)** How it actually behaves:
- Greater latches in1. memory4 refreshes in2 every tick, so after a positive number Greater emits "1" **every
  tick**. That keeps resetting the delay, so nothing is sent until a text line arrives. Text parses as 0, which
  stops Greater, and then the text is delivered.
- Saying `0`: signalcheck5's "1" replaces the queued "0", and **"1" is transmitted on channel 0**. This is a
  spurious send.
- A negative number: set_channel clamps it to 0 and the number itself is sent.

Showcase demo: say `1` on ch 10, then any text; the debug displays on ch 0-4 show the latest message per channel.

---

## 3. Showcase sub (`Husk OS showcase.sub`): integration with devices

The HuskOS 2.3.3 assembly is installed **unchanged** (the netlist diff shows only positions and box-pin labels). The
OS never wires to devices directly. Every device link is a wifi channel.

| Device | Wiring | How HuskOS uses it |
|---|---|---|
| `emergencylight#174` | `toggle` ← wifi ch **50** | `toggle light` (CUSTOM wifi5 sends "1" on ch 50). This is the **control** pattern: a command transmits on the device's private channel |
| `junctionbox#105` | `condition_out` → concat(memory `JB1 Condition% = `, condition) → wifi ch **26** and a textdisplay | **Telemetry** pattern: the device publishes on its own channel. Typing `26` then `listen` shows `From 26:JB1 Condition% = 100` |
| `railgunloadersmall#108` | `contained_items` → concat(`HMP1 AMMO = `, count) → wifi ch **27** and a textdisplay | Same, ch 27 |
| `switch#138` | Output `Hello!` / FalseOutput `Goodbye!` → wifi ch **5** | "Test listen command here": select `5`, `listen` |
| NTP display (mux + button + 4 wifis 121-124) | as in 2.2 | Clock on a wall display |
| Syslog light `lightcomponent90#467` | set_state ← SYSLOG out2 | "log full" indicator |
| Unicast box #30 (input ch 10) and 5 textdisplays on wifi ch 0-4 | as in 2.4 | Debug screens: "Switch to 10 and say 1, then say anything" |

- The battery, oxygen generator, pump and nav terminal are just the shuttle's base systems; HuskOS does not touch them.
- There is no reactor, door or pump control. Anything like that would follow the ch-50 pattern: a command in CUSTOM
  → a wifi on a dedicated channel → a wifi at the device → `toggle` / `set_state`.
- **(uncertain)** The junction-box and loader concats emit every tick (memory plus a per-tick device output), and so
  probably does the switch. Listening to channels 26 or 27 would then add a terminal line every tick. HuskOS's
  `listen` has no change filter.

---

## 4. Why each trick works (game behaviour)

- **Terminal**: `signal_out` fires once with the typed line when Enter is pressed. That is a clean single-event
  source; everything downstream is event-driven from it.
  - Each `signal_in` signal appends one line. Several signals in one tick give several lines.
  - `clear_text` (any signal) wipes the history. HuskOS then re-sends the welcome line, because the clear removes it.
- **RegEx (Upd)**:
  - It latches the input and re-matches only when the input changes.
  - With ContinuousOutput False, it sends once per *received* signal. A source that sends every tick (a memory)
    therefore makes even a non-continuous regex fire every tick.
  - With UseCaptureGroup True, `Output` is the group number (`"1"`) or **name** (`output`, `output2`), and the regex
    emits that group's text. This gives argument parsing (`echo (.+)`) and string splitting.
  - FalseOutput "" means silent on no match. The default FalseOutput is **"0"**, and forgetting to clear it produces
    a "0" every time (see the syslog regex24 and regex5).
  - `(?i)` makes commands case-insensitive.
  - `set_output` lets a regex print a dynamic value: wire the live string to set_output, then use the regex as
    "command → print the current value" (time, whoami, pwd).
  - Wiring the *same* signal into `signal_in` and `set_output` makes it a filter that passes matching values (regex2
    passes numbers).
- **SignalCheck (Recv)**: an exact compare that forwards the same signal synchronously.
  - `set_targetsignal` fed from a memory stream lets you **compare two dynamic strings**: superuser name versus
    current user, entered password versus the stored password.
  - `set_output` from another memory makes it a lookup table (username → password, password → username).
  - Output "" with FalseOutput X turns "any non-empty value" into X, e.g. the `clear` request bus.
- **And/Or/Xor (Upd, TimeFrame)**:
  - With TimeFrame 0, an input counts only if received since the previous Update. Pairing a one-shot event (a
    command) with a per-tick stream (a user check) therefore works naturally as a guard.
  - "0" on an input is ignored. This makes "1"/"0" streams usable as flags, but it is also the source of the tmout bug.
  - Xor with set_output = the input gives an "else" branch (emit T unless the other condition also fired).
  - Or with set_output = the input gives a latch that re-emits in Update, i.e. a 1-tick step in a loop.
- **Delay**:
  - 0.01 s gives `(int)(0.01/0.0167) = 0` ticks: it emits on its next Update. That is 0-1 tick, which takes the signal
    out of the current synchronous chain and orders it after the work that triggered it (clear, then message; art,
    then the OS line, then the user line, then the uptime line).
  - 0.05 s is 3 ticks and 0.1 s is 6 ticks. They are used so that a relay opened "for the next line" does not catch
    the current line, which is still propagating depth-first.
  - `ResetWhenDifferentSignalReceived` plus a constant stream builds an inactivity watchdog.
  - `ResetWhenSignalReceived` builds a cancel-if-followed-within-T filter.
- **Relay (Recv)**: it passes signal_inN → signal_outN only while on. It is used three ways:
  - as a **lock or mode flag**: toggle it to divert lines between the parser and the login prompt;
  - as a **timed gate** on a continuous memory stream: a toggle-on plus a delayed toggle-off writes a value
    downstream once;
  - as a tidy junction or 2-lane splitter (IsOn True, never switched).
  - `toggle` ignores "0", so a "1"/"0" result can drive it and only success acts.
  - `state_out` reports the state every tick.
- **Memory (Upd)**:
  - It outputs its value every tick, which makes it a broadcast register (current user, superuser name, constants).
  - With `memory → adder → memory`, the loop advances only when the other adder input is fresh, which makes a counter.
  - MaxValueLength is saved per item: the syslog slots use 256, the default is 200. Or and Concat use
    MaxOutputLength 200 / 256.
- **Wifi**:
  - Delivery is synchronous to every wifi on the same channel and team within 20000 units, and never to itself.
  - So a channel is a sub-wide bus. HuskOS uses 404 as the "current channel", 120-124 for time, 50 for the light,
    and 23/161/587/25/2200-2204 in Bleeding Edge.
  - `set_channel` uses int.TryParse, so a raw text line can be wired to it: only numbers retune.
  - Headsets with chat link are just more nodes on the bus, which is how the chat-driven OS works.
  - Chat has a 1 s message interval, hence the 1 s delays in multi-line chat output.
- **Mux/Demux (Recv) ring buffer**:
  - The mux forwards the selected input; `selected_input_out` (Upd) reports the index every tick, and feeding it to
    `demux.set_output` locks read and write to the same slot.
  - A per-slot "full" regex picks the next index through `set_input`.
- **ContinuousOutput**: True makes a regex emit every tick while it matches, which is good for status lines and bad
  for terminal output (it floods). HuskOS mostly uses False.
- **Circuit boxes as modules**: box I/O adds no latency, and labelled pins (`Module Feedback`, `Current User`,
  `Superuser Name`) define an internal "ABI" between modules. A new module only needs CMD in, user in, and feedback out.

---

## 5. Weaknesses and limits

- **Global session**: there is one current-user register for the whole sub. Two terminals (or chat users in
  Bleeding Edge) share the login, the lock relays and the listen state.
- **Login bugs (analysis)**:
  - An unknown username leaves signalcheck1's target and memory3 from the previous lookup. Entering an unknown name
    with the last-looked-up user's password logs you in as that user.
  - The username/password prompt state relies on toggles. Any missed or doubled toggle desyncs relay10, relay1,
    relay2 and relay4. There is no reset except picking the item up again.
  - The password is typed in clear text. It is only hidden by clearing the terminal afterwards. The radio version
    leaks it to channel 23.
- **tmout (2.3.3, analysis)**:
  - `sudo tmout off` sends "0" into an And input, which the And ignores, so it never fires.
  - The superuser check for tmout still reads wifi ch **3389**, and nothing in the assembly transmits there, so
    `sudo tmout on` also fails unless a radio says the name on 3389. Anyone on 3389 can also spoof it.
- **time -dh / time -dhm** use `ContinuousOutput True` with a set_output that changes every tick. **(uncertain)**
  This likely prints a line every tick until another command changes the latched input.
- **Uptime clamp**: Adder ClampMax 999999 freezes the counter at 999999 s (11 d 13:46:39). Days are padded or
  truncated to 2 digits.
- **Syslog (analysis)**:
  - Every "full" regex fires every tick (its memory input refreshes every tick). regex24 also sends its default
    FalseOutput "0" to `set_input` every tick.
  - The last writer in ItemList order wins. In file order it is slot 0's regex ("1"), so after slot 1 fills the
    selector probably stays on slot 1, and new entries are truncated away. Effective capacity is about 2 slots.
  - `reset` does not clear the memories, so the full-regexes immediately move the selector again.
- **Order-dependent timing**: Xor TimeFrame 0.01 relies on regex2 (Upd) arriving in the same Update as the raw line.
  If xor16 updates first, a numeric channel line also leaks into the command stream (harmless except syslog and
  custom modules).
- **Loose matching**: `name(.*)?` matches prefixes (`clearance` clears, `timeout` does not match `^time$`, but
  `pwdx` prints pwd).
  - SignalCheck commands (`logout`, `info`, `sudo tmout on`) are case-sensitive and exact.
  - Stale version strings (2.3.2) appear in os-release and neofetch.
- **Output rate**: Update-driven components emit at most one value per tick. Multi-line output needs a loop or a
  delay chain. Chat output needs 1 s spacing.
- **Listen** has no change filter or rate limit. Devices that publish every tick flood the terminal.
- **Echo** has no local confirmation and goes to whatever channel was last selected (default 404).
- **Security**: all channels are plaintext. Default channels (404, 23, 25, 161, 587, 3389, 50, 120-124) are public
  knowledge, so the docs tell users to change them. Wifi is limited to the same team only.
- **Capacity**: 64 components per box, and string caps of 200/256 (the art had to be split). Each account costs 2
  memories and 2 signal checks, plus extra wiring to the shared check.

---

## 6. Reusable patterns

| # | Name | Minimal recipe | When to use |
|---|---|---|---|
| 1 | **Command regex** | `regex Expr="^(?i)cmd(\s.*)?$" Output="<reply>" FalseOutput="" Continuous=False` on the command bus, output to the feedback bus | Any fixed-reply or trigger command. Use `(\s.*)?` (not `(.*)?`) to avoid prefix matches |
| 2 | **Argument capture** | `regex Expr="^(?i)cmd (.+)$" UseCaptureGroup=True Output="1"` (or a named group `(?<arg>.+)`, Output="arg") | Commands with parameters (echo, set X to N) |
| 3 | **Live-value printer** | value stream → `regex.set_output`, command → `regex.signal_in` | Print the current time, user, channel or sensor value on request |
| 4 | **Match-passthrough filter** | the same wire into `regex.signal_in` and `regex.set_output`, FalseOutput "" | Pass only lines of a given shape (numbers, IDs) |
| 5 | **Xor else-branch** | line → `xor.in1` and `xor.set_output`; "special case detected" → `xor.in2`; TF ≈ 0.01, FalseOutput "" | Route "everything that is not X" (commands versus channel numbers). Mind the Update order |
| 6 | **Feedback bus** | every module's out → one box input → wired straight to the terminal `signal_in` | Modular OS. Modules never touch the terminal |
| 7 | **Clear-request bus** | `signalcheck Target="" Output="" FalseOutput="clear"` → `regex ^clear` → `terminal.clear_text`, then `terminal.signal_in` (banner) | Let any module wipe the screen. Follow with delay-0.01 messages |
| 8 | **Ordered multi-line output** | message1 → out; message1 → `delay 0.01` → message2 → out; ... (or delay 1 s for chat) | Several lines that must appear in order or after a clear |
| 9 | **String-splitter loop** | Or(set_output=in) → regex `^(?<h>.*?)SEP(?<t>.*)` with Output=h → print; same with Output=t → back to the Or | Print a long packed string line by line (help pages, art). Chain parts with a sentinel SignalCheck when it exceeds 200/256 |
| 10 | **Broadcast register** | memory (Value=X) → wired or wifi to every consumer | Current user, superuser name, mode flags, constants |
| 11 | **Dynamic compare** | stream A → `signalcheck.set_targetsignal`, stream B → `signal_in` (Output "1"/FalseOutput "0" or "") | Permission checks (user == admin), password check |
| 12 | **Lookup row** | `signalcheck(Target←key memory, Output←value memory)` per row, outputs OR'd onto one wire | Small key→value tables (accounts, aliases) |
| 13 | **Guarded command** | And(TF 0)(command check, `signalcheck(user==X)` fed every tick); Or several user checks for groups | Per-user and admin-only commands |
| 14 | **Mode lock relay** | relay (IsOn True) in front of the parser; `toggle` from "prompt started" and "prompt finished" | Multi-line prompts (login, two-step input). Prefer `set_state` from an explicit state over toggles to avoid desync |
| 15 | **Next-line capture** | prompt event → `delay ≥0.05` → `relay.toggle` (on); captured line → (its own check) → `relay.toggle` (off) | Read "the next line typed" as data. The delay keeps the current line from being captured |
| 16 | **Timed write gate** | value memory → relay (IsOn False) → target memory; success "1" → `relay.toggle`, and → `delay 0.05` → `relay.toggle` | Commit a value once on an event. A "0" result does nothing, because toggle ignores "0" |
| 17 | **Inactivity watchdog** | constant memory "IDLE" → `delay T (ResetWhenDifferent=True)`; activity → the same input; out → enable relay → action | Auto-logout or auto-lock after T s without input |
| 18 | **Seconds counter** | `oscillator Pulse 1Hz` → `adder.in2`; `memory` ↔ `adder.in1/out` | Uptime clock. Beware ClampMax 999999 |
| 19 | **Zero-pad** | concat("0", n) → regex `(.{2})$` UseCaptureGroup Output="1" | Fixed-width time fields |
| 20 | **Radio bus channels** | wifi out on channel N; any number of listeners in range | Device control (`toggle`/`set_state` on a private channel) and telemetry (device → concat label → channel) |
| 21 | **Channel select from text** | the raw line → `wifi.set_channel` (int.TryParse ignores text) | "type a number to tune", unicast routers |
| 22 | **Listen gate** | wifi.out → relay (IsOn False, toggled by `listen`) → concat("From "+ch+":", msg) → terminal | Monitor a channel on demand. Add a change filter for per-tick publishers |
| 23 | **Fan-out multicast** | wifi(in ch) → N wifi.signal_in; optionally each `set_channel` ← a config wifi | Announcements, mirroring |
| 24 | **Ring buffer of memories** | mux(select) → concat(old+" \| "+new) → demux(same index via `selected_input_out→set_output`) → slot memory; per-slot `^.{L,}$` → next index → `set_input` | Logs or history. Make the advance logic monotonic (a counter incremented once per full event), not "every full slot shouts its successor" |
| 25 | **Remote multi-format display** | wifi ch A..D → mux in0..3 → textdisplay; button → `move_input` | Wall clocks or status panels cycling views |
| 26 | **Cancel-if-followed filter** | signal → `delay T (ResetWhenSignalReceived=True)`; "cancel" signals also into the delay | Debounce, or drop control tokens. Careful: the cancel token itself gets sent after T |
| 27 | **Gated 2-way splitter** | the same signal into relay in1 and in2; out1 and out2 to different consumers | One lock controlling two fan-out paths |
