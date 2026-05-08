# Stitch Arcade

Keyboard-only HTML5 canvas game embedded on an embroidery merch site. Player traces shape outlines with a needle to score points. No build step, no deps — drop the folder in or iframe it.

## Files

| File | Exports | Purpose |
|---|---|---|
| `index.html` | — | Cabinet shell: `#marquee`, `#screen`, `#game` canvas (480×480), `#hud`, `#overlay`, `#controls` |
| `style.css` | — | Palette in `:root` vars; cabinet, HUD, overlay (`.bottom` modifier), `.panel--result` with rank colors |
| `js/audio.js` | `window.SFX` | WebAudio chiptune. `SFX.sfx.{stitch,perfect,miss,…}()`, `unlock()`, `setMuted()` |
| `js/shapes.js` | `window.Shapes` | `SHAPES` catalog + polyline math (`distanceToOutline`, `pointAt`) |
| `js/leaderboard.js` | `window.Leaderboard` | Per-shape top-10 in localStorage key `stitch-arcade.leaderboard.v1` |
| `js/input.js` | `window.Input` | Logical keymap, `isDown` / `pressed` (edge) / `clearEdges` |
| `js/game.js` | `window.Game` | Gameplay state + canvas rendering. All scoring lives here |
| `js/main.js` | — | State machine + DOM overlays. `requestAnimationFrame` loop |

**Naming gotcha**: it's `window.SFX`, not `window.Audio` — the latter is the browser's HTMLAudioElement constructor.
**No modules**: IIFEs + `window.X` so it works under `file://` and any embed.

## Architecture

### State machine (`main.js`)
`TITLE → SHAPE_SELECT → READY → PLAYING → RESULT → NAME_ENTRY? → LEADERBOARD → TITLE`

`READY` has two internal phases driven by `stateData.armed`:
- `!armed` — scene dimmed, "HOLD SPACE TO BEGIN" panel. Holding Space flips to `armed`.
- `armed` — scene revealed, "RELEASE TO SEW!" panel. Releasing Space transitions to PLAYING.

Both phases call `Game.aimTick(dt)`, so ←/→ swings the needle's heading without moving / stitching / advancing time. Replaces the old 3-2-1 countdown — that didn't compose with the freeze-on-Space behavior.

Each state has `enter<Name>` (writes overlay HTML) and `tick<Name>` (consumes inputs). `setState` clears overlay HTML, edge events, and the `bottom` class. RESULT adds `overlay.bottom` so the result panel pins to the bottom and the finished embroidery stays visible above it. Canvas render is delegated to `Game.render` for COUNTDOWN/PLAYING/RESULT, otherwise `drawIdleBackground` (animated stitched border).

### Frame loop (`Game.tick(dt)`)
read input (set `s.frozen`) → capture `prevEye` → turn → choose `effSpeed` (0 or `SPEED_DEFAULT`) → move → soft-wall bounce → accumulate distance → drop stitches every `STITCH_INTERVAL` of motion → check end condition

### Coordinate spaces
Shapes are normalized to a unit circle in **shape space**. Multiply by `RADIUS=160` to get **canvas-relative px** (origin at canvas center). Render wraps everything in `translate(CX, CY)`. `s.needle.{x,y}` is canvas-relative px.

### Needle anatomy
24px sprite. **Eye** is 7px behind center along heading (`NEEDLE_EYE_OFFSET=7`). `needleEyePos()` returns its world position. The eye is the conceptual thread anchor — end-of-round detection and the in-progress thread line both use it, not the center.

## Scoring & end condition

The scoring model went through several iterations driven by playtest. The current model is **sample-based** and **coverage-aware**, designed to resist two cheats: backtracking (re-stitching covered area) and shortcutting (cutting across the design).

### How it works
1. On `start()`, the outline is sampled at `STITCH_INTERVAL` arclength intervals — `numSamples ≈ 115–130` per shape. Each sample stores `bestDist=Infinity`.
2. Every placed stitch loops over all samples; for each one the stitch beats, it updates `bestDist` and applies a delta to `scoreCache`. Re-stitching a sample with a worse stitch is a no-op.
3. **Coverage** = `sampleCovered / numSamples`. **DONE %** in the HUD shows this. Backtracking can't advance it.
4. **Sample accuracy** = `Σ (1 − bestDist/MISS_DIST) over covered samples / numSamples` — uncovered samples count as 0, so skipping drags it down.
5. **Path efficiency** = `min(1, lengthPx × 1.05 / distanceTraveled)` — detours can't farm coverage (sample-bests prevent that), but they still cost rank: a player who walks 1.5× the outline to finish lands well below someone who traced it cleanly. The 1.05× grace absorbs normal wobble so clean runs aren't punished.
6. **Final accuracy** = `sampleAccuracy × efficiency`. **Score** = `accuracy × numSamples × POINTS_PER_PERFECT`. Score is still a direct function of (final) accuracy — no boost multiplier. The HUD score also applies efficiency live so wandering visibly costs points instead of being a surprise drop on RESULT.

### Speed model
Three states, no levels:
- **Default** (`SPEED_DEFAULT=90` px/s) — no key held
- **Slow** (`s.slow=true`, `SPEED_SLOW=45` px/s) — `↓` held; half speed, turning at full rate
- **Stop** (`s.frozen=true`) — `Space` held; movement halts, turning still works

Slow mode does NOT alter scoring rate per pixel — stitches are placed every `STITCH_INTERVAL` of motion regardless of speed, so per-pixel coverage and accuracy contributions are identical. Slow just buys the player more time to aim through tight turns. There is no boost. `↑` is unbound during PLAYING (still used in menus).

`stop` is a logical key bound to Space (separate from `action` which is also bound to Space+Z for menu confirms — both can coexist because PLAYING/READY don't read `action` edges).

### End condition
- Natural: `coverage ≥ ARC_DONE (0.85)` AND swept eye-path distance to start `≤ RETURN_RADIUS (6)`. **Swept** (`pointToSegment(prevEye→eye, startPos)`) — point checks alone get skipped through at high speed.
- Overrun safety: `distanceTraveled ≥ lengthPx × ARC_OVERRUN (1.55)` calls `finish(false)`. No closing stitch — the open loop is the honest record.
- `finish(true)` adds one tier-3 closing stitch at `s.startPos` (visual loop closure only — does NOT update samples or score).

### Rank ladder (`rankFor(accuracyPct)`)
Purely accuracy-based — score tracks accuracy 1:1, so no separate score gate is needed.

| Rank | Requirement |
|---|---|
| D | <48% accuracy |
| C | ≥48% |
| B | ≥65% |
| A | ≥80% |
| S | ≥95% |
| SS | ≥97% |
| SSS | ≥99% |

Theoretical max score ≈ `numSamples × 100` ≈ 11k–13k depending on shape.

## Visual conventions

- Fabric circle: `RADIUS+24`. Hoop ring: `RADIUS+30` with a screw nub at top.
- Outline drawn dashed, before stitches.
- Stitch = 7px dash colored by tier (3 gold / 2 red / 1 pink / 0 blue) with shadow.
- **Start marker**: small gold dot + dark outline. Pulses a wider aura once `coverage ≥ ARC_DONE`. Hidden when `s.finished`.
- **Stop feedback**: pulsing gold ring + forward arrow around the frozen needle (`s.frozen`).
- **In-progress thread** (`drawThread`) is a dashed line from last stitch to *eye* (not center). Suppressed when `s.finished`.

## Common edits

| Goal | File · Location |
|---|---|
| Difficulty / accuracy bands | `game.js` const block: `MISS_DIST`, `PERFECT_DIST`, `RANK_ACCURACY_*` |
| Speed feel | `game.js`: `SPEED_DEFAULT`, `TURN_RATE` |
| End-of-round strictness | `game.js`: `RETURN_RADIUS`, `ARC_DONE`, `ARC_OVERRUN` |
| Add a shape | `shapes.js`: write a generator (uses `normalize()`); add to `SHAPES` with `{id, name, difficulty, build, startS}` |
| Server-side leaderboards | Replace the 4 functions in `leaderboard.js` — call sites are unchanged |
| Palette | `style.css` `:root` vars **and** `PALETTE` in `game.js` (canvas can't use CSS vars directly) |
| Result panel layout | `main.js` `enterResult` HTML + `style.css` `.panel--result` |
| Rank styling (incl. SS/SSS animations) | `style.css` `.panel--result .rank-{D,C,B,A,S,SS,SSS}` |
| New sfx | `audio.js` add to `sfx` object |
| Logical key bindings | `input.js` `KEY_MAP` |

## Gotchas

- Closing stitch in `finish(true)` is purely visual — does NOT update sample bests or score. Don't accidentally route it through `placeStitch`.
- `s.numStitches` (per-stitch counter, for P/G/M display) ≠ `s.numSamples` (fixed at `start()`, drives scoring).
- `Float32Array.fill(Infinity)` is intentional for `sampleBestDist` initialization.
- The HUD's "DONE %" reads `getProgressFraction()` which is coverage, not distance — distance is only used for the overrun cap now.
- `drawStartMarker` "ready" pulse uses coverage too, not distance.
- HTML overlays sit above the canvas inside `#screen`; `pointer-events: none` by default, restored only when `has-content` is set.
- The `action` key (Z, Space) is still defined in `input.js` and used as a confirm shortcut in TITLE / SHAPE_SELECT / RESULT / NAME_ENTRY / LEADERBOARD — but **not** in PLAYING. Don't reintroduce it as a gameplay binding without a deliberate reason.

## Past iteration history (context for design choices)

- **Round-end was distance-based** → backtracking inflated progress and shortcuts ended runs early. Replaced with coverage sampling.
- **End check used needle center** → tip overshot the start by 14px. Anchored on the eye instead.
- **`closeLoop` once drew an interpolated chain of bridging stitches** → looked like a synthetic line in screenshots. Replaced with a single tier-3 stitch at the exact start.
- **Old `RETURN_RADIUS=28`** plus point check meant the eye could be 28px out when the round ended. Now 6px with a swept segment check.
- **Old scoring averaged per-stitch accuracy** → cheaters could farm one side of the design. Sample-best fixed it.
- **Sample-best alone was too lenient** → veering far off course, circling back, and finishing the design still scored an A because every sample eventually got a near stitch. Added a path-efficiency multiplier (`lengthPx × 1.05 / distanceTraveled`, capped at 1) so detour length still costs rank.
- **Default speed used to be 80** with no speed multiplier. Lowered to 48 and weighted scoring so pushing speed is the risk/reward play.
- **Continuous 9-level speed (0.5×–2.5× mult) + Z thimble** — replaced with a three-state model (default 90 / stop / boost 180, mult 1× or 2×). Simpler input, simpler scoring, same risk/reward shape.
- **Boost (↑) with 1.5× score mult** — removed because boosting at all times was strictly optimal, making it feel mandatory rather than a risk/reward choice. Now a two-state model (default / stop) with score derived purely from accuracy.
- **3-2-1 countdown into PLAYING** — replaced with a hold-↓-to-arm / release-to-start gate. The countdown clashed with the freeze-on-↓ behavior: if the player was already holding ↓ when GO! fired, nothing visibly happened until they released, which felt broken.
