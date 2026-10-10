// Humanoid generator: turns a short recipe (body settings + equipped items) into a full Puppetz
// character definition: skeleton, parts, materials, body clips, face expressions.
//
//   { "generator": "humanoid", "id": "knight",
//     "body": { "sex": "male", "age": 30, "height": 1, "girth": 1, "hair": "short", ... },
//     "equipment": { "clothes": "tunic", "armor": "plate", "back": { "item": "cape", "color": "#b33" },
//                    "mainHand": "sword", "offHand": "roundShield" } }
//
// Items are functions of the body's measurements (see makeBody), so every item fits every body:
// a child, a tall thin elf or a stout dwarf. Each item slot is a layer: clothes sit on the skin,
// armor on the clothes, a cape over everything. Materials are named per item ("clothes",
// "armor_metal", ...) so a texture can later be attached to one item without touching the rest.
import { ITEMS, SLOTS, itemsForSlot, resolveEquip, mixColor } from './items.js';

export { ITEMS, SLOTS, itemsForSlot, resolveEquip };

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;
const r3 = (v) => Math.round(v * 10000) / 10000;
const v3 = (a) => a.map(r3);

// ---------------------------------------------------------------- options (drive the editor UI)

export const BODY_OPTIONS = [
  { key: 'sex', label: 'Sex', options: ['male', 'female'] },
  { key: 'age', label: 'Age', range: [5, 90, 1] },
  { key: 'height', label: 'Height', range: [0.8, 1.2, 0.01] },
  { key: 'girth', label: 'Girth', range: [0.8, 1.35, 0.01] },
  { key: 'skin', label: 'Skin', color: true },
  { key: 'eyes', label: 'Eyes', color: true },
  { key: 'hairColor', label: 'Hair color', color: true },
];

export const BODY_DEFAULTS = {
  sex: 'male', age: 25, height: 1, girth: 1, skin: '#f2c9a5', eyes: '#3a5f9e',
  hairColor: '#6b4226',
};

export const SKIN_TONES = ['#ffe0c7', '#f2c9a5', '#e0a77e', '#b97a50', '#8a5634', '#5c3a24'];
/** Natural hair shades first, then a few fantasy colors. */
export const HAIR_COLORS = ['#1c1714', '#3b2a20', '#6b4226', '#a8642a', '#c8562e', '#e2c070', '#f0e2b8', '#9a9a9a', '#3a6fd9', '#d94a9a', '#4fa36b', '#8a4ad9'];

export const EXPRESSIONS = ['neutral', 'happy', 'sad', 'agitated', 'angry', 'sleepy'];

// ---------------------------------------------------------------- body measurements

function makeBody(b) {
  const age = clamp(b.age, 4, 99);
  const grow = smooth(5, 18, age); // 0 = small child, 1 = grown up
  const old = smooth(50, 88, age);
  const female = b.sex === 'female';
  const H = b.height * lerp(0.6, 1, grow) * (1 - 0.05 * old); // length scale
  const G = b.girth * lerp(0.8, 1, grow); // girth scale
  // Head: an ellipsoid, R wide, R·HY tall and R·HZ deep. Children's heads are bigger and rounder.
  const R = 0.152 * lerp(0.88, 1, grow) * (0.85 + 0.15 * b.height);
  const HY = lerp(1.08, 1.18, grow);
  const HZ = lerp(1.03, 1.08, grow);

  const d = {
    age, grow, old, female, H, G, R, HY, HZ,
    thigh: 0.27 * H, shin: 0.25 * H, ankle: 0.06 * H, footLen: 0.1 * lerp(0.75, 1, grow) * (0.85 + 0.15 * G),
    legR: 0.055 * G, armR: 0.04 * G,
    spineLen: 0.15 * H, chestLen: 0.19 * H, neckLen: 0.045 * H,
    upperArm: 0.19 * H, foreArm: 0.16 * H, handR: 0.043 * lerp(0.8, 1, grow) * (0.7 + 0.3 * G),
    shoulderX: (female ? 0.13 : 0.15) * lerp(0.78, 1, grow) * (0.55 + 0.45 * G),
    hipX: (female ? 0.078 : 0.07) * G,
    hipR: (female ? 0.14 : 0.12) * G, waistR: (female ? 0.1 : 0.115) * G, chestR: (female ? 0.125 : 0.142) * G,
    depth: 0.8, // torso cross-section is flattened front-to-back
  };
  d.hipY = d.thigh + d.shin + d.ankle;
  d.top = d.spineLen + d.chestLen; // neck base, in spine-bone space
  d.armOut = 7 + 30 * Math.max(0, G - 1); // stout characters hold their arms further out
  // Torso outline (radius, y) in spine-bone space: crotch, hips, waist, chest, shoulders, neck.
  d.torso = [
    [0, -0.1 * H], [d.hipR * 0.72, -0.095 * H], [d.hipR, -0.045 * H], [d.hipR * 0.97, 0.02 * H],
    [d.waistR, d.spineLen * 0.75], [d.chestR, d.spineLen + d.chestLen * 0.45],
    [d.shoulderX * 0.93, d.top - 0.05 * H], [d.shoulderX * 0.62, d.top - 0.008 * H], [0.045 * G, d.top], [0, d.top],
  ];
  return d;
}

// ---------------------------------------------------------------- generator context

function makeContext(cfg) {
  const body = { ...BODY_DEFAULTS, ...cfg.body };
  const d = makeBody(body);
  const ctx = {
    cfg, body, d,
    skeleton: [], parts: [], materials: {},
    hides: new Set(), // body features covered by items, e.g. "hairTop" under a helmet
    grip: null, // "blade" | "pole": how the main-hand item is held (drives poses and swings)
    shield: false,
    layer: { torso: 1, arm: 1, foreArm: 1, leg: 1, shin: 1, foot: 1, hand: 1, head: 1 }, // outermost covering per region
  };
  // Materials are named per body region / item, and a recipe can override any of them ("materials").
  // "textures": false turns the procedural textures off for a clean, flat-colored look.
  ctx.mat = (name, m) => {
    if (ctx.materials[name]) return name;
    const mat = { ...m, ...cfg.materials?.[name] };
    if (cfg.textures === false) { delete mat.texture; delete mat.textureScale; }
    ctx.materials[name] = mat;
    return name;
  };
  ctx.bone = (b) => { ctx.skeleton.push(b); return b.name; };
  ctx.part = (p) => {
    const out = { ...p };
    for (const k of ['position', 'rotation']) if (out[k]) out[k] = v3(out[k]);
    if (Array.isArray(out.scale)) out.scale = v3(out.scale);
    ctx.parts.push(out);
  };
  // Limb segment: a capsule hanging down the bone's -Y axis, overlapping into the next joint.
  ctx.limb = (name, bone, len, r, material, extra = {}) => ctx.part({
    name, bone, material, position: [0, -len / 2 + (extra.shift ?? 0), 0],
    geometry: { type: 'capsule', radius: r3(r), length: r3(Math.max(0.005, (extra.len ?? len) - r)), radialSegments: 20 },
    ...(extra.mirror && { mirror: true }),
  });
  // Torso-shaped shell between two heights, inflated by k (a lathe of the body outline).
  ctx.torsoShell = (name, material, k, yFrom = -Infinity, yTo = Infinity, extra = {}) => {
    const pts = d.torso.filter(([, y]) => y >= yFrom - 1e-6 && y <= yTo + 1e-6).map(([r, y]) => [r3(r && r * k + 0.004), r3(y)]);
    if (yFrom > -Infinity) pts.unshift([0, pts[0][1]]);
    if (yTo < Infinity) pts.push([0, pts[pts.length - 1][1]]);
    ctx.part({ name, bone: 'spine', material, scale: [1, 1, d.depth], geometry: { type: 'lathe', segments: 40, points: pts }, ...extra });
  };
  ctx.torsoRadius = (y) => {
    const t = d.torso;
    for (let i = 1; i < t.length; i++) {
      if (y <= t[i][1]) { const s = (y - t[i - 1][1]) / (t[i][1] - t[i - 1][1] || 1); return lerp(t[i - 1][0], t[i][0], clamp(s, 0, 1)); }
    }
    return 0;
  };
  // Head-space design: things on the head are placed as if the head were a sphere of radius R;
  // hp() maps such a point onto the actual ellipsoid head (taller by HY, deeper by HZ).
  ctx.hp = ([x, y, z]) => v3([x, y * d.HY, z * d.HZ]);
  ctx.hpts = (pts) => pts.map(ctx.hp);
  // Part of a (stretched) sphere around the head center. Azimuth: 0 = front (+Z), 90 = left (+X).
  // Polar: 0 = top of the head, 180 = bottom.
  ctx.headShell = (name, material, radius, az0, az1, p0, p1, extra = {}) => ctx.part({
    name, bone: 'skull', material, scale: [1, r3(d.HY), r3(d.HZ)], ...extra,
    geometry: { type: 'sphere', radius: r3(radius), widthSegments: 32, heightSegments: 20,
      phiStart: az0 + 90, phiLength: az1 - az0, thetaStart: p0, thetaLength: p1 - p0 },
  });
  // Point on a sphere of radius r around the head center, plus the rotation that aims +Y outward.
  ctx.onHead = (r, polar, az) => ({
    position: ctx.hp([r * Math.sin(polar * DEG) * Math.sin(az * DEG), r * Math.cos(polar * DEG), r * Math.sin(polar * DEG) * Math.cos(az * DEG)]),
    rotation: [polar, az, 0], rotationOrder: 'YXZ',
  });
  // Depth of the face surface at (x, y) from the head center, in sphere design space (see hp).
  ctx.faceZ = (x, y) => Math.sqrt(Math.max(0, d.R * d.R - x * x - y * y));
  return ctx;
}

// ---------------------------------------------------------------- body

function buildBody(ctx) {
  const { d, body } = ctx;
  const { H, R } = d;
  const skin = ctx.mat('skin', { texture: 'skin', textureScale: 2, color: body.skin, roughness: 0.55 });
  const skinShade = ctx.mat('skin_shade', { texture: 'skin', textureScale: 2, color: mixColor(body.skin, '#7a3b2a', 0.18), roughness: 0.6 });

  // Skeleton. Both arms are written out (no mirror) because held items change one side's rest pose.
  const B = ctx.bone;
  B({ name: 'root', parent: null });
  B({ name: 'hips', parent: 'root', position: [0, r3(d.hipY), 0] });
  B({ name: 'spine', parent: 'hips', position: [0, r3(0.02 * H), 0], rotation: [r3(10 * d.old), 0, 0],
    limits: { x: [-25, 40], y: [-40, 40], z: [-20, 20] } });
  B({ name: 'chest', parent: 'spine', position: [0, r3(d.spineLen), 0], limits: { x: [-20, 25], y: [-30, 30], z: [-15, 15] } });
  B({ name: 'neck', parent: 'chest', position: [0, r3(d.chestLen), 0], rotation: [r3(-6 * d.old), 0, 0],
    limits: { x: [-30, 30], y: [-45, 45], z: [-25, 25] } });
  B({ name: 'head', parent: 'neck', position: [0, r3(d.neckLen), 0], limits: { x: [-35, 30], y: [-70, 70], z: [-30, 30] } });
  // "skull" sits at the head's center and carries everything on the head. Body clips move "head",
  // expressions move "skull", so a nod while talking and a sad droop can play at the same time.
  B({ name: 'skull', parent: 'head', position: [0, r3(R * d.HY * 0.9), r3(0.01 * H)] });

  const shoulderY = d.chestLen - 0.045 * H;
  const shoulderX = d.shoulderX - d.armR * 0.5;
  const arm = (side, s) => {
    B({ name: `upperArm${side}`, parent: 'chest', position: v3([s * shoulderX, shoulderY, 0]), rotation: [0, 0, r3(s * d.armOut)],
      tags: ['arm'], limits: { x: [-170, 60], y: [-80, 80], z: s > 0 ? [-30, 160] : [-160, 30] } });
    B({ name: `foreArm${side}`, parent: `upperArm${side}`, position: [0, r3(-d.upperArm), 0], rotation: [-10, 0, 0],
      tags: ['arm'], limits: { x: [-150, 0], y: [-80, 80], z: [0, 0] } });
    B({ name: `hand${side}`, parent: `foreArm${side}`, position: [0, r3(-d.foreArm), 0], tags: ['arm'],
      limits: { x: [-70, 80], y: [-30, 30], z: [-40, 40] } });
  };
  arm('_L', 1);
  arm('_R', -1);
  B({ name: 'grip_R', parent: 'hand_R', position: [0, r3(-d.handR * 0.8), r3(d.handR * 0.15)], tags: ['socket'] });
  B({ name: 'mount_L', parent: 'foreArm_L', position: [r3(d.armR * 1.6), r3(-d.foreArm * 0.55), 0], tags: ['socket'] });

  B({ name: 'thigh_L', parent: 'hips', position: [r3(d.hipX), 0, 0], mirror: true, tags: ['leg'],
    limits: { x: [-100, 45], y: [-30, 30], z: [-20, 45] } });
  B({ name: 'shin_L', parent: 'thigh_L', position: [0, r3(-d.thigh), 0], mirror: true, tags: ['leg'],
    limits: { x: [0, 140], y: [0, 0], z: [0, 0] } });
  B({ name: 'foot_L', parent: 'shin_L', position: [0, r3(-d.shin), 0], mirror: true, tags: ['leg'],
    limits: { x: [-45, 45], y: [-20, 20], z: [-20, 20] } });

  // Skin. Clothing and armor are shells over these shapes.
  ctx.torsoShell('torso', skin, 1);
  ctx.part({ name: 'neckSkin', bone: 'neck', material: skin, position: [0, r3(d.neckLen * 0.6), 0],
    geometry: { type: 'cylinder', radiusTop: r3(R * 0.32), radiusBottom: r3(R * 0.36), height: r3(d.neckLen + R * 0.35) } });
  for (const [side, s] of [['_L', 1], ['_R', -1]]) {
    ctx.part({ name: `shoulder${side}`, bone: `upperArm${side}`, material: skin, geometry: { type: 'sphere', radius: r3(d.armR * 1.25) } });
    ctx.limb(`upperArmSkin${side}`, `upperArm${side}`, d.upperArm, d.armR, skin);
    ctx.limb(`foreArmSkin${side}`, `foreArm${side}`, d.foreArm, d.armR * 0.9, skin);
    ctx.part({ name: `fist${side}`, bone: `hand${side}`, material: skin, position: [0, r3(-d.handR * 0.8), 0], scale: [0.85, 1, 1],
      geometry: { type: 'sphere', radius: r3(d.handR) } });
    ctx.part({ name: `thumb${side}`, bone: `hand${side}`, material: skin, position: v3([-s * d.handR * 0.25, -d.handR * 0.45, d.handR * 0.75]),
      geometry: { type: 'sphere', radius: r3(d.handR * 0.42), widthSegments: 14, heightSegments: 10 } });
  }
  ctx.limb('thighSkin_L', 'thigh_L', d.thigh, d.legR, skin, { mirror: true });
  ctx.limb('shinSkin_L', 'shin_L', d.shin, d.legR * 0.85, skin, { mirror: true });
  ctx.part({ name: 'footSkin_L', bone: 'foot_L', material: skin, mirror: true,
    position: [0, r3(-d.ankle * 0.5), r3(d.footLen * 0.3)], scale: v3([d.legR * 0.95, d.ankle * 0.5, d.footLen * 0.55]),
    geometry: { type: 'sphere', radius: 1 } });

  buildFace(ctx, skin, skinShade);
}

// ---------------------------------------------------------------- face

function buildFace(ctx, skin, skinShade) {
  const { d, body } = ctx;
  const R = d.R;
  const B = ctx.bone;
  ctx.headShell('skullSkin', skin, R, 0, 360, 0, 180);
  ctx.part({ name: 'nose', bone: 'skull', material: skinShade, position: ctx.hp([0, -0.27 * R, ctx.faceZ(0, -0.27 * R) - 0.02 * R]),
    scale: [1.15, 0.9, 1], geometry: { type: 'sphere', radius: r3(0.075 * R), widthSegments: 16, heightSegments: 12 } });
  ctx.part({ name: 'ear_L', bone: 'skull', material: skinShade, mirror: true, position: ctx.hp([0.96 * R, -0.12 * R, -0.02 * R]),
    scale: [0.45, 1, 0.8], geometry: { type: 'sphere', radius: r3(0.17 * R), widthSegments: 16, heightSegments: 12 } });

  const iris = ctx.mat('eye_iris', { color: body.eyes, roughness: 0.2, clearcoat: 1 });
  const pupil = ctx.mat('eye_pupil', { color: '#141418', roughness: 0.2, clearcoat: 1 });
  const glint = ctx.mat('eye_glint', { color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 1 });
  const ex = 0.36 * R;
  const ey = -0.06 * R;
  const tilt = [r3(Math.asin(-ey / R) / DEG), r3(Math.asin(ex / R) / DEG), 0];
  // eye_L carries the expression (squint, wide); blink_L under it only blinks (overlay clip).
  B({ name: 'eye_L', parent: 'skull', position: ctx.hp([ex, ey, ctx.faceZ(ex, ey) - 0.035 * R]), rotation: tilt, mirror: true });
  B({ name: 'blink_L', parent: 'eye_L', mirror: true });
  ctx.part({ name: 'iris_L', bone: 'blink_L', material: iris, mirror: true, scale: v3([0.15 * R, 0.2 * R, 0.08 * R]),
    geometry: { type: 'sphere', radius: 1, widthSegments: 20, heightSegments: 16 } });
  ctx.part({ name: 'pupil_L', bone: 'blink_L', material: pupil, mirror: true, position: v3([0, -0.01 * R, 0.035 * R]),
    scale: v3([0.085 * R, 0.12 * R, 0.05 * R]), geometry: { type: 'sphere', radius: 1, widthSegments: 16, heightSegments: 12 } });
  ctx.part({ name: 'glint_L', bone: 'blink_L', material: glint, mirror: true, castShadow: false, position: v3([0.04 * R, 0.07 * R, 0.07 * R]),
    geometry: { type: 'sphere', radius: r3(0.045 * R), widthSegments: 10, heightSegments: 8 } });
  ctx.part({ name: 'glintSmall_L', bone: 'blink_L', material: glint, mirror: true, castShadow: false, position: v3([-0.05 * R, -0.08 * R, 0.065 * R]),
    geometry: { type: 'sphere', radius: r3(0.022 * R), widthSegments: 8, heightSegments: 6 } });
  if (d.female) {
    const lash = ctx.mat('eye_lash', { color: '#2a1d1a', roughness: 0.5 });
    ctx.part({ name: 'lash_L', bone: 'blink_L', material: lash, mirror: true, geometry: { type: 'tube', radius: r3(0.016 * R), tubularSegments: 16,
      points: [[-0.1 * R, 0.17 * R, 0.05 * R], [0.05 * R, 0.205 * R, 0.045 * R], [0.15 * R, 0.16 * R, 0.03 * R], [0.21 * R, 0.2 * R, 0.01 * R]].map(v3) } });
  }

  const brow = ctx.mat('brow', { color: mixColor(mixColor(body.hairColor, '#e4e4e4', d.old * 0.85), '#000000', 0.25), roughness: 0.7 });
  const by = ey + 0.3 * R;
  B({ name: 'brow_L', parent: 'skull', position: ctx.hp([ex, by, ctx.faceZ(ex, by) + 0.005 * R]), rotation: [r3(Math.asin(-by / R) / DEG), tilt[1], 0], mirror: true });
  ctx.part({ name: 'browHair_L', bone: 'brow_L', material: brow, mirror: true, geometry: { type: 'tube', radius: r3(0.03 * R), tubularSegments: 16,
    points: [[-0.13 * R, -0.015 * R, -0.01 * R], [0, 0.02 * R, 0], [0.13 * R, 0, -0.015 * R]].map(v3) } });

  // Mouth shapes are props under "mouth": the face layer shows one at a time by scaling the others
  // to 0.01. "talk" (body layer) opens talkMouth under whichever shape is showing.
  const lip = ctx.mat('mouth', { color: '#6b2b2b', roughness: 0.5 });
  const inside = ctx.mat('mouth_inside', { color: '#9c3a3f', roughness: 0.5 });
  const my = -0.52 * R;
  B({ name: 'mouth', parent: 'skull', position: ctx.hp([0, my, ctx.faceZ(0, my) - 0.01 * R]), rotation: [r3(Math.asin(-my / R) / DEG * 0.8), 0, 0] });
  const w = 0.2 * R;
  const curve = (bend) => [[-w, bend], [-w / 2, -bend * 0.35], [0, -bend * 0.6], [w / 2, -bend * 0.35], [w, bend]].map(([x, y]) => v3([x, y, 0.012 * R]));
  const shapes = {
    mouthNeutral: { type: 'tube', radius: r3(0.022 * R), tubularSegments: 16, points: curve(0.03 * R).map(([x, y, z]) => [r3(x * 0.7), y, z]) },
    mouthSmile: { type: 'tube', radius: r3(0.024 * R), tubularSegments: 20, points: curve(0.09 * R) },
    mouthFrown: { type: 'tube', radius: r3(0.024 * R), tubularSegments: 20, points: curve(-0.07 * R).map(([x, y, z]) => [r3(x * 0.8), y, z]) },
  };
  for (const [name, geometry] of Object.entries(shapes)) {
    B({ name, parent: 'mouth', scale: name === 'mouthNeutral' ? 1 : 0.01, tags: ['prop'] });
    ctx.part({ name: `${name}Line`, bone: name, material: lip, castShadow: false, geometry });
  }
  B({ name: 'mouthOpen', parent: 'mouth', scale: 0.01, tags: ['prop'] });
  ctx.part({ name: 'mouthOpenHole', bone: 'mouthOpen', material: inside, castShadow: false, scale: v3([0.13 * R, 0.11 * R, 0.04 * R]),
    geometry: { type: 'sphere', radius: 1, widthSegments: 16, heightSegments: 12 } });
  B({ name: 'talkMouth', parent: 'mouth', position: v3([0, -0.03 * R, -0.005 * R]), scale: 0.01, tags: ['prop'] });
  ctx.part({ name: 'talkMouthHole', bone: 'talkMouth', material: inside, castShadow: false, scale: v3([0.14 * R, 0.09 * R, 0.035 * R]),
    geometry: { type: 'sphere', radius: 1, widthSegments: 16, heightSegments: 12 } });

  const blush = ctx.mat('blush', { color: '#ff8a8a', roughness: 0.8, opacity: 0.75 });
  B({ name: 'blush', parent: 'skull', scale: 0.01, tags: ['prop'] });
  const bx = 0.56 * R;
  const byy = -0.32 * R;
  ctx.part({ name: 'blush_L', bone: 'blush', material: blush, mirror: true, castShadow: false,
    position: ctx.hp([bx, byy, ctx.faceZ(bx, byy) - 0.025 * R]), rotation: [0, r3(Math.asin(bx / R) / DEG), 0], scale: [1, 0.6, 0.3],
    geometry: { type: 'sphere', radius: r3(0.14 * R), widthSegments: 14, heightSegments: 10 } });
}

// ---------------------------------------------------------------- poses & clips

const T = (bone, channel, axis, src, extra) => ({ bone, channel, axis, ...src, ...extra });
const rot = (bone, axis, src, extra) => T(bone, 'rotation', axis, src, extra);
const pos = (bone, axis, src, extra) => T(bone, 'position', axis, src, extra);
const wave = (amp, freq = 1, phase = 0, offset = 0) => ({ wave: { amp: r3(amp), freq, phase, offset: r3(offset) } });
const keys = (k) => ({ keys: k.map(([t, v]) => [t, r3(v)]) });
const value = (v) => ({ value: r3(v) });
const ABS = { absolute: true };
const scaleAll = (bone, src, extra) => ['x', 'y', 'z'].map((ax) => T(bone, 'scale', ax, src, { absolute: true, ...extra }));

/** Rest-pose rotations for the arms, depending on what the hands hold. */
function armRest(ctx) {
  const out = ctx.d.armOut;
  const L = { upper: [0, 0, out], fore: [-10, 0, 0], hand: [0, 0, 0] };
  const R = { upper: [0, 0, -out], fore: [-10, 0, 0], hand: [0, 0, 0] };
  if (ctx.grip === 'blade') Object.assign(R, { upper: [-5, 0, -out - 3], fore: [-35, 0, 0], hand: [55, 0, 0] });
  if (ctx.grip === 'pole') Object.assign(R, { upper: [-8, 0, -out - 6], fore: [-78, 0, 0], hand: [-8, -22, 0] }); // wrist leans the pole away from the head
  if (ctx.shield) Object.assign(L, { upper: [-5, 0, out + 4], fore: [-30, 0, 0] });
  return { L, R };
}

// A held pose for one arm, as absolute rotation tracks (so it does not depend on the rest pose).
const armPose = (side, upper, fore, hand) => [
  ...['x', 'y', 'z'].map((ax, i) => rot(`upperArm${side}`, ax, Array.isArray(upper[i]) ? keys(upper[i]) : value(upper[i]), ABS)),
  ...['x', 'y', 'z'].map((ax, i) => rot(`foreArm${side}`, ax, Array.isArray(fore[i]) ? keys(fore[i]) : value(fore[i]), ABS)),
  ...['x', 'y', 'z'].map((ax, i) => rot(`hand${side}`, ax, Array.isArray(hand[i]) ? keys(hand[i]) : value(hand[i]), ABS)),
];

function makeClips(ctx) {
  const { d } = ctx;
  const { H } = d;
  const rest = armRest(ctx);
  const legLen = d.thigh + d.shin;
  const lively = lerp(1.25, 1, d.grow) * lerp(1, 0.7, d.old); // kids bounce, elders take it slow
  const extraBones = new Set(ctx.skeleton.map((b) => b.name));
  const cape = (src) => (extraBones.has('cape') ? [rot('cape', 'x', src)] : []);
  const tail = (src) => (extraBones.has('ponytail') ? [rot('ponytail', 'x', src)] : []);
  // How much each arm swings while moving: held poles and shields keep their pose.
  const swingL = ctx.shield ? 0.35 : 1;
  const swingR = ctx.grip === 'pole' ? 0.15 : ctx.grip === 'blade' ? 0.55 : 1;
  const clips = {};

  clips.idle = { duration: 3.2, tracks: [
    pos('hips', 'y', wave(0.004 * H, 2)),
    rot('hips', 'z', wave(1.5 * lively, 1)),
    rot('spine', 'z', wave(-1.5 * lively, 1)),
    rot('spine', 'x', wave(1.5, 2, 0.25)),
    rot('head', 'y', { interp: 'smooth', ...keys([[0, 0], [0.2, 0], [0.3, 18 * lively], [0.5, 18 * lively], [0.6, -12 * lively], [0.8, -12 * lively], [0.9, 0], [1, 0]]) }),
    rot('head', 'x', wave(2, 2)),
    rot('upperArm_L', 'z', wave(2, 2, 0.1)),
    rot('upperArm_R', 'z', wave(-2, 2, 0.1)),
    ...cape(wave(2, 1)),
    ...tail(wave(4, 1)),
  ] };

  const walkDur = r3(lerp(0.75, 1.0, smooth(0.6, 1.1, H)) / lively ** 0.5);
  const A = (ctx.skirtHem ?? 0) < -(d.thigh + 0.06 * H) ? 18 : 26;
  clips.walk = { duration: walkDur, tracks: [
    pos('hips', 'y', wave(0.02 * H, 2, 0.25)),
    rot('hips', 'y', wave(6, 1)),
    rot('hips', 'z', wave(3, 1, 0.25)),
    rot('spine', 'y', wave(-8, 1)),
    rot('spine', 'x', value(3)),
    rot('head', 'y', wave(3, 1)),
    rot('head', 'x', wave(2, 2)),
    rot('thigh_L', 'x', wave(A, 1), { mirror: { phase: 0.5 } }),
    rot('shin_L', 'x', keys([[0, 5], [0.25, 8], [0.5, 55], [0.7, 20], [0.8, 4], [1, 5]]), { mirror: { phase: 0.5 } }),
    rot('foot_L', 'x', keys([[0, -3], [0.25, -18], [0.5, -30], [0.75, 10], [0.88, 8], [1, -3]]), { mirror: { phase: 0.5 } }),
    rot('upperArm_L', 'x', wave(-22 * swingL, 1)),
    rot('upperArm_R', 'x', wave(22 * swingR, 1)),
    rot('foreArm_L', 'x', wave(-8 * swingL, 1, 0.1, -8 * swingL)),
    rot('foreArm_R', 'x', wave(8 * swingR, 1, 0.1, -8 * swingR)),
    ...cape(wave(4, 2, 0, -10)),
    ...tail(wave(10, 2)),
  ] };

  const runDur = r3(walkDur * 0.66);
  const RA = 42;
  clips.run = { duration: runDur, tracks: [
    pos('hips', 'y', wave(0.04 * H, 2, 0.25, 0.01 * H)),
    rot('hips', 'y', wave(9, 1)),
    rot('spine', 'y', wave(-12, 1)),
    rot('spine', 'x', value(14)),
    rot('head', 'x', value(-8)),
    rot('thigh_L', 'x', wave(RA, 1, 0, -8), { mirror: { phase: 0.5 } }),
    rot('shin_L', 'x', keys([[0, 20], [0.25, 35], [0.5, 110], [0.7, 70], [0.85, 15], [1, 20]]), { mirror: { phase: 0.5 } }),
    rot('foot_L', 'x', keys([[0, -5], [0.25, -30], [0.5, -20], [0.75, 15], [0.9, 10], [1, -5]]), { mirror: { phase: 0.5 } }),
    rot('upperArm_L', 'x', wave(-45 * swingL, 1)),
    rot('upperArm_R', 'x', wave(45 * swingR, 1)),
    rot('foreArm_L', 'x', wave(-15 * swingL, 1, 0, ctx.shield ? 0 : -65)),
    rot('foreArm_R', 'x', wave(15 * swingR, 1, 0, ctx.grip ? 0 : -65)),
    ...cape(wave(6, 2, 0, -32)),
    ...tail(wave(18, 2, 0, -15)),
  ] };

  // Talk: the mouth flaps through syllables, the head nods, a free hand gestures.
  const flap = keys([[0, 0.01], [0.04, 1], [0.08, 0.3], [0.12, 0.9], [0.17, 0.01], [0.24, 0.8], [0.3, 0.2], [0.36, 1], [0.42, 0.01],
    [0.55, 0.01], [0.6, 0.9], [0.65, 0.3], [0.7, 1], [0.76, 0.4], [0.82, 0.9], [0.88, 0.01], [1, 0.01]]);
  const gesture = !ctx.grip ? '_R' : !ctx.shield ? '_L' : null;
  const gs = gesture === '_L' ? 1 : -1;
  clips.talk = { duration: 3.6, tracks: [
    ...scaleAll('talkMouth', { interp: 'linear', ...flap }),
    rot('head', 'x', wave(4, 4)),
    rot('head', 'y', keys([[0, 0], [0.3, 8], [0.6, -6], [1, 0]])),
    rot('spine', 'y', keys([[0, 0], [0.3, 5], [0.6, -3], [1, 0]])),
    pos('hips', 'y', wave(0.004 * H, 2)),
    ...(gesture ? [
      rot(`upperArm${gesture}`, 'x', keys([[0, 0], [0.15, -40], [0.45, -30], [0.6, -45], [0.85, -10], [1, 0]])),
      rot(`upperArm${gesture}`, 'z', keys([[0, 0], [0.15, gs * 10], [0.6, gs * 15], [1, 0]])),
      rot(`foreArm${gesture}`, 'x', keys([[0, 0], [0.15, -60], [0.3, -45], [0.45, -70], [0.6, -50], [0.85, -20], [1, 0]])),
      rot(`hand${gesture}`, 'z', keys([[0, 0], [0.2, gs * 25], [0.5, gs * -10], [0.7, gs * 25], [1, 0]])),
    ] : []),
  ] };

  // Combat: a crouched guard with the weapon up and the shield in front.
  const out = d.armOut;
  // A long skirt or robe would be pierced by a wide stance: step less.
  const st = (ctx.skirtHem ?? 0) < -(d.thigh + 0.06 * H) ? 0.45 : 1;
  const stanceLegs = [
    pos('hips', 'y', wave(0.008 * H, 2, 0, -0.05 * H)),
    rot('hips', 'y', value(-20)),
    rot('spine', 'y', value(18)),
    rot('spine', 'x', value(8)),
    rot('head', 'y', value(5)),
    rot('thigh_L', 'x', value(-32 * st)), rot('thigh_L', 'z', value(8 * st)), rot('thigh_L', 'y', value(15)),
    rot('shin_L', 'x', value(40 * st)), rot('foot_L', 'x', value(-8 * st)),
    rot('thigh_R', 'x', value(18 * st)), rot('thigh_R', 'z', value(-10 * st)), rot('thigh_R', 'y', value(10)),
    rot('shin_R', 'x', value(30 * st)), rot('foot_R', 'x', value(-32 * st)),
    ...cape(value(-6)),
  ];
  const guardR = ctx.grip === 'blade' ? armPose('_R', [-30, 0, -out - 30], [-85, 0, 0], [-10, 0, 0])
    : ctx.grip === 'pole' ? armPose('_R', [-10, 0, -out - 10], [-55, 0, 0], [62, 0, 0])
    : armPose('_R', [-45, 0, -out - 5], [-115, 25, 0], [0, 0, 0]);
  const guardL = ctx.shield ? armPose('_L', [-60, 0, out + 5], [-80, 0, 0], [0, 0, 0])
    : armPose('_L', [-45, 0, out + 5], [-115, -25, 0], [0, 0, 0]);
  clips.combat = { duration: 1.2, tracks: [...stanceLegs, ...guardR, ...guardL] };

  // Attack: a chop (sword, axe), a thrust (spear, staff) or a jab (empty hand), back to guard.
  let strike;
  if (ctx.grip === 'blade') {
    strike = armPose('_R',
      [[[0, -30], [0.3, -165], [0.42, -60], [0.55, -35], [1, -30]], 0, -out - 30],
      [[[0, -85], [0.3, -50], [0.42, -5], [0.55, -15], [1, -85]], 0, 0],
      [[[0, -10], [0.3, -10], [0.42, 40], [0.55, 30], [1, -10]], 0, 0]);
  } else if (ctx.grip === 'pole') {
    strike = armPose('_R',
      [[[0, -10], [0.35, 15], [0.5, -60], [0.65, -55], [1, -10]], 0, -out - 10],
      [[[0, -55], [0.35, -75], [0.5, -10], [0.65, -15], [1, -55]], 0, 0],
      [[[0, 62], [0.35, 75], [0.5, 75], [0.65, 70], [1, 62]], 0, 0]);
  } else {
    strike = armPose('_R',
      [[[0, -45], [0.25, -35], [0.4, -85], [0.55, -80], [1, -45]], 0, -out - 5],
      [[[0, -115], [0.25, -125], [0.4, -10], [0.55, -15], [1, -115]], [[0, 25], [0.4, 0], [1, 25]], 0],
      [0, 0, 0]);
  }
  clips.attack = { duration: ctx.grip === 'pole' ? 1.0 : 0.85, tracks: [
    ...stanceLegs.filter((t) => !(t.bone === 'spine' && t.channel === 'rotation')),
    rot('spine', 'x', keys([[0, 8], [0.3, 0], [0.45, 22], [0.6, 18], [1, 8]])),
    rot('spine', 'y', keys([[0, 18], [0.3, 30], [0.45, -5], [0.6, 0], [1, 18]])),
    ...strike, ...guardL,
  ] };

  // Face layer. Every expression states every mouth shape so that switching always lands cleanly.
  const MOUTHS = ['mouthNeutral', 'mouthSmile', 'mouthFrown', 'mouthOpen'];
  const face = (mouth, blush, tracks, duration = 2.4) => ({ layer: 'face', duration, tracks: [
    ...MOUTHS.flatMap((m) => scaleAll(m, value(m === mouth ? 1 : 0.01))),
    ...scaleAll('blush', value(blush ? 1 : 0.01)),
    ...tracks,
  ] });
  const R = d.R;
  const eyesY = (v, extra = {}) => T('eye_L', 'scale', 'y', typeof v === 'number' ? value(v) : v, { mirror: true, ...extra });
  clips.face_neutral = face('mouthNeutral', false, []);
  clips.face_happy = face('mouthSmile', true, [
    eyesY(0.62),
    pos('brow_L', 'y', value(0.05 * R), { mirror: true }),
    rot('skull', 'z', wave(3, 1)),
    rot('skull', 'x', wave(1.5, 2, 0, -3)),
  ]);
  clips.face_sad = face('mouthFrown', false, [
    eyesY(0.82),
    rot('brow_L', 'z', value(-20), { mirror: true }),
    pos('brow_L', 'y', value(0.025 * R), { mirror: true }),
    rot('skull', 'x', value(10)),
    rot('skull', 'z', value(-4)),
  ], 3);
  clips.face_agitated = face('mouthOpen', false, [
    eyesY(1.15), T('eye_L', 'scale', 'x', value(1.1), { mirror: true }),
    rot('brow_L', 'z', value(-10), { mirror: true }),
    pos('brow_L', 'y', value(0.08 * R), { mirror: true }),
    rot('skull', 'y', wave(4, 8)),
    rot('skull', 'z', wave(2, 6, 0.3)),
    T('mouthOpen', 'scale', 'y', wave(0.25, 8, 0, 1), { absolute: true }),
  ], 1.5);
  clips.face_angry = face('mouthFrown', true, [
    eyesY(0.75),
    rot('brow_L', 'z', value(24), { mirror: true }),
    pos('brow_L', 'y', value(-0.035 * R), { mirror: true }),
    rot('skull', 'x', value(-5)),
    T('mouthFrown', 'scale', 'x', value(0.75), { absolute: true }),
  ]);
  clips.face_sleepy = face('mouthNeutral', false, [
    eyesY(keys([[0, 0.18], [0.45, 0.1], [0.6, 0.3], [0.7, 0.12], [1, 0.18]])),
    rot('brow_L', 'z', value(-6), { mirror: true }),
    pos('brow_L', 'y', value(-0.01 * R), { mirror: true }),
    rot('skull', 'x', keys([[0, 8], [0.5, 16], [0.6, 4], [1, 8]])),
    rot('skull', 'z', value(7)),
  ], 4);

  clips.blink = { layer: 'overlay', duration: 3.9, tracks: [
    T('blink_L', 'scale', 'y', { interp: 'linear', ...keys([[0, 1], [0.86, 1], [0.89, 0.08], [0.92, 1], [1, 1]]) }, { mirror: true }),
  ] };

  // Foot travel per half cycle is about 2·leg·sin(amplitude); the knees shorten it a little.
  const walkSpeed = (4 * legLen * Math.sin(A * DEG) / walkDur) * 0.82;
  const runSpeed = (4 * legLen * Math.sin(RA * DEG) / runDur) * 0.85;
  return { clips, rest, walkSpeed: r3(walkSpeed), runSpeed: r3(runSpeed) };
}

// ---------------------------------------------------------------- generator

export function generateHumanoid(cfg) {
  const ctx = makeContext(cfg);
  buildBody(ctx);

  const equipment = cfg.equipment ?? {};
  // Headwear goes on before hair so it can hide the top of the hair.
  const order = [...SLOTS.filter((s) => s.key !== 'hair' && s.key !== 'beard'), ...SLOTS.filter((s) => s.key === 'hair' || s.key === 'beard')];
  for (const { key } of order) {
    const eq = resolveEquip(equipment[key], ctx.body.hairColor);
    if (!eq) {
      if (equipment[key] && equipment[key] !== 'none') throw new Error(`Unknown item "${equipment[key].item ?? equipment[key]}" in slot "${key}"`);
      continue;
    }
    if (eq.item.slot !== key) throw new Error(`Item "${eq.id}" goes in slot "${eq.item.slot}", not "${key}"`);
    eq.item.build(ctx, eq);
  }

  const { clips, rest, walkSpeed, runSpeed } = makeClips(ctx);
  // Apply the held-item arm poses to the rest skeleton.
  const byName = new Map(ctx.skeleton.map((b) => [b.name, b]));
  for (const [side, pose] of [['_L', rest.L], ['_R', rest.R]]) {
    byName.get(`upperArm${side}`).rotation = v3(pose.upper);
    byName.get(`foreArm${side}`).rotation = v3(pose.fore);
    byName.get(`hand${side}`).rotation = v3(pose.hand);
  }

  const d = ctx.d;
  const expressions = Object.fromEntries(EXPRESSIONS.map((e) => [e, `face_${e}`]));
  return {
    id: cfg.id ?? 'humanoid',
    name: cfg.name ?? cfg.id ?? 'Humanoid',
    description: cfg.description ?? 'Generated humanoid character.',
    version: cfg.version ?? 1,
    symmetry: { left: '_L', right: '_R' },
    materials: ctx.materials,
    skeleton: ctx.skeleton,
    parts: ctx.parts,
    clips,
    controller: {
      states: { idle: 'idle', walk: 'walk', run: 'run', talk: 'talk', combat: 'combat', attack: 'attack' },
      overlays: ['blink'],
      expressions,
      defaultExpression: EXPRESSIONS.includes(cfg.expression) ? cfg.expression : 'neutral',
      walkSpeed, runSpeed, turnSpeed: 9, crossfade: 0.22,
    },
    view: { target: [0, r3((d.hipY + d.top + d.R * d.HY) * 0.6), 0], distance: r3(0.9 + 1.25 * (d.hipY + d.top + 2 * d.R * d.HY)) },
  };
}
