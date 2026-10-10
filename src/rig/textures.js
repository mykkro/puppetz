// Procedural textures: small tileable grayscale patterns generated in code (no image files), used
// to break up the flat colors: woven cloth, leather grain, brushed metal, wood, skin, hair.
// A material opts in with "texture": "<type>" (and optional "textureScale", "textureStrength").
// The texture multiplies the material color (map) and also drives a bump map in the web viewer.
// Works in the browser and in Node; textures are cached per type so a GLB stores each one once.
import * as THREE from 'three';

const SIZE = 128;

// Deterministic tileable value noise.
function makeNoise(seed) {
  const n = 64;
  const grid = new Float32Array(n * n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < grid.length; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    grid[i] = s / 0xffffffff;
  }
  const at = (x, y) => grid[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  const fade = (t) => t * t * (3 - 2 * t);
  // Value noise with period `period` cells (must divide 64 for seamless tiling).
  return (u, v, period) => {
    const x = u * period;
    const y = v * period;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = fade(x - xi);
    const fy = fade(y - yi);
    const w = (k) => ((k % period) + period) % period;
    const a = at(w(xi), w(yi)) + (at(w(xi + 1), w(yi)) - at(w(xi), w(yi))) * fx;
    const b = at(w(xi), w(yi + 1)) + (at(w(xi + 1), w(yi + 1)) - at(w(xi), w(yi + 1))) * fx;
    return a + (b - a) * fy;
  };
}

const noise = makeNoise(1337);
const fbm = (u, v, base, octaves = 4) => {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(u, v, base << o);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm; // 0..1
};

// Each pattern returns a value in about -1..1 for (u, v) in 0..1; strength scales it later.
const PATTERNS = {
  noise: (u, v) => (fbm(u, v, 4) - 0.5) * 2,
  skin: (u, v) => (fbm(u, v, 2, 3) - 0.5) * 1.4 + (noise(u, v, 64) - 0.5) * 0.5,
  fabric: (u, v) => {
    const weave = Math.sin(u * Math.PI * 2 * 48) * Math.sin(v * Math.PI * 2 * 48);
    return weave * 0.45 + (fbm(u, v, 4) - 0.5) * 1.2;
  },
  knit: (u, v) => {
    const row = Math.abs(Math.sin(v * Math.PI * 2 * 24));
    const stitch = Math.abs(Math.sin((u * 32 + (Math.floor(v * 48) % 2) * 0.5) * Math.PI));
    return (row * stitch - 0.4) * 1.2 + (fbm(u, v, 8, 2) - 0.5) * 0.6;
  },
  leather: (u, v) => {
    const blotch = fbm(u, v, 4);
    const pores = noise(u, v, 32);
    return (blotch - 0.5) * 1.6 + (pores > 0.7 ? -0.6 : 0) + (noise(u, v, 64) - 0.5) * 0.4;
  },
  metal: (u, v) => (noise(u * 0.05, v, 64) - 0.5) * 1.2 + (fbm(u, v, 2, 2) - 0.5) * 0.8,
  wood: (u, v) => {
    const warp = fbm(u, v, 4, 3) * 3;
    const rings = Math.sin((u * 12 + warp) * Math.PI * 2);
    return rings * 0.6 + (noise(u * 0.1, v, 64) - 0.5) * 0.8;
  },
  hair: (u, v) => (noise(u, v * 0.03, 64) - 0.5) * 1.6 + (fbm(u, v, 4, 2) - 0.5) * 0.6,
  // Interlocking rings: each row offset by half a ring.
  chain: (u, v) => {
    const n = 16;
    const y = v * n;
    const x = u * n + (Math.floor(y) % 2) * 0.5;
    const dx = x - Math.floor(x) - 0.5;
    const dy = y - Math.floor(y) - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy);
    return Math.abs(r - 0.32) < 0.11 ? 0.9 : -0.9;
  },
  fur: (u, v) => (noise(u, v * 0.25, 64) - 0.5) * 2 + (fbm(u, v, 8, 2) - 0.5) * 0.8,
  // Quilted padding: diamond seams over soft puffs.
  quilt: (u, v) => {
    const n = 8;
    const a = (u + v) * n;
    const b = (u - v) * n;
    const seam = Math.min(Math.abs(a - Math.round(a)), Math.abs(b - Math.round(b)));
    return seam < 0.06 ? -1 : Math.min(1, seam * 3) * 0.6 + (fbm(u, v, 8, 2) - 0.5) * 0.4;
  },
};

export const TEXTURE_TYPES = Object.keys(PATTERNS);

const DEFAULT_STRENGTH = { noise: 0.12, skin: 0.06, fabric: 0.14, knit: 0.16, leather: 0.16, metal: 0.06, wood: 0.18, hair: 0.18, chain: 0.35, fur: 0.25, quilt: 0.2 };
const DEFAULT_BUMP = { skin: 0.5, metal: 0.4 };

const cache = new Map();

/** A shared grayscale RGBA DataTexture for the given pattern type and strength. */
export function proceduralTexture(type, strength = DEFAULT_STRENGTH[type] ?? 0.12) {
  const key = `${type}:${strength}`;
  if (cache.has(key)) return cache.get(key);
  const pattern = PATTERNS[type];
  if (!pattern) throw new Error(`Unknown texture "${type}" (known: ${TEXTURE_TYPES.join(', ')})`);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = pattern(x / SIZE, y / SIZE);
      // Mostly near white: the texture multiplies the material color, so it only shades it a little.
      const g = Math.round(Math.min(255, Math.max(0, 255 * (1 - strength) + 255 * strength * p)));
      const i = (y * SIZE + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = g;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  tex.name = `puppetz-${type}`;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Adds map + bumpMap to material params for a JSON material with a "texture" field. */
export function applyTexture(params, m) {
  if (!m.texture) return params;
  const base = proceduralTexture(m.texture, m.textureStrength);
  const map = base.clone(); // clones share the image (one copy in the GLB) but have their own repeat
  const scale = m.textureScale ?? 1;
  map.repeat.set(scale, scale);
  map.needsUpdate = true;
  return { ...params, map, bumpMap: map, bumpScale: m.bumpScale ?? DEFAULT_BUMP[m.texture] ?? 1.5 };
}
