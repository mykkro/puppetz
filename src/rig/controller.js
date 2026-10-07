// Runtime for a rigged character: plays clips (base layer with crossfades + always-on overlays)
// and lets you pose bones manually on top of the animation. Works for characters built from JSON
// and for GLBs (including foreign GLBs without our metadata).
import * as THREE from 'three';

const DEG = Math.PI / 180;

/** Finds our character root inside a loaded glTF scene (node whose extras contain "character"). */
export function findCharacterRoot(scene) {
  let found = null;
  scene.traverse((o) => { if (!found && o.userData?.character) found = o; });
  return found;
}

/** Bones: nodes flagged as bones; for foreign GLBs, every non-mesh node with children (or SkinnedMesh bones). */
export function collectBones(root) {
  const flagged = [];
  root.traverse((o) => { if (o !== root && (o.userData?.bone)) flagged.push(o); });
  if (flagged.length) return flagged;
  const guessed = [];
  root.traverse((o) => { if (o !== root && (o.isBone || (!o.isMesh && o.children.length))) guessed.push(o); });
  return guessed;
}

export class RigController {
  constructor(root, clips, meta = {}) {
    this.root = root;
    this.meta = meta;
    this.clips = clips;
    this.mixer = new THREE.AnimationMixer(root);
    this.bones = collectBones(root);
    this.boneByName = new Map(this.bones.map((b) => [b.name, b]));
    this.overrides = new Map(); // bone name -> {x,y,z} degrees, applied on top of the animation
    this._base = new Map(); // bone -> quaternion before override was applied
    this._tmpQ = new THREE.Quaternion();
    this._tmpE = new THREE.Euler();
    this.animate = true;
    this.speed = 1;

    this.rest = new Map(this.bones.map((b) => [b, {
      p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone(),
    }]));

    this.actions = new Map();
    for (const clip of clips) {
      const action = this.mixer.clipAction(clip);
      const cfg = meta.clips?.[clip.name] ?? {};
      if (cfg.loop === false) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(clip.name, action);
    }

    const ctl = meta.controller ?? {};
    this.states = { ...ctl.states };
    if (!this.states.idle) this.states.idle = clips.find((c) => /idle/i.test(c.name))?.name ?? clips[0]?.name;
    if (!this.states.walk) this.states.walk = clips.find((c) => /walk/i.test(c.name))?.name;
    this.overlays = ctl.overlays
      ?? Object.entries(meta.clips ?? {}).filter(([, c]) => c.layer === 'overlay').map(([n]) => n);
    this.crossfade = ctl.crossfade ?? 0.25;
    this.walkSpeed = ctl.walkSpeed ?? 0.8;
    this.turnSpeed = ctl.turnSpeed ?? 8;

    this.current = null;
    this.state = null;
    this._startOverlays();
    this.setState('idle', 0);
  }

  get clipNames() {
    return [...this.actions.keys()];
  }

  _startOverlays() {
    for (const name of this.overlays) this.actions.get(name)?.reset().play();
  }

  /** state: a key of controller.states ("idle", "walk", ...) or a raw clip name. */
  setState(state, fade = this.crossfade) {
    const clipName = this.states[state] ?? state;
    const next = this.actions.get(clipName);
    this.state = state;
    if (!next || next === this.current) return;
    next.reset();
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.play();
    if (this.current && fade > 0) this.current.crossFadeTo(next, fade, false);
    else if (this.current) this.current.stop();
    this.current = next;
  }

  /** Turn clip playback on/off. Off = rest pose (+ manual overrides): handy for posing. */
  setAnimate(on) {
    this.animate = on;
    if (on) {
      const state = this.state;
      this.current = null;
      this._startOverlays();
      this.setState(state, 0);
    } else {
      this.mixer.stopAllAction();
      this.current = null;
      this.resetToRest();
    }
  }

  resetToRest() {
    for (const [b, r] of this.rest) {
      b.position.copy(r.p);
      b.quaternion.copy(r.q);
      b.scale.copy(r.s);
    }
    this._base.clear();
  }

  setOverride(boneName, euler) {
    if (!euler || (euler.x === 0 && euler.y === 0 && euler.z === 0)) this.overrides.delete(boneName);
    else this.overrides.set(boneName, { ...euler });
  }

  clearOverrides() {
    this.overrides.clear();
  }

  update(dt) {
    // Undo last frame's manual offsets so bones the mixer does not drive don't accumulate them.
    for (const [bone, q] of this._base) bone.quaternion.copy(q);
    this._base.clear();

    if (this.animate) this.mixer.update(dt * this.speed);

    for (const [name, e] of this.overrides) {
      const bone = this.boneByName.get(name);
      if (!bone) continue;
      this._base.set(bone, bone.quaternion.clone());
      this._tmpE.set(e.x * DEG, e.y * DEG, e.z * DEG, 'XYZ');
      bone.quaternion.multiply(this._tmpQ.setFromEuler(this._tmpE));
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}
