"""Panda3D example: load every character GLB from models/index.json, animate it and pose its rig.

    python viewer.py                       # interactive
    python viewer.py --active chicken --mode wander
    python viewer.py --screenshot shot.png --frames 120   # render offscreen, save, exit

Keys
    arrows        walk the active character (camera relative)
    space         toggle wander (walk in a circle)
    e             cycle extra states of the character (e.g. eat)
    tab           switch active character
    1-6           rotate selected bone  X- X+ Y- Y+ Z- Z+   (hold; respects joint limits)
    b / shift+b   next / previous bone
    r / backspace reset selected bone / all bones
    p             toggle clips (off = rest pose, handy for posing)
    k             toggle skeleton overlay
    - / =         playback speed
    mouse drag    orbit, wheel = zoom
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from panda3d.core import (
    AmbientLight, CardMaker, ClockObject, DirectionalLight, Filename, LineSegs, Material,
    NodePath, TextNode, Vec3, loadPrcFileData,
)

from glb_rig import RigPlayer

REPO = Path(__file__).resolve().parents[2]
MODELS = REPO / "models"

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--active", help="id of the character to control (default: first in index.json)")
parser.add_argument("--mode", default="idle", help="idle, walk, wander or any state of the character (e.g. eat)")
parser.add_argument("--screenshot", help="render offscreen, save this PNG and exit")
parser.add_argument("--frames", type=int, default=90, help="frames to simulate before --screenshot (60 fps)")
parser.add_argument("--pose", action="append", default=[], metavar="BONE:X,Y,Z",
                    help="manual rotation offset (degrees) for a bone of the active character; repeatable")
args = parser.parse_args()

loadPrcFileData("", """
window-title Puppetz Viewer (Panda3D)
win-size 1280 800
sync-video true
framebuffer-multisample 1
multisamples 4
""")
if args.screenshot:
    loadPrcFileData("", "window-type offscreen\naudio-library-name null")

# Imported after the prc settings so they apply to the window.
from direct.gui.OnscreenText import OnscreenText  # noqa: E402
from direct.showbase.ShowBase import ShowBase  # noqa: E402
import simplepbr  # noqa: E402

WANDER_RADIUS = 1.6
POSE_SPEED = 90.0  # degrees per second while a pose key is held


class Character:
    def __init__(self, base: ShowBase, entry: dict, x: float):
        glb = MODELS / entry["glb"]
        if not glb.exists():
            raise SystemExit(f"{glb} is missing - run `npm run build:glb` in the repo root first")
        self.id = entry["id"]
        self.holder = base.render.attach_new_node(f"{self.id}-holder")  # moved/turned by locomotion
        self.holder.set_pos(x, 0, 0)
        self.model = base.loader.load_model(Filename.from_os_specific(str(glb)))
        self.model.reparent_to(self.holder)
        self.rig = RigPlayer(glb, self.model)
        self.heading = 0.0  # degrees; 0 = facing -Y (towards the default camera)

    @property
    def target(self) -> Vec3:
        # view.target is in glTF space (y up) -> Panda z up.
        tx, ty, tz = self.rig.view.get("target", (0, 0.8, 0))
        return self.holder.get_pos() + Vec3(tx, -tz, ty)


class Viewer(ShowBase):
    def __init__(self) -> None:
        super().__init__()
        self.disable_mouse()
        self.camLens.set_min_fov(40)  # 40 deg vertically on landscape windows, like the web viewer
        simplepbr.init(enable_shadows=True, msaa_samples=0 if args.screenshot else 4, exposure=0.6)
        self.set_background_color(0.85, 0.87, 0.89, 1)

        self._setup_world()

        index = json.loads((MODELS / "index.json").read_text(encoding="utf-8"))
        entries = index["models"]
        spacing = 1.4
        self.chars = [Character(self, e, (i - (len(entries) - 1) / 2) * spacing) for i, e in enumerate(entries)]
        ids = [c.id for c in self.chars]
        self.active = ids.index(args.active) if args.active in ids else 0
        self.mode = args.mode
        self.bone_index = 0
        self.show_skeleton = False

        # Orbit camera around the active character.
        self.cam_heading, self.cam_pitch = 25.0, 12.0
        self.cam_dist = self.char.rig.view.get("distance", 3.0)
        self._drag_from = None

        self.help = OnscreenText(text=__doc__.split("Keys", 1)[1].strip("\n"), parent=self.a2dTopLeft,
                                 pos=(0.05, -0.06), scale=0.034, align=TextNode.A_left, fg=(0.1, 0.12, 0.14, 1),
                                 mayChange=False)
        self.status = OnscreenText(text="", parent=self.a2dBottomLeft, pos=(0.05, 0.08), scale=0.05,
                                   align=TextNode.A_left, fg=(0.1, 0.12, 0.14, 1), mayChange=True)
        self.overlay = self.render.attach_new_node("overlay")
        self.overlay.set_shader_off(1)
        self.overlay.set_light_off(1)
        self.overlay.set_depth_test(False)
        self.overlay.set_depth_write(False)
        self.overlay.set_bin("fixed", 100)

        self._bind_keys()
        self.task_mgr.add(self._update, "update")
        self._select_bone(self.char.rig.bones.index("head") if "head" in self.char.rig.bones else 0)
        for spec in args.pose:
            bone, _, values = spec.partition(":")
            self.char.rig.set_override(bone, tuple(float(v) for v in values.split(",")))

    # ------------------------------------------------------------ setup

    def _setup_world(self) -> None:
        cm = CardMaker("ground")
        cm.set_frame(-15, 15, -15, 15)
        ground = self.render.attach_new_node(cm.generate())
        ground.set_p(-90)
        mat = Material("ground")
        mat.set_base_color((0.72, 0.75, 0.78, 1))
        mat.set_roughness(0.95)
        mat.set_metallic(0.0)
        ground.set_material(mat)

        amb = AmbientLight("ambient")
        amb.set_color((0.55, 0.55, 0.6, 1))
        self.render.set_light(self.render.attach_new_node(amb))

        sun = DirectionalLight("sun")
        sun.set_color((2.6, 2.45, 2.25, 1))
        sun.set_shadow_caster(True, 2048, 2048)
        lens = sun.get_lens()
        lens.set_film_size(7, 7)
        lens.set_near_far(1, 20)
        self.sun = self.render.attach_new_node(sun)
        self.render.set_light(self.sun)

    def _bind_keys(self) -> None:
        self.keys: set[str] = set()
        for k in ["arrow_up", "arrow_down", "arrow_left", "arrow_right", "1", "2", "3", "4", "5", "6"]:
            self.accept(k, self.keys.add, [k])
            self.accept(f"{k}-up", self.keys.discard, [k])
        self.accept("space", self._toggle_wander)
        self.accept("e", self._next_extra_state)
        self.accept("tab", self._next_character)
        self.accept("b", lambda: self._select_bone(self.bone_index + 1))
        self.accept("shift-b", lambda: self._select_bone(self.bone_index - 1))
        self.accept("r", lambda: self.char.rig.set_override(self.bone, None))
        self.accept("backspace", lambda: self.char.rig.overrides.clear())
        self.accept("p", self._toggle_animate)
        self.accept("k", self._toggle_skeleton)
        self.accept("-", self._change_speed, [-0.25])
        self.accept("=", self._change_speed, [0.25])
        self.accept("mouse1", self._start_drag)
        self.accept("mouse1-up", self._stop_drag)
        self.accept("wheel_up", self._zoom, [0.9])
        self.accept("wheel_down", self._zoom, [1.1])
        self.accept("escape", self.userExit)

    # ------------------------------------------------------------ actions

    @property
    def char(self) -> Character:
        return self.chars[self.active]

    @property
    def bone(self) -> str:
        return self.char.rig.bones[self.bone_index]

    def _next_extra_state(self) -> None:
        """Cycles idle -> extra states (states other than idle/walk, e.g. "eat") -> idle."""
        extras = [s for s in self.char.rig.states if s not in ("idle", "walk") and self.char.rig.states[s] in self.char.rig.clips]
        cycle = ["idle", *extras]
        self.mode = cycle[(cycle.index(self.mode) + 1) % len(cycle)] if self.mode in cycle else cycle[min(1, len(cycle) - 1)]

    def _toggle_wander(self) -> None:
        self.mode = "idle" if self.mode == "wander" else "wander"

    def _next_character(self) -> None:
        self.char.rig.set_state("idle")
        self.active = (self.active + 1) % len(self.chars)
        self.cam_dist = self.char.rig.view.get("distance", 3.0)
        self._select_bone(self.char.rig.bones.index("head") if "head" in self.char.rig.bones else 0)

    def _select_bone(self, i: int) -> None:
        self.bone_index = i % len(self.char.rig.bones)

    def _toggle_animate(self) -> None:
        rig = self.char.rig
        rig.animate = not rig.animate

    def _toggle_skeleton(self) -> None:
        self.show_skeleton = not self.show_skeleton

    def _change_speed(self, delta: float) -> None:
        for c in self.chars:
            c.rig.speed = min(3.0, max(0.0, c.rig.speed + delta))

    def _start_drag(self) -> None:
        if self.mouseWatcherNode.has_mouse():
            m = self.mouseWatcherNode.get_mouse()
            self._drag_from = (m.x, m.y, self.cam_heading, self.cam_pitch)

    def _stop_drag(self) -> None:
        self._drag_from = None

    def _zoom(self, factor: float) -> None:
        self.cam_dist = min(12.0, max(0.8, self.cam_dist * factor))

    # ------------------------------------------------------------ per frame

    def _update(self, task):
        dt = min(ClockObject.get_global_clock().get_dt(), 0.1)
        self._update_camera_input()
        self._update_locomotion(dt)
        self._update_posing(dt)
        for c in self.chars:
            c.rig.update(dt)
        self._update_camera()
        self._draw_overlay()
        rig = self.char.rig
        pose = rig.overrides.get(self.bone, (0, 0, 0))
        self.status.text = (f"{rig.name}  [{rig.current}]  speed {rig.speed:.2f}x"
                            f"{'' if rig.animate else '  (rest pose)'}    "
                            f"bone: {self.bone}  offset x{pose[0]:.0f} y{pose[1]:.0f} z{pose[2]:.0f}")
        return task.cont

    def _update_locomotion(self, dt: float) -> None:
        c = self.char
        rig = c.rig
        speed = rig.walk_speed * rig.speed
        ix = ("arrow_right" in self.keys) - ("arrow_left" in self.keys)
        iy = ("arrow_up" in self.keys) - ("arrow_down" in self.keys)

        walking = False
        target = c.heading
        if ix or iy:
            # Camera-relative direction on the ground plane.
            fwd = c.target - self.camera.get_pos()
            fwd.z = 0
            fwd.normalize()
            right = Vec3(fwd.y, -fwd.x, 0)
            move = fwd * iy + right * ix
            # Panda heading h turns local -Y (the character's front) to (sin h, -cos h).
            target = math.degrees(math.atan2(move.x, -move.y))
            walking = True
        elif self.mode == "wander":
            target = c.heading + math.degrees(speed / WANDER_RADIUS) * dt
            walking = True

        diff = (target - c.heading + 180) % 360 - 180
        c.heading += diff * min(1.0, rig.turn_speed * dt)
        c.holder.set_h(c.heading)
        if walking:
            h = math.radians(c.heading)
            c.holder.set_pos(c.holder.get_pos() + Vec3(math.sin(h), -math.cos(h), 0) * speed * dt)
        extra = self.mode if self.mode not in ("wander", "walk") and self.mode in rig.states else "idle"
        rig.set_state("walk" if walking or self.mode == "walk" else extra)

    def _update_posing(self, dt: float) -> None:
        deltas = {"1": (0, -1), "2": (0, 1), "3": (1, -1), "4": (1, 1), "5": (2, -1), "6": (2, 1)}
        held = [deltas[k] for k in self.keys if k in deltas]
        if not held:
            return
        rig = self.char.rig
        e = list(rig.overrides.get(self.bone, (0, 0, 0)))
        for axis, sign in held:
            e[axis] += sign * POSE_SPEED * dt
        rig.set_override(self.bone, rig.clamp_to_limits(self.bone, tuple(e)))

    def _update_camera_input(self) -> None:
        if self._drag_from and self.mouseWatcherNode.has_mouse():
            m = self.mouseWatcherNode.get_mouse()
            x0, y0, h0, p0 = self._drag_from
            self.cam_heading = h0 - (m.x - x0) * 180
            self.cam_pitch = min(80.0, max(-5.0, p0 + (m.y - y0) * 90))

    def _update_camera(self) -> None:
        target = self.char.target
        h, p = math.radians(self.cam_heading), math.radians(self.cam_pitch)
        offset = Vec3(math.sin(h) * math.cos(p), -math.cos(h) * math.cos(p), math.sin(p)) * self.cam_dist
        self.camera.set_pos(target + offset)
        self.camera.look_at(target)
        hp = self.char.holder.get_pos()
        self.sun.set_pos(hp + Vec3(2.5, -3, 5))
        self.sun.look_at(hp)

    def _draw_overlay(self) -> None:
        self.overlay.node().remove_all_children()
        rig = self.char.rig
        ls = LineSegs("overlay")
        ls.set_thickness(2)
        if self.show_skeleton:
            bones = set(rig.bones)
            ls.set_color(1, 0.24, 0.5, 1)
            for name in rig.bones:
                np_ = rig.bone_node(name)
                parent = np_.get_parent()
                if parent.get_name() in bones:
                    ls.move_to(parent.get_pos(self.render))
                    ls.draw_to(np_.get_pos(self.render))
        # Selected joint: small cross.
        p = rig.bone_node(self.bone).get_pos(self.render)
        ls.set_color(0, 0.78, 1, 1)
        for axis in (Vec3(0.04, 0, 0), Vec3(0, 0.04, 0), Vec3(0, 0, 0.04)):
            ls.move_to(p - axis)
            ls.draw_to(p + axis)
        self.overlay.attach_new_node(ls.create())


def main() -> None:
    app = Viewer()
    if not args.screenshot:
        app.run()
        return
    clock = ClockObject.get_global_clock()
    clock.set_mode(ClockObject.M_non_real_time)  # fixed 1/60 s steps -> deterministic output
    clock.set_frame_rate(60)
    for _ in range(args.frames):
        app.task_mgr.step()
    out = Path(args.screenshot).resolve()
    app.win.save_screenshot(Filename.from_os_specific(str(out)))
    print(f"saved {out}")


if __name__ == "__main__":
    main()
