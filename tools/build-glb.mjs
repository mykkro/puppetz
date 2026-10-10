// Builds models/<id>/<id>.glb from every JSON character listed in models/index.json.
// Usage: npm run build:glb            (all models)
//        npm run build:glb -- chicken (only the given ids)
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

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

// GLTFExporter draws textures into a canvas and encodes it as PNG. Node has no canvas, so this
// stand-in supports exactly what the exporter does with our DataTextures: putImageData (with an
// optional vertical flip) and convertToBlob('image/png').
globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
globalThis.OffscreenCanvas ??= class OffscreenCanvas {
  constructor(width, height) { this.width = width; this.height = height; this.flip = false; }
  getContext() {
    const canvas = this;
    return {
      translate() {},
      scale(_x, y) { canvas.flip = y < 0; },
      putImageData(img) { canvas.pixels = img; },
      drawImage() { throw new Error('build-glb: only DataTexture images are supported in Node'); },
    };
  }
  async convertToBlob() {
    const { width, height, data } = this.pixels;
    return new Blob([encodePNG(width, height, data, this.flip)], { type: 'image/png' });
  }
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function encodePNG(width, height, rgba, flip) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = flip ? height - 1 - y : y;
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + src * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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
