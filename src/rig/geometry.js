// Primitive shape factory: turns a part's "geometry" description into a THREE.BufferGeometry.
// All angles are in degrees, all distances in meters (model units).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const DEG = Math.PI / 180;

const factories = {
  sphere: (g) => new THREE.SphereGeometry(
    g.radius ?? 0.1,
    g.widthSegments ?? 28,
    g.heightSegments ?? 18,
    (g.phiStart ?? 0) * DEG,
    (g.phiLength ?? 360) * DEG,
    (g.thetaStart ?? 0) * DEG,
    (g.thetaLength ?? 180) * DEG,
  ),

  box: (g) => {
    const [x, y, z] = g.size ?? [0.1, 0.1, 0.1];
    return g.radius
      ? new RoundedBoxGeometry(x, y, z, g.segments ?? 3, g.radius)
      : new THREE.BoxGeometry(x, y, z);
  },

  cylinder: (g) => new THREE.CylinderGeometry(
    g.radiusTop ?? g.radius ?? 0.05,
    g.radiusBottom ?? g.radius ?? 0.05,
    g.height ?? 0.1,
    g.radialSegments ?? 24,
    1,
    g.openEnded ?? false,
  ),

  capsule: (g) => new THREE.CapsuleGeometry(
    g.radius ?? 0.05,
    g.length ?? 0.1,
    g.capSegments ?? 6,
    g.radialSegments ?? 16,
  ),

  cone: (g) => new THREE.ConeGeometry(
    g.radius ?? 0.05,
    g.height ?? 0.1,
    g.radialSegments ?? 16,
  ),

  torus: (g) => new THREE.TorusGeometry(
    g.radius ?? 0.1,
    g.tube ?? 0.02,
    g.radialSegments ?? 12,
    g.tubularSegments ?? 48,
    (g.arc ?? 360) * DEG,
  ),

  // Surface of revolution around the local Y axis. points: [[radius, y], ...] from bottom to top.
  lathe: (g) => new THREE.LatheGeometry(
    g.points.map(([r, y]) => new THREE.Vector2(r, y)),
    g.segments ?? 40,
    (g.phiStart ?? 0) * DEG,
    (g.phiLength ?? 360) * DEG,
  ),

  // Flat shape: a 2D outline in the XY plane extruded along Z (centered), with rounded edges.
  // Fins, tail lobes, ears, leaves, flat claws. points: [[x, y], ...]; smooth: spline through them.
  extrude: (g) => {
    const pts = g.points.map(([x, y]) => new THREE.Vector2(x, y));
    const shape = new THREE.Shape();
    if (g.smooth) {
      shape.moveTo(pts[0].x, pts[0].y);
      shape.splineThru([...pts.slice(1), pts[0]]);
    } else {
      shape.setFromPoints(pts);
    }
    const depth = g.depth ?? 0.02;
    const bevel = g.bevel ?? Math.min(0.01, depth / 2);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      steps: 1,
      curveSegments: g.curveSegments ?? 32,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: g.bevelSegments ?? 3,
    });
    geo.translate(0, 0, -depth / 2);
    return geo;
  },

  // Tube along a smooth curve whose radius tapers from radiusStart to radiusEnd (0 = sharp tip).
  // Claws, horns, curved teeth, spikes, tentacles. points: [[x, y, z], ...].
  horn: (g) => taperedTube(
    new THREE.CatmullRomCurve3(g.points.map((p) => new THREE.Vector3(...p))),
    g.radiusStart ?? g.radius ?? 0.02,
    g.radiusEnd ?? 0,
    g.tubularSegments ?? 24,
    g.radialSegments ?? 12,
    g.taper ?? 1,
  ),

  // Smooth tube through 3D points (eyebrows, mouths, glyphs, antennae...).
  tube: (g) => new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(g.points.map((p) => new THREE.Vector3(...p)), g.closed ?? false),
    g.tubularSegments ?? 32,
    g.radius ?? 0.01,
    g.radialSegments ?? 8,
    g.closed ?? false,
  ),
};

/** Tube along `curve` with radius r0 -> r1 (radius(t) = r0 + (r1 - r0) * t^taper), capped ends. */
function taperedTube(curve, r0, r1, segments, radial, taper) {
  const frames = curve.computeFrenetFrames(segments, false);
  const positions = [];
  const normals = [];
  const indices = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, p);
    const r = r0 + (r1 - r0) * t ** taper;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      n.copy(frames.normals[i]).multiplyScalar(-Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a)).normalize();
      positions.push(p.x + r * n.x, p.y + r * n.y, p.z + r * n.z);
      normals.push(n.x, n.y, n.z);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // Flat caps for blunt ends (a zero radius already closes to a point).
  const cap = (t, r, ring, outward) => {
    if (r <= 0) return;
    curve.getPointAt(t, p);
    const tangent = frames.tangents[t === 0 ? 0 : segments].clone().multiplyScalar(outward);
    const center = positions.length / 3;
    positions.push(p.x, p.y, p.z);
    normals.push(tangent.x, tangent.y, tangent.z);
    for (let j = 0; j <= radial; j++) {
      const k = (ring * (radial + 1) + j) * 3;
      positions.push(positions[k], positions[k + 1], positions[k + 2]);
      normals.push(tangent.x, tangent.y, tangent.z);
    }
    for (let j = 0; j < radial; j++) {
      if (outward < 0) indices.push(center, center + 1 + j, center + 2 + j);
      else indices.push(center, center + 2 + j, center + 1 + j);
    }
  };
  cap(0, r0, 0, -1);
  cap(1, r1, segments, 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

export const GEOMETRY_TYPES = Object.keys(factories);

export function createGeometry(desc) {
  const make = factories[desc?.type];
  if (!make) throw new Error(`Unknown geometry type "${desc?.type}" (known: ${GEOMETRY_TYPES.join(', ')})`);
  const geo = make(desc);
  geo.normalizeNormals(); // some generators emit non-unit normals; glTF requires unit length
  return geo;
}
