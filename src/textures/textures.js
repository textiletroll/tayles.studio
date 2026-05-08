/**
 * Procedural panel textures — felt, wool, denim, canvas.
 *
 * Each texture renders as a 256×256 PNG tile that's tiled via CSS
 * background-repeat. Generators tint by the panel's base color so the user's
 * chosen background color shows through the pattern. Tiles are memoized by
 * (type, color) so the cost is paid once per distinct combination.
 *
 * Design choices:
 *  - Canvas-generated PNG tiles (vs SVG patterns) — keeps texture math in JS
 *    and avoids cross-browser SVG filter quirks.
 *  - Tile size 256 — large enough to mask repetition for irregular textures,
 *    small enough that toDataURL is cheap (~3ms).
 *  - Generators are deterministic per color so cached URLs stay valid until
 *    the user changes color/texture.
 */

export const TEXTURE_TYPES = ['none', 'felt', 'wool', 'denim', 'canvas'];

const TILE_SIZE = 256;
const cache = new Map();

function parseColor(hex) {
  if (!hex || typeof hex !== 'string' || hex[0] !== '#' || hex.length < 7) {
    return { r: 128, g: 128, b: 128 };
  }
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function clamp(v) { return Math.max(0, Math.min(255, v | 0)); }

function rgba(r, g, b, a) {
  return `rgba(${clamp(r)},${clamp(g)},${clamp(b)},${a})`;
}

/* Mulberry32 — small deterministic PRNG seeded from color so the same
 * (type, color) always produces the same texture. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Felt — pressed wool: base color flecked with tiny dots of slightly varied
 * shade. Reads as a soft, slightly fuzzy surface. */
function renderFelt(ctx, base, rng) {
  const w = TILE_SIZE, h = TILE_SIZE;
  ctx.fillStyle = `rgb(${base.r},${base.g},${base.b})`;
  ctx.fillRect(0, 0, w, h);
  // Subtle large-scale shading
  for (let i = 0; i < 800; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const dr = (rng() - 0.5) * 60;
    const dg = (rng() - 0.5) * 60;
    const db = (rng() - 0.5) * 60;
    const a = 0.05 + rng() * 0.18;
    ctx.fillStyle = rgba(base.r + dr, base.g + dg, base.b + db, a);
    const r = 1 + rng() * 1.5;
    ctx.fillRect(x, y, r, r);
  }
  // Small dark fibers — a few short scratch marks
  for (let i = 0; i < 60; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const len = 2 + rng() * 4;
    const ang = rng() * Math.PI * 2;
    ctx.strokeStyle = rgba(base.r * 0.6, base.g * 0.6, base.b * 0.6, 0.25);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
}

/* Wool — knitted/spun fibers visible as short curved strokes radiating in
 * many directions. More directional than felt. */
function renderWool(ctx, base, rng) {
  const w = TILE_SIZE, h = TILE_SIZE;
  ctx.fillStyle = `rgb(${base.r},${base.g},${base.b})`;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 1400; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const ang = rng() * Math.PI * 2;
    const len = 2 + rng() * 5;
    const dr = (rng() - 0.4) * 70;
    const dg = (rng() - 0.4) * 70;
    const db = (rng() - 0.4) * 70;
    const a = 0.18 + rng() * 0.25;
    ctx.strokeStyle = rgba(base.r + dr, base.g + dg, base.b + db, a);
    ctx.lineWidth = 0.7 + rng() * 0.6;
    ctx.lineCap = 'round';
    // Slight curve via quadratic — gives the fiber an organic look
    const mx = x + Math.cos(ang) * (len / 2) + (rng() - 0.5) * 1.2;
    const my = y + Math.sin(ang) * (len / 2) + (rng() - 0.5) * 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(mx, my, x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
}

/* Denim — cotton twill weave: dominant diagonal threads in a slightly darker
 * shade running NW→SE, with lighter cross-threads filling the gaps. The
 * dominant diagonal is the recognizable "denim" look. */
function renderDenim(ctx, base, rng) {
  const w = TILE_SIZE, h = TILE_SIZE;
  // Base is a slightly desaturated/darker version of the input color so the
  // diagonal threads stand out
  const dimR = base.r * 0.85;
  const dimG = base.g * 0.85;
  const dimB = base.b * 0.95;
  ctx.fillStyle = `rgb(${clamp(dimR)},${clamp(dimG)},${clamp(dimB)})`;
  ctx.fillRect(0, 0, w, h);
  // Tileable diagonal threads — spacing 4px, drawn long enough to wrap
  ctx.lineCap = 'butt';
  ctx.lineWidth = 1.2;
  for (let i = -h; i < w + h; i += 4) {
    const shade = 0.65 + rng() * 0.15;
    ctx.strokeStyle = rgba(base.r * shade, base.g * shade, base.b * (shade + 0.05), 0.85);
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
    ctx.stroke();
  }
  // Lighter cross-threads (less dominant in twill weave)
  ctx.lineWidth = 0.7;
  for (let i = -h; i < w + h; i += 5) {
    ctx.strokeStyle = rgba(base.r * 1.15, base.g * 1.15, base.b * 1.05, 0.35);
    ctx.beginPath();
    ctx.moveTo(i, h);
    ctx.lineTo(i + h, 0);
    ctx.stroke();
  }
  // Speckled noise to soften the regularity
  for (let i = 0; i < 1500; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const dr = (rng() - 0.5) * 30;
    ctx.fillStyle = rgba(base.r + dr, base.g + dr, base.b + dr, 0.1);
    ctx.fillRect(x, y, 1, 1);
  }
}

/* Canvas — plain weave (over-under in both directions). Visible horizontal
 * and vertical thread lines forming a basket-weave grid. Tiles cleanly. */
function renderCanvas(ctx, base, rng) {
  const w = TILE_SIZE, h = TILE_SIZE;
  ctx.fillStyle = `rgb(${base.r},${base.g},${base.b})`;
  ctx.fillRect(0, 0, w, h);
  const spacing = 4;
  // Horizontal threads (warp)
  ctx.lineWidth = 2;
  ctx.lineCap = 'butt';
  for (let y = 0; y < h; y += spacing) {
    const shade = 0.85 + rng() * 0.15;
    ctx.strokeStyle = rgba(base.r * shade, base.g * shade, base.b * shade, 0.55);
    ctx.beginPath();
    ctx.moveTo(0, y + 1);
    ctx.lineTo(w, y + 1);
    ctx.stroke();
  }
  // Vertical threads (weft) — sit on top of warp at every other intersection
  // for the over-under appearance
  ctx.lineWidth = 1.6;
  for (let x = 0; x < w; x += spacing) {
    const shade = 0.95 + rng() * 0.1;
    ctx.strokeStyle = rgba(base.r * shade, base.g * shade, base.b * shade, 0.45);
    // Draw vertical thread in short dashes that interleave with horizontal
    for (let y = 0; y < h; y += spacing * 2) {
      const offset = (x / spacing) % 2 === 0 ? 0 : spacing;
      ctx.beginPath();
      ctx.moveTo(x + 1, y + offset);
      ctx.lineTo(x + 1, y + offset + spacing);
      ctx.stroke();
    }
  }
  // Subtle highlight specks to read as fabric, not flat lines
  for (let i = 0; i < 600; i++) {
    const x = rng() * w;
    const y = rng() * h;
    ctx.fillStyle = rgba(base.r * 1.2, base.g * 1.2, base.b * 1.2, 0.08);
    ctx.fillRect(x, y, 1, 1);
  }
}

const RENDERERS = {
  felt: renderFelt,
  wool: renderWool,
  denim: renderDenim,
  canvas: renderCanvas,
};

/**
 * Returns a data: URL for the requested texture+color, generating the tile
 * lazily and caching the result. Pass type === 'none' (or falsy) to get null.
 */
export function getTextureUrl(type, color) {
  if (!type || type === 'none') return null;
  if (!RENDERERS[type]) return null;
  const key = `${type}|${color}`;
  if (cache.has(key)) return cache.get(key);

  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext('2d');
  const base = parseColor(color);
  // Seed the PRNG from the color so the same color → same dot positions.
  const seed = (base.r * 256 + base.g) * 256 + base.b + type.length * 17;
  const rng = makeRng(seed);
  RENDERERS[type](ctx, base, rng);
  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}
