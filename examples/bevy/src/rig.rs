//! Loading and animating the rigid-rig character GLBs produced by `npm run build:glb`.
//!
//! Bevy's glTF loader already gives us everything structural: one entity per glTF node with
//! its `Name`, `Transform` and `GltfExtras`, meshes, PBR materials, and the clips as
//! `AnimationClip`s that target the joint nodes (an `AnimationPlayer` is added to the
//! animation root). This module adds the character layer on top:
//!
//! * reads the metadata from the nodes' extras: `character` (states, overlays, walk speed, view)
//!   on the root node, `bone` / `limits` on joints;
//! * builds an `AnimationGraph` with every clip, crossfades the base clips with
//!   `AnimationTransitions`, and keeps overlay clips (blink) always playing;
//! * lets you pose joints manually on top of the animation (`RigCharacter::set_override`).
//!
//! ```ignore
//! app.add_plugins(CharacterRigPlugin);
//! let e = spawn_character(&mut commands, &assets, "chicken/chicken.glb", Transform::default());
//! // later, once the entity has a RigCharacter component:
//! rig.set_state("walk");
//! rig.set_override("head", Vec3::new(0.0, 30.0, 10.0));
//! ```
//!
//! Space: glTF and Bevy are both Y-up and right-handed, so no conversion is needed.
//! Characters face +Z and their left side is +X.

// Part of the public API for applications; the bundled viewer does not use all of it.
#![allow(dead_code)]

use std::collections::HashMap;
use std::time::Duration;

use bevy::animation::AnimationTargetId;
use bevy::app::AnimationSystems;
use bevy::gltf::{Gltf, GltfExtras};
use bevy::prelude::*;
use bevy::scene::SceneInstanceReady;
use bevy::transform::TransformSystems;
use serde::Deserialize;

pub struct CharacterRigPlugin;

impl Plugin for CharacterRigPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, (finish_loading, apply_state_requests))
            .add_systems(
                PostUpdate,
                (
                    // Start every frame from the rest pose: channels no clip drives stay at rest,
                    // and last frame's manual overrides are discarded.
                    reset_bones_to_rest.before(AnimationSystems),
                    apply_pose
                        .after(AnimationSystems)
                        .before(TransformSystems::Propagate),
                ),
            );
    }
}

// ------------------------------------------------------------------ metadata (glTF extras)

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct CharacterMeta {
    pub id: String,
    pub name: String,
    pub controller: ControllerMeta,
    pub view: ViewMeta,
    pub clips: HashMap<String, ClipMeta>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct ControllerMeta {
    pub states: HashMap<String, String>,
    pub overlays: Option<Vec<String>>,
    pub walk_speed: f32,
    pub turn_speed: f32,
    pub crossfade: f32,
}

impl Default for ControllerMeta {
    fn default() -> Self {
        Self { states: HashMap::new(), overlays: None, walk_speed: 0.8, turn_speed: 8.0, crossfade: 0.25 }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ViewMeta {
    pub target: [f32; 3],
    pub distance: f32,
}

impl Default for ViewMeta {
    fn default() -> Self {
        Self { target: [0.0, 0.8, 0.0], distance: 3.0 }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ClipMeta {
    pub layer: String,
    #[serde(rename = "loop")]
    pub looping: bool,
}

impl Default for ClipMeta {
    fn default() -> Self {
        Self { layer: "base".into(), looping: true }
    }
}

/// Allowed manual offset from rest, in degrees, per axis. `[0, 0]` locks an axis.
#[derive(Deserialize, Clone, Copy, Debug, Default)]
pub struct Limits {
    pub x: Option<[f32; 2]>,
    pub y: Option<[f32; 2]>,
    pub z: Option<[f32; 2]>,
}

impl Limits {
    pub fn clamp(&self, deg: Vec3) -> Vec3 {
        let c = |v: f32, l: Option<[f32; 2]>| l.map_or(v, |[lo, hi]| v.clamp(lo, hi));
        Vec3::new(c(deg.x, self.x), c(deg.y, self.y), c(deg.z, self.z))
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct NodeExtras {
    bone: bool,
    limits: Option<Limits>,
    character: Option<CharacterMeta>,
}

// ------------------------------------------------------------------ components

/// A joint of a loaded character.
#[derive(Component, Debug)]
pub struct RigBone {
    pub name: String,
    pub rest: Transform,
    pub limits: Option<Limits>,
    /// The entity carrying the [`RigCharacter`].
    pub character: Entity,
}

/// Added to the entity passed to [`spawn_character`] once the model is loaded and spawned.
#[derive(Component)]
pub struct RigCharacter {
    pub meta: CharacterMeta,
    /// Joint entities, in hierarchy order.
    pub bones: Vec<Entity>,
    pub bone_names: Vec<String>,
    /// Play clips (`false` = rest pose + manual overrides, handy for posing).
    pub animate: bool,
    /// Clip playback speed.
    pub speed: f32,
    /// Manual rotation offsets (degrees, Euler XYZ, local axes) applied on top of the animation.
    pub overrides: HashMap<String, Vec3>,
    player: Entity,
    nodes: HashMap<String, AnimationNodeIndex>,
    requested: String,
    current: String,
}

impl RigCharacter {
    pub fn name(&self) -> &str {
        &self.meta.name
    }

    /// Requests a state from `controller.states` (`"idle"`, `"walk"`, ...) or a raw clip name.
    /// The crossfade happens in the next `Update`.
    pub fn set_state(&mut self, state: &str) {
        if self.requested != state {
            self.requested = state.to_owned();
        }
    }

    pub fn state(&self) -> &str {
        &self.requested
    }

    /// Name of the base clip currently playing.
    pub fn current_clip(&self) -> &str {
        &self.current
    }

    pub fn clip_names(&self) -> impl Iterator<Item = &str> {
        self.nodes.keys().map(String::as_str)
    }

    pub fn bone(&self, name: &str) -> Option<Entity> {
        self.bone_names.iter().position(|n| n == name).map(|i| self.bones[i])
    }

    pub fn set_override(&mut self, bone: &str, degrees: Vec3) {
        if degrees == Vec3::ZERO {
            self.overrides.remove(bone);
        } else {
            self.overrides.insert(bone.to_owned(), degrees);
        }
    }

    pub fn override_of(&self, bone: &str) -> Vec3 {
        self.overrides.get(bone).copied().unwrap_or(Vec3::ZERO)
    }

    pub fn walk_speed(&self) -> f32 {
        self.meta.controller.walk_speed
    }

    pub fn turn_speed(&self) -> f32 {
        self.meta.controller.turn_speed
    }

    fn clip_for(&self, state: &str) -> String {
        self.meta.controller.states.get(state).cloned().unwrap_or_else(|| state.to_owned())
    }
}

#[derive(Component)]
struct LoadingCharacter(Handle<Gltf>);

#[derive(Component)]
struct PendingRig {
    graph: Handle<AnimationGraph>,
    nodes: HashMap<String, AnimationNodeIndex>,
}

// ------------------------------------------------------------------ spawning

/// Spawns a character from a GLB path (relative to the asset folder). The returned entity is the
/// character's root: move/turn it for locomotion. It gets a [`RigCharacter`] once ready.
pub fn spawn_character(
    commands: &mut Commands,
    assets: &AssetServer,
    path: impl Into<String>,
    transform: Transform,
) -> Entity {
    let path: String = path.into();
    commands
        .spawn((
            Name::new(path.clone()),
            transform,
            Visibility::default(),
            LoadingCharacter(assets.load(path)),
        ))
        .id()
}

fn finish_loading(
    mut commands: Commands,
    loading: Query<(Entity, &LoadingCharacter, &Name)>,
    gltfs: Res<Assets<Gltf>>,
    assets: Res<AssetServer>,
    mut graphs: ResMut<Assets<AnimationGraph>>,
) {
    for (entity, LoadingCharacter(handle), name) in &loading {
        if assets.load_state(handle).is_failed() {
            error!("could not load {name} - did you run `npm run build:glb`?");
            commands.entity(entity).remove::<LoadingCharacter>();
            continue;
        }
        let Some(gltf) = gltfs.get(handle) else { continue };
        let Some(scene) = gltf.default_scene.clone().or_else(|| gltf.scenes.first().cloned()) else {
            error!("{name} contains no scene");
            commands.entity(entity).remove::<LoadingCharacter>();
            continue;
        };

        let mut graph = AnimationGraph::new();
        let root = graph.root;
        let nodes = gltf
            .named_animations
            .iter()
            .map(|(clip_name, clip)| (clip_name.to_string(), graph.add_clip(clip.clone(), 1.0, root)))
            .collect();

        commands
            .entity(entity)
            .remove::<LoadingCharacter>()
            .insert((SceneRoot(scene), PendingRig { graph: graphs.add(graph), nodes }))
            .observe(on_scene_ready);
    }
}

fn on_scene_ready(
    ready: On<SceneInstanceReady>,
    mut commands: Commands,
    pending: Query<&PendingRig>,
    children: Query<&Children>,
    nodes: Query<(&Name, &Transform, Option<&GltfExtras>, Has<AnimationTargetId>)>,
    mut players: Query<&mut AnimationPlayer>,
) {
    let root = ready.entity;
    let Ok(pending) = pending.get(root) else { return };

    let mut meta = None;
    let mut bones = Vec::new();
    let mut animated = Vec::new(); // fallback for foreign GLBs without our extras
    let mut player_entity = None;
    for e in children.iter_descendants_depth_first(root) {
        if player_entity.is_none() && players.contains(e) {
            player_entity = Some(e);
        }
        let Ok((name, transform, extras, is_target)) = nodes.get(e) else { continue };
        let extras: NodeExtras = extras
            .and_then(|x| serde_json::from_str(&x.value).ok())
            .unwrap_or_default();
        if let Some(m) = extras.character {
            meta = Some(m);
        }
        let bone = RigBone { name: name.to_string(), rest: *transform, limits: extras.limits, character: root };
        if extras.bone {
            bones.push((e, bone));
        } else if is_target && !name.is_empty() {
            animated.push((e, bone));
        }
    }
    if bones.is_empty() {
        bones = animated;
    }

    let mut meta = meta.unwrap_or_default();
    let clip_names: Vec<&String> = pending.nodes.keys().collect();
    let find = |word: &str| clip_names.iter().find(|n| n.to_lowercase().contains(word)).map(|n| n.to_string());
    if !meta.controller.states.contains_key("idle") {
        if let Some(c) = find("idle").or_else(|| clip_names.first().map(|n| n.to_string())) {
            meta.controller.states.insert("idle".into(), c);
        }
    }
    if !meta.controller.states.contains_key("walk") {
        if let Some(c) = find("walk") {
            meta.controller.states.insert("walk".into(), c);
        }
    }
    let overlays = meta.controller.overlays.clone().unwrap_or_else(|| {
        meta.clips.iter().filter(|(_, c)| c.layer == "overlay").map(|(n, _)| n.clone()).collect()
    });

    let Some(player_entity) = player_entity else {
        warn!("{} has no animations", meta.name);
        commands.entity(root).remove::<PendingRig>();
        return;
    };

    // Overlays play forever on top of the base layer; the base layer starts in "idle".
    let mut player = players.get_mut(player_entity).expect("checked above");
    for name in &overlays {
        if let Some(&node) = pending.nodes.get(name) {
            player.play(node).repeat();
        }
    }
    commands
        .entity(player_entity)
        .insert((AnimationGraphHandle(pending.graph.clone()), AnimationTransitions::new()));

    for (e, bone) in &bones {
        commands.entity(*e).insert(RigBone {
            name: bone.name.clone(),
            rest: bone.rest,
            limits: bone.limits,
            character: root,
        });
    }
    let (bone_entities, bone_names) = bones.into_iter().map(|(e, b)| (e, b.name)).unzip();
    if meta.name.is_empty() {
        meta.name = meta.id.clone();
    }
    commands.entity(root).remove::<PendingRig>().insert(RigCharacter {
        meta,
        bones: bone_entities,
        bone_names,
        animate: true,
        speed: 1.0,
        overrides: HashMap::new(),
        player: player_entity,
        nodes: pending.nodes.clone(),
        requested: "idle".into(),
        current: String::new(),
    });
}

// ------------------------------------------------------------------ per frame

fn apply_state_requests(
    mut characters: Query<&mut RigCharacter>,
    mut players: Query<(&mut AnimationPlayer, &mut AnimationTransitions)>,
) {
    for mut rig in &mut characters {
        let Ok((mut player, mut transitions)) = players.get_mut(rig.player) else { continue };
        let clip = rig.clip_for(&rig.requested);
        if clip != rig.current {
            if let Some(&node) = rig.nodes.get(&clip) {
                let fade = if rig.current.is_empty() { 0.0 } else { rig.meta.controller.crossfade };
                let looping = rig.meta.clips.get(&clip).is_none_or(|c| c.looping);
                let active = transitions.play(&mut player, node, Duration::from_secs_f32(fade));
                if looping {
                    active.repeat();
                }
                rig.current = clip;
            }
        }
        let speed = rig.speed;
        for (_, animation) in player.playing_animations_mut() {
            animation.set_speed(speed);
        }
    }
}

fn reset_bones_to_rest(mut bones: Query<(&RigBone, &mut Transform)>) {
    for (bone, mut transform) in &mut bones {
        *transform = bone.rest;
    }
}

fn apply_pose(characters: Query<&RigCharacter>, mut bones: Query<(&RigBone, &mut Transform)>) {
    for rig in &characters {
        for &entity in &rig.bones {
            let Ok((bone, mut transform)) = bones.get_mut(entity) else { continue };
            if !rig.animate {
                *transform = bone.rest;
            }
            if let Some(deg) = rig.overrides.get(&bone.name) {
                let offset = Quat::from_euler(
                    EulerRot::XYZ,
                    deg.x.to_radians(),
                    deg.y.to_radians(),
                    deg.z.to_radians(),
                );
                transform.rotation *= offset;
            }
        }
    }
}
