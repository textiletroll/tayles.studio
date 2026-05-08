# Embedding Stitch Arcade

Instructions for embedding this game into the `tayles.studio` site (or any static site).

## What this folder is

A self-contained static HTML5 game. No build step, no dependencies, no server-side code. Just `index.html` + `style.css` + `js/*.js` + this doc. Every path inside the game is relative, so the folder works at any URL depth.

## Recommended placement

Drop the entire folder into the site repo as `stitch-arcade/` under whichever directory the site framework serves verbatim:

| Site framework | Put folder under |
|---|---|
| Plain HTML / Jekyll (GitHub Pages default) | repo root, e.g. `/games/stitch-arcade/` |
| Astro | `public/games/stitch-arcade/` |
| Next.js | `public/games/stitch-arcade/` |
| Eleventy | `_site` passthrough or `public/` (depends on config) |
| Hugo | `static/games/stitch-arcade/` |
| SvelteKit | `static/games/stitch-arcade/` |

Rename the folder to `stitch-arcade` (no space) so the URL is clean.

After deploy, the game is reachable on its own at e.g. `https://tayles.studio/games/stitch-arcade/`. That URL is what the iframe points at — the game does not need to be rendered "in place" by the host page.

### Jekyll note

Jekyll processes most files by default. Static assets in a subfolder pass through fine, but if the site uses a global layout that wraps every `.html`, add an empty `.nojekyll` file at the repo root, OR add front matter / `_config.yml` exclusion for the `stitch-arcade/` folder so Jekyll leaves it alone.

## Embedding on a page

```html
<iframe
  src="/games/stitch-arcade/"
  width="560"
  height="640"
  style="border:0; display:block; margin:0 auto;"
  title="Stitch Arcade"
  loading="lazy"
></iframe>
```

Sizing: the game canvas is 480×480 px; the cabinet adds marquee, controls bar, and padding. ~560×640 fits the default styling comfortably. Adjust as desired — the cabinet is `max-width: 100vmin` so it scales down on narrow viewports.

### Keyboard focus (important)

The game is keyboard-only. An iframe doesn't receive key events until it has focus. On the host page:

```html
<iframe id="stitch" src="/games/stitch-arcade/" width="560" height="640"
        style="border:0; display:block; margin:0 auto;"
        title="Stitch Arcade" loading="lazy"></iframe>
<script>
  (function () {
    var f = document.getElementById('stitch');
    if (!f) return;
    f.addEventListener('load', function () { try { f.focus(); } catch (_) {} });
    // Re-focus when the user moves the mouse over it, so keys "just work"
    // after the user has scrolled or clicked elsewhere on the host page.
    f.addEventListener('mouseenter', function () { try { f.focus(); } catch (_) {} });
  })();
</script>
```

The game's input handler already calls `preventDefault()` on arrows / Space inside the iframe document, so the host page does NOT lose its own scroll behavior when the iframe has focus.

### Audio

WebAudio is unlocked on the first key press inside the iframe (`SFX.unlock()` in `js/audio.js`). No host-page changes required. There is a mute toggle bound to `M`.

## Things the host page does NOT need to do

- No CSS overrides — the game styles only inside its own document.
- No script imports — all game JS loads from inside the iframe.
- No `postMessage` integration — the game does not communicate with the parent.
- No CORS / cross-origin setup — same-origin (same repo) is the simplest case and it Just Works.

## Persistence

The game uses `localStorage` for two things, both scoped to the game's origin:

| Key | Purpose |
|---|---|
| `stitch-arcade.leaderboard.v1` | Per-shape top-10 scores |
| `stitch-arcade.lastName.v1` | Last initials entered (prefilled next time) |

Because storage is per-origin, scores set on `tayles.studio` stay on `tayles.studio`. If the game is ever moved to a different domain, scores do not migrate. If it stays under the same origin but moves between subpaths (`/games/stitch-arcade/` → `/play/stitch-arcade/`), scores DO carry over — `localStorage` is keyed by origin, not by path.

## Updating the game

It's static — replace the folder contents and redeploy the site. No cache headers to bust beyond whatever the host applies to other assets. Bumping the version suffix on the localStorage keys (e.g. `.v2`) would invalidate scores; don't do that unintentionally.

## Standalone use

The folder is a complete site on its own. Opening `index.html` directly via `file://` works — useful for offline testing.
