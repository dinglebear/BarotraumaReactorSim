# Text displays and terminals (sim/label.js)

From the game's source, FakeFishGames/Barotrauma @ e6e95da (client `ItemLabel.cs`, shared and server `ItemLabel.cs`, `Terminal.cs`), plus `Content/Items/Labels/labels.xml` from the content mirror.

## The scrolling bug Dingle hit
A long text that changes every second never shows its end:
- **Sending the same text** does nothing. Both setters return early, and the scroll is untouched.
- **Different text that still has to scroll** keeps the scroll offset, but clamps the character index to the length of the text alone. The scrolling string is about 19 spaces followed by the text (client ItemLabel.cs:166, :189).
- **The result:** once the scroll passes position L (the text length), every change pulls it back to L. The loop never finishes, and the tail, usually the changing value, is never shown.
  - "Reactor output: 1000 kW", changing every second, sticks around "utput: 10".
  - With 3 s or more between changes, the end is visible.
- **Different text that now fits** (short enough): a full reset. Text that keeps switching between fitting and not fitting restarts from the blank box every time.

**What works:** values short enough never to scroll (about 7–8 characters), with any fixed label on its own display. `sim/label.js` models this, and the sandbox and ship mock warn when a display's text would never show its end.

## Text display (`textdisplay`)
- **Item size:** 63×24 world px (sprite 126×48, scale 0.5).
- **ItemLabel:** `scrollable="true"`, padding 10,5,10,12 × scale. The text area is **53 × 15.5 px**.
- **Text:** white by default; `set_text_color` changes it.
- **Font:** Exo2 SemiBold at an effective **12 px**. Text scale cancels out.
- **Approximate glyph widths:**

  | Glyphs | Width (px) |
  |---|---|
  | lowercase | ~6 |
  | digits | ~6.5 |
  | capitals | ~7–7.5 |
  | space, i, l, ., :, ! and other narrow glyphs | ~3 |

  A box fits about 8–9 lowercase letters, 7–8 digits or about 7 capitals.
- **When it scrolls:** only if the text width is at least 53 px. Otherwise it is static, drawn left-aligned, with the scroll reset.
- **Scrolling:**
  - The speed is 20 px/s, about 5–7 % slower in practice.
  - There is no pause at the ends.
  - After the last character leaves, the box is blank and the text comes in again from the right.
  - A 23-character text loops in about 10 s.
- **Wrapping:** a scrollable label never wraps. A literal `\n` is shown as the two characters, not as a line break.
- **Multiplayer:** the server sends label text after it has stayed unchanged for **0.1 s** (a trailing debounce). Text that changes every frame never reaches clients until it settles.

## Terminal (`terminal`)
- **History:** keeps 60 messages, the oldest dropped first.
- **Message length:** each message is cut to 200 characters. Each `\n` counts as 2 characters and becomes a line break.
- **No deduplication:** every `signal_in` adds a line, even if it's identical. A source that sends every tick adds 60 lines/s and wipes the history in 1 s.
- **Autoscroll:** forced to the bottom on every new line, so nobody can scroll up while lines keep arriving.
- **clear_text:** any value other than "0" clears it.
- **Default text colour:** 50,205,50.
- **Multiplayer:** lines that arrive by signal are not synced. Every machine simulates its own.
