# Puppetz character format reference

A character exists in two forms:

| | File | Role |
|---|---|---|
| **Source** | `models/<id>/<id>.json` | hand-written description: rig, shapes, materials, animations, controller settings |
| **Build** | `models/<id>/<id>.glb` | standard glTF 2.0 binary produced by `npm run build:glb`, loaded by engines |

The JSON is the source of truth. Never edit a GLB by hand; change the JSON and rebuild.
For a step-by-step tutorial, see [creating-a-character.md](creating-a-character.md).

- [Concepts](#concepts)
- [Conventions](#conventions)
- [JSON file](#json-file)
  - [Top level](#top-level) · [materials](#materials) · [skeleton](#skeleton) · [parts](#parts) · [geometry types](#geometry-types) · [clips](#clips) · [controller](#controller) · [view](#view) · [symmetry and mirroring](#symmetry-and-mirroring)
- [GLB structure](#glb-structure)
- [models/index.json](#modelsindexjson)
- [Validation](#validation)

---

## Concepts

```
character root node "shark"        extras.character = controller, view, clip info
└─ root                             joint (bone)
   └─ hips                          joint
      ├─ spine ── torso, bellyPatch, dorsalFin      (parts on a joint; spine leans forward 40°)
      │  └─ chest ── gills
      │     ├─ head ── headSkin, throat, teeth, nostrils
      │     │  ├─ jaw ── jawSkin
      │     │  └─ eye_L, eye_R
      │     ├─ upperArm_L ─ foreArm_L ─ hand_L ── claws
      │     └─ upperArm_R ─ foreArm_R ─ hand_R ─ food ── fish (a prop, hidden at rest)
      ├─ tail ── tailSkin
      │  └─ tailFin ── caudalFin
      ├─ thigh_L ─ shin_L ─ foot_L ── toe claws
      └─ thigh_R ─ …
```

- **Joint (bone)**: a transform node in a hierarchy. Rotating a joint moves everything below it.
- **Part**: a primitive mesh (sphere, capsule, lathe…) attached to a joint at an offset.
  The rig is **rigid**: parts move with their joint but never bend or stretch. There is no skinning.
- **Rest pose**: the joint transforms written in `skeleton`. It is the "neutral" pose, for
  example the shark's relaxed arms, the Alzák's hands on hips or the chicken's crossed wings.
- **Clip**: an animation made of **tracks**. Each track drives one joint, one channel (rotation,
  position or scale) and one axis, as an *offset from the rest pose*.
- **Layers**: *base* clips (idle, walk…) replace each other with a crossfade. *Overlay* clips
  (blink…) always play on top.
- **Controller**: maps gameplay states to clips and stores the walk speed so feet don't slide.

## Conventions

| | |
|---|---|
| Units | meters. Characters stand on the ground at y = 0 and are roughly 1–1.6 m tall |
| Axes | right-handed, **+Y up**, the character faces **+Z**, its **left side is +X** |
| Angles | degrees everywhere in the JSON |
| Euler order | `XYZ` (three.js convention: matrix = Rx·Ry·Rz) unless `rotationOrder` is set |
| Names | bones and parts: `[A-Za-z0-9_-]` only, unique across the file. Dots, slashes and brackets break animation binding in three.js and other engines |
| Sides | left/right twins end with `_L` / `_R` (configurable in `symmetry`) |
| Limb direction | by convention a limb bone "points" down its local **−Y**: the child joint sits at `[0, -length, 0]` and limb parts are centered at `[0, -length/2, 0]` |

---

## JSON file

A minimal but complete character:

```json
{
  "$schema": "../character.schema.json",
  "id": "blob",
  "name": "Blob",
  "materials": { "skin": { "color": "#6fb3ff", "roughness": 0.5 } },
  "skeleton": [
    { "name": "root", "parent": null },
    { "name": "body", "parent": "root", "position": [0, 0.3, 0] }
  ],
  "parts": [
    { "name": "bodySkin", "bone": "body", "material": "skin", "geometry": { "type": "sphere", "radius": 0.3 } }
  ],
  "clips": {
    "idle": { "duration": 2, "tracks": [
      { "bone": "body", "channel": "scale", "axis": "y", "wave": { "amp": 0.05, "freq": 1, "offset": 1 } }
    ] }
  },
  "controller": { "states": { "idle": "idle" } }
}
```

### Top level

| Field | Type | Required | Notes |
|---|---|---|---|
| `$schema` | string | – | `"../character.schema.json"` gives editor autocompletion and validation |
| `id` | name | ✔ | unique id; also the GLB root node name and file name |
| `name` | string | – | display name (any Unicode) |
| `description` | string | – | free text |
| `version` | integer | – | your own version of the model |
| `units`, `up`, `forward` | const | – | documentation only: `"meters"`, `"+Y"`, `"+Z"` |
| `symmetry` | object | – | `{ "left": "_L", "right": "_R" }`, see [mirroring](#symmetry-and-mirroring) |
| `materials` | object | ✔ | name → [material](#materials) |
| `skeleton` | array | ✔ | ordered list of [joints](#skeleton) |
| `parts` | array | ✔ | list of [parts](#parts) |
| `clips` | object | – | name → [clip](#clips) |
| `controller` | object | – | [runtime settings](#controller) |
| `view` | object | – | [default camera](#view) |

### materials

```json
"metal": { "color": "#c8ccd1", "metalness": 0.85, "roughness": 0.28 }
```

| Field | Default | Notes |
|---|---|---|
| `color` | `#cccccc` | base color (sRGB hex) |
| `roughness` | 0.6 | 0 = mirror, 1 = matte |
| `metalness` | 0 | use 0.8–1 for metals |
| `emissive`, `emissiveIntensity` | – | self-lit color, e.g. for eye glints |
| `opacity` | 1 | < 1 makes the material transparent |
| `clearcoat`, `clearcoatRoughness` | – | glossy coat layer (exported as `KHR_materials_clearcoat`) |
| `flatShading` | false | faceted low-poly look (web viewer only, not stored in glTF) |
| `doubleSided` | false | render back faces, for open shapes like eyelid caps |
| `texture` | – | procedural pattern that slightly shades the color: `noise`, `skin`, `fabric`, `knit`, `quilt`, `chain`, `fur`, `leather`, `metal`, `wood`, `hair` (see [humanoids.md](humanoids.md#textures)) |
| `textureScale`, `textureStrength`, `bumpScale` | 1, per type, per type | pattern repeats, how strongly it shades, bump depth (web viewer) |

Materials are PBR metallic-roughness and export to glTF unchanged. Details (logos, pupils, mouths)
are geometry; the optional procedural textures only add surface grain.

### skeleton

```json
{ "name": "foreArm_L", "parent": "upperArm_L", "position": [0, -0.18, 0], "rotation": [-15, 0, -74],
  "mirror": true, "tags": ["arm"], "limits": { "x": [-120, 20], "y": [-60, 60], "z": [-150, 10] } }
```

| Field | Notes |
|---|---|
| `name` | unique name |
| `parent` | name of a joint declared **earlier**, or `null` for the top joint (attached to the character root) |
| `position` | joint position relative to the parent joint, in rest pose |
| `rotation` | rest-pose Euler angles (degrees) |
| `rotationOrder` | `XYZ` (default), `XZY`, `YXZ`, `YZX`, `ZXY` or `ZYX` |
| `scale` | number or `[x, y, z]` |
| `mirror` | `true` also creates the opposite-side joint |
| `limits` | allowed **manual** offset from rest per axis, in degrees: `{ "x": [min, max], … }`. `[0, 0]` locks an axis, which makes a hinge such as a knee. Posing UIs use it; animations ignore it |
| `tags` | free-form labels (`arm`, `leg`, `wing`…) for tools and gameplay code |

### parts

```json
{ "name": "boot_L", "bone": "foot_L", "material": "metal",
  "geometry": { "type": "sphere", "radius": 1 },
  "position": [0, -0.05, 0.035], "scale": [0.075, 0.06, 0.115], "mirror": true }
```

| Field | Notes |
|---|---|
| `name` | unique name (it shares the name space with joints) |
| `bone` | joint it is attached to |
| `material` | material name |
| `geometry` | [shape](#geometry-types) |
| `position`, `rotation`, `rotationOrder`, `scale` | offset from the joint |
| `mirror` | also create the opposite-side part on the opposite-side joint |
| `mirrorFlip` | mirror with a true reflection (`scale.x = -1`), for shapes not symmetric about their own YZ plane |
| `visible`, `castShadow`, `receiveShadow` | default `true` |
| `tags` | free-form labels |

**Tip:** a unit sphere (`radius: 1`) with a non-uniform `scale` is the easiest way to get
ellipsoids (boots, beaks, bodies).

### geometry types

All shapes are centered on the part's origin unless stated otherwise.

| `type` | Parameters (defaults) | Shape |
|---|---|---|
| `sphere` | `radius` (0.1), `widthSegments` (28), `heightSegments` (18), `phiStart`/`phiLength` (0/360), `thetaStart`/`thetaLength` (0/180) | sphere; partial angles give caps and eyelids (`thetaLength: 80` = top cap) |
| `box` | `size` [x,y,z], `radius` (rounded corners), `segments` (3) | box / rounded box |
| `cylinder` | `radiusTop`, `radiusBottom` (or `radius`), `height`, `radialSegments` (24), `openEnded` | cylinder or frustum along Y |
| `capsule` | `radius`, `length` (straight part), `capSegments` (6), `radialSegments` (16) | pill along Y; total height = `length + 2·radius` |
| `cone` | `radius`, `height`, `radialSegments` (16) | cone pointing +Y |
| `torus` | `radius`, `tube`, `arc` (360), `radialSegments` (12), `tubularSegments` (48) | ring in the XY plane (rotate `[90,0,0]` to lay it flat) |
| `lathe` | `points` [[r, y], …] bottom→top, `segments` (40), `phiStart`, `phiLength` | profile revolved around Y: heads, bodies, cans, vases |
| `tube` | `points` [[x,y,z], …], `radius` (0.01), `tubularSegments` (32), `radialSegments` (8), `closed` | smooth tube through points: mouths, brows, letters, antennae |
| `extrude` | `points` [[x, y], …] outline, `smooth` (false), `depth` (0.02), `bevel` (≤ 0.01), `curveSegments` (32), `bevelSegments` (3) | flat shape: the outline in the XY plane, extruded along Z (centered) with rounded edges. Fins, tail lobes, ears, leaves, blades. Thickness = `depth + 2·bevel` |
| `horn` | `points` [[x,y,z], …], `radiusStart` (0.02), `radiusEnd` (0 = sharp), `taper` (1), `tubularSegments` (24), `radialSegments` (12) | tube along a curve that tapers to a point: claws, horns, curved teeth, spikes, tentacles |

`lathe`, `tube`, `extrude` and `horn` points are in the part's local space. Start and end a lathe
profile at `r = 0` to close it.

**Pointy shapes.** Cones are round and straight. Use `extrude` for anything flat and pointed, like
fins, and `horn` for anything round and pointed that curves, like claws and horns. To stand an
`extrude` outline up in a plane, rotate the part. For example, `rotation: [90, 90, 0]` maps outline
x → part +Y and outline y → part +Z, with the thickness along X. This is the shark's tail fin:

```json
{ "name": "caudalFin", "bone": "tailFin", "material": "skin", "rotation": [90, 90, 0],
  "geometry": { "type": "extrude", "smooth": true, "depth": 0.014, "bevel": 0.009,
                "points": [[0, 0.05], [0.1, 0.16], [0.22, 0.3], [0.31, 0.39], [0.25, 0.22], [0.18, 0.08],
                           [0.15, 0.02], [0.2, -0.1], [0.25, -0.19], [0.12, -0.1], [0, -0.05]] } }
```

A curved claw on a toe:

```json
{ "name": "toeClawMid_L", "bone": "foot_L", "material": "claw", "position": [0, -0.015, 0.165], "mirror": true,
  "geometry": { "type": "horn", "radiusStart": 0.014, "points": [[0, 0, 0], [0, -0.004, 0.02], [0, -0.016, 0.036]] } }
```

### clips

```json
"walk": {
  "duration": 0.9, "loop": true, "layer": "base", "fps": 30,
  "tracks": [
    { "bone": "thigh_L", "channel": "rotation", "axis": "x", "wave": { "amp": 28, "freq": 1 }, "mirror": { "phase": 0.5 } },
    { "bone": "shin_L",  "channel": "rotation", "axis": "x",
      "keys": [[0, 5], [0.25, 8], [0.5, 55], [0.7, 20], [0.8, 4], [1, 5]], "mirror": { "phase": 0.5 } },
    { "bone": "upperArm_L", "channel": "rotation", "axis": "z", "value": -32, "mirror": true }
  ]
}
```

Clip fields:

| Field | Default | Notes |
|---|---|---|
| `duration` | – | seconds |
| `loop` | true | non-looping clips hold their last frame |
| `layer` | `base` | `base`: body clips, one at a time, crossfaded. `face`: expressions, one at a time, crossfaded independently of `base`. `overlay`: always playing on top |
| `fps` | 30 | bake rate of the exported keyframes |
| `tracks` | – | list of tracks |

Track fields:

| Field | Notes |
|---|---|
| `bone` | joint name |
| `channel` | `rotation`: degrees **added** to the rest rotation. `position`: meters **added** to the rest position. `scale`: factor **multiplied** with the rest scale |
| `axis` | `x`, `y` or `z` |
| one of: `wave` / `keys` / `value` | the value source, see below |
| `interp` | for `keys`: `smooth` (Catmull-Rom, default), `linear` or `step` |
| `phase` | time shift in cycles (0.5 = half a clip later) |
| `absolute` | `true`: the value **replaces** the rest value instead of offsetting it. Use it for props that appear only in one clip (see below) |
| `mirror` | `true`: also drive the opposite-side joint, with Y/Z rotations and X position negated. `{ "phase": 0.5 }`: the same, half a cycle later, which is how one leg track gives a full walk |

Value sources (time `t` is normalized 0…1 over the clip):

- **`wave`** `{ amp, freq, phase, offset }` gives `offset + amp · sin(2π · (freq · t + phase))`.
  Use whole-number `freq` for seamless loops. Good for breathing, bobbing, swinging and wagging.
- **`keys`** `[[t, value], …]` sorted by `t`. Looping clips wrap from the last key to the first,
  so include keys at 0 and 1 with the same value. Good for gestures, look-arounds and the knee
  bend of a step.
- **`value`**: a constant offset for the whole clip. Good for changing a pose for one clip, such as
  dropping the arms while walking.

**Props.** An object that appears only during one clip (the fish in the shark's `eat`) is a
joint with a tiny rest scale and its parts attached. The clip scales it up with `absolute` tracks:

```json
{ "name": "food", "parent": "hand_R", "position": [0, -0.06, 0.02], "scale": 0.01, "tags": ["prop"] }

{ "bone": "food", "channel": "scale", "axis": "x", "absolute": true, "interp": "linear",
  "keys": [[0, 0.01], [0.1, 1], [0.36, 1], [0.37, 0.7], [0.51, 0.7], [0.52, 0.4], [0.66, 0.4], [0.67, 0.01], [1, 0.01]] }
```

(Same for `y` and `z`.) Each step down is a bite. Every other base clip automatically keeps the
prop at its rest scale (see [GLB structure](#glb-structure)), so it stays hidden in idle and walk.
Use 0.01 rather than 0, because some engines reject zero scale.

Several tracks on the same joint, channel and axis are added together (multiplied, for scale).
One rotation track on a joint animates all three axes of that joint in the baked output; the
other axes keep their rest values.

### controller

```json
"controller": { "states": { "idle": "idle", "walk": "walk", "eat": "eat" }, "overlays": ["blink"],
                "walkSpeed": 0.8, "turnSpeed": 8, "crossfade": 0.25 }
```

| Field | Default | Notes |
|---|---|---|
| `states` | – | gameplay state → clip. `idle` and `walk` drive locomotion; every other state (the shark's `eat`, or your `run`, `jump`, `wave`…) shows up in the viewers as a button (web) or under the `e` key (Panda3D, Bevy) |
| `overlays` | overlay-layer clips | clips that loop on top forever |
| `walkSpeed` | 0.8 | m/s when walking. Match the stride, see the [guide](creating-a-character.md#7-match-the-walk-speed) |
| `runSpeed` | 2 × walkSpeed | m/s when running (the `run` state; Shift in the web viewer) |
| `expressions` | – | expression name → `face` layer clip, e.g. `{ "happy": "face_happy" }` |
| `defaultExpression` | first expression | the expression the character starts with |
| `turnSpeed` | 8 | heading smoothing factor (1/s) |
| `crossfade` | 0.25 | seconds to blend between base clips |

### view

`{ "target": [0, 0.85, 0], "distance": 3.2 }`: the point the viewers' cameras look at (relative
to the character's feet) and the default camera distance.

### symmetry and mirroring

Write only the left side and set `"mirror": true`. The right side is generated by reflecting
across the YZ plane (x → −x):

| Item | Mirrored copy |
|---|---|
| joint | name `_L`→`_R`, parent mirrored, `position.x` negated, `rotation.y` and `rotation.z` negated, Y/Z limits flipped |
| part | name and joint mirrored, same transform rule; `mirrorFlip` additionally applies `scale.x = -1` |
| track | joint mirrored, rotation Y/Z and position X values negated, `mirror.phase` added |

Mirroring is optional. Asymmetric poses (the chicken's crossed wings, both pupils looking the
same way) are written as explicit `_L` and `_R` entries.

---

## GLB structure

`npm run build:glb` builds each character with [src/rig/character.js](../src/rig/character.js)
and writes it with three.js `GLTFExporter`: glTF 2.0 binary, one buffer, no textures.

```
scene 0
└─ node "<id>"                    extras.character = { schema, version, id, name, controller, view, clips }
   └─ node "root"                 extras.bone = true
      └─ node "hips"              extras.bone = true          translation/rotation/scale = rest pose
         ├─ node "spine"          extras.bone = true, limits, tags
         │  ├─ node "can"         extras.part = true          mesh = …
         │  └─ …
         └─ …
animations: "idle", "walk", "blink"
```

**Nodes.** There is one node per joint and one per part, with the same names as in the JSON
(mirrored twins included). Joints have no mesh. Each part node carries exactly one mesh (one
primitive: `POSITION`, `NORMAL`, `TEXCOORD_0`, indices). Transforms are stored as
`translation` / `rotation` (quaternion) / `scale`, never as a matrix, because animated nodes
require TRS.

**Extras.**

| Node | `extras` |
|---|---|
| character root | `character`: `{ schema: "puppetz-character", version, id, name, controller, view, clips: { <name>: { layer, loop, duration } } }` |
| joint | `bone: true`, optional `limits` `{x,y,z: [min,max]}` and `tags` |
| part | `part: true`, optional `tags` |

**Materials.** There is one glTF material per JSON material, using the same name and
`pbrMetallicRoughness`. Materials with `clearcoat` use `KHR_materials_clearcoat`.

**Animations.** There is one glTF animation per clip, using the clip name.
- Channels target joint nodes only. `rotation` channels hold quaternions; `translation` and
  `scale` channels hold vec3. All are `LINEAR`.
- Animated channels are sampled at `fps` (e.g. a 0.9 s walk at 30 fps has 28 keys) and store
  **absolute** values: rest plus offset.
- Every base-layer clip also contains a constant two-key rest-pose channel for each channel that
  another base clip animates. Crossfades then blend every touched channel back to rest, even in
  engines that only blend channels present in a clip.
- `face` clips get the same treatment among themselves.
- Overlay clips contain only their own channels.

**Reading it in an engine.**

| Engine | Geometry & hierarchy | Clips | Metadata |
|---|---|---|---|
| three.js | `GLTFLoader` | `gltf.animations` + `AnimationMixer` | `node.userData` |
| Bevy | glTF loader (`SceneRoot`) | `Gltf::named_animations` + `AnimationPlayer` | `GltfExtras` component (JSON string) |
| Panda3D | `panda3d-gltf` | not supported for rigid nodes; read the channels from the GLB ([glb_rig.py](../examples/panda3d/glb_rig.py)) | parse the GLB JSON chunk |
| Blender | File › Import › glTF | imported as object actions | custom properties |
| Godot / Unity | glTF importer | node animations are supported | extras → metadata / custom importer |

Axes: glTF is Y-up, +Z forward for these characters. Z-up engines (Panda3D, Blender, Unreal)
convert on import. Panda3D maps `(x, y, z)` to `(x, −z, y)`, so characters face −Y.

---

## Generated characters

A character file can also be a short recipe for a generator instead of a full rig:
`{ "generator": "humanoid", ... }`. The builder expands it into an ordinary definition first
([src/rig/generators.js](../src/rig/generators.js)). Recipes have their own schema,
[models/humanoid.schema.json](../models/humanoid.schema.json). See [humanoids.md](humanoids.md).

## models/index.json

The list of characters the viewers and the GLB builder use:

```json
{ "models": [ { "id": "shark", "name": "Shark", "json": "shark/shark.json", "glb": "shark/shark.glb" } ] }
```

Paths are relative to `models/`.

## Validation

[models/character.schema.json](../models/character.schema.json) is a JSON Schema (draft 2020-12).
Editors such as VS Code use it automatically through the `$schema` field. From the command line:

```sh
npx ajv-cli@5 validate --spec=draft2020 -s models/character.schema.json -d "models/{shark,alzak,chicken}/*.json"
npx ajv-cli@5 validate --spec=draft2020 -s models/humanoid.schema.json -d "models/{knight,ranger,wizard,villager,dwarf,archer,viking}/*.json"
```

The builder adds checks the schema can't express: parent joints declared first, unknown
joint, material or parent references, duplicate names, and a mirror suffix being present.
`npm run build:glb` reports these with the offending name.
