# Puppetz: Bevy example

Loads the Puppetz character GLBs (`models/<id>/<id>.glb`) in [Bevy](https://bevyengine.org/) 0.18.1,
plays their idle/walk/blink clips, walks them around and lets you pose any joint. It is the
same viewer as the [Panda3D example](../panda3d/), written in Rust.

## Run

```sh
# from this folder (examples/bevy)
npm run build:glb --prefix ../..       # only if the .glb files are missing or the JSON changed
cargo run --release
```

Options (after `--`):

```sh
cargo run --release -- --active chicken --mode wander
cargo run --release -- --active shark --mode eat                        # any state of the character
cargo run --release -- --pose head:0,25,12 --pose upperArm_L:0,0,-40   # start with a manual pose
cargo run --release -- --screenshot shot.png --frames 120               # render, save, exit
cargo run --release -- --models path/to/models                          # another models folder
```

Keys: arrows walk, space wander, `e` cycle extra states (the shark's eat), tab switch character, `b`/`shift+b` select bone, hold `1`–`6`
to rotate it (X−/X+/Y−/Y+/Z−/Z+, clamped to the joint limits), `r`/backspace reset, `p` rest
pose, `k` skeleton, `-`/`=` speed, mouse drag orbits, wheel zooms.

The first build compiles Bevy and takes several minutes. If your antivirus blocks cargo's
`build-script-build.exe` files with "Access is denied (os error 5)", add an exception for the
target folder, or point cargo at an allowed one with `CARGO_TARGET_DIR`.

## Files

| File | What it does |
|---|---|
| [src/rig.rs](src/rig.rs) | `CharacterRigPlugin` and `spawn_character()`. This is the reusable part |
| [src/main.rs](src/main.rs) | The viewer: scene, camera, input, HUD, gizmos, screenshot mode |

## How it works

Bevy's glTF loader does most of the work. Each glTF node becomes an entity with its `Name`,
`Transform` and `GltfExtras`. The clips become `AnimationClip`s that target the joint nodes,
including plain non-skinned nodes like ours. glTF and Bevy are both Y-up and right-handed, so no
axis conversion is needed. Characters face +Z.

`rig.rs` adds the character layer on top:

1. `spawn_character()` loads the `Gltf` asset. When it is ready, it builds an `AnimationGraph`
   containing every named clip and spawns the scene.
2. On `SceneInstanceReady`, it reads the extras. The root node's `character` extras give the
   states, overlays, walk speed and camera view; each joint's extras give `bone: true` and its
   limits. It then tags the joints with `RigBone` (name, rest transform, limits), adds
   `AnimationTransitions` to the `AnimationPlayer`, starts the overlay clips (blink), and inserts
   `RigCharacter` on the character entity.
3. Each frame:
   - `apply_state_requests` crossfades the base clips when `RigCharacter::set_state()` was called.
   - In `PostUpdate`, joints are reset to rest before Bevy's `AnimationSystems`.
   - After the animation, `apply_pose` applies the manual overrides (or the rest pose when
     `animate` is off), before transform propagation.

```rust
app.add_plugins(CharacterRigPlugin);

// Startup:
let shark = rig::spawn_character(&mut commands, &assets, "shark/shark.glb", Transform::default());

// Any system, once the entity has a RigCharacter:
fn drive(mut q: Query<&mut RigCharacter>) {
    for mut rig in &mut q {
        rig.set_state("eat");                              // crossfade ("idle", "walk", "eat"... or a clip name)
        rig.set_override("head", Vec3::new(0.0, 30.0, 10.0)); // degrees, XYZ, on top of the animation
        rig.speed = 1.5;
    }
}
// Joints are ordinary entities: rig.bone("tail") gives the Entity; parts are its children (by Name).
```
