// Exports a character (rest pose) plus its baked clips as a binary glTF (GLB).
// Bones become glTF nodes (extras.bone = true), parts become meshes under them,
// clips become glTF animations, and the character metadata ends up in the root node's extras.
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export async function exportGLB(root, clips) {
  const exporter = new GLTFExporter();
  // trs: animated nodes must use translation/rotation/scale instead of a matrix (glTF spec).
  return exporter.parseAsync(root, { binary: true, trs: true, onlyVisible: false, animations: clips });
}
