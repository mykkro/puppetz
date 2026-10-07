"""Play the rig animations of our character GLBs in Panda3D.

panda3d-gltf loads the geometry and keeps every glTF node (bones and parts) as a named
NodePath, converting glTF's Y-up space to Panda's Z-up. It does not play animations of
plain (non-skinned) nodes, though, which is exactly what our rigid rigs use. This module
reads the animation channels and the character metadata straight from the GLB and drives
the bone NodePaths itself:

    model = base.loader.load_model("models/chicken/chicken.glb")
    rig = RigPlayer("models/chicken/chicken.glb", model)
    rig.set_state("walk")                         # crossfades from idle
    rig.set_override("head", (0, 30, 10))         # manual pose on top of the animation
    rig.update(dt)                                # every frame

All maths happens in glTF space (Y up, character faces +Z, its left is +X). The result
is converted to Panda space only when it is written to the nodes.
"""
from __future__ import annotations

import bisect
import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path

from panda3d.core import NodePath, Quat

Vec3 = tuple[float, float, float]
Quat4 = tuple[float, float, float, float]  # glTF order: x, y, z, w

# ---------------------------------------------------------------- GLB reading

_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
_FLOAT = 5126


def read_glb(path: str | Path) -> tuple[dict, bytes]:
    """Returns (gltf JSON document, binary chunk)."""
    data = Path(path).read_bytes()
    magic, _version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError(f"{path} is not a GLB file")
    doc, binary, offset = None, b"", 12
    while offset < length:
        chunk_len, chunk_type = struct.unpack_from("<I4s", data, offset)
        chunk = data[offset + 8: offset + 8 + chunk_len]
        if chunk_type == b"JSON":
            doc = json.loads(chunk)
        elif chunk_type == b"BIN\0":
            binary = chunk
        offset += 8 + chunk_len
    if doc is None:
        raise ValueError(f"{path} has no JSON chunk")
    return doc, binary


def read_accessor(doc: dict, binary: bytes, index: int) -> list[tuple[float, ...]]:
    acc = doc["accessors"][index]
    if acc["componentType"] != _FLOAT:
        raise ValueError("only float animation data is supported")
    view = doc["bufferViews"][acc["bufferView"]]
    n = _COMPONENTS[acc["type"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride", 4 * n)
    fmt = f"<{n}f"
    return [struct.unpack_from(fmt, binary, start + i * stride) for i in range(acc["count"])]


# ---------------------------------------------------------------- math helpers (glTF space)

def lerp3(a: Vec3, b: Vec3, t: float) -> Vec3:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def nlerp(a: Quat4, b: Quat4, t: float) -> Quat4:
    """Normalized lerp along the shortest arc. Close enough to slerp for 30 fps keys and crossfades."""
    if a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0:
        b = (-b[0], -b[1], -b[2], -b[3])
    q = tuple(a[i] + (b[i] - a[i]) * t for i in range(4))
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return (q[0] / n, q[1] / n, q[2] / n, q[3] / n)


def qmul(a: Quat4, b: Quat4) -> Quat4:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def euler_xyz_deg_to_quat(x: float, y: float, z: float) -> Quat4:
    """Same convention as three.js Euler order 'XYZ' (used by the JSON format and the web viewer)."""
    x, y, z = (math.radians(v) / 2 for v in (x, y, z))
    c1, c2, c3 = math.cos(x), math.cos(y), math.cos(z)
    s1, s2, s3 = math.sin(x), math.sin(y), math.sin(z)
    return (
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    )


# glTF (x, y, z) -> Panda (x, -z, y); the same basis change panda3d-gltf applies to the nodes.
def to_panda_pos(v: Vec3) -> tuple[float, float, float]:
    return (v[0], -v[2], v[1])


def to_panda_quat(q: Quat4) -> Quat:
    return Quat(q[3], q[0], -q[2], q[1])


def to_panda_scale(s: Vec3) -> tuple[float, float, float]:
    return (s[0], s[2], s[1])


# ---------------------------------------------------------------- clips

@dataclass
class Channel:
    node: str
    path: str  # "translation" | "rotation" | "scale"
    times: list[float]
    values: list[tuple[float, ...]]
    interpolation: str

    def sample(self, t: float) -> tuple[float, ...]:
        times, values = self.times, self.values
        if t <= times[0]:
            return values[0]
        if t >= times[-1]:
            return values[-1]
        i = bisect.bisect_right(times, t) - 1
        if self.interpolation == "STEP":
            return values[i]
        s = (t - times[i]) / (times[i + 1] - times[i])
        if self.path == "rotation":
            return nlerp(values[i], values[i + 1], s)
        return lerp3(values[i], values[i + 1], s)


@dataclass
class Clip:
    name: str
    duration: float
    channels: list[Channel]
    loop: bool = True
    layer: str = "base"

    def sample(self, t: float) -> dict[tuple[str, str], tuple[float, ...]]:
        return {(c.node, c.path): c.sample(t) for c in self.channels}


# ---------------------------------------------------------------- player

@dataclass
class _Rest:
    translation: Vec3
    rotation: Quat4
    scale: Vec3


@dataclass
class RigPlayer:
    glb_path: str | Path
    model: NodePath
    speed: float = 1.0
    animate: bool = True

    meta: dict = field(init=False)
    bones: list[str] = field(init=False)
    limits: dict[str, dict] = field(init=False)
    clips: dict[str, Clip] = field(init=False)
    overrides: dict[str, Vec3] = field(init=False, default_factory=dict)

    def __post_init__(self) -> None:
        doc, binary = read_glb(self.glb_path)
        nodes = doc.get("nodes", [])

        self.meta = next((n["extras"]["character"] for n in nodes if "character" in n.get("extras", {})), {})
        bone_defs = [n for n in nodes if n.get("extras", {}).get("bone")]
        if not bone_defs:  # foreign GLB: treat every animated node as a bone
            animated = {ch["target"]["node"] for a in doc.get("animations", []) for ch in a["channels"]}
            bone_defs = [nodes[i] for i in sorted(animated)]
        self.bones = [n["name"] for n in bone_defs]
        self.limits = {n["name"]: n["extras"]["limits"] for n in bone_defs if "limits" in n.get("extras", {})}

        self._np: dict[str, NodePath] = {}
        self._rest: dict[str, _Rest] = {}
        for n in bone_defs:
            np_ = self.model.find(f"**/{n['name']}")
            if np_.is_empty():
                raise ValueError(f"bone node {n['name']!r} not found in the loaded model")
            self._np[n["name"]] = np_
            self._rest[n["name"]] = _Rest(
                tuple(n.get("translation", (0, 0, 0))),
                tuple(n.get("rotation", (0, 0, 0, 1))),
                tuple(n.get("scale", (1, 1, 1))),
            )

        clip_cfg = self.meta.get("clips", {})
        self.clips = {}
        for anim in doc.get("animations", []):
            channels = []
            for ch in anim["channels"]:
                sampler = anim["samplers"][ch["sampler"]]
                if sampler.get("interpolation", "LINEAR") == "CUBICSPLINE":
                    raise ValueError("CUBICSPLINE animation is not supported by this example")
                name = nodes[ch["target"]["node"]]["name"]
                if name not in self._np:
                    continue
                channels.append(Channel(
                    node=name,
                    path=ch["target"]["path"],
                    times=[t[0] for t in read_accessor(doc, binary, sampler["input"])],
                    values=read_accessor(doc, binary, sampler["output"]),
                    interpolation=sampler.get("interpolation", "LINEAR"),
                ))
            cfg = clip_cfg.get(anim.get("name", ""), {})
            duration = max((c.times[-1] for c in channels), default=0.0)
            name = anim.get("name") or f"clip{len(self.clips)}"
            self.clips[name] = Clip(name, duration, channels, cfg.get("loop", True), cfg.get("layer", "base"))

        ctl = self.meta.get("controller", {})
        self.states: dict[str, str] = dict(ctl.get("states", {}))
        self.states.setdefault("idle", next((n for n in self.clips if "idle" in n.lower()), next(iter(self.clips), "")))
        self.states.setdefault("walk", next((n for n in self.clips if "walk" in n.lower()), ""))
        self.overlays: list[str] = ctl.get("overlays", [n for n, c in self.clips.items() if c.layer == "overlay"])
        self.crossfade: float = ctl.get("crossfade", 0.25)
        self.walk_speed: float = ctl.get("walkSpeed", 0.8)
        self.turn_speed: float = ctl.get("turnSpeed", 8.0)
        self.view: dict = self.meta.get("view", {})

        self._time: dict[str, float] = {name: 0.0 for name in self.clips}
        self.state = ""
        self.current = ""
        self._previous = ""
        self._fade_total = 0.0
        self._fade_left = 0.0
        self.set_state("idle", 0)

    # -------------------------------------------------------- control

    @property
    def name(self) -> str:
        return self.meta.get("name", Path(self.glb_path).stem)

    def set_state(self, state: str, fade: float | None = None) -> None:
        """state: a key of controller.states ('idle', 'walk', ...) or a raw clip name."""
        self.state = state
        clip = self.states.get(state, state)
        if clip not in self.clips or clip == self.current:
            return
        fade = self.crossfade if fade is None else fade
        self._previous = self.current if fade > 0 else ""
        self._fade_total = self._fade_left = fade if self._previous else 0.0
        self.current = clip
        self._time[clip] = 0.0

    def set_override(self, bone: str, euler_deg: Vec3 | None) -> None:
        """Extra local rotation (degrees, XYZ, glTF axes) applied on top of the animation."""
        if not euler_deg or not any(euler_deg):
            self.overrides.pop(bone, None)
        else:
            self.overrides[bone] = tuple(euler_deg)

    def clamp_to_limits(self, bone: str, euler_deg: Vec3) -> Vec3:
        lim = self.limits.get(bone)
        if not lim:
            return euler_deg
        return tuple(  # type: ignore[return-value]
            min(max(v, lim[ax][0]), lim[ax][1]) if ax in lim else v
            for v, ax in zip(euler_deg, "xyz")
        )

    def bone_node(self, bone: str) -> NodePath:
        return self._np[bone]

    # -------------------------------------------------------- per frame

    def _advance(self, clip: str, dt: float) -> float:
        c = self.clips[clip]
        t = self._time[clip] + dt
        if c.duration > 0:
            t = t % c.duration if c.loop else min(t, c.duration)
        self._time[clip] = t
        return t

    def update(self, dt: float) -> None:
        dt *= self.speed
        pose: dict[tuple[str, str], tuple[float, ...]] = {}

        if self.animate and self.current:
            cur = self.clips[self.current].sample(self._advance(self.current, dt))
            if self._previous and self._fade_left > 0:
                self._fade_left = max(0.0, self._fade_left - dt)
                w = 1.0 - self._fade_left / self._fade_total
                prev = self.clips[self._previous].sample(self._advance(self._previous, dt))
                for key in cur.keys() | prev.keys():
                    a = prev.get(key) or self._rest_value(*key)
                    b = cur.get(key) or self._rest_value(*key)
                    pose[key] = nlerp(a, b, w) if key[1] == "rotation" else lerp3(a, b, w)
                if self._fade_left == 0:
                    self._previous = ""
            else:
                pose.update(cur)
            for name in self.overlays:
                if name in self.clips:
                    pose.update(self.clips[name].sample(self._advance(name, dt)))

        # Every bone is rebuilt from rest each frame, so channels a clip doesn't drive fall back to rest.
        for bone, np_ in self._np.items():
            rest = self._rest[bone]
            t = pose.get((bone, "translation"), rest.translation)
            r = pose.get((bone, "rotation"), rest.rotation)
            s = pose.get((bone, "scale"), rest.scale)
            if bone in self.overrides:
                r = qmul(r, euler_xyz_deg_to_quat(*self.overrides[bone]))
            np_.set_pos(*to_panda_pos(t))
            np_.set_quat(to_panda_quat(r))
            np_.set_scale(*to_panda_scale(s))

    def _rest_value(self, bone: str, path: str) -> tuple[float, ...]:
        return getattr(self._rest[bone], path)
