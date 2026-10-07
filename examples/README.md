# Examples: using Puppetz characters in game engines

Both examples load every model listed in [`models/index.json`](../models/index.json) and work the
same way: same keys, same command-line options, same behavior. That makes them easy to compare and
a good template for your own engine integration.

| | [Panda3D](panda3d/) | [Bevy](bevy/) |
|---|---|---|
| Language | Python 3.10+ | Rust (edition 2024), Bevy 0.18.1 |
| Run | `pip install -r requirements.txt`, `python viewer.py` | `cargo run --release` |
| Reusable module | [glb_rig.py](panda3d/glb_rig.py) `RigPlayer` | [src/rig.rs](bevy/src/rig.rs) `CharacterRigPlugin` |
| glTF loading | `panda3d-gltf` | built into Bevy |
| Who plays the clips | `RigPlayer` (it reads the channels from the GLB) | Bevy's `AnimationPlayer` + `AnimationTransitions` |
| Axis conversion | yes: glTF Y-up → Panda Z-up | none (both Y-up) |
| Rendering | `panda3d-simplepbr` (PBR + shadows) | Bevy PBR + cascaded shadows |

Both need the GLBs. They are committed, but rebuild them after editing a JSON: `npm run build:glb`
in the repo root.

## Common controls

| Input | Action |
|---|---|
| arrows | walk the active character (camera relative) |
| space | toggle wander (walk in a circle) |
| `e` | cycle the character's extra states (e.g. the shark's **eat**) |
| tab | switch active character |
| `b` / shift+`b` | select next / previous joint |
| hold `1`…`6` | rotate the joint X− X+ Y− Y+ Z− Z+, clamped to its limits |
| `r` / backspace | reset the joint / all joints |
| `p` | toggle clips (off = rest pose, handy for posing) |
| `k` | skeleton overlay |
| `-` / `=` | playback speed |
| mouse drag / wheel | orbit / zoom |

Command line: `--active <id>`, `--mode idle|walk|wander|<state>` (e.g. `--mode eat`), `--pose bone:x,y,z` (repeatable),
`--screenshot out.png --frames N` (render N frames at a fixed 60 fps, save, exit).

## What an integration has to do

The GLBs are standard glTF 2.0, so any engine can load the meshes and the joint hierarchy.
A full character integration adds four things:

1. **Read the metadata** from the node `extras`. The character root node has `extras.character`:
   which clip is idle or walk, overlay clips, walk speed, crossfade time and camera view. Each
   joint has `extras.bone = true`, plus optional `limits` (degrees) and `tags`.
2. **Play clips on two layers.** Base clips (idle, walk) crossfade into each other. Overlay clips
   (blink) loop on top all the time and touch different channels.
3. **Start each frame from the rest pose, then animate.** A joint that no clip drives then stays at
   rest instead of keeping a stale value. The builder already writes rest-pose tracks into every
   base clip for channels the other base clips animate, so crossfades are clean in engines that
   only blend the channels present in a clip (e.g. Bevy).
4. **Optional manual posing.** After the animation, multiply each posed joint's local rotation by
   an extra rotation built from Euler XYZ degrees, the same convention as the JSON. Clamp it to the
   joint's `limits`.

Locomotion is done by moving a parent node of the character root, never the joints. Use the
character's `walkSpeed` (m/s) so the feet don't slide.

See [docs/character-format.md](../docs/character-format.md#glb-structure) for the exact GLB layout.
