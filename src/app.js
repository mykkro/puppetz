import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildCharacter } from './rig/character.js';
import { RigController, findCharacterRoot } from './rig/controller.js';
import { exportGLB } from './rig/exportGLB.js';
import { BODY_OPTIONS, BODY_DEFAULTS, SKIN_TONES, HAIR_COLORS, SLOTS, itemsForSlot, resolveEquip } from './rig/humanoid.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
scene.background = new THREE.Color(dark ? '#1b1f24' : '#d9dde2');
scene.fog = new THREE.Fog(scene.background, 8, 22);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.7;

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 0.8;
controls.maxDistance = 12;

scene.add(new THREE.HemisphereLight('#ffffff', '#7a6f60', 0.9));
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.position.set(2.5, 5, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -3;
sun.shadow.camera.right = sun.shadow.camera.top = 3;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(30, 64),
  new THREE.MeshStandardMaterial({ color: dark ? '#2a3038' : '#c3c9cf', roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(30, 60, dark ? '#3c454f' : '#aab1b9', dark ? '#3c454f' : '#aab1b9');
grid.material.transparent = true;
grid.material.opacity = 0.35;
grid.position.y = 0.001;
scene.add(grid);

// The holder is what locomotion moves/turns, so clips can freely animate the character's own nodes.
const holder = new THREE.Group();
scene.add(holder);

// ------------------------------------------------------------------ skeleton overlay

const overlayMat = { depthTest: false, transparent: true };
const skelLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#ff3d7f', ...overlayMat }));
const skelJoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: '#ffd23d', size: 7, sizeAttenuation: false, ...overlayMat }));
const selMarker = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 12), new THREE.MeshBasicMaterial({ color: '#00c8ff', ...overlayMat }));
for (const o of [skelLines, skelJoints, selMarker]) { o.renderOrder = 999; o.frustumCulled = false; scene.add(o); }

function updateOverlay() {
  const ctl = state.controller;
  selMarker.visible = !!state.selected && !document.body.classList.contains('clean');
  if (state.selected) state.selected.getWorldPosition(selMarker.position);
  const show = $('showSkeleton').checked && ctl;
  skelLines.visible = skelJoints.visible = !!show;
  if (!show) return;
  const boneSet = new Set(ctl.bones);
  const lines = [];
  const joints = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (const bone of ctl.bones) {
    bone.getWorldPosition(a);
    joints.push(a.x, a.y, a.z);
    if (boneSet.has(bone.parent)) {
      bone.parent.getWorldPosition(b);
      lines.push(b.x, b.y, b.z, a.x, a.y, a.z);
    }
  }
  skelLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  skelJoints.geometry.setAttribute('position', new THREE.Float32BufferAttribute(joints, 3));
}

// ------------------------------------------------------------------ model loading

const loader = new GLTFLoader();
const state = {
  index: null, entry: null, source: 'json', def: null, glbBuffer: null,
  model: null, controller: null, meta: null, selected: null,
  mode: 'idle', heading: 0, moving: false, expression: params.get('expr'),
};

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
  if (isError) setPanelOpen($('left'), true); // don't hide errors inside a collapsed panel
}

// ------------------------------------------------------------------ panels

const phone = matchMedia('(max-width: 640px)');

function setPanelOpen(panel, open) {
  panel.classList.toggle('collapsed', !open);
  panel.querySelector('.toggle').setAttribute('aria-expanded', open);
  // On phones only one panel fits over the scene at a time.
  if (open && phone.matches) {
    for (const other of document.querySelectorAll('.panel')) if (other !== panel) setPanelOpen(other, false);
  }
}

for (const panel of document.querySelectorAll('.panel')) {
  panel.querySelector('.panel-head').addEventListener('click', () => setPanelOpen(panel, panel.classList.contains('collapsed')));
  if (phone.matches) setPanelOpen(panel, false); // start collapsed so the model gets the screen
}

function disposeModel() {
  if (!state.model) return;
  state.controller?.dispose();
  holder.remove(state.model);
  state.model.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  state.model = state.controller = state.selected = null;
}

// keepView: rebuilding the same character after an edit keeps the camera, position and pose overrides.
function mountModel(model, clips, meta, keepView = false) {
  const prev = keepView && state.controller ? { overrides: state.controller.overrides, selected: state.selected?.name } : null;
  disposeModel();
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  holder.add(model);
  if (!prev) {
    holder.position.set(0, 0, 0);
    holder.rotation.set(0, 0, 0);
    state.heading = 0;
  }
  state.model = model;
  state.meta = meta;
  state.controller = new RigController(model, clips, meta);
  state.controller.speed = Number($('speed').value);
  state.controller.setAnimate($('animate').checked);
  if (prev) for (const [k, v] of prev.overrides) state.controller.setOverride(k, v);
  if (state.expression) state.controller.setExpression(state.expression, 0);
  state.expression = state.controller.expression;

  $('clip').innerHTML = '<option value="">— by mode —</option>'
    + state.controller.clipNames.map((n) => `<option>${n}</option>`).join('');
  $('bone').innerHTML = state.controller.bones.map((b) => `<option>${b.name}</option>`).join('');
  selectBone(state.controller.boneByName.get(prev?.selected) ?? state.controller.bones.find((b) => b.name === 'head') ?? state.controller.bones[0]);
  buildModeButtons();
  buildExpressionButtons();
  if (prev) return;

  const view = meta.view ?? {};
  const target = new THREE.Vector3(...(view.target ?? [0, 0.8, 0]));
  // ?focus=<bone> aims the camera at a joint instead, e.g. focus=skull&zoom=0.35 for a face close-up.
  const focus = state.controller.boneByName.get(params.get('focus'));
  if (focus) { model.updateWorldMatrix(true, true); focus.getWorldPosition(target); }
  const d = (view.distance ?? 3) * (Number(params.get('zoom')) || 1);
  controls.target.copy(target);
  // ?yaw=degrees orbits the start position around the character (0 = front, 90 = its left side).
  const yaw = THREE.MathUtils.degToRad(Number(params.get('yaw') ?? 30));
  camera.position.copy(target).add(new THREE.Vector3(Math.sin(yaw) * 0.97 * d, 0.25 * d, Math.cos(yaw) * 0.97 * d));
  state.viewTarget = target;
}

function buildModeButtons() {
  // One button per extra controller state (e.g. "eat"), next to Idle / Walk / Wander.
  for (const b of document.querySelectorAll('#modes .extra')) b.remove();
  for (const name of Object.keys(state.controller.states)) {
    if (['idle', 'walk', 'wander'].includes(name) || !state.controller.actions.has(state.controller.states[name])) continue;
    const b = document.createElement('button');
    b.className = 'extra';
    b.dataset.mode = name;
    b.textContent = name[0].toUpperCase() + name.slice(1);
    $('modes').append(b);
  }
  setMode(state.mode);
}

function buildExpressionButtons() {
  const names = Object.keys(state.controller.expressions);
  $('exprBox').hidden = !names.length;
  $('expressions').innerHTML = names
    .map((n) => `<button data-expr="${n}" class="${n === state.expression ? 'on' : ''}">${n[0].toUpperCase() + n.slice(1)}</button>`).join('');
}

$('expressions').addEventListener('click', (e) => {
  const name = e.target.dataset.expr;
  if (!name || !state.controller) return;
  state.expression = name;
  state.controller.setExpression(name);
  for (const b of $('expressions').children) b.classList.toggle('on', b.dataset.expr === name);
});

async function loadEntry(entry, source) {
  state.entry = entry;
  state.source = source;
  setStatus(`Loading ${entry.name} (${source})…`);
  try {
    if (source === 'json') {
      const def = await (await fetch(`models/${entry.json}`, { cache: 'no-cache' })).json();
      const { root, clips, meta } = buildCharacter(def);
      state.def = def;
      state.glbBuffer = null;
      mountModel(root, clips, meta);
      showEditor(def.generator === 'humanoid');
    } else {
      const res = await fetch(`models/${entry.glb}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`models/${entry.glb} not found — run "npm run build:glb"`);
      await loadGLBBuffer(await res.arrayBuffer());
      showEditor(false);
    }
    setStatus(`${entry.name}: ${state.controller.bones.length} bones, clips: ${state.controller.clipNames.join(', ')}`);
    history.replaceState(null, '', `?model=${entry.id}&source=${source}`);
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}

async function loadGLBBuffer(buffer) {
  const gltf = await loader.parseAsync(buffer, '');
  const charRoot = findCharacterRoot(gltf.scene);
  const meta = charRoot?.userData.character ?? { name: 'GLB', clips: {} };
  state.def = null;
  state.glbBuffer = buffer;
  // Clips target nodes by name, so the mixer root must contain them all: use the whole glTF scene.
  mountModel(gltf.scene, gltf.animations, meta);
}

// ------------------------------------------------------------------ UI: animation

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === mode);
  $('clip').value = '';
}

$('modes').addEventListener('click', (e) => { if (e.target.dataset.mode) setMode(e.target.dataset.mode); });
$('speed').addEventListener('input', () => {
  const v = Number($('speed').value);
  $('speedOut').textContent = `${v.toFixed(2)}×`;
  if (state.controller) state.controller.speed = v;
});
$('animate').addEventListener('change', () => state.controller?.setAnimate($('animate').checked));
$('clip').addEventListener('change', () => {
  const name = $('clip').value;
  if (!name) return;
  state.mode = 'clip';
  for (const b of document.querySelectorAll('#modes button')) b.classList.remove('on');
  state.controller.setState(name);
});

$('download').addEventListener('click', async () => {
  try {
    let data = state.glbBuffer;
    if (!data && state.def) {
      const fresh = buildCharacter(state.def); // rest pose, not the currently animated one
      data = await exportGLB(fresh.root, fresh.clips);
    }
    if (!data) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
    a.download = `${state.meta?.id ?? 'model'}.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, true);
  }
});

// ------------------------------------------------------------------ UI: rig posing

const axes = ['x', 'y', 'z'];

function selectBone(bone) {
  state.selected = bone ?? null;
  if (!bone) return;
  $('bone').value = bone.name;
  const limits = bone.userData.limits ?? {};
  const current = state.controller.overrides.get(bone.name) ?? { x: 0, y: 0, z: 0 };
  for (const ax of axes) {
    const input = $(`r${ax}`);
    const [min, max] = limits[ax] ?? [-180, 180];
    input.min = min;
    input.max = max;
    input.disabled = min === max;
    input.value = current[ax];
    $(`r${ax}Out`).textContent = `${current[ax]}°`;
  }
  const parts = bone.children.filter((c) => c.isMesh);
  $('parts').innerHTML = parts.length
    ? parts.map((p, i) => `<label><input type="checkbox" data-i="${i}" ${p.visible ? 'checked' : ''}> ${p.name}</label>`).join('')
    : '<div style="color:var(--muted)">No parts (pure joint)</div>';
  $('parts').onchange = (e) => { parts[e.target.dataset.i].visible = e.target.checked; };
}

$('bone').addEventListener('change', () => selectBone(state.controller.boneByName.get($('bone').value)));
for (const ax of axes) {
  $(`r${ax}`).addEventListener('input', () => {
    const e = Object.fromEntries(axes.map((a) => [a, Number($(`r${a}`).value)]));
    $(`r${ax}Out`).textContent = `${e[ax]}°`;
    state.controller.setOverride(state.selected.name, e);
  });
}
$('resetBone').addEventListener('click', () => { state.controller.setOverride(state.selected.name, null); selectBone(state.selected); });
$('resetAll').addEventListener('click', () => {
  state.controller.clearOverrides();
  state.model.traverse((o) => { if (o.isMesh) o.visible = true; });
  selectBone(state.selected);
});

// Click a part -> select the bone that carries it (orbit drags are ignored).
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || !state.controller) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(state.model, true).find((h) => h.object.visible);
  if (!hit) return;
  const bones = new Set(state.controller.bones);
  let o = hit.object;
  while (o && !bones.has(o)) o = o.parent;
  if (o) selectBone(o);
});

// Drag & drop any .glb
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  try {
    await loadGLBBuffer(await file.arrayBuffer());
    setStatus(`${file.name}: ${state.controller.bones.length} bones, clips: ${state.controller.clipNames.join(', ') || 'none'}`);
  } catch (err) {
    setStatus(`Could not load ${file.name}: ${err.message}`, true);
  }
});

// ------------------------------------------------------------------ character editor (generated humanoids)

function showEditor(on) {
  $('editor').hidden = !on;
  if (on) buildEditor();
}

function buildEditor() {
  const body = { ...BODY_DEFAULTS, ...state.def.body };
  $('textures').checked = state.def.textures !== false;
  $('bodyControls').innerHTML = BODY_OPTIONS.map((o) => {
    const v = body[o.key];
    if (o.options) {
      const opts = o.options.map((x) => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('');
      return `<label class="field"><span>${o.label}</span><select data-body="${o.key}">${opts}</select><span></span></label>`;
    }
    if (o.range) {
      const [min, max, step] = o.range;
      return `<label class="field"><span>${o.label}</span><input type="range" data-body="${o.key}" min="${min}" max="${max}" step="${step}" value="${v}"><output>${v}</output></label>`;
    }
    const palette = { skin: SKIN_TONES, hairColor: HAIR_COLORS }[o.key];
    const swatches = palette
      ? `<span class="swatches">${palette.map((c) => `<button data-swatch="${o.key}" data-value="${c}" class="swatch" style="background:${c}" aria-label="${o.label} ${c}"></button>`).join('')}</span>`
      : '<span></span>';
    const input = `<label class="field"><span>${o.label}</span><span></span><input type="color" data-body="${o.key}" value="${v}"></label>`;
    return palette ? `${input}<div class="field palette">${swatches}</div>` : input;
  }).join('');

  const eq = state.def.equipment ?? {};
  // Hair and beard items without their own color follow the body's hair color.
  $('slotControls').innerHTML = SLOTS.map(({ key, label }) => {
    const cur = resolveEquip(eq[key], body.hairColor);
    const opts = [{ id: 'none', label: '—' }, ...itemsForSlot(key)]
      .map((o) => `<option value="${o.id}" ${o.id === (cur?.id ?? 'none') ? 'selected' : ''}>${o.label}</option>`).join('');
    const colors = cur
      ? `<span class="swatches"><input type="color" data-color="${key}" value="${cur.color}">${cur.item.colors.accent ? `<input type="color" data-accent="${key}" value="${cur.accent}">` : ''}</span>`
      : '<span></span>';
    return `<label class="field"><span>${label}</span><select data-slot="${key}">${opts}</select>${colors}</label>`;
  }).join('');
}

function rebuildRecipe(rebuildUI = false) {
  try {
    const { root, clips, meta } = buildCharacter(state.def);
    mountModel(root, clips, meta, true);
    if (rebuildUI) buildEditor();
    setStatus(`${state.def.name}: ${state.controller.bones.length} bones, walk ${meta.controller.walkSpeed} m/s, run ${meta.controller.runSpeed} m/s`);
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}

$('editor').addEventListener('input', (e) => {
  const t = e.target;
  const def = state.def;
  if (t.dataset.body) {
    const v = t.type === 'range' ? Number(t.value) : t.value;
    def.body = { ...BODY_DEFAULTS, ...def.body, [t.dataset.body]: v };
    if (t.type === 'range') t.nextElementSibling.textContent = v;
    rebuildRecipe(t.dataset.body === 'hairColor');
  } else if (t.dataset.slot) {
    def.equipment = { ...def.equipment };
    if (t.value === 'none') delete def.equipment[t.dataset.slot];
    else def.equipment[t.dataset.slot] = t.value;
    rebuildRecipe(true);
  } else if (t.dataset.color || t.dataset.accent) {
    const slot = t.dataset.color ?? t.dataset.accent;
    const cur = resolveEquip(def.equipment[slot], { ...BODY_DEFAULTS, ...def.body }.hairColor);
    def.equipment[slot] = {
      item: cur.id, color: cur.color, ...(cur.item.colors.accent && { accent: cur.accent }),
      [t.dataset.color ? 'color' : 'accent']: t.value,
    };
    rebuildRecipe();
  }
});
$('textures').addEventListener('change', () => {
  if ($('textures').checked) delete state.def.textures;
  else state.def.textures = false;
  rebuildRecipe();
});
$('bodyControls').addEventListener('click', (e) => {
  const key = e.target.dataset.swatch;
  if (!key) return;
  e.preventDefault();
  state.def.body = { ...BODY_DEFAULTS, ...state.def.body, [key]: e.target.dataset.value };
  rebuildRecipe(true);
});

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randomColor = () => `#${[0, 0, 0].map(() => Math.floor(40 + Math.random() * 190).toString(16).padStart(2, '0')).join('')}`;
$('randomize').addEventListener('click', () => {
  const sex = pick(['male', 'female']);
  const age = pick([8, 14, 22, 30, 40, 70]);
  state.def.body = {
    sex, age, height: +(0.85 + Math.random() * 0.3).toFixed(2), girth: +(0.85 + Math.random() * 0.4).toFixed(2),
    skin: pick(SKIN_TONES), eyes: pick(['#3a5f9e', '#5a3a22', '#3f7a3a', '#6a6a6a', '#7a4ab0']),
    hairColor: pick(Math.random() < 0.85 ? HAIR_COLORS.slice(0, 7) : HAIR_COLORS.slice(8)),
  };
  const equipment = {
    hair: pick(sex === 'male' ? ['short', 'spiky', 'bob', 'balding', 'afro', 'mohawk'] : ['bob', 'long', 'ponytail', 'bun', 'afro', 'braids', 'pigtails']),
    ...(sex === 'male' && age > 18 && Math.random() < 0.4 && { beard: pick(['shortBeard', 'longBeard', 'moustache']) }),
  };
  for (const { key } of SLOTS) {
    if (key === 'hair' || key === 'beard') continue;
    if (!['clothes', 'feet'].includes(key) && Math.random() < 0.45) continue; // optional slots stay empty sometimes
    const it = pick(itemsForSlot(key));
    equipment[key] = { item: it.id, color: Math.random() < 0.5 ? it.colors.color : randomColor(), ...(it.colors.accent && { accent: it.colors.accent }) };
  }
  state.def.equipment = equipment;
  rebuildRecipe(true);
});

$('saveRecipe').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`${JSON.stringify(state.def, null, 2)}\n`], { type: 'application/json' }));
  a.download = `${state.def.id ?? 'character'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ------------------------------------------------------------------ locomotion

const keys = new Set();
addEventListener('keydown', (e) => { if (e.target.tagName !== 'SELECT') keys.add(e.code); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const WANDER_RADIUS = 1.6;
const tmpDir = new THREE.Vector3();
const prevPos = new THREE.Vector3();

function updateLocomotion(dt) {
  const ctl = state.controller;
  if (!ctl) return;
  const running = !!ctl.states.run && (keys.has('ShiftLeft') || keys.has('ShiftRight') || state.mode === 'run');
  const speed = (running ? ctl.runSpeed : ctl.walkSpeed) * ctl.speed;

  const input = new THREE.Vector2(
    (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0),
    (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0),
  );

  let walking = false;
  let targetHeading = state.heading;
  if (input.lengthSq() > 0) {
    // Camera-relative movement on the ground plane.
    camera.getWorldDirection(tmpDir);
    tmpDir.y = 0;
    tmpDir.normalize();
    const right = new THREE.Vector3(-tmpDir.z, 0, tmpDir.x);
    const move = tmpDir.multiplyScalar(input.y).addScaledVector(right, input.x).normalize();
    targetHeading = Math.atan2(move.x, move.z);
    walking = true;
  } else if (state.mode === 'wander') {
    targetHeading = state.heading + (speed / WANDER_RADIUS) * dt;
    walking = true;
  }

  // Turn smoothly along the shortest arc.
  let diff = targetHeading - state.heading;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  state.heading += diff * Math.min(1, ctl.turnSpeed * dt);
  holder.rotation.y = state.heading;

  if (walking) {
    holder.position.x += Math.sin(state.heading) * speed * dt;
    holder.position.z += Math.cos(state.heading) * speed * dt;
  }

  if (state.mode !== 'clip') {
    const extra = state.mode !== 'wander' && ctl.states[state.mode] ? state.mode : 'idle';
    const moving = walking || state.mode === 'walk' || state.mode === 'run';
    ctl.setState(moving ? (running ? 'run' : 'walk') : extra);
  }
}

// ------------------------------------------------------------------ loop

const clock = new THREE.Clock();
let skipTime = Number(params.get('t')) || 0;
let freezeNow = false;
renderer.setAnimationLoop(() => {
  let dt = Math.min(clock.getDelta(), 0.1);
  if (skipTime > 0 && state.controller) {
    dt = skipTime; // ?t=seconds: jump the animation forward once (for screenshots of a specific moment)
    skipTime = 0;
    freezeNow = params.get('freeze') === '1'; // &freeze=1 then holds that pose
  }
  prevPos.copy(holder.position);
  updateLocomotion(dt);
  state.controller?.update(dt);
  if (freezeNow) { state.controller.speed = 0; freezeNow = false; }

  // Camera follows the character.
  const delta = holder.position.clone().sub(prevPos);
  camera.position.add(delta);
  controls.target.add(delta);
  sun.position.set(holder.position.x + 2.5, 5, holder.position.z + 3);
  sun.target.position.copy(holder.position);

  controls.update();
  updateOverlay();
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ boot

try {
  state.index = await (await fetch('models/index.json', { cache: 'no-cache' })).json();
} catch {
  setStatus('Cannot load models/index.json — serve this folder over HTTP ("npm start"), file:// is blocked by the browser.', true);
  throw new Error('index.json not reachable');
}
$('model').innerHTML = state.index.models.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
const initial = state.index.models.find((m) => m.id === params.get('model')) ?? state.index.models[0];
$('model').value = initial.id;
$('source').value = params.get('source') === 'glb' ? 'glb' : 'json';
if (params.get('mode')) state.mode = params.get('mode');
if (params.get('ui') === '0') document.body.classList.add('clean'); // panels hidden, e.g. for screenshots
if (params.get('skeleton') === '1') $('showSkeleton').checked = true;

const reload = () => loadEntry(state.index.models.find((m) => m.id === $('model').value), $('source').value);
$('model').addEventListener('change', reload);
$('source').addEventListener('change', reload);
await reload();

window.viewer = { state, scene, camera, renderer }; // for debugging from the console
