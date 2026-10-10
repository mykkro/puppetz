# Humanoid characters: bodies, items and expressions

Hand-written characters like the shark describe every joint and shape. Humanoids are different:
you write a short **recipe** (a body plus the items it wears and holds), and the humanoid
generator ([src/rig/humanoid.js](../src/rig/humanoid.js)) builds the full rig, parts and animations
from it. The result is an ordinary Puppetz character, so the viewer, the GLB builder and the engine
examples treat it like any other.

```json
{
  "$schema": "../humanoid.schema.json",
  "generator": "humanoid",
  "id": "knight",
  "name": "Knight",
  "body": { "sex": "male", "age": 28, "height": 1, "girth": 1, "skin": "#f2c9a5", "eyes": "#3a5f9e", "hairColor": "#a8642a" },
  "equipment": {
    "hair": "short",
    "clothes": { "item": "tunic", "color": "#2f5fa8", "accent": "#3b3b48" },
    "armor": "plate",
    "hands": "gauntlets",
    "feet": "greaves",
    "back": { "item": "cape", "color": "#a8323a" },
    "mainHand": "sword",
    "offHand": "roundShield"
  },
  "expression": "neutral"
}
```

The quickest way to make one is the **Character** panel in the viewer: pick one of the humanoid
models, change the body and the items, press **Save JSON** and put the file in
`models/<id>/<id>.json`. Add it to [models/index.json](../models/index.json) and run
`npm run build:glb` for the GLB.

Sample recipes: [knight](../models/knight/knight.json), [ranger](../models/ranger/ranger.json),
[wizard](../models/wizard/wizard.json), [village kid](../models/villager/villager.json),
[stout warrior](../models/dwarf/dwarf.json).

## Body

| Field | Values | Effect |
|---|---|---|
| `sex` | `male`, `female` | shoulder and hip width, waist, eyelashes |
| `age` | 5–90 | children are smaller with bigger, rounder heads; from about 50 the back bends and hair greys; elders move slower |
| `height` | 0.8–1.2 | limb and torso length |
| `girth` | 0.8–1.35 | body and limb thickness; stout characters hold their arms further out |
| `skin`, `eyes`, `hairColor` | `#rrggbb` | `hairColor` is the natural hair color: brows use it, and so do hair and beard items unless you give them their own color (`"hair": { "item": "mohawk", "color": "#3a6fd9" }` dyes just the hair). The editor has palettes of skin tones and natural and fantasy hair colors |

The style is stylized but not chibi: an egg-shaped head about a quarter of the height, big eyes
with glints, rigid jointed limbs.

## Items and slots

Everything worn or carried is an **item** from the library in
[src/rig/items.js](../src/rig/items.js). Each item goes into one **slot**:

| Slot | Items |
|---|---|
| `hair` | `short`, `spiky`, `bob`, `long`, `ponytail`, `bun`, `afro`, `mohawk`, `braids`, `pigtails`, `balding` |
| `beard` | `shortBeard`, `longBeard`, `moustache` (grown-ups only) |
| `clothes` | `shirt` (shirt and trousers), `tunic`, `dress`, `robe` |
| `armor` | `leather` (vest), `plate` (breastplate, pauldrons, tassets, knee cops) |
| `hands` | `gloves`, `gauntlets` |
| `feet` | `shoes`, `boots`, `greaves` |
| `head` | `helmet`, `hood`, `wizardHat`, `crown` |
| `back` | `cape`, `backpack` |
| `mainHand` | `sword`, `axe`, `spear`, `staff` (right hand) |
| `offHand` | `roundShield`, `kiteShield` (left forearm) |

An entry is either the item name or `{ "item": "...", "color": "#...", "accent": "#..." }`.
`color` is the main color and `accent` the second one, such as trousers under a tunic, a cape clasp
or a shield rim. Leave a slot out (or set it to `"none"`) to leave it empty.

**Items fit any body.** An item never contains fixed sizes. It is built from the body's
measurements: head radius and shape, limb lengths and thicknesses, the torso outline. The same
helmet fits a child and a stout warrior, and the same cape hangs right on both.

**Slots are layers.** They are built from the inside out: clothes on the skin, armor over the
clothes, gloves and boots over sleeves and trousers, a cape over everything. Each layer records how
far out it reaches, so the next one goes around it: plate armor sits outside the tunic, and a cape
widens to hang over tassets or a robe. Headwear can hide the top of the hair, so a helmet doesn't
end up with hair poking through it.

**Held items change the animations.** A sword or axe is held like a blade, a spear or staff like
a pole, and a shield sits on the forearm. The rest pose, the walk (less arm swing for a held pole),
the combat guard and the attack (a chop for blades, a thrust for poles, a punch for empty hands)
all adapt to what the hands hold. Long skirts and robes make the stance and stride narrower, so the
legs don't poke through.

### Adding an item

Add an entry to `ITEMS` in [src/rig/items.js](../src/rig/items.js); the editor lists it in its
slot automatically. Then run `npm run build:schema` so the recipe schema knows the new name.

```js
bandana: {
  slot: 'head', label: 'Bandana', colors: { color: '#c0392b' },
  build(ctx, o) {
    const R = ctx.d.R;                                   // head radius
    const cloth = ctx.mat('bandana', { texture: 'fabric', textureScale: 3, color: o.color, roughness: 0.85, doubleSided: true });
    ctx.headShell('bandanaTop', cloth, R * 1.08, 0, 360, 0, 58); // a cap: azimuth 0–360°, from the top down to 58°
    ctx.hides.add('hairTop');                            // the hair item then skips its top
  },
},
```

The tools on `ctx`:

| | |
|---|---|
| `ctx.d` | body measurements: `R` (head radius), `HY`/`HZ` (head height/depth factors), `thigh`, `shin`, `upperArm`, `foreArm`, `armR`, `legR`, `handR`, `shoulderX`, `hipR`, `waistR`, `chestR`, `spineLen`, `chestLen`, `H` (length scale), `G` (girth scale), `grow` (0 child … 1 adult), `old` |
| `ctx.mat(name, props)` | defines a material once and returns its name. Name it after the item: recipes can override it, and a real texture can be attached to it later |
| `ctx.part({...})`, `ctx.bone({...})` | add a part or a joint, as in a character JSON (see [character-format.md](character-format.md)) |
| `ctx.limb(name, bone, length, radius, material)` | a capsule down a limb bone |
| `ctx.torsoShell(name, material, k, yFrom, yTo)` | the torso outline inflated by `k`, optionally cut to a height range |
| `ctx.torsoRadius(y)` | torso radius at a height, for belts, straps and backpacks |
| `ctx.headShell(name, material, r, az0, az1, polar0, polar1)` | part of a shell around the head (azimuth 0 = front, 90 = left; polar 0 = top) |
| `ctx.hp([x, y, z])`, `ctx.onHead(r, polar, az)` | head positions: design as if the head were a sphere of radius `R`, and `hp` maps the point onto the real egg-shaped head |
| `ctx.layer` | outermost covering so far per region (`torso`, `arm`, `foreArm`, `leg`, `shin`), as a factor of the bare size. Grow it when your item wraps a region |
| `ctx.hides`, `ctx.grip`, `ctx.shield`, `ctx.skirtR` | what is hidden, how the main hand holds (`blade`/`pole`), whether a shield is worn, the widest skirt |
| sockets | weapons attach to the `grip_R` joint, pointing along its +Z; shields to `mount_L`, facing its +X |

## Textures

Materials can use a **procedural texture**: a small tileable grayscale pattern generated in code
([src/rig/textures.js](../src/rig/textures.js)) that slightly shades the color: `fabric`, `knit`,
`leather`, `metal`, `wood`, `skin`, `hair`, `noise`. It gives cloth a weave, leather a grain and
wood its rings, so the characters don't look like clean plastic. In the web viewer the same pattern
is also used as a bump map.

```json
"materials": { "cape": { "texture": "knit", "textureScale": 4 } }
```

- `"textures": false` in a recipe (or the **Textures** checkbox in the editor) switches back to
  flat colors.
- `"materials"` in a recipe overrides any material by name (`skin`, `clothes`, `armor_metal`,
  `cape`...): its color, roughness, texture, `textureScale`, `textureStrength` or `bumpScale`.
- Any hand-written character can use `texture` on its materials too.
- In the GLB, the textures are embedded PNGs (each pattern once). Repeats use
  `KHR_texture_transform`, and the web viewer's bump map is stored as `EXT_materials_bump`.
  Engines that don't support those extensions show the pattern at its base scale without bump.

## Animations

Every humanoid gets the same set of clips, adapted to its body and equipment:

| State | Clip | |
|---|---|---|
| `idle` | `idle` | breathing, weight shift, looking around |
| `walk` | `walk` | stride and speed computed from the leg length (`walkSpeed`) |
| `run` | `run` | `runSpeed`; **Shift** + WASD or the **Run** button in the viewer |
| `talk` | `talk` | the mouth flaps, the head nods, a free hand gestures |
| `combat` | `combat` | crouched guard, weapon up, shield in front |
| `attack` | `attack` | a looping chop, thrust or punch |

**Expressions** play on their own `face` layer, so a character can run and look angry at the same
time: `neutral`, `happy`, `sad`, `agitated`, `angry`, `sleepy`. They move the brows and eyes, swap
the mouth shape (smile, frown, open), show a blush and tilt the head. The controller lists them in
`controller.expressions`. In the viewer, use the **Expression** buttons or `?expr=angry` in the URL.

The face works on two joints: body clips turn `head`, expressions turn `skull` (the head's center,
which carries everything on the head). Blinking is an overlay on `blink_L`/`blink_R`, separate from
the expression's squint on `eye_L`/`eye_R`, so sleepy eyes still blink. Talking opens `talkMouth`
under whichever mouth shape the expression shows.

## In game engines

A humanoid GLB is a normal Puppetz GLB. The face clips are named `face_<expression>` and marked
`layer: "face"` in the extras; to support expressions, play the selected one on top of the body
clip, the same way overlays are played. Engines that ignore them (the current Panda3D and Bevy
examples) show the neutral face, which is the rest pose.
