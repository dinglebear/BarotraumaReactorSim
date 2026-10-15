# Building a submarine from scratch (for AIs)

`sim/subbuild.js` builds a whole sub from a room layout. You describe rooms on a grid and how they connect. The builder makes everything around them:
- hulls;
- the outer shell;
- inside walls and floor slabs;
- doors with their gaps;
- hatches with gaps and ladders;
- AI waypoints and spawn points.

It returns a `SubDoc` (`sim/subedit.js`) for the machinery and the electrical work, which uses the same tools as SUBEDIT.md (`add`, `wire`, `box`, `audit`).

**The outline is smoothed automatically** (see "Smooth walls" below), so design the silhouette with steps: humps, overhangs, a narrower top deck. The builder fills every step with a slanted shell piece.

Worked example: `ships/scratch/capsule.gen.js` builds **Claude's Test Capsule**: 6 rooms with the top deck stepped in by 128 at both ends (so the builder bevels it), an orange shell, a reactor, engine, pump, oxygen generator and nav terminal, lights, and Claude's feed-forward reactor circuit. `node sim/test.js` builds and checks it every time. Its power runs clean in the mock (0 % unmet); it is not yet tested in game.

## Workflow
1. **Study real subs in the bench's Sub tab.** Tick **Walls**, **Background**, **Props** and **Gaps & waypoints** to see the shell, slabs, background walls, every item's hitbox, door gaps and the AI path network. Click any piece for its identifier and hitbox. On the command line:
   - `node sim/cli.js sub catalog <Sub> [regex]` lists every structure (WALL = collides, DECO = scenery) and item you can copy, with its typical size;
   - `node sim/cli.js explain <file>` shows the electrical side.
2. **Write a generator script** (copy `ships/scratch/capsule.gen.js`):
   ```js
   const B = new SubBuilder(templates, { name, description, class, tier, price, ... }, { shellColor: '217,119,87,255', wallColor, backColor });
   B.room('engine', x, floorY, w, h, { name: 'Engine Room', wet: false });   // rooms tile a grid: neighbours share edges exactly
   B.door('engine', 'reactor');               // rooms side by side
   B.hatch('reactor', 'oxygen', x);           // lower room, upper room, x of the hatch centre
   B.spawn('bridge', 'captain');              // jobs: captain engineer mechanic medicaldoctor securityofficer assistant; 'cargo'
   const d = B.build();                        // -> SubDoc
   d.add('reactor', 'reactor1', x, y); d.wire(...); d.box(...);   // machinery, wiring, circuit boxes
   ```
3. **Check:** `d.check()` (loader rules) and `d.audit(null)` (loose items, items in walls, boxes over 64). Then `node sim/cli.js ship <Name> --transcript` runs a practice round, and the bench's Sub tab shows it.
4. **Tell the human** what to verify in game. Start with: open it in the sub editor, walk every room, use every door, hatch and ladder, check bots path, then sail.

## Conventions (taken from the vanilla subs; numbers in `sim/subbuild.js`)
| Thing | Rule |
|---|---|
| **Room (hull)** | Rect from the floor surface up to the top of its ceiling slab. Rooms tile the interior: neighbours share edges exactly (no gaps, no overlaps). Room height 256 = 208 walkable + 48 slab. `Oxygen` = w×h (full). |
| **Inside walls** | `ff_y_wall` 48 thick, centred on a shared vertical edge, from the floor up to the ceiling slab. |
| **Floor slabs** | `ff_x_wall` 48 thick, inside the top of the lower room, on shared horizontal edges. Hatch holes are cut out. |
| **Shell** | `shella0deg` (horizontal) and `shella90deg` (vertical), 96 thick, outside every exposed room edge. **Bottom pieces are flipped Y and right-hand pieces flipped X**, as in the vanilla subs, so the 72-thick metal plate sits against the room. Unflipped, the plate is 24 off: the floor ends up below the room. The horizontal pieces extend over the outer corners. |
| **Background** | `FF_Wall_G2` fills each room (scenery, no collision). |
| **Door** | `doorwbuttons` (24×208) on the wall centre line at the floor, and a gap 34×208 `horizontal=true`. The door's `linked` = the gap ID. |
| **Hatch** | `hatchwbuttons` (128×49) in the slab, and a gap 128×58 `horizontal=false` (linked). A `ladder` runs from the lower floor to 120 above the upper floor. |
| **Waypoints** | Along every floor at floor + 113, about 120 apart, linked in a chain (`linkedto0..n`). A doorway waypoint has `gap=<gap>`. Ladder waypoints at the bottom and top have `ladders=<ladder>` (and `gap=` at the top). Spawn points are `spawn=Human job=<job>`, or `spawn=Cargo`. |
| **Oxygen** | The `oxygenerator`'s `linked` = a list of vent IDs; each `vent`'s `linked` = the generator. |
| **Engine** | Overhangs the stern shell, like the vanilla subs. |
| **Colours** | Any structure takes `SpriteColor` (R,G,B,A), so the whole sub can be tinted. |
| **Submarine attributes** | `blankSub()` fills name, description, class, tier, price, crew size, `gameversion`, `requiredcontentpackages=Vanilla`. `dimensions` is computed. There is no preview image (the game shows none until the sub is saved in the editor). |

## Smooth walls (`sim/shellgeom.js`, on by default)
Every structure collides as a rotated rectangle defined by its prefab (bodywidth × bodyheight, an offset and a rotation; flipping mirrors both). `sim/shellgeom.js` rebuilds that exactly from `ships/templates/structure_prefabs.json`. The prefab data comes from the game's `StructurePrefabs.xml` via the community content mirror. The body is set to minus the prefab rotation, so a −52° piece rises "/". The game's own subs prove the maths: all four vanilla subs pass the watertight check, and removing the Camel's hump slopes fails it.

What the builder does with it:
| Where | What | Cost to the room |
|---|---|---|
| **Short step** (≤ 260 long, an outer corner next to a notch, e.g. a deck that steps in by 128) | One slope across the whole step, from one wall's centre line to the other's. The steepest piece whose span matches the step is used. | It clips the lower room's corner by ≤ ~50 |
| **Notch** (a hump, an overhang) | A slope fills the empty corner outside both rooms (the Camel's humps use `shella52deg` this way). The biggest piece at 25–65° that fits the two edges is used. | None |
| **Outer top corner** | A shallow slope (≤ 25°) across the corner, along up to ~85 % of the edge. | ≤ ~60 at the ceiling corner, by the wall |
| **Outer bottom corner** | The same, but only for rooms built with `{ bevelBottom: true }`, because it raises the floor by ≤ ~60 near the wall. | Floor corner |

- **Joints:** straight shells run 24 units under each slope's end, so there's no crack.
- **Placement:** fittings are nudged out of the real collision shapes, not a slope's big sprite box.
- **Checks:** run `node sim/cli.js sub leaks <Sub>` after a build. `node sim/test.js` checks the vanilla subs, a stepped test build and the capsule.
- **Which pieces:** only the submarine shell pieces the vanilla subs actually place (`SLOPES` in `sim/subbuild.js`). Their sprites have never been seen here, only their collision bodies, so **check the look in the sub editor**.
- **Turning it off:** pass `{ smooth: false }` or `{ bevelTop: false }` in the builder's style options.

To get a smooth sub, give the outline steps. For example: a top deck narrower than the bottom one, a hump on top, or a bow room shorter than its neighbour. A plain rectangle only gets its top corners bevelled.

## Patch-language equivalents (SUBEDIT.md)
```
hull @h x,top,w,h RoomName=Bridge
structure @s ff_x_wall x,top,w,h SpriteColor=217,119,87,255
gap @g x,top,w,h horizontal|vertical
waypoint @w x,y spawn=Human job=engineer gap=@g ladders=@l
wplink @a @b
set @door linked=@g
remove <id>        # works for hulls, structures, gaps and waypoints too
```

## Not covered yet / to verify in game
- **Shapes:** rooms are rectangles on a grid; the outline is smoothed with slanted pieces at steps and corners. Curved noses that span several pieces (Typhon-style bows) still need hand placement: use `place()` in `sim/shellgeom.js` to put any slanted piece on a line.
- **No docking port or hatch yet:** missions that dock at outposts need one, so copy `dockingport`/`dockinghatch` from a sub that has them.
- **No turrets, airlock or ballast-specific pumps yet.** Use `add`/`wire` with templates, like the Camel Overkill.
- **Bot behaviour on the generated waypoints is untested,** as is whether the game's sub body (collision) forms correctly from the shell. The sub editor's "generate waypoints" can redo the AI paths if they misbehave.
