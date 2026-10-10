// Character generators: a character file may be a short recipe ({ "generator": "humanoid", ... })
// instead of a full rig. expandGenerator() turns it into an ordinary character definition, so the
// builder, the viewer and the GLB tool treat both kinds of file the same way.
import { generateHumanoid } from './humanoid.js';

export const GENERATORS = { humanoid: generateHumanoid };

export function expandGenerator(def) {
  if (!def?.generator) return def;
  const generate = GENERATORS[def.generator];
  if (!generate) throw new Error(`Unknown generator "${def.generator}" (known: ${Object.keys(GENERATORS).join(', ')})`);
  return generate(def);
}
