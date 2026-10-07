# Puppetz: Panda3D example

Loads the Puppetz character GLBs (`models/<id>/<id>.glb`) in [Panda3D](https://www.panda3d.org/),
plays their idle/walk/blink clips, walks them around and lets you pose any joint.

## Run

```sh
# from this folder (examples/panda3d)
python -m venv .venv
.venv\Scripts\activate            # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt

npm run build:glb --prefix ../..   # only if the .glb files are missing or the JSON changed
python viewer.py
```

Options:

```sh
python viewer.py --active chicken --mode wander
python viewer.py --active shark --mode eat                         # any state of the character
python viewer.py --pose head:0,25,12 --pose upperArm_L:0,0,-40      # start with a manual pose
python viewer.py --screenshot shot.png --frames 120                  # render offscreen, save, exit
```

Keys: arrows walk, space wander, `e` cycle extra states (the shark's eat), tab switch character, `b`/`shift+b` select bone, hold `1`–`6`
to rotate it (X−/X+/Y−/Y+/Z−/Z+, clamped to the joint limits), `r`/backspace reset, `p` rest
pose, `k` skeleton, `-`/`=` speed, mouse drag orbits, wheel zooms.

## How it works

| Piece | Who does it |
|---|---|
| Geometry, materials, node hierarchy | [panda3d-gltf](https://github.com/Moguri/panda3d-gltf) loader: `base.loader.load_model("….glb")` |
| PBR shading + shadows | [panda3d-simplepbr](https://github.com/Moguri/panda3d-simplepbr) |
| Rig animation, crossfades, posing | [glb_rig.py](glb_rig.py) `RigPlayer` (about 300 lines, no other dependencies) |

panda3d-gltf only plays animations on **skinned** meshes. Our characters are rigid: each part is a
mesh parented to a joint node, and the clips animate those joint nodes directly. So `RigPlayer`
reads the glTF animation channels and the character metadata (`extras`: walk speed, states,
overlay clips, joint limits) from the GLB itself, and every frame writes the sampled
position, rotation and scale to the joint `NodePath`s.

Axes: panda3d-gltf converts glTF's Y-up space to Panda's Z-up space. The mapping is
`(x, y, z) → (x, -z, y)`, and the quaternion `(x, y, z, w)` becomes `Quat(w, x, -z, y)`. Characters
end up facing **-Y**, towards Panda's default camera. `RigPlayer` does all its maths in glTF space
and converts only when it writes to the nodes.

## Using it in your own code

```python
from glb_rig import RigPlayer

model = base.loader.load_model("models/shark/shark.glb")
model.reparent_to(base.render)
rig = RigPlayer("models/shark/shark.glb", model)

rig.set_state("eat")                        # crossfade to a state ("idle", "walk", "eat"...) or any clip name
rig.set_override("head", (0, 30, 10))       # degrees, on top of the animation, glTF axes
rig.bone_node("tail").set_color_scale(1, 0, 0, 1)   # joints are plain NodePaths
model.find("**/dorsalFin").hide()           # parts too (names from the JSON)

def update(task):
    rig.update(globalClock.get_dt())
    return task.cont
base.task_mgr.add(update)
```

Supported glTF animation features: LINEAR and STEP interpolation on translation, rotation and scale.
That covers everything `npm run build:glb` produces. CUBICSPLINE and skinned meshes are not handled
here; for skinned GLBs, use Panda3D's `Actor` instead.
