// Builds models/<id>/<id>.glb from every JSON character listed in models/index.json.
// Usage: npm run build:glb            (all models)
//        npm run build:glb -- chicken (only the given ids)
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GLTFExporter reads its output Blob through FileReader, which Node does not have.
globalThis.FileReader ??= class FileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onload?.({ target: this }); this.onloadend?.({ target: this }); });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
      this.onload?.({ target: this });
      this.onloadend?.({ target: this });
    });
  }
};

const { buildCharacter } = await import('../src/rig/character.js');
const { exportGLB } = await import('../src/rig/exportGLB.js');

const modelsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');
const index = JSON.parse(await readFile(join(modelsDir, 'index.json'), 'utf8'));
const only = process.argv.slice(2);

let failed = false;
for (const entry of index.models) {
  if (only.length && !only.includes(entry.id)) continue;
  try {
    const def = JSON.parse((await readFile(join(modelsDir, entry.json), 'utf8')).replace(/^﻿/, ''));
    const { root, bones, clips } = buildCharacter(def);
    const glb = await exportGLB(root, clips);
    const out = join(modelsDir, entry.glb);
    await writeFile(out, Buffer.from(glb));
    let meshes = 0;
    root.traverse((o) => { if (o.isMesh) meshes++; });
    console.log(`✔ ${entry.id}: ${bones.size} bones, ${meshes} parts, clips [${clips.map((c) => c.name).join(', ')}] -> ${entry.glb} (${(glb.byteLength / 1024).toFixed(0)} KB)`);
  } catch (err) {
    failed = true;
    console.error(`✘ ${entry.id}: ${err.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
