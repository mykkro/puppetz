//! Bevy example: load every character GLB listed in models/index.json, animate and pose its rig.
//!
//! ```text
//! cargo run --release
//! cargo run --release -- --active chicken --mode wander
//! cargo run --release -- --pose head:0,25,12 --pose upperArm_L:0,0,-40
//! cargo run --release -- --screenshot shot.png --frames 120
//! ```

mod rig;

use std::path::PathBuf;
use std::time::Duration;

use bevy::input::mouse::{AccumulatedMouseMotion, AccumulatedMouseScroll};
use bevy::light::CascadeShadowConfigBuilder;
use bevy::prelude::*;
use bevy::render::view::screenshot::{Screenshot, save_to_disk};
use bevy::time::TimeUpdateStrategy;
use serde::Deserialize;

use rig::{CharacterRigPlugin, RigBone, RigCharacter};

const HELP: &str = "\
arrows: walk the active character (camera relative)
space: toggle wander (walk in a circle)
e: cycle extra states of the character (e.g. eat)
tab: switch active character
1-6 (hold): rotate selected bone X- X+ Y- Y+ Z- Z+ (joint limits apply)
b / shift+b: next / previous bone
r / backspace: reset selected bone / all bones
p: toggle clips (off = rest pose)
k: toggle skeleton overlay
- / =: playback speed
mouse drag: orbit, wheel: zoom";

const WANDER_RADIUS: f32 = 1.6;
const POSE_SPEED: f32 = 90.0; // degrees per second while a pose key is held
const SPACING: f32 = 1.4;

// ------------------------------------------------------------------ command line

#[derive(Resource, Clone, Debug)]
struct Args {
    models: PathBuf,
    active: Option<String>,
    mode: Mode,
    poses: Vec<(String, Vec3)>,
    screenshot: Option<PathBuf>,
    frames: u32,
}

fn parse_args() -> Args {
    let mut args = Args {
        models: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models"),
        active: None,
        mode: Mode::Idle,
        poses: Vec::new(),
        screenshot: None,
        frames: 90,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().unwrap_or_else(|| panic!("{flag} needs a value"));
        match flag.as_str() {
            "--models" => args.models = value().into(),
            "--active" => args.active = Some(value()),
            "--mode" => {
                args.mode = match value().as_str() {
                    "idle" => Mode::Idle,
                    "walk" => Mode::Walk,
                    "wander" => Mode::Wander,
                    other => Mode::State(other.to_owned()),
                }
            }
            "--pose" => {
                let spec = value();
                let (bone, xyz) = spec.split_once(':').expect("--pose BONE:X,Y,Z");
                let v: Vec<f32> = xyz.split(',').map(|n| n.trim().parse().expect("number")).collect();
                args.poses.push((bone.to_owned(), Vec3::new(v[0], v[1], v[2])));
            }
            "--screenshot" => args.screenshot = Some(value().into()),
            "--frames" => args.frames = value().parse().expect("--frames N"),
            other => panic!("unknown argument {other}"),
        }
    }
    args
}

#[derive(Deserialize)]
struct ModelIndex {
    models: Vec<IndexEntry>,
}

#[derive(Deserialize)]
struct IndexEntry {
    id: String,
    glb: String,
}

// ------------------------------------------------------------------ app state

#[derive(Clone, Debug, PartialEq, Eq)]
enum Mode {
    Idle,
    Walk,
    Wander,
    /// Any other controller state of the character, e.g. "eat".
    State(String),
}

#[derive(Resource)]
struct Viewer {
    chars: Vec<(String, Entity)>,
    active: usize,
    mode: Mode,
    bone_index: usize,
    show_skeleton: bool,
    yaw: f32,
    pitch: f32,
    distance: f32,
    initial_poses_applied: bool,
    frame: u32,
}

/// Current facing of a character root, in radians (0 = facing +Z).
#[derive(Component, Default)]
struct Heading(f32);

#[derive(Component)]
struct StatusText;

#[derive(Component)]
struct Sun;

fn main() {
    let args = parse_args();
    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .set(AssetPlugin { file_path: args.models.to_string_lossy().into_owned(), ..default() })
            .set(WindowPlugin {
                primary_window: Some(Window {
                    title: "Puppetz Viewer (Bevy)".into(),
                    resolution: (1280, 800).into(),
                    ..default()
                }),
                ..default()
            }),
    )
    .add_plugins(CharacterRigPlugin)
    .insert_resource(ClearColor(Color::srgb(0.85, 0.87, 0.89)))
    .insert_resource(GlobalAmbientLight { color: Color::WHITE, brightness: 600.0, ..default() })
    .add_systems(Startup, setup)
    .add_systems(
        Update,
        (
            on_character_ready,
            keyboard_controls,
            posing,
            locomotion,
            camera_control,
            update_hud,
            draw_overlay,
        )
            .chain(),
    );
    if args.screenshot.is_some() {
        // Fixed 60 fps steps -> deterministic screenshots.
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(1.0 / 60.0)))
            .add_systems(Update, screenshot_and_exit);
    }
    app.insert_resource(args).run();
}

// ------------------------------------------------------------------ setup

fn setup(
    mut commands: Commands,
    assets: Res<AssetServer>,
    args: Res<Args>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut gizmo_config: ResMut<GizmoConfigStore>,
    mut fonts: ResMut<Assets<Font>>,
) {
    let index_path = args.models.join("index.json");
    let index: ModelIndex = serde_json::from_str(
        &std::fs::read_to_string(&index_path).unwrap_or_else(|e| panic!("{}: {e}", index_path.display())),
    )
    .expect("valid models/index.json");

    let n = index.models.len() as f32;
    let chars: Vec<(String, Entity)> = index
        .models
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let x = (i as f32 - (n - 1.0) / 2.0) * SPACING;
            let e = rig::spawn_character(&mut commands, &assets, entry.glb.clone(), Transform::from_xyz(x, 0.0, 0.0));
            commands.entity(e).insert(Heading::default());
            (entry.id.clone(), e)
        })
        .collect();
    let active = args.active.as_ref().and_then(|id| chars.iter().position(|(c, _)| c == id)).unwrap_or(0);

    commands.insert_resource(Viewer {
        chars,
        active,
        mode: args.mode.clone(),
        bone_index: 0,
        show_skeleton: false,
        yaw: 25f32.to_radians(),
        pitch: 12f32.to_radians(),
        distance: 3.0,
        initial_poses_applied: false,
        frame: 0,
    });

    commands.spawn((
        Camera3d::default(),
        Projection::Perspective(PerspectiveProjection { fov: 40f32.to_radians(), ..default() }),
        Transform::from_xyz(1.5, 1.6, 2.6).looking_at(Vec3::new(0.0, 0.8, 0.0), Vec3::Y),
    ));
    commands.spawn((
        Sun,
        DirectionalLight { illuminance: 9000.0, shadows_enabled: true, ..default() },
        Transform::from_xyz(2.5, 5.0, 3.0).looking_at(Vec3::ZERO, Vec3::Y),
        CascadeShadowConfigBuilder { first_cascade_far_bound: 4.0, maximum_distance: 20.0, ..default() }.build(),
    ));
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(30.0, 30.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.72, 0.75, 0.78),
            perceptual_roughness: 0.95,
            ..default()
        })),
    ));

    // Bevy's built-in font is ASCII only ("Alzák" needs more): use a system font when available.
    let font = system_font(&mut fonts).unwrap_or_default();
    let text_color = TextColor(Color::srgb(0.1, 0.12, 0.14));
    commands.spawn((
        Text::new(HELP),
        TextFont { font: font.clone(), font_size: 14.0, ..default() },
        text_color,
        Node { position_type: PositionType::Absolute, top: px(10), left: px(12), ..default() },
    ));
    commands.spawn((
        StatusText,
        Text::new("loading..."),
        TextFont { font, font_size: 17.0, ..default() },
        text_color,
        Node { position_type: PositionType::Absolute, bottom: px(12), left: px(12), ..default() },
    ));

    // Skeleton/selection gizmos draw on top of the meshes.
    gizmo_config.config_mut::<DefaultGizmoConfigGroup>().0.depth_bias = -1.0;
}

// ------------------------------------------------------------------ helpers

fn system_font(fonts: &mut Assets<Font>) -> Option<Handle<Font>> {
    const CANDIDATES: &[&str] = &[
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ];
    CANDIDATES
        .iter()
        .filter_map(|path| std::fs::read(path).ok())
        .find_map(|bytes| Font::try_from_bytes(bytes).ok())
        .map(|font| fonts.add(font))
}

fn active_entity(viewer: &Viewer) -> Entity {
    viewer.chars[viewer.active].1
}

fn select_head(viewer: &mut Viewer, rig: &RigCharacter) {
    viewer.bone_index = rig.bone_names.iter().position(|n| n == "head").unwrap_or(0);
}

// ------------------------------------------------------------------ systems

fn on_character_ready(
    mut viewer: ResMut<Viewer>,
    args: Res<Args>,
    mut ready: Query<(Entity, &mut RigCharacter), Added<RigCharacter>>,
) {
    for (entity, mut rig) in &mut ready {
        if entity != active_entity(&viewer) {
            continue;
        }
        viewer.distance = rig.meta.view.distance;
        select_head(&mut viewer, &rig);
        if !viewer.initial_poses_applied {
            for (bone, deg) in &args.poses {
                rig.set_override(bone, *deg);
            }
            viewer.initial_poses_applied = true;
        }
    }
}

fn keyboard_controls(
    keys: Res<ButtonInput<KeyCode>>,
    mut viewer: ResMut<Viewer>,
    mut rigs: Query<&mut RigCharacter>,
) {
    if keys.just_pressed(KeyCode::Space) {
        viewer.mode = if viewer.mode == Mode::Wander { Mode::Idle } else { Mode::Wander };
    }
    if keys.just_pressed(KeyCode::KeyK) {
        viewer.show_skeleton = !viewer.show_skeleton;
    }
    if keys.just_pressed(KeyCode::KeyE) {
        // Cycle idle -> extra states (anything besides idle/walk, e.g. "eat") -> idle.
        if let Ok(rig) = rigs.get(active_entity(&viewer)) {
            let mut extras: Vec<&String> =
                rig.meta.controller.states.keys().filter(|s| *s != "idle" && *s != "walk").collect();
            extras.sort();
            let current = extras.iter().position(|s| matches!(&viewer.mode, Mode::State(m) if m == *s));
            viewer.mode = match current.map_or(0, |i| i + 1) {
                i if i < extras.len() => Mode::State(extras[i].clone()),
                _ => Mode::Idle,
            };
        }
    }
    if keys.just_pressed(KeyCode::Tab) {
        if let Ok(mut rig) = rigs.get_mut(active_entity(&viewer)) {
            rig.set_state("idle");
        }
        viewer.active = (viewer.active + 1) % viewer.chars.len();
        if let Ok(rig) = rigs.get(active_entity(&viewer)) {
            viewer.distance = rig.meta.view.distance;
            select_head(&mut viewer, rig);
        }
    }
    let speed_delta = if keys.just_pressed(KeyCode::Minus) {
        -0.25
    } else if keys.just_pressed(KeyCode::Equal) {
        0.25
    } else {
        0.0
    };
    if speed_delta != 0.0 {
        for mut rig in &mut rigs {
            rig.speed = (rig.speed + speed_delta).clamp(0.0, 3.0);
        }
    }

    let Ok(mut rig) = rigs.get_mut(active_entity(&viewer)) else { return };
    let count = rig.bones.len().max(1);
    let shift = keys.any_pressed([KeyCode::ShiftLeft, KeyCode::ShiftRight]);
    if keys.just_pressed(KeyCode::KeyB) {
        viewer.bone_index = if shift { (viewer.bone_index + count - 1) % count } else { (viewer.bone_index + 1) % count };
    }
    if keys.just_pressed(KeyCode::KeyP) {
        rig.animate = !rig.animate;
    }
    if keys.just_pressed(KeyCode::Backspace) {
        rig.overrides.clear();
    }
    if keys.just_pressed(KeyCode::KeyR) {
        if let Some(name) = rig.bone_names.get(viewer.bone_index).cloned() {
            rig.set_override(&name, Vec3::ZERO);
        }
    }
}

fn posing(
    keys: Res<ButtonInput<KeyCode>>,
    time: Res<Time>,
    viewer: Res<Viewer>,
    mut rigs: Query<&mut RigCharacter>,
    bones: Query<&RigBone>,
) {
    let deltas = [
        (KeyCode::Digit1, Vec3::NEG_X),
        (KeyCode::Digit2, Vec3::X),
        (KeyCode::Digit3, Vec3::NEG_Y),
        (KeyCode::Digit4, Vec3::Y),
        (KeyCode::Digit5, Vec3::NEG_Z),
        (KeyCode::Digit6, Vec3::Z),
    ];
    let dir: Vec3 = deltas.iter().filter(|(k, _)| keys.pressed(*k)).map(|(_, d)| *d).sum();
    if dir == Vec3::ZERO {
        return;
    }
    let Ok(mut rig) = rigs.get_mut(active_entity(&viewer)) else { return };
    let Some(&bone_entity) = rig.bones.get(viewer.bone_index) else { return };
    let Ok(bone) = bones.get(bone_entity) else { return };
    let mut deg = rig.override_of(&bone.name) + dir * POSE_SPEED * time.delta_secs();
    if let Some(limits) = bone.limits {
        deg = limits.clamp(deg);
    }
    rig.set_override(&bone.name, deg);
}

fn locomotion(
    keys: Res<ButtonInput<KeyCode>>,
    time: Res<Time>,
    viewer: Res<Viewer>,
    camera: Query<&Transform, (With<Camera3d>, Without<Heading>)>,
    mut chars: Query<(Entity, &mut Transform, &mut Heading, &mut RigCharacter)>,
) {
    let dt = time.delta_secs();
    let Ok(cam) = camera.single() else { return };
    for (entity, mut transform, mut heading, mut rig) in &mut chars {
        if entity != active_entity(&viewer) {
            rig.set_state("idle");
            continue;
        }
        let speed = rig.walk_speed() * rig.speed;
        let axis = |pos: KeyCode, neg: KeyCode| keys.pressed(pos) as i32 as f32 - keys.pressed(neg) as i32 as f32;
        let input = Vec2::new(axis(KeyCode::ArrowRight, KeyCode::ArrowLeft), axis(KeyCode::ArrowUp, KeyCode::ArrowDown));

        let mut walking = false;
        let mut target = heading.0;
        if input != Vec2::ZERO {
            // Camera-relative movement on the ground plane.
            let fwd = (transform.translation - cam.translation).with_y(0.0).normalize_or_zero();
            let right = Vec3::new(-fwd.z, 0.0, fwd.x);
            let mv = fwd * input.y + right * input.x;
            target = mv.x.atan2(mv.z);
            walking = true;
        } else if viewer.mode == Mode::Wander {
            target = heading.0 + speed / WANDER_RADIUS * dt;
            walking = true;
        }

        // Turn along the shortest arc.
        let diff = (target - heading.0 + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI;
        heading.0 += diff * (rig.turn_speed() * dt).min(1.0);
        transform.rotation = Quat::from_rotation_y(heading.0);
        if walking {
            transform.translation += Vec3::new(heading.0.sin(), 0.0, heading.0.cos()) * speed * dt;
        }
        let state = match &viewer.mode {
            _ if walking => "walk".to_owned(),
            Mode::Walk => "walk".to_owned(),
            Mode::State(s) if rig.meta.controller.states.contains_key(s) => s.clone(),
            _ => "idle".to_owned(),
        };
        rig.set_state(&state);
    }
}

fn camera_control(
    mouse: Res<ButtonInput<MouseButton>>,
    motion: Res<AccumulatedMouseMotion>,
    scroll: Res<AccumulatedMouseScroll>,
    mut viewer: ResMut<Viewer>,
    chars: Query<(&Transform, Option<&RigCharacter>), (Without<Camera3d>, Without<Sun>)>,
    mut camera: Query<&mut Transform, (With<Camera3d>, Without<Sun>)>,
    mut sun: Query<&mut Transform, (With<Sun>, Without<Camera3d>)>,
) {
    if mouse.pressed(MouseButton::Left) {
        viewer.yaw -= motion.delta.x * 0.006;
        viewer.pitch = (viewer.pitch + motion.delta.y * 0.004).clamp(-0.08, 1.4);
    }
    if scroll.delta.y != 0.0 {
        viewer.distance = (viewer.distance * if scroll.delta.y > 0.0 { 0.9 } else { 1.1 }).clamp(0.8, 12.0);
    }

    let Ok((root, rig)) = chars.get(active_entity(&viewer)) else { return };
    let view_target = rig.map_or(Vec3::new(0.0, 0.8, 0.0), |r| Vec3::from_array(r.meta.view.target));
    let target = root.translation + view_target;
    let (yaw, pitch) = (viewer.yaw, viewer.pitch);
    let offset = Vec3::new(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos()) * viewer.distance;
    if let Ok(mut cam) = camera.single_mut() {
        *cam = Transform::from_translation(target + offset).looking_at(target, Vec3::Y);
    }
    if let Ok(mut sun) = sun.single_mut() {
        *sun = Transform::from_translation(root.translation + Vec3::new(2.5, 5.0, 3.0)).looking_at(root.translation, Vec3::Y);
    }
}

fn update_hud(viewer: Res<Viewer>, rigs: Query<&RigCharacter>, mut status: Query<&mut Text, With<StatusText>>) {
    let (Ok(rig), Ok(mut text)) = (rigs.get(active_entity(&viewer)), status.single_mut()) else { return };
    let bone = rig.bone_names.get(viewer.bone_index).map_or("-", String::as_str);
    let o = rig.override_of(bone);
    **text = format!(
        "{}  [{}]  speed {:.2}x{}    bone: {}  offset x{:.0} y{:.0} z{:.0}",
        rig.name(),
        rig.current_clip(),
        rig.speed,
        if rig.animate { "" } else { "  (rest pose)" },
        bone,
        o.x,
        o.y,
        o.z
    );
}

fn draw_overlay(
    mut gizmos: Gizmos,
    viewer: Res<Viewer>,
    rigs: Query<&RigCharacter>,
    bones: Query<(&GlobalTransform, &ChildOf), With<RigBone>>,
    globals: Query<&GlobalTransform>,
) {
    let Ok(rig) = rigs.get(active_entity(&viewer)) else { return };
    if viewer.show_skeleton {
        for &e in &rig.bones {
            let Ok((g, child_of)) = bones.get(e) else { continue };
            if bones.contains(child_of.parent()) {
                if let Ok(parent) = globals.get(child_of.parent()) {
                    gizmos.line(parent.translation(), g.translation(), Color::srgb(1.0, 0.24, 0.5));
                }
            }
        }
    }
    if let Some(Ok((g, _))) = rig.bones.get(viewer.bone_index).map(|&e| bones.get(e)) {
        gizmos.cross(Isometry3d::from_translation(g.translation()), 0.04, Color::srgb(0.0, 0.78, 1.0));
    }
}

fn screenshot_and_exit(
    mut commands: Commands,
    mut viewer: ResMut<Viewer>,
    args: Res<Args>,
    mut exit: MessageWriter<AppExit>,
) {
    viewer.frame += 1;
    let Some(path) = args.screenshot.clone() else { return };
    if viewer.frame == args.frames {
        commands.spawn(Screenshot::primary_window()).observe(save_to_disk(path));
    }
    if viewer.frame == args.frames + 15 {
        exit.write(AppExit::Success);
    }
}
