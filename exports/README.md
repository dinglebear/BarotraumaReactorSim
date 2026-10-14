# Ready-to-paste circuits for the vanilla subs

`exports/<Sub>/` holds Blueprints files with that sub's own values already filled in: reactor max output, battery count, recharge, output and capacity, all read from the sub's `.sub` file. Copy them into `Barotrauma/LocalMods/Blueprints_saved_blueprints/` and load each one into its own circuit box.

## example_battery: auto-reactor that uses the batteries as a buffer
Two circuit boxes. The **battery box** does the battery math and tells the **reactor box** what to make:
- It keeps the batteries near 60 %, so they can both soak up surplus and cover dips.
- The reactor follows demand, and goes below demand only by what the batteries are really delivering.

On the bench it holds the voltage within about 0.1 % on all three vanilla subs, with no unmet demand.

### Wiring (the box pins are labelled in game)
**Reactor box** (`example_battery_reactor.txt`):
| pin | wire to |
|---|---|
| in2 | reactor `power_value_out` |
| in3 | reactor `temperature_out` |
| in4 | reactor `fuel_out` |
| in8 | battery box `out2` (a wire between the two boxes) |
| out1 | reactor `set_fissionrate` |
| out2 | reactor `set_turbineoutput` |

**Battery box** (`example_battery_battery.txt`):
| pin | wire to |
|---|---|
| in1 | `charge_%` of ONE battery |
| in2 | `charge_rate` of the same battery |
| in3 | main junction box `load_value_out` (the junction box on the reactor's grid) |
| in6 | reactor `power_value_out` |
| in7 | `power_value_out` of the same battery |
| out1 | `set_rate` of EVERY battery |
| out2 | reactor box `in8` |
| out3 | `disable_output` of EVERY battery |

Then turn the reactor's **automatic control OFF**. Otherwise AutoTemp fights the circuit.

### Per sub: remove the old battery wiring first
Vanilla subs already wire their batteries to their own logic, which conflicts with this circuit:
- **Dugong:** unwire the circuit box near the nav terminal from the batteries' `disable_output`. It keeps them disabled (backup batteries switched by a nav button). Its `charge_%` wires to the adder can stay.
- **Humpback:** the battery circuit box drives every battery's `set_rate` and `disable_output`. Unwire both.
- **Typhon2:** the terminal drives the batteries' `set_rate`. Unwire it.

If you leave the old wiring, the circuit still runs safely: it never sends the reactor below demand when the batteries don't deliver. The batteries just stop helping.

Tell me what happens. The bench can only be as good as the game it copies.
