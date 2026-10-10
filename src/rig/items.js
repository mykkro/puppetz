// The item library for generated humanoids: clothes, armor, headwear, hair, beards, capes, weapons,
// shields... Every item is attached to a body by slot and sized from that body's measurements, so
// one item fits a child, a tall thin elf and a stout dwarf alike.
//
// An item is { slot, label, colors: { color, accent }, build(ctx, opt) }:
// - build() adds bones, parts and materials through ctx (see makeContext in humanoid.js), sized from
//   ctx.d: the body measurements (head radius R, limb lengths and radii, torso outline...).
// - Slots are layers, built inner to outer: clothes sit on the skin, armor on the clothes, a cape on
//   everything. An item that wraps a body region grows ctx.layer[region] so the next layer goes
//   around it; ctx.skirtR is the widest skirt so far. Headwear can set ctx.hides ("hairTop").
// - Main-hand items set ctx.grip ("blade" or "pole"), off-hand shields set ctx.shield: the body clips
//   (idle, walk, combat, attack...) adapt the arm poses to what the hands hold.
// - opt holds the resolved colors. "natural" as a default color means the body's hair color.
// - Material names are per item ("clothes", "armor_metal", "cape"...), so a texture can later be
//   attached to one item without touching the others; recipes may also override them ("materials").
//
// To add an item, add an entry to ITEMS; the editor lists it in its slot automatically.
const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const r3 = (v) => Math.round(v * 10000) / 10000;
const v3 = (a) => a.map(r3);

export function mixColor(a, b, t) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((c, i) => Math.round(lerp(c, y[i], t)).toString(16).padStart(2, '0')).join('')}`;
}

/** Slot order is the build order (inner layers first) and the editor's order. */
export const SLOTS = [
  { key: 'hair', label: 'Hair' },
  { key: 'beard', label: 'Beard' },
  { key: 'clothes', label: 'Clothes' },
  { key: 'armor', label: 'Armor' },
  { key: 'hands', label: 'Hands' },
  { key: 'feet', label: 'Feet' },
  { key: 'head', label: 'Head' },
  { key: 'back', label: 'Back' },
  { key: 'mainHand', label: 'Main hand' },
  { key: 'offHand', label: 'Off hand' },
];

// Hair and beards grey with age, whatever their color.
const hairMat = (ctx, o, roughness = 0.65) => ({ color: mixColor(o.color, '#e4e4e4', ctx.d.old * 0.85), roughness, doubleSided: true });
const shell = (ctx, name, m, r, az0, az1, p0, p1) => ctx.headShell(name, m, r, az0, az1, p0, p1);

function shortHair(ctx, hair) {
  const Rh = ctx.d.R * 1.06;
  const covered = ctx.hides.has('hairTop');
  if (!covered) shell(ctx, 'hairTop', hair, Rh, 0, 360, 0, 62);
  shell(ctx, 'hairBack', hair, Rh, 80, 280, 0, 118);
  if (!covered) {
    shell(ctx, 'hairSide_L', hair, Rh, 55, 80, 0, 92);
    shell(ctx, 'hairSide_R', hair, Rh, 280, 305, 0, 92);
  }
}

function bobHair(ctx, hair) {
  const Rb = ctx.d.R * 1.09;
  const covered = ctx.hides.has('hairTop');
  if (!covered) {
    shell(ctx, 'hairTop', hair, Rb, 0, 360, 0, 60);
    shell(ctx, 'hairFringe', hair, Rb, -50, 50, 0, 70);
  }
  shell(ctx, 'hairBack', hair, Rb, 80, 280, 0, 132);
  // Under a hood or helmet only the parts below its edge remain.
  shell(ctx, 'hairSide_L', hair, Rb, covered ? 52 : 42, 80, covered ? 70 : 0, 122);
  shell(ctx, 'hairSide_R', hair, Rb, 280, covered ? 308 : 318, covered ? 70 : 0, 122);
}

function beard(ctx, m, chin) {
  const R = ctx.d.R;
  if (chin) ctx.headShell('beard', m, R * 1.05, -112, 112, 122, 180);
  ctx.part({ name: 'moustache', bone: 'mouth', material: m, geometry: { type: 'tube', radius: r3(0.05 * R), tubularSegments: 20,
    points: [[-0.26 * R, -0.04 * R, 0.0], [-0.12 * R, 0.1 * R, 0.04 * R], [0, 0.11 * R, 0.05 * R], [0.12 * R, 0.1 * R, 0.04 * R], [0.26 * R, -0.04 * R, 0]].map(v3) } });
}

const sleeve = (ctx, prefix, material, upperK, foreK, foreLen = 1) => {
  const { d } = ctx;
  for (const side of ['_L', '_R']) {
    if (upperK) {
      ctx.part({ name: `${prefix}Shoulder${side}`, bone: `upperArm${side}`, material, geometry: { type: 'sphere', radius: r3(d.armR * 1.25 * upperK) } });
      ctx.limb(`${prefix}Upper${side}`, `upperArm${side}`, d.upperArm, d.armR * upperK, material);
    }
    if (foreK) ctx.limb(`${prefix}Fore${side}`, `foreArm${side}`, d.foreArm, d.armR * 0.9 * foreK, material, { len: d.foreArm * foreLen, shift: d.foreArm * (1 - foreLen) / 2 });
  }
  if (upperK) ctx.layer.arm = Math.max(ctx.layer.arm, upperK);
  if (foreK) ctx.layer.foreArm = Math.max(ctx.layer.foreArm, foreK);
};

const legs = (ctx, prefix, material, k, shinK = k) => {
  const { d } = ctx;
  ctx.limb(`${prefix}Thigh_L`, 'thigh_L', d.thigh, d.legR * k, material, { mirror: true });
  if (shinK) ctx.limb(`${prefix}Shin_L`, 'shin_L', d.shin, d.legR * 0.85 * shinK, material, { mirror: true });
  ctx.layer.leg = Math.max(ctx.layer.leg, k);
  if (shinK) ctx.layer.shin = Math.max(ctx.layer.shin, shinK);
};

// Open, flared cloth tube from the waist down ("hem" in spine-bone space, negative = below the hips).
const skirt = (ctx, name, material, hemY, hemR, k = ctx.layer.torso, top = ctx.d.spineLen * 0.75) => {
  const r0 = ctx.torsoRadius(top) * k + 0.006;
  const rHip = ctx.torsoRadius(-0.045 * ctx.d.H) * k + 0.01;
  const pts = [[hemR, hemY], [lerp(hemR, rHip, 0.6), lerp(hemY, -0.045 * ctx.d.H, 0.6)], [rHip, -0.045 * ctx.d.H], [r0, top]];
  ctx.part({ name, bone: 'spine', material, scale: [1, 1, 0.85], geometry: { type: 'lathe', segments: 40, points: pts.map(v3) } });
  ctx.skirtR = Math.max(ctx.skirtR ?? 0, hemR, rHip);
  ctx.skirtHem = Math.min(ctx.skirtHem ?? 0, hemY); // long skirts make the clips keep the legs closer together
};

const belt = (ctx, name, material, buckle, k) => {
  const y = ctx.d.spineLen * 0.55;
  const r = ctx.torsoRadius(y) * k + 0.006;
  ctx.part({ name, bone: 'spine', material, position: [0, r3(y), 0], rotation: [90, 0, 0], scale: [1, ctx.d.depth, 1],
    geometry: { type: 'torus', radius: r3(r), tube: r3(0.014 * ctx.d.G), radialSegments: 8, tubularSegments: 40 } });
  if (buckle) ctx.part({ name: `${name}Buckle`, bone: 'spine', material: buckle, position: [0, r3(y), r3(r * ctx.d.depth + 0.008)],
    geometry: { type: 'box', size: v3([0.045 * ctx.d.G, 0.04 * ctx.d.H, 0.012]), radius: 0.004 } });
};

const bootsShape = (ctx, prefix, material, k, cuff) => {
  const { d } = ctx;
  ctx.part({ name: `${prefix}Foot_L`, bone: 'foot_L', material, mirror: true,
    position: [0, r3(-d.ankle * 0.48), r3(d.footLen * 0.32)], scale: v3([d.legR * 1.05 * k, d.ankle * 0.56 * k, d.footLen * 0.62 * k]),
    geometry: { type: 'sphere', radius: 1 } });
  if (cuff) {
    const h = d.shin * cuff;
    ctx.part({ name: `${prefix}Shaft_L`, bone: 'shin_L', material, mirror: true, position: [0, r3(-d.shin + h / 2 - d.ankle * 0.3), 0],
      geometry: { type: 'cylinder', radiusTop: r3(d.legR * 0.85 * ctx.layer.shin * 1.18), radiusBottom: r3(d.legR * 0.9 * k), height: r3(h + d.ankle * 0.3) } });
    ctx.part({ name: `${prefix}Cuff_L`, bone: 'shin_L', material, mirror: true, position: [0, r3(-d.shin + h), 0], rotation: [90, 0, 0],
      geometry: { type: 'torus', radius: r3(d.legR * 0.85 * ctx.layer.shin * 1.2), tube: r3(0.012 * d.G), radialSegments: 8, tubularSegments: 28 } });
  }
};

export const ITEMS = {
  // ------------------------------------------------ hair (on the scalp; hats may hide the top)
  // Hair and beard colors default to the body's natural hair color, and grey with age.
  short: {
    slot: 'hair', label: 'Short', colors: { color: 'natural' },
    build(ctx, o) { shortHair(ctx, ctx.mat('hair', hairMat(ctx, o))); },
  },
  spiky: {
    slot: 'hair', label: 'Spiky', colors: { color: 'natural' },
    build(ctx, o) {
      const hair = ctx.mat('hair', hairMat(ctx, o));
      shortHair(ctx, hair);
      if (ctx.hides.has('hairTop')) return;
      const R = ctx.d.R;
      const spikes = [[0, 0], [28, 0], [30, 70], [30, -70], [30, 140], [30, -140], [52, 35], [52, -35], [55, 105], [55, -105], [60, 180]];
      spikes.forEach(([polar, az], i) => {
        const h = 0.32 * R;
        const { position, rotation, rotationOrder } = ctx.onHead(R * 1.06 + h * 0.3, polar, az);
        ctx.part({ name: `hairSpike${i}`, bone: 'skull', material: hair, position, rotation, rotationOrder,
          geometry: { type: 'cone', radius: r3(0.17 * R), height: r3(h), radialSegments: 12 } });
      });
    },
  },
  bob: {
    slot: 'hair', label: 'Bob', colors: { color: 'natural' },
    build(ctx, o) { bobHair(ctx, ctx.mat('hair', hairMat(ctx, o))); },
  },
  long: {
    slot: 'hair', label: 'Long', colors: { color: 'natural' },
    build(ctx, o) {
      const hair = ctx.mat('hair', hairMat(ctx, o));
      const R = ctx.d.R;
      bobHair(ctx, hair);
      ctx.part({ name: 'hairLong', bone: 'skull', material: hair, position: ctx.hp([0, -0.85 * R, -0.5 * R]), rotation: [12, 0, 0],
        scale: v3([0.92 * R, 1.15 * R, 0.42 * R]), geometry: { type: 'sphere', radius: 1 } });
    },
  },
  ponytail: {
    slot: 'hair', label: 'Ponytail', colors: { color: 'natural', accent: '#d94a64' },
    build(ctx, o) {
      const hair = ctx.mat('hair', hairMat(ctx, o));
      const R = ctx.d.R;
      shortHair(ctx, hair);
      ctx.bone({ name: 'ponytail', parent: 'skull', position: ctx.hp([0, 0.35 * R, -1.0 * R]), rotation: [-25, 0, 0], tags: ['hair'] });
      ctx.part({ name: 'ponytailTie', bone: 'ponytail', material: ctx.mat('hair_tie', { texture: 'fabric', textureScale: 3, color: o.accent, roughness: 0.5 }), rotation: [90, 0, 0],
        geometry: { type: 'torus', radius: r3(0.1 * R), tube: r3(0.04 * R) } });
      ctx.part({ name: 'ponytailHair', bone: 'ponytail', material: hair, geometry: { type: 'horn', radiusStart: r3(0.13 * R), radiusEnd: r3(0.03 * R), taper: 0.7,
        points: [[0, 0, 0], [0, -0.3 * R, -0.25 * R], [0, -0.85 * R, -0.3 * R], [0, -1.25 * R, -0.15 * R]].map(v3) } });
    },
  },
  bun: {
    slot: 'hair', label: 'Bun', colors: { color: 'natural' },
    build(ctx, o) {
      const hair = ctx.mat('hair', hairMat(ctx, o));
      bobHair(ctx, hair);
      if (ctx.hides.has('hairTop')) return;
      const R = ctx.d.R;
      ctx.part({ name: 'hairBun', bone: 'skull', material: hair, position: ctx.hp([0, 0.82 * R, -0.62 * R]), geometry: { type: 'sphere', radius: r3(0.38 * R) } });
    },
  },
  afro: {
    slot: 'hair', label: 'Afro', colors: { color: 'natural' },
    build(ctx, o) {
      const hair = ctx.mat('hair', hairMat(ctx, o, 0.9));
      const R = ctx.d.R;
      const covered = ctx.hides.has('hairTop');
      shell(ctx, 'hairBase', hair, R * 1.08, 70, 290, covered ? 60 : 0, 120);
      // A cloud of curls around the scalp, leaving the face open.
      let i = 0;
      for (const [polar, step, from, to] of [[0, 360, 0, 1], [30, 45, 0, 360], [60, 40, 0, 360], [90, 36, 60, 300], [112, 40, 80, 280]]) {
        if (covered && polar < 75) continue;
        for (let az = from; az < to; az += step) {
          if (polar >= 60 && (az < 55 || az > 305)) continue;
          const { position } = ctx.onHead(R * 1.12, polar, az);
          ctx.part({ name: `hairCurl${i++}`, bone: 'skull', material: hair, position, geometry: { type: 'sphere', radius: r3(R * 0.34), widthSegments: 14, heightSegments: 10 } });
        }
      }
    },
  },
  mohawk: {
    slot: 'hair', label: 'Mohawk', colors: { color: 'natural' },
    build(ctx, o) {
      if (ctx.hides.has('hairTop')) return;
      const hair = ctx.mat('hair', hairMat(ctx, o));
      const R = ctx.d.R;
      shell(ctx, 'hairStrip', hair, R * 1.03, -12, 12, 0, 48);
      shell(ctx, 'hairStripBack', hair, R * 1.03, 168, 192, 0, 120);
      [-35, -15, 5, 25, 45, 65, 85, 105].forEach((polar, i) => {
        const h = R * (0.45 - Math.abs(polar - 30) * 0.002);
        const { position, rotation, rotationOrder } = ctx.onHead(R * 1.02 + h * 0.35, Math.abs(polar), polar < 0 ? 0 : 180);
        ctx.part({ name: `hairCrest${i}`, bone: 'skull', material: hair, position, rotation, rotationOrder, scale: [0.45, 1, 1],
          geometry: { type: 'cone', radius: r3(R * 0.2), height: r3(h), radialSegments: 10 } });
      });
    },
  },
  braids: {
    slot: 'hair', label: 'Braids', colors: { color: 'natural', accent: '#3a6fd9' },
    build(ctx, o) {
      const hair = ctx.mat('hair', hairMat(ctx, o));
      const tie = ctx.mat('hair_tie', { texture: 'fabric', textureScale: 3, color: o.accent, roughness: 0.5 });
      const R = ctx.d.R;
      bobHair(ctx, hair);
      for (const [side, s] of [['_L', 1], ['_R', -1]]) {
        for (let k = 0; k < 6; k++) {
          const p = ctx.hp([s * R * (0.78 - k * 0.02), -R * (0.55 + k * 0.24), -R * (0.15 + k * 0.03)]);
          ctx.part({ name: `braid${k}${side}`, bone: 'skull', material: hair, position: p, scale: [1, 1.2, 1],
            geometry: { type: 'sphere', radius: r3(R * (0.17 - k * 0.012)), widthSegments: 12, heightSegments: 10 } });
        }
        ctx.part({ name: `braidTie${side}`, bone: 'skull', material: tie, position: ctx.hp([s * R * 0.66, -R * 1.92, -R * 0.33]), rotation: [90, 0, 0],
          geometry: { type: 'torus', radius: r3(R * 0.08), tube: r3(R * 0.035), radialSegments: 6, tubularSegments: 16 } });
      }
    },
  },
  pigtails: {
    slot: 'hair', label: 'Pigtails', colors: { color: 'natural', accent: '#d94a64' },
    build(ctx, o) {
      const hair = ctx.mat('hair', hairMat(ctx, o));
      const tie = ctx.mat('hair_tie', { texture: 'fabric', textureScale: 3, color: o.accent, roughness: 0.5 });
      const R = ctx.d.R;
      bobHair(ctx, hair);
      for (const [side, s] of [['_L', 1], ['_R', -1]]) {
        const root = [s * R * 0.92, R * 0.35, -R * 0.35];
        ctx.part({ name: `pigtailTie${side}`, bone: 'skull', material: tie, position: ctx.hp(root), rotation: [0, 0, r3(s * 60)],
          geometry: { type: 'torus', radius: r3(R * 0.09), tube: r3(R * 0.04), radialSegments: 6, tubularSegments: 16 } });
        ctx.part({ name: `pigtail${side}`, bone: 'skull', material: hair, geometry: { type: 'horn', radiusStart: r3(R * 0.14), radiusEnd: r3(R * 0.03), taper: 0.8,
          points: ctx.hpts([root, [s * R * 1.25, R * 0.3, -R * 0.4], [s * R * 1.45, -R * 0.1, -R * 0.35], [s * R * 1.4, -R * 0.6, -R * 0.3]]) } });
      }
    },
  },
  balding: {
    slot: 'hair', label: 'Balding', colors: { color: 'natural' },
    build(ctx, o) { ctx.headShell('hairRing', ctx.mat('hair', hairMat(ctx, o)), ctx.d.R * 1.06, 75, 285, 70, 112); },
  },

  // ------------------------------------------------ beard (grown-ups only)
  shortBeard: {
    slot: 'beard', label: 'Short beard', colors: { color: 'natural' },
    build(ctx, o) { if (ctx.d.grow > 0.6) beard(ctx, ctx.mat('beard', hairMat(ctx, o, 0.75)), true); },
  },
  longBeard: {
    slot: 'beard', label: 'Long beard', colors: { color: 'natural' },
    build(ctx, o) {
      if (ctx.d.grow <= 0.6) return;
      const m = ctx.mat('beard', hairMat(ctx, o, 0.75));
      const R = ctx.d.R;
      beard(ctx, m, true);
      // A broad flattened bib under the chin.
      ctx.part({ name: 'beardLong', bone: 'skull', material: m, position: ctx.hp([0, -1.2 * R, 0.45 * R]), rotation: [-12, 0, 0],
        scale: v3([0.7 * R, 0.62 * R, 0.32 * R]), geometry: { type: 'sphere', radius: 1 } });
    },
  },
  moustache: {
    slot: 'beard', label: 'Moustache', colors: { color: 'natural' },
    build(ctx, o) { if (ctx.d.grow > 0.6) beard(ctx, ctx.mat('beard', hairMat(ctx, o, 0.75)), false); },
  },
  // ------------------------------------------------ clothes (on the skin)
  shirt: {
    slot: 'clothes', label: 'Shirt & trousers', colors: { color: '#e9e2cf', accent: '#5b6b8a' },
    build(ctx, o) {
      const cloth = ctx.mat('clothes', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.8 });
      const trousers = ctx.mat('clothes_trousers', { texture: 'fabric', textureScale: 3, color: o.accent, roughness: 0.8 });
      ctx.torsoShell('shirt', cloth, 1.05, ctx.d.spineLen * 0.3);
      ctx.torsoShell('trouserSeat', trousers, 1.05, -Infinity, ctx.d.spineLen * 0.35);
      sleeve(ctx, 'shirtSleeve', cloth, 1.12, 0);
      legs(ctx, 'trouser', trousers, 1.1);
      ctx.layer.torso = 1.05;
      belt(ctx, 'belt', ctx.mat('leather', { texture: 'leather', textureScale: 2, color: '#5a3a22', roughness: 0.7 }), ctx.mat('gold', { texture: 'metal', textureScale: 1, color: '#d9a93a', metalness: 0.9, roughness: 0.3 }), 1.06);
    },
  },
  tunic: {
    slot: 'clothes', label: 'Tunic', colors: { color: '#4f8a3c', accent: '#7a5a3a' },
    build(ctx, o) {
      const cloth = ctx.mat('clothes', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.85 });
      const skirtMat = ctx.mat('clothes_skirt', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.85, doubleSided: true });
      const trousers = ctx.mat('clothes_trousers', { texture: 'fabric', textureScale: 3, color: o.accent, roughness: 0.85 });
      ctx.torsoShell('tunic', cloth, 1.05);
      skirt(ctx, 'tunicSkirt', skirtMat, -0.06 * ctx.d.H - ctx.d.thigh * 0.4, ctx.d.hipR * 1.28, 1.05);
      sleeve(ctx, 'tunicSleeve', cloth, 1.12, 1.12, 0.75);
      legs(ctx, 'trouser', trousers, 1.1);
      ctx.layer.torso = 1.05;
      belt(ctx, 'belt', ctx.mat('leather', { texture: 'leather', textureScale: 2, color: '#5a3a22', roughness: 0.7 }), ctx.mat('gold', { texture: 'metal', textureScale: 1, color: '#d9a93a', metalness: 0.9, roughness: 0.3 }), 1.06);
    },
  },
  dress: {
    slot: 'clothes', label: 'Dress', colors: { color: '#c75b8e', accent: '#f4e3ec' },
    build(ctx, o) {
      const cloth = ctx.mat('clothes', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.75 });
      const skirtMat = ctx.mat('clothes_skirt', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.75, doubleSided: true });
      const trim = ctx.mat('clothes_trim', { texture: 'fabric', textureScale: 3, color: o.accent, roughness: 0.7 });
      const { d } = ctx;
      ctx.torsoShell('bodice', cloth, 1.05);
      const hemY = -0.06 * d.H - d.thigh - d.shin * 0.35;
      skirt(ctx, 'dressSkirt', skirtMat, hemY, d.hipR * 1.85, 1.05);
      ctx.part({ name: 'dressHem', bone: 'spine', material: trim, position: [0, r3(hemY), 0], rotation: [90, 0, 0], scale: [1, 0.85, 1],
        geometry: { type: 'torus', radius: r3(d.hipR * 1.85), tube: r3(0.012 * d.G), radialSegments: 8, tubularSegments: 48 } });
      for (const side of ['_L', '_R']) {
        ctx.part({ name: `puffSleeve${side}`, bone: `upperArm${side}`, material: cloth, position: [0, r3(-d.upperArm * 0.12), 0],
          geometry: { type: 'sphere', radius: r3(d.armR * 1.75) } });
      }
      ctx.layer.arm = 1.4;
      ctx.layer.torso = 1.05;
      belt(ctx, 'sash', trim, null, 1.06);
    },
  },
  robe: {
    slot: 'clothes', label: 'Robe', colors: { color: '#3d4fa3', accent: '#e0c060' },
    build(ctx, o) {
      const cloth = ctx.mat('clothes', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.85 });
      const skirtMat = ctx.mat('clothes_skirt', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.85, doubleSided: true });
      const trim = ctx.mat('clothes_trim', { texture: 'fabric', textureScale: 3, color: o.accent, roughness: 0.6, metalness: 0.2 });
      const { d } = ctx;
      ctx.torsoShell('robe', cloth, 1.06);
      const hemY = -(d.hipY - d.ankle * 0.9);
      skirt(ctx, 'robeSkirt', skirtMat, hemY, d.hipR * 1.8, 1.06);
      ctx.part({ name: 'robeHem', bone: 'spine', material: trim, position: [0, r3(hemY), 0], rotation: [90, 0, 0], scale: [1, 0.85, 1],
        geometry: { type: 'torus', radius: r3(d.hipR * 1.8), tube: r3(0.014 * d.G), radialSegments: 8, tubularSegments: 48 } });
      sleeve(ctx, 'robeSleeve', cloth, 1.15, 0);
      for (const side of ['_L', '_R']) {
        ctx.part({ name: `robeCuff${side}`, bone: `foreArm${side}`, material: skirtMat, position: [0, r3(-d.foreArm * 0.55), 0], rotation: [180, 0, 0],
          geometry: { type: 'cylinder', radiusTop: r3(d.armR * 2.3), radiusBottom: r3(d.armR * 1.15), height: r3(d.foreArm * 0.95), openEnded: true } });
      }
      legs(ctx, 'robeLeg', ctx.mat('clothes_trousers', { texture: 'fabric', textureScale: 3, color: mixColor(o.color, '#000000', 0.4), roughness: 0.9 }), 1.08);
      ctx.layer.torso = 1.06;
      belt(ctx, 'rope', trim, null, 1.07);
    },
  },

  // ------------------------------------------------ armor (over clothes)
  leather: {
    slot: 'armor', label: 'Leather vest', colors: { color: '#8a5a32' },
    build(ctx, o) {
      const leather = ctx.mat('armor_leather', { texture: 'leather', textureScale: 2, color: o.color, roughness: 0.65 });
      const k = ctx.layer.torso * 1.07;
      ctx.torsoShell('leatherVest', leather, k, ctx.d.spineLen * 0.2, ctx.d.top - 0.03 * ctx.d.H);
      for (const side of ['_L', '_R']) {
        ctx.part({ name: `leatherPad${side}`, bone: `upperArm${side}`, material: leather, position: [0, r3(0.005), 0],
          geometry: { type: 'sphere', radius: r3(ctx.d.armR * 1.65 * ctx.layer.arm), thetaLength: 80 } });
      }
      belt(ctx, 'armorBelt', ctx.mat('armor_strap', { texture: 'leather', textureScale: 2, color: '#3e2716', roughness: 0.7 }), ctx.mat('armor_buckle', { texture: 'metal', textureScale: 1, color: '#c9ccd2', metalness: 0.9, roughness: 0.3 }), k + 0.01);
      ctx.layer.torso = k;
    },
  },
  plate: {
    slot: 'armor', label: 'Plate armor', colors: { color: '#c3c8d0', accent: '#8a8f98' },
    build(ctx, o) {
      const metal = ctx.mat('armor_metal', { texture: 'metal', textureScale: 1, color: o.color, metalness: 0.85, roughness: 0.3 });
      const metalSkirt = ctx.mat('armor_metal_skirt', { texture: 'metal', textureScale: 1, color: o.color, metalness: 0.85, roughness: 0.3, doubleSided: true });
      const dark = ctx.mat('armor_metal_dark', { texture: 'metal', textureScale: 1, color: o.accent, metalness: 0.85, roughness: 0.38 });
      const { d } = ctx;
      const k = ctx.layer.torso * 1.1;
      ctx.torsoShell('breastplate', metal, k, -0.03 * d.H);
      skirt(ctx, 'tassets', metalSkirt, -0.06 * d.H - d.thigh * 0.3, d.hipR * 1.35 * k / 1.05, k);
      ctx.part({ name: 'gorget', bone: 'neck', material: dark, position: [0, r3(d.neckLen * 0.1), 0], rotation: [90, 0, 0],
        geometry: { type: 'torus', radius: r3(d.R * 0.42), tube: r3(d.R * 0.09), radialSegments: 10, tubularSegments: 32 } });
      for (const side of ['_L', '_R']) {
        const s = side === '_L' ? 1 : -1;
        ctx.part({ name: `pauldron${side}`, bone: `upperArm${side}`, material: metal, position: v3([s * d.armR * 0.2, d.armR * 0.3, 0]), rotation: [0, 0, r3(-s * 15)],
          scale: [1, 0.8, 1], geometry: { type: 'sphere', radius: r3(d.armR * 2 * ctx.layer.arm), thetaLength: 95 } });
        ctx.part({ name: `pauldronRim${side}`, bone: `upperArm${side}`, material: dark, position: v3([s * d.armR * 0.2, d.armR * 0.3 - d.armR * 0.1, 0]),
          rotation: [90, 0, 0], geometry: { type: 'torus', radius: r3(d.armR * 2 * ctx.layer.arm), tube: r3(d.armR * 0.18), radialSegments: 8, tubularSegments: 32 } });
      }
      sleeve(ctx, 'mail', dark, ctx.layer.arm * 1.05, 0);
      ctx.part({ name: 'kneeCop_L', bone: 'shin_L', material: metal, mirror: true, position: [0, 0, r3(d.legR * 0.5)],
        geometry: { type: 'sphere', radius: r3(d.legR * 1.05 * ctx.layer.leg) } });
      ctx.layer.torso = k;
    },
  },

  // ------------------------------------------------ hands
  gloves: {
    slot: 'hands', label: 'Gloves', colors: { color: '#6b4428' },
    build(ctx, o) {
      const m = ctx.mat('gloves', { texture: 'leather', textureScale: 2, color: o.color, roughness: 0.7 });
      const { d } = ctx;
      for (const [side, s] of [['_L', 1], ['_R', -1]]) {
        ctx.part({ name: `glove${side}`, bone: `hand${side}`, material: m, position: [0, r3(-d.handR * 0.8), 0], scale: [0.85, 1, 1],
          geometry: { type: 'sphere', radius: r3(d.handR * 1.08) } });
        ctx.part({ name: `gloveThumb${side}`, bone: `hand${side}`, material: m, position: v3([-s * d.handR * 0.25, -d.handR * 0.45, d.handR * 0.75]),
          geometry: { type: 'sphere', radius: r3(d.handR * 0.47), widthSegments: 14, heightSegments: 10 } });
        ctx.part({ name: `gloveCuff${side}`, bone: `foreArm${side}`, material: m, position: [0, r3(-d.foreArm * 0.85), 0],
          geometry: { type: 'cylinder', radiusTop: r3(d.armR * 1.45 * ctx.layer.foreArm), radiusBottom: r3(d.armR * 1.15), height: r3(d.foreArm * 0.3) } });
      }
    },
  },
  gauntlets: {
    slot: 'hands', label: 'Gauntlets', colors: { color: '#c3c8d0' },
    build(ctx, o) {
      const m = ctx.mat('gauntlets', { texture: 'metal', textureScale: 1, color: o.color, metalness: 0.85, roughness: 0.3 });
      const { d } = ctx;
      for (const side of ['_L', '_R']) {
        ctx.part({ name: `gauntletHand${side}`, bone: `hand${side}`, material: m, position: [0, r3(-d.handR * 0.75), 0], scale: [0.85, 1, 1],
          geometry: { type: 'sphere', radius: r3(d.handR * 1.1) } });
        ctx.part({ name: `gauntletBracer${side}`, bone: `foreArm${side}`, material: m, position: [0, r3(-d.foreArm * 0.62), 0],
          geometry: { type: 'cylinder', radiusTop: r3(d.armR * 1.2 * ctx.layer.foreArm), radiusBottom: r3(d.armR * 1.6 * ctx.layer.foreArm), height: r3(d.foreArm * 0.72) } });
      }
      ctx.layer.foreArm *= 1.5;
    },
  },

  // ------------------------------------------------ feet
  shoes: {
    slot: 'feet', label: 'Shoes', colors: { color: '#4a3020' },
    build(ctx, o) { bootsShape(ctx, 'shoe', ctx.mat('shoes', { texture: 'leather', textureScale: 2, color: o.color, roughness: 0.6 }), 1.1, 0); },
  },
  boots: {
    slot: 'feet', label: 'Boots', colors: { color: '#5a3a22' },
    build(ctx, o) { bootsShape(ctx, 'boot', ctx.mat('boots', { texture: 'leather', textureScale: 2, color: o.color, roughness: 0.65 }), 1.14, 0.55); ctx.layer.shin *= 1.2; },
  },
  greaves: {
    slot: 'feet', label: 'Armored boots', colors: { color: '#c3c8d0' },
    build(ctx, o) { bootsShape(ctx, 'greave', ctx.mat('greaves', { texture: 'metal', textureScale: 1, color: o.color, metalness: 0.85, roughness: 0.3 }), 1.16, 0.8); ctx.layer.shin *= 1.25; },
  },

  // ------------------------------------------------ head
  helmet: {
    slot: 'head', label: 'Helmet', colors: { color: '#c3c8d0', accent: '#b83a3a' },
    build(ctx, o) {
      const R = ctx.d.R;
      const metal = ctx.mat('helmet', { texture: 'metal', textureScale: 1, color: o.color, metalness: 0.85, roughness: 0.3, doubleSided: true });
      ctx.headShell('helmetDome', metal, R * 1.14, 0, 360, 0, 66);
      ctx.headShell('helmetGuard', metal, R * 1.14, 50, 310, 0, 112);
      ctx.part({ name: 'helmetRim', bone: 'skull', material: metal, position: ctx.hp([0, R * 1.14 * Math.cos(66 * DEG), 0]), rotation: [90, 0, 0], scale: [1, r3(ctx.d.HZ), 1],
        geometry: { type: 'torus', radius: r3(R * 1.14 * Math.sin(66 * DEG)), tube: r3(0.035 * R), radialSegments: 8, tubularSegments: 40 } });
      ctx.part({ name: 'helmetNasal', bone: 'skull', material: metal, position: ctx.hp([0, 0.2 * R, ctx.faceZ(0, 0.2 * R) + 0.06 * R]), rotation: [-8, 0, 0],
        geometry: { type: 'box', size: v3([0.1 * R, 0.5 * R, 0.05 * R]), radius: 0.004 } });
      ctx.part({ name: 'helmetPlume', bone: 'skull', material: ctx.mat('helmet_plume', { texture: 'fabric', textureScale: 3, color: o.accent, roughness: 0.9 }),
        geometry: { type: 'horn', radiusStart: r3(0.18 * R), radiusEnd: r3(0.05 * R), taper: 0.6,
          points: ctx.hpts([[0, 1.12 * R, 0.1 * R], [0, 1.45 * R, -0.15 * R], [0, 1.35 * R, -0.7 * R], [0, 0.95 * R, -1.05 * R]]) } });
      ctx.hides.add('hairTop');
    },
  },
  hood: {
    slot: 'head', label: 'Hood', colors: { color: '#3f5f34' },
    build(ctx, o) {
      const R = ctx.d.R;
      const cloth = ctx.mat('hood', { texture: 'knit', textureScale: 3, color: o.color, roughness: 0.9, doubleSided: true });
      ctx.headShell('hoodTop', cloth, R * 1.2, 0, 360, 0, 52);
      ctx.headShell('hoodBack', cloth, R * 1.2, 48, 312, 0, 140);
      ctx.part({ name: 'hoodTip', bone: 'skull', material: cloth, geometry: { type: 'horn', radiusStart: r3(0.35 * R), radiusEnd: 0, taper: 1,
        points: ctx.hpts([[0, 0.5 * R, -0.9 * R], [0, 0.35 * R, -1.25 * R], [0, 0.0, -1.35 * R]]) } });
      ctx.part({ name: 'hoodCowl', bone: 'neck', material: cloth, position: [0, r3(ctx.d.neckLen * 0.2), 0], rotation: [90, 0, 0],
        geometry: { type: 'torus', radius: r3(R * 0.55), tube: r3(R * 0.16), radialSegments: 10, tubularSegments: 32 } });
      ctx.hides.add('hairTop');
    },
  },
  wizardHat: {
    slot: 'head', label: 'Wizard hat', colors: { color: '#3d4fa3', accent: '#e0c060' },
    build(ctx, o) {
      const R = ctx.d.R;
      const felt = ctx.mat('hat', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.85 });
      const band = ctx.mat('hat_band', { texture: 'fabric', textureScale: 3, color: o.accent, roughness: 0.5, metalness: 0.3 });
      const base = 0.55 * R * ctx.d.HY;
      ctx.part({ name: 'hatBrim', bone: 'skull', material: felt, position: [0, r3(base), r3(-0.03 * R)], rotation: [-8, 0, 0],
        geometry: { type: 'cylinder', radius: r3(1.75 * R), height: r3(0.05 * R), radialSegments: 40 } });
      ctx.part({ name: 'hatCone', bone: 'skull', material: felt, position: [0, r3(base), r3(-0.03 * R)], rotation: [-8, 0, 0], scale: [1, 1, r3(ctx.d.HZ)],
        geometry: { type: 'horn', radiusStart: r3(0.98 * R), radiusEnd: 0, taper: 0.85, radialSegments: 24,
          points: [[0, 0, 0], [0, 0.9 * R, -0.05 * R], [0, 1.6 * R, -0.35 * R], [0, 1.95 * R, -0.85 * R]].map(v3) } });
      ctx.part({ name: 'hatBand', bone: 'skull', material: band, position: [0, r3(base + 0.1 * R), r3(-0.04 * R)], rotation: [82, 0, 0], scale: [1, r3(ctx.d.HZ), 1],
        geometry: { type: 'torus', radius: r3(0.92 * R), tube: r3(0.06 * R), radialSegments: 8, tubularSegments: 40 } });
      ctx.hides.add('hairTop');
    },
  },
  crown: {
    slot: 'head', label: 'Crown', colors: { color: '#e2b53e', accent: '#c4243b' },
    build(ctx, o) {
      const R = ctx.d.R;
      const gold = ctx.mat('crown', { texture: 'metal', textureScale: 1, color: o.color, metalness: 0.9, roughness: 0.28, doubleSided: true });
      const gem = ctx.mat('crown_gem', { color: o.accent, roughness: 0.1, clearcoat: 1 });
      const y = 0.72 * R * ctx.d.HY;
      const r = Math.sqrt(1.12 ** 2 - 0.72 ** 2) * R * 1.05;
      ctx.part({ name: 'crownBand', bone: 'skull', material: gold, position: [0, r3(y + 0.12 * R), 0], scale: [1, 1, r3(ctx.d.HZ)],
        geometry: { type: 'cylinder', radiusTop: r3(r * 1.08), radiusBottom: r3(r), height: r3(0.28 * R), radialSegments: 32, openEnded: true } });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 360;
        const p = [Math.sin(a * DEG) * r * 1.1, y + 0.36 * R, Math.cos(a * DEG) * r * 1.1 * ctx.d.HZ];
        ctx.part({ name: `crownPoint${i}`, bone: 'skull', material: gold, position: v3(p), geometry: { type: 'cone', radius: r3(0.1 * R), height: r3(0.22 * R) } });
        ctx.part({ name: `crownGem${i}`, bone: 'skull', material: gem, position: v3([p[0] * 1.04, y + 0.12 * R, p[2] * 1.04]),
          geometry: { type: 'sphere', radius: r3(0.055 * R), widthSegments: 12, heightSegments: 8 } });
      }
    },
  },

  // ------------------------------------------------ back (over everything)
  cape: {
    slot: 'back', label: 'Cape', colors: { color: '#a8323a', accent: '#e2b53e' },
    build(ctx, o) {
      const { d } = ctx;
      const cloth = ctx.mat('cape', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.85, doubleSided: true });
      const clasp = ctx.mat('cape_clasp', { texture: 'metal', textureScale: 1, color: o.accent, metalness: 0.9, roughness: 0.3 });
      const k = ctx.layer.torso;
      const topR = d.shoulderX * k + d.armR * ctx.layer.arm * 0.9;
      const len = d.top + d.thigh + d.shin * 0.5;
      ctx.bone({ name: 'cape', parent: 'chest', position: [0, r3(d.chestLen - 0.02 * d.H), 0], tags: ['cloth'] });
      // Wide enough to hang over whatever is worn below: hips, tunic skirts, tassets, robes.
      const lowR = Math.max(topR * 1.15, d.hipR * k * 1.25, (ctx.skirtR ?? 0) * 1.12);
      ctx.part({ name: 'capeCloth', bone: 'cape', material: cloth, scale: [1, 1, 0.85], geometry: { type: 'lathe', segments: 32, phiStart: 95, phiLength: 170,
        points: [[lowR * 1.08, -len], [lowR, -len * 0.6], [Math.max(topR, lowR * 0.85), -len * 0.3], [topR * 0.82, 0.0], [topR * 0.45, 0.02 * d.H]].map(v3) } });
      ctx.part({ name: 'capeClasp_L', bone: 'cape', material: clasp, mirror: true, position: v3([d.shoulderX * 0.55, -0.01 * d.H, d.chestR * k * d.depth * 0.75]),
        geometry: { type: 'sphere', radius: r3(0.022 * d.G), widthSegments: 12, heightSegments: 8 } });
    },
  },
  backpack: {
    slot: 'back', label: 'Backpack', colors: { color: '#8a6a3a', accent: '#5a3a22' },
    build(ctx, o) {
      const { d } = ctx;
      const canvas = ctx.mat('backpack', { texture: 'leather', textureScale: 2, color: o.color, roughness: 0.85 });
      const strap = ctx.mat('backpack_strap', { texture: 'leather', textureScale: 2, color: o.accent, roughness: 0.7 });
      const back = ctx.torsoRadius(d.spineLen + d.chestLen * 0.45) * ctx.layer.torso * d.depth;
      ctx.part({ name: 'pack', bone: 'chest', material: canvas, position: v3([0, d.chestLen * 0.3, -back - 0.07 * d.G]),
        geometry: { type: 'box', size: v3([0.22 * d.G, 0.26 * d.H, 0.13 * d.G]), radius: 0.03 } });
      ctx.part({ name: 'packFlap', bone: 'chest', material: strap, position: v3([0, d.chestLen * 0.3 + 0.1 * d.H, -back - 0.07 * d.G]),
        geometry: { type: 'box', size: v3([0.23 * d.G, 0.08 * d.H, 0.14 * d.G]), radius: 0.02 } });
      ctx.part({ name: 'packRoll', bone: 'chest', material: ctx.mat('backpack_roll', { texture: 'knit', textureScale: 3, color: '#a3b06a', roughness: 0.9 }),
        position: v3([0, d.chestLen * 0.3 + 0.17 * d.H, -back - 0.07 * d.G]), rotation: [0, 0, 90],
        geometry: { type: 'capsule', radius: r3(0.045 * d.G), length: r3(0.2 * d.G) } });
    },
  },

  // ------------------------------------------------ main hand (right). Held along the grip's +Z axis.
  sword: {
    slot: 'mainHand', label: 'Sword', colors: { color: '#d7dbe2', accent: '#7a4b2a' },
    build(ctx, o) {
      const s = lerp(0.75, 1, ctx.d.grow);
      const steel = ctx.mat('sword_blade', { texture: 'metal', textureScale: 1, color: o.color, metalness: 0.9, roughness: 0.22 });
      const hilt = ctx.mat('sword_hilt', { texture: 'wood', textureScale: 1, color: o.accent, roughness: 0.6 });
      const gold = ctx.mat('sword_guard', { texture: 'metal', textureScale: 1, color: '#d9a93a', metalness: 0.9, roughness: 0.3 });
      const len = 0.5 * s;
      const w = 0.028 * s;
      ctx.part({ name: 'swordGrip', bone: 'grip_R', material: hilt, rotation: [90, 0, 0], geometry: { type: 'cylinder', radius: r3(0.016 * s), height: r3(0.11 * s) } });
      ctx.part({ name: 'swordPommel', bone: 'grip_R', material: gold, position: [0, 0, r3(-0.065 * s)], geometry: { type: 'sphere', radius: r3(0.025 * s) } });
      ctx.part({ name: 'swordGuard', bone: 'grip_R', material: gold, position: [0, 0, r3(0.065 * s)],
        geometry: { type: 'box', size: v3([0.035 * s, 0.17 * s, 0.025 * s]), radius: 0.008 } });
      ctx.part({ name: 'swordBlade', bone: 'grip_R', material: steel, position: [0, 0, r3(0.075 * s)], rotation: [90, 90, 0],
        geometry: { type: 'extrude', depth: 0.006, bevel: 0.004, points: [[-w, 0], [w, 0], [w * 0.9, len * 0.85], [0, len], [-w * 0.9, len * 0.85]].map(v3) } });
      ctx.grip = 'blade';
    },
  },
  axe: {
    slot: 'mainHand', label: 'Axe', colors: { color: '#cfd3da', accent: '#8a5a32' },
    build(ctx, o) {
      const s = lerp(0.75, 1, ctx.d.grow);
      const steel = ctx.mat('axe_head', { texture: 'metal', textureScale: 1, color: o.color, metalness: 0.9, roughness: 0.25 });
      const wood = ctx.mat('axe_haft', { texture: 'wood', textureScale: 1, color: o.accent, roughness: 0.7 });
      ctx.part({ name: 'axeHaft', bone: 'grip_R', material: wood, position: [0, 0, r3(0.17 * s)], rotation: [90, 0, 0],
        geometry: { type: 'cylinder', radius: r3(0.017 * s), height: r3(0.58 * s) } });
      ctx.part({ name: 'axeBlade', bone: 'grip_R', material: steel, position: [0, 0, r3(0.4 * s)], rotation: [90, 90, 0],
        geometry: { type: 'extrude', smooth: true, depth: 0.014, bevel: 0.005,
          points: [[0.01, -0.035], [-0.07, -0.06], [-0.15, -0.1], [-0.17, 0], [-0.15, 0.1], [-0.07, 0.06], [0.01, 0.035]].map(([x, y]) => v3([x * s, y * s])) } });
      ctx.part({ name: 'axeSpike', bone: 'grip_R', material: steel, position: [0, r3(0.01 * s), r3(0.4 * s)], rotation: [-90, 0, 0],
        geometry: { type: 'cone', radius: r3(0.022 * s), height: r3(0.07 * s) } });
      ctx.grip = 'blade';
    },
  },
  spear: {
    slot: 'mainHand', label: 'Spear', colors: { color: '#d7dbe2', accent: '#8a5a32' },
    build(ctx, o) {
      const s = lerp(0.7, 1, ctx.d.grow) * ctx.d.H / lerp(0.6, 1, ctx.d.grow);
      const steel = ctx.mat('spear_head', { texture: 'metal', textureScale: 1, color: o.color, metalness: 0.9, roughness: 0.22 });
      const wood = ctx.mat('spear_shaft', { texture: 'wood', textureScale: 1, color: o.accent, roughness: 0.7 });
      const below = 0.5 * s;
      const above = 0.85 * s;
      ctx.part({ name: 'spearShaft', bone: 'grip_R', material: wood, position: [0, 0, r3((above - below) / 2)], rotation: [90, 0, 0],
        geometry: { type: 'cylinder', radius: r3(0.015 * s), height: r3(above + below) } });
      ctx.part({ name: 'spearHead', bone: 'grip_R', material: steel, position: [0, 0, r3(above - 0.01)], rotation: [90, 90, 0],
        geometry: { type: 'extrude', smooth: true, depth: 0.008, bevel: 0.004, points: [[0, 0], [0.035 * s, 0.07 * s], [0, 0.2 * s], [-0.035 * s, 0.07 * s]].map(v3) } });
      ctx.part({ name: 'spearBinding', bone: 'grip_R', material: ctx.mat('spear_binding', { texture: 'leather', textureScale: 2, color: '#3e2716', roughness: 0.7 }), position: [0, 0, r3(above - 0.03 * s)],
        geometry: { type: 'torus', radius: r3(0.017 * s), tube: r3(0.008 * s), radialSegments: 6, tubularSegments: 16 } });
      ctx.grip = 'pole';
    },
  },
  staff: {
    slot: 'mainHand', label: 'Magic staff', colors: { color: '#7a5634', accent: '#5fd3ff' },
    build(ctx, o) {
      const s = lerp(0.7, 1, ctx.d.grow) * ctx.d.H / lerp(0.6, 1, ctx.d.grow);
      const wood = ctx.mat('staff_wood', { texture: 'wood', textureScale: 1, color: o.color, roughness: 0.75 });
      const gem = ctx.mat('staff_gem', { color: o.accent, emissive: o.accent, emissiveIntensity: 0.8, roughness: 0.1 });
      const below = 0.5 * s;
      const above = 0.8 * s;
      ctx.part({ name: 'staffShaft', bone: 'grip_R', material: wood, position: [0, 0, r3((above - below) / 2)], rotation: [90, 0, 0],
        geometry: { type: 'cylinder', radiusTop: r3(0.022 * s), radiusBottom: r3(0.015 * s), height: r3(above + below) } });
      ctx.part({ name: 'staffCurl', bone: 'grip_R', material: wood, geometry: { type: 'horn', radiusStart: r3(0.022 * s), radiusEnd: r3(0.008 * s),
        points: [[0, 0, above], [0, 0.05 * s, above + 0.08 * s], [0, 0.0, above + 0.17 * s], [0, -0.07 * s, above + 0.13 * s], [0, -0.06 * s, above + 0.06 * s]].map(v3) } });
      ctx.part({ name: 'staffGem', bone: 'grip_R', material: gem, castShadow: false, position: [0, r3(-0.005 * s), r3(above + 0.1 * s)],
        geometry: { type: 'sphere', radius: r3(0.04 * s) } });
      ctx.grip = 'pole';
    },
  },

  // ------------------------------------------------ off hand (left forearm). Faces the mount's +X.
  roundShield: {
    slot: 'offHand', label: 'Round shield', colors: { color: '#2f5fa8', accent: '#d9a93a' },
    build(ctx, o) {
      const s = lerp(0.7, 1, ctx.d.grow);
      const wood = ctx.mat('shield', { texture: 'wood', textureScale: 1, color: o.color, roughness: 0.7 });
      const trim = ctx.mat('shield_trim', { color: o.accent, metalness: 0.85, roughness: 0.3 });
      const r = 0.2 * s;
      const out = ctx.d.armR * (ctx.layer.foreArm - 1);
      ctx.part({ name: 'shieldBoard', bone: 'mount_L', material: wood, position: [r3(out), 0, 0], rotation: [0, 0, 90],
        geometry: { type: 'cylinder', radius: r3(r), height: r3(0.03 * s), radialSegments: 40 } });
      ctx.part({ name: 'shieldRim', bone: 'mount_L', material: trim, position: [r3(out + 0.008 * s), 0, 0], rotation: [0, 90, 0],
        geometry: { type: 'torus', radius: r3(r), tube: r3(0.017 * s), radialSegments: 8, tubularSegments: 48 } });
      ctx.part({ name: 'shieldBoss', bone: 'mount_L', material: trim, position: [r3(out + 0.015 * s), 0, 0], rotation: [0, 0, -90],
        geometry: { type: 'sphere', radius: r3(0.055 * s), thetaLength: 90 } });
      ctx.shield = true;
    },
  },
  kiteShield: {
    slot: 'offHand', label: 'Kite shield', colors: { color: '#f0ece0', accent: '#b8323a' },
    build(ctx, o) {
      const s = lerp(0.7, 1, ctx.d.grow);
      const board = ctx.mat('shield', { texture: 'wood', textureScale: 1, color: o.color, roughness: 0.6 });
      const paint = ctx.mat('shield_trim', { color: o.accent, roughness: 0.6 });
      const out = ctx.d.armR * (ctx.layer.foreArm - 1);
      const pts = [[0, 0.17], [0.13, 0.14], [0.14, 0.02], [0.09, -0.18], [0, -0.32], [-0.09, -0.18], [-0.14, 0.02], [-0.13, 0.14]]
        .map(([x, y]) => [x * s, y * s + 0.06 * s]);
      ctx.part({ name: 'shieldBoard', bone: 'mount_L', material: board, position: [r3(out + 0.01), 0, 0], rotation: [0, 90, 0],
        geometry: { type: 'extrude', smooth: true, depth: 0.014, bevel: 0.008, points: pts.map(v3) } });
      ctx.part({ name: 'shieldCrossV', bone: 'mount_L', material: paint, position: [r3(out + 0.027), r3(0.0), 0],
        geometry: { type: 'box', size: v3([0.006, 0.36 * s, 0.05 * s]) } });
      ctx.part({ name: 'shieldCrossH', bone: 'mount_L', material: paint, position: [r3(out + 0.027), r3(0.08 * s), 0],
        geometry: { type: 'box', size: v3([0.006, 0.05 * s, 0.2 * s]) } });
      ctx.shield = true;
    },
  },
};

export function itemsForSlot(slot) {
  return Object.entries(ITEMS).filter(([, it]) => it.slot === slot).map(([id, it]) => ({ id, label: it.label, colors: it.colors }));
}

/**
 * Normalizes an equipment entry ("sword" or { item, color, accent }) to { id, item, color, accent }.
 * naturalHair replaces the "natural" default color of hair and beard items.
 */
export function resolveEquip(entry, naturalHair = '#6b4226') {
  if (!entry || entry === 'none') return null;
  const e = typeof entry === 'string' ? { item: entry } : entry;
  const item = ITEMS[e.item];
  if (!item) return null;
  const def = (c) => (c === 'natural' ? naturalHair : c);
  return { id: e.item, item, color: e.color ?? def(item.colors.color), accent: e.accent ?? def(item.colors.accent ?? item.colors.color) };
}
