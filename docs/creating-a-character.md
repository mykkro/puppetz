# Creating your own Puppetz character

This guide walks through making a new character from a reference picture to a GLB that walks
in the browser, Panda3D and Bevy. Most examples come from the project's star, the
[Shark](../models/shark/shark.json), with a few from [alzak.json](../models/alzak/alzak.json) and
[chicken.json](../models/chicken/chicken.json), so copy freely from them. Every field is documented in [character-format.md](character-format.md).

**Workflow:** edit JSON → reload the viewer (source **JSON**) → repeat → `npm run build:glb`.

```sh
npm install
npm start            # keep it running; http://localhost:8080
```

---

## 1. Plan from a reference image

1. **Measure proportions in pixels** on the picture: total height, head, body, legs, feet, and the
   widths. Pick a real height (the Shark is about 1.1 m tall and 1.7 m long) and convert: `meters = pixels × height / imageHeight`.
2. **Split the character into rigid pieces.** Anything that should move separately needs its own
   joint: head, eyes (for blinking and looking around), each arm segment, each leg segment, plus a
   tail, antenna or ears.
3. **Pick a shape for each piece**:

   | Looks like | Use |
   |---|---|
   | ball, egg, ellipsoid, boot, beak | `sphere` (often `radius: 1` + non-uniform `scale`) |
   | limb segment, finger, toe | `capsule` |
   | head, can or body with a specific silhouette | `lathe` (draw half the outline as `[r, y]` points) |
   | fin, tail lobe, ear, leaf, blade | `extrude` (draw the 2D outline, give it a thickness) |
   | claw, horn, curved tooth, spike | `horn` (a tube that tapers to a point along a curve) |
   | straight spike, comb, simple tooth | `cone` |
   | ring, collar, rim, rounded letter | `torus` (`arc` for partial) |
   | mouth, eyebrow, stroke, antenna | `tube` |
   | plate, badge, tooth | `box` with `radius` |

4. **Note the characteristic pose**, such as hands on hips or arms crossed. That becomes the rest pose.

## 2. Create the files

```sh
mkdir models/robot
```

Create `models/robot/robot.json`:

```json
{
  "$schema": "../character.schema.json",
  "id": "robot",
  "name": "Robot",
  "symmetry": { "left": "_L", "right": "_R" },
  "materials": {},
  "skeleton": [],
  "parts": [],
  "clips": {},
  "controller": { "states": { "idle": "idle", "walk": "walk" }, "overlays": ["blink"], "walkSpeed": 0.8 },
  "view": { "target": [0, 0.8, 0], "distance": 3 }
}
```

Register it in [models/index.json](../models/index.json):

```json
{ "id": "robot", "name": "Robot", "json": "robot/robot.json", "glb": "robot/robot.glb" }
```

Open the viewer, pick **Robot** and source **JSON**. Errors such as an unknown joint, material or
parent show in the status line and the browser console.

## 3. Build the skeleton

Work top-down from the ground. The character faces **+Z**, its left is **+X**, and **Y is up**.
Limb joints point down their local −Y.

```json
"skeleton": [
  { "name": "root",       "parent": null },
  { "name": "hips",       "parent": "root",       "position": [0, 0.45, 0] },
  { "name": "spine",      "parent": "hips",       "position": [0, 0.05, 0] },
  { "name": "chest",      "parent": "spine",      "position": [0, 0.30, 0] },
  { "name": "neck",       "parent": "chest",      "position": [0, 0.17, 0] },
  { "name": "head",       "parent": "neck",       "position": [0, 0.06, 0] },
  { "name": "eye_L",      "parent": "head",       "position": [0.12, 0.24, 0.15], "mirror": true },

  { "name": "upperArm_L", "parent": "chest",      "position": [0.19, 0.15, 0], "mirror": true },
  { "name": "foreArm_L",  "parent": "upperArm_L", "position": [0, -0.18, 0],   "mirror": true },
  { "name": "hand_L",     "parent": "foreArm_L",  "position": [0, -0.20, 0],   "mirror": true },

  { "name": "thigh_L",    "parent": "hips",       "position": [0.085, 0, 0],   "mirror": true },
  { "name": "shin_L",     "parent": "thigh_L",    "position": [0, -0.17, 0],   "mirror": true },
  { "name": "foot_L",     "parent": "shin_L",     "position": [0, -0.17, 0],   "mirror": true }
]
```

Rules of thumb:

- **Hip height = thigh + shin + ankle height.** Here 0.17 + 0.17 + 0.11 (boot) = 0.45, so the soles touch y = 0.
- Keep `root` at the origin. Engines move the whole character by a parent node, so `root` stays still.
- Put eyes, ears and antennae on their **own joints**. Blinking scales the eye joint, and looking around rotates it.
- Turn on **Show skeleton** in the viewer to see the joints as lines.

## 4. Add materials and parts

```json
"materials": {
  "skin":  { "color": "#79c932", "roughness": 0.45 },
  "metal": { "color": "#c8ccd1", "metalness": 0.85, "roughness": 0.28 },
  "eyeWhite": { "color": "#ffffff", "roughness": 0.15, "clearcoat": 1 },
  "pupil": { "color": "#111111", "roughness": 0.2 }
},
"parts": [
  { "name": "upperArmSkin_L", "bone": "upperArm_L", "material": "skin", "position": [0, -0.09, 0], "mirror": true,
    "geometry": { "type": "capsule", "radius": 0.04, "length": 0.14 } },
  { "name": "boot_L", "bone": "foot_L", "material": "metal", "position": [0, -0.05, 0.035], "scale": [0.075, 0.06, 0.115], "mirror": true,
    "geometry": { "type": "sphere", "radius": 1 } },
  { "name": "eyeball_L", "bone": "eye_L", "material": "eyeWhite", "mirror": true,
    "geometry": { "type": "sphere", "radius": 0.1 } },
  { "name": "pupil_L", "bone": "eye_L", "material": "pupil", "position": [0, 0, 0.095], "scale": [1, 1, 0.45], "mirror": true,
    "geometry": { "type": "sphere", "radius": 0.028 } }
]
```

Tips:

- **Limb parts sit halfway down the joint**: a capsule of total length L sits at `[0, -L/2, 0]`.
  Remember that capsule `length` excludes the two end caps.
- **A joint sphere** (shoulder, knee) the size of the limb radius hides gaps when joints bend.
- **Heads and bodies with character** come from a `lathe` profile. Trace the right half of the
  silhouette from bottom to top, starting and ending at `r = 0`:
  ```json
  { "type": "lathe", "points": [[0,0],[0.12,0.03],[0.205,0.15],[0.228,0.32],[0.18,0.46],[0.05,0.525],[0,0.53]] }
  ```
- **Details on a surface** (mouth, nose, logo): compute the surface point and push the part out
  slightly. For a lathe of radius `r` at height `y`, the front surface at sideways offset `x` is
  `z = √(r² − x²)`.
- **Same-side gaze**: a mirrored pupil looks outward on both eyes. If both pupils should look the
  same way, write `pupil_L` and `pupil_R` explicitly instead of using `mirror`.
- Part names share one name space with joints, so suffix them (`…Skin_L`).

## 5. Set the rest pose

Rest rotations go in `skeleton[].rotation` in degrees. For an arm hanging along −Y from the
shoulder:

| To do this | rotate |
|---|---|
| swing the arm out sideways (left arm) | `z` positive |
| swing it forward | `x` negative |
| bend the elbow forward (forearm) | `x` negative |
| bend the knee backward (shin) | `x` positive |

The Shark's T-rex arms are upper arm `[-70, 0, 20]` (swung forward and slightly out) and forearm
`[-40, 0, 0]` (bent forward). With `mirror: true`, the right side gets `[-70, 0, -20]` and
`[-40, 0, 0]` automatically. For bolder poses, see the Alzák's hands on hips (upper arm
`[10, 0, 50]`, forearm `[-15, 0, -74]`) or the chicken's crossed wings (written per side).

**Leaning bodies.** Rotate a joint's rest pose and its whole subtree tilts with it. The Shark's
`spine` leans forward 40° and his `head` tilts another 45°, so a dinosaur posture is just two
numbers. Child axes tilt too: in the Shark's head the snout points along local +Y, so looking
left or right is a `z` rotation of the head, not `y`. Turn on the skeleton and try the sliders to
see which axis does what.

Use the viewer to find angles. Select a joint (click a part, or use the Bone list), drag the
X/Y/Z sliders, and copy the numbers into `rotation`. Untick **Play clips** to pose from the rest
pose. The slider values are offsets from the current rest, so add them to it.

## 6. Animate

All values are **offsets from the rest pose**, so clips stay valid when you tweak the rest pose.
Time in `keys` and `wave` is normalized: 0…1 over `duration`.

### Idle (3–4 s): breathing, sway, looking around

```json
"idle": { "duration": 4, "tracks": [
  { "bone": "hips",  "channel": "position", "axis": "y", "wave": { "amp": 0.006, "freq": 2 } },
  { "bone": "chest", "channel": "rotation", "axis": "x", "wave": { "amp": 1.5, "freq": 2 } },
  { "bone": "head",  "channel": "rotation", "axis": "z", "wave": { "amp": 4, "freq": 1 } },
  { "bone": "head",  "channel": "rotation", "axis": "y",
    "keys": [[0, 0], [0.2, 0], [0.3, 18], [0.5, 18], [0.62, -12], [0.82, -12], [0.93, 0], [1, 0]] },
  { "bone": "upperArm_L", "channel": "rotation", "axis": "z", "wave": { "amp": 2, "freq": 2 }, "mirror": true }
] }
```

Small amplitudes look alive; big ones look nervous. Use `"interp": "linear"` keys with short
transitions for jerky, bird-like head moves (see the chicken).

### Walk (0.7–1 s per cycle, two steps)

This recipe works for any two-legged character. The left leg is described once, and
`"mirror": { "phase": 0.5 }` gives the right leg half a cycle later.

```json
"walk": { "duration": 0.9, "tracks": [
  { "bone": "thigh_L", "channel": "rotation", "axis": "x", "wave": { "amp": 28, "freq": 1 }, "mirror": { "phase": 0.5 } },
  { "bone": "shin_L",  "channel": "rotation", "axis": "x",
    "keys": [[0, 5], [0.25, 8], [0.5, 55], [0.7, 20], [0.8, 4], [1, 5]], "mirror": { "phase": 0.5 } },
  { "bone": "foot_L",  "channel": "rotation", "axis": "x",
    "keys": [[0, -3], [0.25, -20], [0.5, -40], [0.75, 10], [0.88, 8], [1, -3]], "mirror": { "phase": 0.5 } },

  { "bone": "hips", "channel": "position", "axis": "y", "wave": { "amp": 0.022, "freq": 2, "phase": 0.25 } },
  { "bone": "hips", "channel": "rotation", "axis": "y", "wave": { "amp": 6, "freq": 1 } },
  { "bone": "spine", "channel": "rotation", "axis": "y", "wave": { "amp": 5, "freq": 1, "phase": 0.5 } },

  { "bone": "upperArm_L", "channel": "rotation", "axis": "x", "wave": { "amp": 22, "freq": 1, "phase": 0.5 }, "mirror": { "phase": 0.5 } }
] }
```

What each line does:

| Track | Why |
|---|---|
| thigh `x` wave | the leg swings back (+) and forward (−) once per cycle |
| shin `x` keys | the knee bends most in mid-swing (t = 0.5, when the thigh passes vertical moving forward) and is nearly straight at heel strike |
| foot `x` keys | toe pushes off behind, dangles in swing, toe up at heel strike |
| hips `y` wave, `freq: 2` | the body is lowest twice per cycle, when the legs are spread (t = 0.25, 0.75) |
| hips `y` rotation + opposite spine twist | counter-rotation of pelvis and shoulders |
| arm `x` wave, `phase: 0.5` | each arm swings **opposite** to the leg on its side |

To give a walk character:
- **Waddle:** add hips `z` roll of 4–6° (the chicken).
- **Bob the head:** use a sawtooth on neck `position z`, with keys `[[0, 0.04], [0.4, -0.03], [0.5, 0.04], …]` and `"interp": "linear"`.
- **Pose change while walking:** use a constant `value`, e.g. drop hands from the hips with `{ "bone": "upperArm_L", "channel": "rotation", "axis": "z", "value": -32, "mirror": true }`.
- **Secondary motion:** tails, antennae and ears follow with a wave at `freq: 2` and a slight `phase` delay.

### Blink (overlay)

```json
"blink": { "duration": 4.3, "layer": "overlay", "tracks": [
  { "bone": "eye_L", "channel": "scale", "axis": "y", "interp": "linear",
    "keys": [[0, 1], [0.9, 1], [0.925, 0.08], [0.95, 1], [1, 1]], "mirror": true }
] }
```

Overlays play forever on top of idle and walk. Give them a duration that isn't a multiple of the
others, so blinks don't always land at the same moment. Overlays must not animate channels that
base clips use.

### More clips: the Shark's eat

Add any clip and map it in `controller.states`, e.g. `"eat": "eat"`. The viewers show every extra
state as a button (web) or under the `e` key (Panda3D, Bevy). Engines play it by state name:
`rig.setState('eat')` (JS), `rig.set_state("eat")` (Python and Rust). Set `"loop": false` for
one-shots.

The Shark's `eat` (3.4 s) is a good template for an action with a **prop**:

1. **The prop is a joint.** `food` is a child of `hand_R` with `"scale": 0.01`, so it is invisible
   at rest, and the fish parts hang on it.
2. **Bring the hand to the mouth.** Use `keys` on `upperArm_R` and `foreArm_R` that rise during the
   first 12 % of the clip, hold, and return at 70–80 %. Finding arm angles that reach a target can
   take a few tries. Pose it in the viewer with the sliders, or script a small search (build the
   character with `buildCharacter()` in Node and test joint angles). The Shark's arms are too short
   to reach, so his head nods 28° down to meet the fish.
3. **Show and shrink the prop** with `absolute` scale tracks: `0.01 → 1` when the hand arrives,
   then a step down at each bite (`1 → 0.7 → 0.4 → 0.01`).
4. **Sync the jaw.** The `jaw` joint opens just before each step down and snaps shut on it (linear
   keys), then two small chews.
5. **Sell it.** The head nods down while biting and looks up to swallow, the free hand pats the
   belly, and the tail wags faster (`freq: 3`).

```json
{ "bone": "jaw", "channel": "rotation", "axis": "x", "interp": "linear",
  "keys": [[0, 0], [0.2, 0], [0.28, 32], [0.36, 0], [0.43, 30], [0.51, 0], [0.58, 30], [0.66, 0],
           [0.7, 10], [0.74, 0], [0.78, 10], [0.82, 0], [1, 0]] }
```

A hinged jaw is just a joint near the back of the head, with the lower-jaw parts attached in
front of it. A positive `x` rotation opens it.

## 7. Match the walk speed

When a character moves faster or slower than its legs, its feet slide. A good starting value:

```
legLength  = thigh + shin length            (Shark: 0.22 + 0.22 = 0.44 m)
stride     = 4 · legLength · sin(thighAmp)   (2 steps per cycle; 4 · 0.44 · sin 28° ≈ 0.83 m)
walkSpeed  ≈ stride / duration               (0.83 / 0.9 ≈ 0.92, the Shark's walkSpeed)
```

Then tune by eye: press **Wander** and watch the feet against the floor grid. If they slide
forward, raise `walkSpeed`; if backward, lower it.

## 8. Build and validate

```sh
npx ajv-cli@5 validate --spec=draft2020 -s models/character.schema.json -d models/robot/robot.json
npm run build:glb -- robot
```

Then check it everywhere:

- Web viewer, source **GLB**: confirms the exported file, not just the live build.
- `examples/panda3d`: `python viewer.py --active robot --mode wander`
- `examples/bevy`: `cargo run --release -- --active robot --mode wander`

All three viewers support `--screenshot` (Panda3D, Bevy) or a URL (`?model=robot&source=glb&mode=walk`)
for quick visual checks.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Part floats away from the body or sinks into it | Its `position` is relative to its **joint**, not the world. Check which joint it is on |
| Knee bends the wrong way | Flip the sign of the shin `x` keys (backward knee = positive `x`) |
| Arms swing with the legs instead of against them | Arm wave needs `phase: 0.5` relative to the same-side thigh |
| Right side looks wrong while the left is fine | The shape isn't symmetric about its own YZ plane. Use `"mirrorFlip": true` or write the `_R` entry explicitly |
| Both pupils look outward | Expected with `mirror`. Write `pupil_L` / `pupil_R` explicitly for a shared gaze |
| A joint stays bent after switching idle → walk | Rebuild the GLB. The builder adds rest tracks to every base clip; old GLBs may lack them |
| "Bone name … may only contain…" | Use letters, digits, `_` and `-` only, with no dots |
| "parent … must be declared before it" | Reorder `skeleton` so parents come first |
| Feet slide | Tune `controller.walkSpeed`, see step 7 |
| Loop pops at the end | Wave `freq` must be a whole number; keys need the same value at t = 0 and t = 1 |
| Blink squashes eyelids or brows too | Parts on the eye joint scale with it. Put brows on `head`; lids on the eye are fine (they blink along) |
| GLB looks different from the JSON view | You forgot `npm run build:glb` |

## Checklist

- [ ] Feet touch y = 0, and the character faces +Z
- [ ] All names are unique, use `[A-Za-z0-9_-]`, and use `_L`/`_R` for sides
- [ ] Rest pose looks right with **Play clips** off
- [ ] idle, walk and blink exist and `controller.states` maps `idle` and `walk`
- [ ] Wander: the feet don't slide
- [ ] Schema validation passes and `npm run build:glb` succeeds
- [ ] The GLB looks the same in the web viewer (source GLB), Panda3D and Bevy
