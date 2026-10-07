// Builds a rigid-skinned character (bones = Object3D nodes, parts = meshes parented to bones)
// from a character JSON description, and bakes its procedural clips into THREE.AnimationClips.
// Works in the browser and in Node (no DOM / canvas needed), so the same code produces the GLBs.
import * as THREE from 'three';
import { createGeometry } from './geometry.js';

const DEG = Math.PI / 180;
const NAME_RE = /^[A-Za-z0-9_-]+$/; // glTF/three.js animation bindings break on '.', '[', ']', '/', ':'

// ---------------------------------------------------------------- symmetry

/**
 * Expands every entry flagged `mirror` into its opposite-side twin (X axis reflection).
 * Bone/part names must end with the left suffix (default "_L"); the twin gets the right suffix.
 */
export function expandSymmetry(def) {
  const sym = { left: '_L', right: '_R', ...def.symmetry };
  const flipName = (n) => {
    if (!n) return n;
    if (n.endsWith(sym.left)) return n.slice(0, -sym.left.length) + sym.right;
    if (n.endsWith(sym.right)) return n.slice(0, -sym.right.length) + sym.left;
    return n;
  };
  const flipPos = (p) => (p ? [-p[0], p[1], p[2]] : p);
  const flipRot = (r) => (r ? [r[0], -r[1], -r[2]] : r);
  const flipLimits = (l) => {
    if (!l) return l;
    const out = { ...l };
    for (const ax of ['y', 'z']) if (l[ax]) out[ax] = [-l[ax][1], -l[ax][0]];
    return out;
  };
  const requireSide = (n, what) => {
    if (!n.endsWith(sym.left) && !n.endsWith(sym.right)) {
      throw new Error(`${what} "${n}" has mirror:true but no "${sym.left}"/"${sym.right}" suffix`);
    }
  };

  const skeleton = [];
  for (const b of def.skeleton ?? []) {
    skeleton.push(b);
    if (!b.mirror) continue;
    requireSide(b.name, 'Bone');
    skeleton.push({
      ...b, mirror: false, mirrorOf: b.name,
      name: flipName(b.name), parent: flipName(b.parent),
      position: flipPos(b.position), rotation: flipRot(b.rotation), limits: flipLimits(b.limits),
    });
  }

  const parts = [];
  for (const p of def.parts ?? []) {
    parts.push(p);
    if (!p.mirror) continue;
    requireSide(p.name, 'Part');
    const scale = p.scale ?? [1, 1, 1];
    parts.push({
      ...p, mirror: false, mirrorOf: p.name,
      name: flipName(p.name), bone: flipName(p.bone),
      position: flipPos(p.position), rotation: flipRot(p.rotation),
      // A true reflection for geometry that is not symmetric about its own YZ plane.
      scale: p.mirrorFlip ? [-scale[0], scale[1], scale[2]] : p.scale,
    });
  }

  const clips = {};
  for (const [name, clip] of Object.entries(def.clips ?? {})) {
    const tracks = [];
    for (const t of clip.tracks ?? []) {
      tracks.push(t);
      if (!t.mirror) continue;
      const negate = (t.channel === 'rotation' && (t.axis === 'y' || t.axis === 'z'))
        || (t.channel === 'position' && t.axis === 'x');
      tracks.push({
        ...t, mirror: false,
        bone: flipName(t.bone),
        phase: (t.phase ?? 0) + (typeof t.mirror === 'object' ? (t.mirror.phase ?? 0) : 0),
        sign: (t.sign ?? 1) * (negate ? -1 : 1),
      });
    }
    clips[name] = { ...clip, tracks };
  }

  return { ...def, skeleton, parts, clips };
}

// ---------------------------------------------------------------- materials

function createMaterial(name, m) {
  const params = {
    name,
    color: new THREE.Color(m.color ?? '#cccccc'),
    roughness: m.roughness ?? 0.6,
    metalness: m.metalness ?? 0,
    flatShading: m.flatShading ?? false,
    side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  };
  if (m.emissive) {
    params.emissive = new THREE.Color(m.emissive);
    params.emissiveIntensity = m.emissiveIntensity ?? 1;
  }
  if (m.opacity !== undefined && m.opacity < 1) {
    params.transparent = true;
    params.opacity = m.opacity;
  }
  if (m.clearcoat !== undefined) {
    return new THREE.MeshPhysicalMaterial({ ...params, clearcoat: m.clearcoat, clearcoatRoughness: m.clearcoatRoughness ?? 0.1 });
  }
  return new THREE.MeshStandardMaterial(params);
}

// ---------------------------------------------------------------- builder

function applyTRS(obj, { position, rotation, scale, rotationOrder }) {
  if (position) obj.position.fromArray(position);
  if (rotation) obj.rotation.set(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG, rotationOrder ?? 'XYZ');
  if (scale) obj.scale.fromArray(typeof scale === 'number' ? [scale, scale, scale] : scale);
}

/**
 * @returns {{ root: THREE.Group, bones: Map<string, THREE.Object3D>, clips: THREE.AnimationClip[], meta: object }}
 */
export function buildCharacter(rawDef) {
  const def = expandSymmetry(rawDef);

  const root = new THREE.Group();
  root.name = def.id;

  const materials = new Map();
  for (const [name, m] of Object.entries(def.materials ?? {})) materials.set(name, createMaterial(name, m));

  const bones = new Map();
  for (const b of def.skeleton) {
    if (!NAME_RE.test(b.name)) throw new Error(`Bone name "${b.name}" may only contain letters, digits, "_" and "-"`);
    if (bones.has(b.name)) throw new Error(`Duplicate bone "${b.name}"`);
    const parent = b.parent ? bones.get(b.parent) : root;
    if (!parent) throw new Error(`Bone "${b.name}": parent "${b.parent}" must be declared before it`);
    const bone = new THREE.Bone();
    bone.name = b.name;
    applyTRS(bone, b);
    bone.userData = { bone: true, ...(b.limits && { limits: b.limits }), ...(b.tags && { tags: b.tags }) };
    parent.add(bone);
    bones.set(b.name, bone);
  }

  const names = new Set(bones.keys());
  for (const p of def.parts) {
    if (!NAME_RE.test(p.name)) throw new Error(`Part name "${p.name}" may only contain letters, digits, "_" and "-"`);
    if (names.has(p.name)) throw new Error(`Duplicate node name "${p.name}"`);
    names.add(p.name);
    const bone = bones.get(p.bone);
    if (!bone) throw new Error(`Part "${p.name}": unknown bone "${p.bone}"`);
    const material = materials.get(p.material);
    if (!material) throw new Error(`Part "${p.name}": unknown material "${p.material}"`);
    const mesh = new THREE.Mesh(createGeometry(p.geometry), material);
    mesh.name = p.name;
    applyTRS(mesh, p);
    mesh.castShadow = p.castShadow ?? true;
    mesh.receiveShadow = p.receiveShadow ?? true;
    mesh.visible = p.visible ?? true;
    mesh.userData = { part: true, ...(p.tags && { tags: p.tags }) };
    bone.add(mesh);
  }

  // Every base-layer clip gets a (constant rest) track for each channel any other base clip animates.
  // Engines blend only the channels present in a clip, so without this a channel animated by idle
  // but not by walk would freeze at its last idle value after an idle -> walk crossfade (e.g. Bevy).
  const isBase = (c) => (c.layer ?? 'base') === 'base';
  const baseChannels = new Set();
  for (const clip of Object.values(def.clips)) {
    if (isBase(clip)) for (const t of clip.tracks) baseChannels.add(`${t.bone}|${t.channel}`);
  }
  const clips = Object.entries(def.clips).map(([name, clip]) =>
    bakeClip(name, clip, def, bones, isBase(clip) ? baseChannels : new Set()));

  // Everything the runtime needs besides geometry. Stored in userData so it survives glTF export (as "extras").
  const meta = {
    schema: 'puppetz-character',
    version: def.version ?? 1,
    id: def.id,
    name: def.name ?? def.id,
    controller: def.controller ?? {},
    view: def.view ?? {},
    clips: Object.fromEntries(Object.entries(def.clips).map(([n, c]) => [n, {
      layer: c.layer ?? 'base',
      loop: c.loop ?? true,
      duration: c.duration,
    }])),
  };
  root.userData.character = meta;

  return { root, bones, clips, meta };
}

// ---------------------------------------------------------------- clip baking

function wrap01(x) {
  return ((x % 1) + 1) % 1;
}

// Keys are [normalizedTime 0..1, value]. Loops wrap around; smooth = Catmull-Rom.
function sampleKeys(keys, t, interp, loop) {
  const n = keys.length;
  if (n === 1) return keys[0][1];
  // Key lookup by any integer index; for loops, index -1 is the last key one cycle earlier, etc.
  const at = (k) => {
    if (!loop) return keys[Math.min(Math.max(k, 0), n - 1)];
    const m = ((k % n) + n) % n;
    return [keys[m][0] + Math.floor(k / n), keys[m][1]];
  };

  if (!loop && t <= keys[0][0]) return keys[0][1];
  if (!loop && t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = -1; // segment [at(i), at(i+1)] contains t; -1 = wrap segment before the first key
  for (let j = 0; j < n; j++) if (keys[j][0] <= t) i = j;

  const [t1, v1] = at(i);
  const [t2, v2] = at(i + 1);
  const s = t2 > t1 ? Math.min(Math.max((t - t1) / (t2 - t1), 0), 1) : 0;

  if (interp === 'step') return v1;
  if (interp === 'linear') return v1 + (v2 - v1) * s;
  const v0 = at(i - 1)[1];
  const v3 = at(i + 2)[1];
  return 0.5 * ((2 * v1) + (-v0 + v2) * s + (2 * v0 - 5 * v1 + 4 * v2 - v3) * s * s + (-v0 + 3 * v1 - 3 * v2 + v3) * s * s * s);
}

function sampleTrack(track, u, loop) {
  const t = loop ? wrap01(u + (track.phase ?? 0)) : Math.min(Math.max(u + (track.phase ?? 0), 0), 1);
  let v;
  if (track.wave) {
    const w = track.wave;
    v = (w.offset ?? 0) + (w.amp ?? 0) * Math.sin(2 * Math.PI * ((w.freq ?? 1) * t + (w.phase ?? 0)));
  } else if (track.keys) {
    v = sampleKeys(track.keys, t, track.interp ?? 'smooth', loop);
  } else if (track.value !== undefined) {
    v = track.value;
  } else {
    throw new Error(`Track on "${track.bone}" needs "wave", "keys" or "value"`);
  }
  return v * (track.sign ?? 1);
}

const AXES = { x: 0, y: 1, z: 2 };

function bakeClip(name, clip, def, bones, sharedChannels) {
  const loop = clip.loop ?? true;
  const duration = clip.duration ?? 1;
  const fps = clip.fps ?? 30;
  const samples = Math.max(2, Math.round(duration * fps)) + 1;
  const times = new Float32Array(samples);
  for (let i = 0; i < samples; i++) times[i] = (i / (samples - 1)) * duration;

  // Group tracks per bone & channel.
  const byBone = new Map();
  for (const t of clip.tracks) {
    if (!bones.has(t.bone)) throw new Error(`Clip "${name}": unknown bone "${t.bone}"`);
    if (!(t.channel in { rotation: 1, position: 1, scale: 1 })) throw new Error(`Clip "${name}": bad channel "${t.channel}"`);
    if (!(t.axis in AXES)) throw new Error(`Clip "${name}": bad axis "${t.axis}"`);
    if (!byBone.has(t.bone)) byBone.set(t.bone, { rotation: [], position: [], scale: [] });
    byBone.get(t.bone)[t.channel].push(t);
  }

  const restByName = new Map(def.skeleton.map((b) => [b.name, b]));
  const out = [];
  const euler = new THREE.Euler();
  const q = new THREE.Quaternion();
  const prev = new THREE.Quaternion();

  for (const [boneName, ch] of byBone) {
    const rest = restByName.get(boneName);
    const restPos = rest.position ?? [0, 0, 0];
    const restRot = rest.rotation ?? [0, 0, 0];
    const restScale = typeof rest.scale === 'number' ? [rest.scale, rest.scale, rest.scale] : (rest.scale ?? [1, 1, 1]);

    // Offsets are summed per axis (several tracks on one axis are layered).
    // "absolute" tracks replace the rest value instead (applied first, other tracks layer on top).
    const offsets = (list, base, combine) => {
      const values = new Float32Array(samples * 3);
      const ordered = [...list.filter((t) => t.absolute), ...list.filter((t) => !t.absolute)];
      for (let i = 0; i < samples; i++) {
        const v = [...base];
        for (const t of ordered) {
          const s = sampleTrack(t, i / (samples - 1), loop);
          v[AXES[t.axis]] = t.absolute ? s : combine(v[AXES[t.axis]], s);
        }
        values.set(v, i * 3);
      }
      return values;
    };

    if (ch.rotation.length) {
      const eul = offsets(ch.rotation, restRot, (a, b) => a + b);
      const quats = new Float32Array(samples * 4);
      for (let i = 0; i < samples; i++) {
        euler.set(eul[i * 3] * DEG, eul[i * 3 + 1] * DEG, eul[i * 3 + 2] * DEG, rest.rotationOrder ?? 'XYZ');
        q.setFromEuler(euler);
        if (i > 0 && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // keep hemisphere continuity
        prev.copy(q);
        q.toArray(quats, i * 4);
      }
      out.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, quats));
    }
    if (ch.position.length) {
      out.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, times, offsets(ch.position, restPos, (a, b) => a + b)));
    }
    if (ch.scale.length) {
      out.push(new THREE.VectorKeyframeTrack(`${boneName}.scale`, times, offsets(ch.scale, restScale, (a, b) => a * b)));
    }
  }

  // Constant rest-pose tracks for channels other base clips animate (two keys are enough).
  const ends = [0, duration];
  for (const key of sharedChannels) {
    const [boneName, channel] = key.split('|');
    if (byBone.get(boneName)?.[channel].length) continue;
    const bone = bones.get(boneName);
    if (channel === 'rotation') {
      out.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, ends, [...bone.quaternion.toArray(), ...bone.quaternion.toArray()]));
    } else {
      const v = (channel === 'position' ? bone.position : bone.scale).toArray();
      out.push(new THREE.VectorKeyframeTrack(`${boneName}.${channel}`, ends, [...v, ...v]));
    }
  }

  return new THREE.AnimationClip(name, duration, out);
}
