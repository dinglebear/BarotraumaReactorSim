# Editing a submarine's internals (for AIs)

The toolkit edits a real `.sub`: it adds, removes and moves items, wires and unwires any connection (doors, lights, pumps, alarms, buttons, relays, logic, reactor, batteries...), changes settings, and builds whole circuit boxes into the sub. Everything you don't touch stays byte-identical. Every edit is checked against the game's loader rules, and the result runs in the practice-round mock.

Design ideas, game signal rules and proven patterns (command bus, sensor network, door brains, battery buses, chat) are in **[CIRCUIT_PATTERNS.md](CIRCUIT_PATTERNS.md)**. A full worked example is the Camel Overkill: [ships/CAMEL_OVERKILL.md](ships/CAMEL_OVERKILL.md), with its generator script `ships/patches/camel_overkill.gen.js`.

## Workflow
0. **Study:** `node sim/cli.js explain <file.sub|assembly.xml> [regex]` prints a readable netlist of any sub or item assembly (community ones too): every wired or logic item, its non-default settings, where each connection goes, and each circuit box's insides with its notes.
1. **Look:** `node sim/cli.js sub list <Sub> [regex]` lists every electrical item: ID, identifier, position (sub coordinates, y up), room, connections and what each is wired to. Filter by identifier, ID or room, e.g. `"door|button|^29 "`.
2. **Write a patch:** `ships/patches/<name>.subpatch` (commands below).
3. **Apply:** (it also runs `sub audit` against the original sub and refreshes a mod folder `ships/custom/<Sub Name>/` if it exists)
    `node sim/cli.js sub patch <Sub> ships/patches/<name>.subpatch` writes `ships/custom/<subname>.sub` (gzipped, loads in game) after the loader checks. Check any sub with `sub check <Sub>`.
4. **See it:** `node sim/cli.js sub render <subname> --base <Original>` writes `renders/<subname>.png`: the true walls, slopes and stairs, every item coloured by job, wires along their nodes, and everything you added in orange. `--crop x0,y0,x1,y1` zooms on a room, `--wires added` hides the original wiring, `--labels all` names every item. Look at it after every patch.
5. **Test:** `node sim/cli.js ship <subname>` runs a practice round. Add `--transcript` to print radio chat, terminal lines and displays. Scenario flags: `--breach S [--breach-hull ID]`, `--fire S [--fire-hull ID]`, `--crew N`, `--type "30:status"` (typed at the terminal at 30 s; repeatable) and `--radio "40:camel status"` (said on headset channel 0). Or rebuild the web pages (`node sim/build_web.js`) and open it in the Sub Studio: filter wires, click items to see their wiring, run a practice round, press buttons, flood rooms, read the displays.
6. Tell the human what changed and what to try in game. Ask them to open it in the sub editor first and keep the original.

**Audit any time:** `node sim/cli.js sub audit <Sub> --base <Original>` finds loose items, items inside walls/floors, circuit boxes over 64 parts, moved originals and connections with more than 5 wires.

## Patch commands (one per line, `#` comments)
```
subname Dugong Overkill                         # the sub's name (and the output file name)
add @h <identifier> at <x>,<y> [Comp.Attr=v ...] # new item; @h is a handle for later lines. Values with spaces: Comp.Attr="a b"; empty: Comp.Attr=""
remove <id|@h>                                  # removes the item, its wires, its contents
move <id|@h> <x>,<y>
set <id|@h> <Component.Attr>=<value> ...        # e.g. RelayComponent.IsOn=false, OrComponent.TimeFrame=2; linked=@loader puts that item's ID
wire <id|@h>.<conn> <id|@h>.<conn> [red|blue|green|orange|yellow|black|brown|white]
unwire <id|@h>.<conn> <id|@h>.<conn>
name @h <id>                                    # give an existing item a handle
hull @h x,top,w,h [RoomName=..]  /  structure @h <identifier> x,top,w,h [SpriteColor=..]  /  gap @h x,top,w,h horizontal|vertical
waypoint @h x,y [spawn=Human job=..] [gap=@g ladders=@l]  /  wplink @a @b      # structure editing (SUBBUILD.md)
box @h at <x>,<y> from <circuit> [box reactor|battery] [NAME=value ...]   # a circuit box with its components built in; NAME=value fills $NAME in the circuit (one circuit, many rooms)
```
- A box's pins are `signal_in0..9` / `signal_out0..9`; wire them like any other connection. `$MAX`/`$BATT_*` in the circuit are filled from this sub.
- Power wires connect `power`, `power_in` and `power_out` (default red). Signal wires default to blue.

## Rules that matter (from the game's code)
- **New items that get wires are copied from a template:** an item with the same identifier in this sub, a vanilla sub, or `ships/templates/vanilla_items.xml`, because the game matches connections by order. The template library has wifi, terminal, text display, oxygen and smoke detectors, lever and switch, every logic part and more. Add more with `node sim/cli.js sub templates ships/templates/vanilla_items.xml ident1,ident2 <source .sub/.xml files>`, using vanilla items only, from the newest game version you have. Logic parts with no template can be added, but can't be wired from outside. Inside a circuit box any component works.
- **A circuit box holds at most 64 components** in game; the rest are lost on load ("failed to find an item in the container"). The editor refuses bigger boxes, so split big designs into several boxes linked by wires or wifi.
- **Placed items stay out of walls and floors:** a room's rectangle includes its floor and ceiling slabs. `add` and `box` move any new fitting that would sit inside solid structure (shell, inside walls, caps, platforms, bow; not Back Wall scenery) to the nearest free spot in the same room, and log it. Stairs count as the game's collision plank (10 units thick at 45° across the bottom of their rectangle), not their whole picture, but their railing still covers the wall behind: keep screens out of a staircase's rectangle.
- **Wires are routed like cable trays:** up from each item to a lane just under the room's real ceiling slab (8 lanes, 5 apart, from 8 below the slab), along it, down a riser at the next room's wall, and down to the target. Mount screens and boxes at least ~50 below the ceiling slab and the bundles never cross them. Turrets, periscopes, loaders and doors are left where you put them.
- **Placed items are attached to the wall** automatically (`Holdable Attached=True`). A template saved loose would otherwise fall to the floor with its wires.
- **Turrets and loaders** are paired by the item `linked` attribute: after adding both, `set @gun linked=@loader` and `set @loader linked=@gun`.
- **Settings the game doesn't save:** the reactor's automatic control. The crew must turn it off for a reactor circuit to take over.
- **One input, many senders: the last signal each tick wins.** If something already drives an input every tick (an OR gate, `meltdown_warning`, a detector), don't wire a second sender there. Feed the existing logic's free input, or add your own device.
- **Vanilla door logic:** door `set_state` ← OR (Output "", FalseOutput "0", TimeFrame 4) ← motion detector. That's an auto-close 4 s after the last motion. Buttons on the door toggle it.
- **Relays:** power relays pass power when on (MaxPower 1000 kW). `toggle` flips on any non-zero signal, `set_state` sets it, and `state_out` sends 1/0 every tick.
- **Wire limits:** the game allows 5 wires per connection when wiring by hand, but loading accepts more. Stay at 5 or fewer so the crew can still rewire.
- Put items inside rooms (`sub list` shows the room); positions are centres.
- The mock simulates power and signals. Relays are separate grids passing power up to MaxPower. There is no water physics or crew pathing: detectors fire from the scenario (breach, fire, crew walking room to room) or by hand on the bench. Oxygen is one value for the whole sub (approximate rates).
