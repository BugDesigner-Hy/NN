const canvas = document.querySelector("#view");
const view3d = document.querySelector("#view3d");
const stage = document.querySelector("#stage");
const emptyTitle = document.querySelector("#emptyTitle");
const emptyText = document.querySelector("#emptyText");
const hintEl = document.querySelector("#hint");
const mode2dBtn = document.querySelector("#mode2d");
const mode3dBtn = document.querySelector("#mode3d");
const ctx = canvas.getContext("2d");
const ink = document.createElement("canvas");
const inkCtx = ink.getContext("2d");
const halo = document.createElement("canvas");
const haloCtx = halo.getContext("2d");
const emptyEl = document.querySelector("#empty");
const statEl = document.querySelector("#stat");
const pauseBtn = document.querySelector("#pause");
const clearBtn = document.querySelector("#clear");
const exportBtn = document.querySelector("#export");
const exportBackground = "#07090f";

const MAX_ALIVE = 900;
const CHUNK_LIMIT = 48;

const params = {
  sprouts: 6,
  speed: 1,
  branchProb: 0.72,
  branchAngle: 46,
  maxDepth: 8,
  gap: 52,
  wander: 0.42,
  thickness: 2,
  hue: 188,
  glow: 0.68,
};

const networks = [];
const somas = [];
const branches = [];
const chunks = [];
const forks = [];
const rings = [];

let nextNetworkId = 1;
let viewWidth = 1;
let viewHeight = 1;
let paused = false;
let alive = 0;
let viewDirty = true;
let haloUsed = false;
let camX = 0;
let camY = 0;
let zoom = 1;
let drag = null;
let mode = "2d";
let spaceHeld = false;

const formats = {
  sprouts: (v) => String(v),
  speed: (v) => Number(v).toFixed(1),
  branchProb: (v) => `${Math.round(v * 100)}%`,
  branchAngle: (v) => `${Math.round(v)}°`,
  maxDepth: (v) => String(v),
  gap: (v) => `${Math.round(v)}`,
  wander: (v) => `${Math.round(v * 100)}%`,
  thickness: (v) => Number(v).toFixed(1),
  hue: (v) => `${Math.round(v)}`,
  glow: (v) => `${Math.round(v * 100)}%`,
};

function bindControls() {
  const bindings = [
    ["sprouts", (v) => Math.round(v)],
    ["speed", (v) => v],
    ["branchProb", (v) => v / 100],
    ["branchAngle", (v) => v],
    ["maxDepth", (v) => Math.round(v)],
    ["gap", (v) => v],
    ["wander", (v) => v / 100],
    ["thickness", (v) => v],
    ["hue", (v) => v],
    ["glow", (v) => v / 100],
  ];

  for (const [key, parse] of bindings) {
    const input = document.querySelector(`#${key}`);
    const label = document.querySelector(`[data-for="${key}"]`);
    const apply = () => {
      params[key] = parse(Number(input.value));
      label.textContent = formats[key](params[key]);
      paintRange(input);
      if (key === "hue") syncAccent();
    };
    input.addEventListener("input", apply);
    apply();
  }
}

function paintRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const percent = ((value - min) / (max - min)) * 100;
  input.style.background = `linear-gradient(90deg, var(--accent) ${percent}%, rgba(255,255,255,0.14) ${percent}%)`;
}

function syncAccent() {
  document.documentElement.style.setProperty("--accent", `hsl(${params.hue} 78% 58%)`);
  for (const input of document.querySelectorAll('input[type="range"]')) {
    paintRange(input);
  }
}

function resize() {
  const rect = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewWidth = Math.max(1, rect.width);
  viewHeight = Math.max(1, rect.height);
  canvas.width = Math.round(viewWidth * dpr);
  canvas.height = Math.round(viewHeight * dpr);
  ink.width = canvas.width;
  ink.height = canvas.height;
  halo.width = canvas.width;
  halo.height = canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  haloCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  inkCtx.lineCap = "round";
  inkCtx.lineJoin = "round";
  haloCtx.lineCap = "round";
  haloCtx.lineJoin = "round";
  viewDirty = true;
  NN3D.resize(viewWidth, viewHeight);
}

function randomPace(parentPace) {
  if (parentPace == null) return 0.08 * 50 ** Math.random();
  return Math.min(4.2, Math.max(0.05, parentPace * (0.62 + Math.random() * 0.75)));
}

function randomAngleSet(count) {
  const angles = [];
  for (let i = 0; i < count; i += 1) angles.push(Math.random() * Math.PI * 2);
  return angles;
}

function createChunk(branch) {
  const chunk = {
    network: branch.network,
    w: branch.w,
    hueShift: branch.hueShift,
    points: [{ x: branch.x, y: branch.y }],
    minX: branch.x,
    minY: branch.y,
    maxX: branch.x,
    maxY: branch.y,
  };
  chunks.push(chunk);
  return chunk;
}

function expandChunk(chunk, x, y) {
  if (x < chunk.minX) chunk.minX = x;
  if (y < chunk.minY) chunk.minY = y;
  if (x > chunk.maxX) chunk.maxX = x;
  if (y > chunk.maxY) chunk.maxY = y;
}

function spawnBranch(network, x, y, angle, depth, width, hueShift, pace) {
  if (network.full || network.alive >= MAX_ALIVE) {
    network.full = true;
    return false;
  }
  network.alive += 1;
  alive += 1;
  const branch = {
    network,
    x,
    y,
    angle,
    depth,
    w: width,
    hueShift,
    traveled: 0,
    interval: nextInterval(network, depth),
    pace: pace == null ? randomPace() : pace,
    drift: (Math.random() - 0.5) * 0.014,
    alive: true,
    mature: false,
    phase: Math.random() * Math.PI * 2,
    chunk: null,
  };
  branch.chunk = createChunk(branch);
  branches.push(branch);
  return true;
}

function nextInterval(network, depth) {
  return network.params.gap * (0.28 + Math.random() * 1.85) * (1 + depth * 0.06);
}

function spawnTree(x, y) {
  const network = {
    id: nextNetworkId,
    params: { ...params },
    hueShift: (Math.random() - 0.5) * 24,
    alive: 0,
    full: false,
  };
  nextNetworkId += 1;
  networks.push(network);
  somas.push({ network, x, y, born: performance.now() });
  rings.push({
    x,
    y,
    radius: 6,
    life: 1,
    hue: network.params.hue + network.hueShift,
  });
  for (const angle of randomAngleSet(network.params.sprouts)) {
    spawnBranch(network, x, y, angle, 0, 1, network.hueShift);
  }
  emptyEl.classList.add("is-hidden");
}

function considerFork(branch) {
  const network = branch.network;
  const settings = network.params;
  if (branch.mature || network.full) return;
  if (branch.depth >= settings.maxDepth) {
    branch.mature = true;
    return;
  }
  if (network.alive >= MAX_ALIVE) {
    network.full = true;
    return;
  }

  const probability = settings.branchProb * Math.pow(0.86, branch.depth);
  if (Math.random() > probability) {
    branch.angle += (Math.random() - 0.5) * 0.5;
    return;
  }

  const spread = (settings.branchAngle * Math.PI) / 180;
  const roll = Math.random();
  const sign = Math.random() < 0.5 ? -1 : 1;
  let spawned = false;

  if (roll < 0.74) {
    const kick = spread * (0.5 + Math.random() * 0.65);
    const childAngle = branch.angle - sign * kick;
    branch.angle += sign * kick * 0.38;
    spawned = spawnBranch(network, branch.x, branch.y, childAngle, branch.depth + 1, branch.w * 0.74, shiftHue(branch.hueShift), randomPace(branch.pace));
  } else if (roll < 0.9) {
    spawned = spawnBranch(
      network,
      branch.x,
      branch.y,
      branch.angle + sign * spread * (0.75 + Math.random() * 0.45),
      branch.depth + 1,
      branch.w * 0.58,
      shiftHue(branch.hueShift),
      randomPace(branch.pace),
    );
    branch.angle -= sign * 0.12;
  } else {
    const left = branch.angle - spread * (0.45 + Math.random() * 0.35);
    const right = branch.angle + spread * (0.45 + Math.random() * 0.35);
    branch.angle += (Math.random() - 0.5) * 0.2;
    const a = spawnBranch(network, branch.x, branch.y, left, branch.depth + 1, branch.w * 0.66, shiftHue(branch.hueShift), randomPace(branch.pace));
    const b = spawnBranch(network, branch.x, branch.y, right, branch.depth + 1, branch.w * 0.66, shiftHue(branch.hueShift), randomPace(branch.pace));
    spawned = a || b;
  }

  if (spawned) addFork(network, branch.x, branch.y, branch.w * 0.8, branch.hueShift);
}

function shiftHue(hueShift) {
  return hueShift + (Math.random() - 0.5) * 18;
}

function addFork(network, x, y, width, hueShift) {
  const fork = { network, x, y, w: width, hueShift };
  forks.push(fork);
  if (!viewDirty && pointVisible(x, y)) paintFork(fork);
}

function rememberPoint(branch) {
  const chunk = branch.chunk;
  const last = chunk.points[chunk.points.length - 1];
  const dist = Math.hypot(branch.x - last.x, branch.y - last.y);
  if (dist < 4) return;
  chunk.points.push({ x: branch.x, y: branch.y });
  expandChunk(chunk, branch.x, branch.y);
  if (!viewDirty && segmentVisible(last.x, last.y, branch.x, branch.y)) {
    paintSegment(branch.network, branch.w, branch.hueShift, last.x, last.y, branch.x, branch.y);
  }
  if (chunk.points.length >= CHUNK_LIMIT) branch.chunk = createChunk(branch);
}

function growBranch(branch, distance) {
  const settings = branch.network.params;
  branch.phase += distance * 0.09;
  const wobble =
    Math.sin(branch.phase) * settings.wander * 0.01 +
    (Math.random() - 0.5) * settings.wander * 0.045;
  branch.angle += branch.drift * distance + wobble;
  branch.x += Math.cos(branch.angle) * distance;
  branch.y += Math.sin(branch.angle) * distance;
  branch.traveled += distance;
  rememberPoint(branch);

  if (branch.mature || branch.traveled < branch.interval) return;
  branch.traveled = 0;
  branch.interval = nextInterval(branch.network, branch.depth);
  considerFork(branch);
}

function step(dt) {
  for (const branch of branches) {
    if (!branch.alive) continue;
    const flutter = 0.74 + 0.52 * (0.5 + 0.5 * Math.sin(branch.phase * 0.37 + branch.drift * 40));
    const budget = (branch.network.params.speed * branch.pace * flutter * 78 * dt) / 1000;
    let left = budget;
    while (left > 0 && branch.alive) {
      const distance = Math.min(2.6, left);
      left -= distance;
      growBranch(branch, distance);
    }
  }

  for (const ring of rings) {
    ring.radius += (150 * dt) / 1000;
    ring.life -= dt / 680;
  }
  for (let i = rings.length - 1; i >= 0; i -= 1) {
    if (rings[i].life <= 0) rings.splice(i, 1);
  }
}

function viewRect(pad) {
  return {
    x0: camX - pad,
    y0: camY - pad,
    x1: camX + viewWidth / zoom + pad,
    y1: camY + viewHeight / zoom + pad,
  };
}

function segmentVisible(x1, y1, x2, y2) {
  const view = viewRect(48 / zoom);
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return maxX >= view.x0 && minX <= view.x1 && maxY >= view.y0 && minY <= view.y1;
}

function pointVisible(x, y) {
  const view = viewRect(48 / zoom);
  return x >= view.x0 && x <= view.x1 && y >= view.y0 && y <= view.y1;
}

function chunkVisible(chunk) {
  const view = viewRect(64 / zoom);
  return chunk.maxX >= view.x0 && chunk.minX <= view.x1 && chunk.maxY >= view.y0 && chunk.minY <= view.y1;
}

function styleOf(network, widthScale, hueShift) {
  const settings = network.params;
  return {
    settings,
    hue: settings.hue + hueShift,
    width: Math.max(0.7, settings.thickness * widthScale) * zoom,
    light: 50 + (1 - widthScale) * 28,
    alpha: 0.28 + widthScale * 0.62,
  };
}

function traceScreen(context, points) {
  context.beginPath();
  context.moveTo((points[0].x - camX) * zoom, (points[0].y - camY) * zoom);
  for (let i = 1; i < points.length; i += 1) {
    context.lineTo((points[i].x - camX) * zoom, (points[i].y - camY) * zoom);
  }
  context.stroke();
}

function paintSegment(network, widthScale, hueShift, x1, y1, x2, y2) {
  const style = styleOf(network, widthScale, hueShift);
  const sx1 = (x1 - camX) * zoom;
  const sy1 = (y1 - camY) * zoom;
  const sx2 = (x2 - camX) * zoom;
  const sy2 = (y2 - camY) * zoom;
  if (style.settings.glow > 0.01) {
    haloUsed = true;
    haloCtx.strokeStyle = `hsla(${style.hue}, 85%, 62%, ${0.18 + style.settings.glow * 0.4})`;
    haloCtx.lineWidth = style.width * (1.5 + style.settings.glow * 2.2);
    haloCtx.beginPath();
    haloCtx.moveTo(sx1, sy1);
    haloCtx.lineTo(sx2, sy2);
    haloCtx.stroke();
  }
  inkCtx.strokeStyle = `hsla(${style.hue}, 80%, ${style.light}%, ${style.alpha})`;
  inkCtx.lineWidth = style.width;
  inkCtx.beginPath();
  inkCtx.moveTo(sx1, sy1);
  inkCtx.lineTo(sx2, sy2);
  inkCtx.stroke();
}

function paintChunk(chunk) {
  if (chunk.points.length < 2) return;
  const style = styleOf(chunk.network, chunk.w, chunk.hueShift);
  if (style.settings.glow > 0.01) {
    haloUsed = true;
    haloCtx.strokeStyle = `hsla(${style.hue}, 85%, 62%, ${0.18 + style.settings.glow * 0.4})`;
    haloCtx.lineWidth = style.width * (1.5 + style.settings.glow * 2.2);
    traceScreen(haloCtx, chunk.points);
  }
  inkCtx.strokeStyle = `hsla(${style.hue}, 80%, ${style.light}%, ${style.alpha})`;
  inkCtx.lineWidth = style.width;
  traceScreen(inkCtx, chunk.points);
}

function paintFork(fork) {
  const style = styleOf(fork.network, fork.w, fork.hueShift);
  const radius = Math.max(1.1, style.width * 0.55);
  const x = (fork.x - camX) * zoom;
  const y = (fork.y - camY) * zoom;
  if (style.settings.glow > 0.01) {
    haloUsed = true;
    haloCtx.fillStyle = `hsla(${style.hue}, 90%, 68%, ${0.25 + style.settings.glow * 0.35})`;
    haloCtx.beginPath();
    haloCtx.arc(x, y, radius * (1.4 + style.settings.glow), 0, Math.PI * 2);
    haloCtx.fill();
  }
  inkCtx.fillStyle = `hsla(${style.hue}, 90%, 76%, 0.9)`;
  inkCtx.beginPath();
  inkCtx.arc(x, y, radius, 0, Math.PI * 2);
  inkCtx.fill();
}

function rebuild() {
  inkCtx.clearRect(0, 0, viewWidth, viewHeight);
  haloCtx.clearRect(0, 0, viewWidth, viewHeight);
  haloUsed = false;
  for (const chunk of chunks) {
    if (chunkVisible(chunk)) paintChunk(chunk);
  }
  for (const fork of forks) {
    if (pointVisible(fork.x, fork.y)) paintFork(fork);
  }
  viewDirty = false;
}

function drawNodes() {
  const now = performance.now();
  for (const soma of somas) {
    if (!pointVisible(soma.x, soma.y)) continue;
    const settings = soma.network.params;
    const hue = settings.hue + soma.network.hueShift;
    const pulse = 1 + Math.sin((now - soma.born) / 280) * 0.08;
    const radius = (4.5 + settings.thickness * 1.35) * pulse * zoom;
    const x = (soma.x - camX) * zoom;
    const y = (soma.y - camY) * zoom;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 3.2);
    gradient.addColorStop(0, `hsla(${hue}, 90%, 78%, 0.95)`);
    gradient.addColorStop(0.35, `hsla(${hue}, 85%, 62%, 0.55)`);
    gradient.addColorStop(1, `hsla(${hue}, 85%, 55%, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius * 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLiveTails() {
  ctx.lineCap = "round";
  for (const branch of branches) {
    const last = branch.chunk.points[branch.chunk.points.length - 1];
    if (!segmentVisible(last.x, last.y, branch.x, branch.y)) continue;
    if (Math.hypot(branch.x - last.x, branch.y - last.y) < 0.2) continue;
    const style = styleOf(branch.network, branch.w, branch.hueShift);
    ctx.strokeStyle = `hsla(${style.hue}, 80%, ${style.light}%, ${style.alpha})`;
    ctx.lineWidth = style.width;
    ctx.beginPath();
    ctx.moveTo((last.x - camX) * zoom, (last.y - camY) * zoom);
    ctx.lineTo((branch.x - camX) * zoom, (branch.y - camY) * zoom);
    ctx.stroke();
  }
}

function drawTips() {
  ctx.beginPath();
  let any = false;
  for (const branch of branches) {
    if (!pointVisible(branch.x, branch.y)) continue;
    const radius = Math.max(1.15, branch.network.params.thickness * branch.w * 0.42) * zoom;
    const x = (branch.x - camX) * zoom;
    const y = (branch.y - camY) * zoom;
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    any = true;
  }
  if (!any) return;
  ctx.fillStyle = "rgba(244, 252, 255, 0.95)";
  ctx.fill();
}

function drawRings() {
  for (const ring of rings) {
    if (!pointVisible(ring.x, ring.y)) continue;
    const x = (ring.x - camX) * zoom;
    const y = (ring.y - camY) * zoom;
    ctx.strokeStyle = `hsla(${ring.hue}, 90%, 70%, ${ring.life * 0.7})`;
    ctx.lineWidth = 1.2 * zoom;
    ctx.beginPath();
    ctx.arc(x, y, ring.radius * zoom, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function draw() {
  if (viewDirty) rebuild();
  ctx.clearRect(0, 0, viewWidth, viewHeight);
  if (haloUsed) {
    ctx.save();
    ctx.filter = "blur(9px)";
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.9;
    ctx.drawImage(halo, 0, 0, viewWidth, viewHeight);
    ctx.restore();
  }
  ctx.drawImage(ink, 0, 0, viewWidth, viewHeight);
  drawNodes();
  drawLiveTails();
  drawTips();
  drawRings();
}

function updateStat() {
  if (mode === "3d") {
    statEl.textContent = `${NN3D.networkCount()} 株 · ${NN3D.aliveCount()} 条生长中`;
    return;
  }
  statEl.textContent = `${networks.length} 株 · ${alive} 条生长中`;
}

function syncChrome() {
  const count = mode === "3d" ? NN3D.networkCount() : networks.length;
  emptyEl.classList.toggle("is-hidden", count > 0);
  stage.classList.toggle("is-3d", mode === "3d");
  canvas.hidden = mode !== "2d";
  view3d.hidden = mode !== "3d";
  mode2dBtn.classList.toggle("is-active", mode === "2d");
  mode3dBtn.classList.toggle("is-active", mode === "3d");
  if (mode === "3d") {
    emptyTitle.textContent = "点击地面上的位置";
    emptyText.textContent = "神经会向随机的三维方向长出，并一直分叉";
    hintEl.textContent = "左键拖动旋转，滚轮缩放，右键平移";
  } else {
    emptyTitle.textContent = "点击任意位置";
    emptyText.textContent = "神经从落点向随机方向长出，并一直向外生长";
    hintEl.textContent = "按住空格拖动画布，松开后点击新建神经。滚轮缩放";
  }
  updateStat();
}

function setMode(next) {
  if (next === mode) return;
  if (next === "3d" && !NN3D.supported) return;
  mode = next;
  if (mode === "3d") NN3D.resize(viewWidth, viewHeight);
  syncChrome();
}

function clearScene() {
  networks.length = 0;
  somas.length = 0;
  branches.length = 0;
  chunks.length = 0;
  forks.length = 0;
  rings.length = 0;
  alive = 0;
  haloUsed = false;
  viewDirty = true;
  syncChrome();
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || mode !== "2d") return;
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch (error) {
    /* pointer capture is optional */
  }
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    camX,
    camY,
    panning: spaceHeld,
  };
  if (spaceHeld) stage.classList.add("is-panning");
});

canvas.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.id || !drag.panning) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  stage.classList.add("is-panning");
  camX = drag.camX - dx / zoom;
  camY = drag.camY - dy / zoom;
  viewDirty = true;
});

function endDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  if (!drag.panning) {
    const rect = canvas.getBoundingClientRect();
    spawnTree(camX + (drag.x - rect.left) / zoom, camY + (drag.y - rect.top) / zoom);
  }
  stage.classList.remove("is-panning");
  drag = null;
}

function setSpaceHeld(held) {
  spaceHeld = held;
  stage.classList.toggle("is-space", held);
  if (!held && drag && drag.panning) {
    stage.classList.remove("is-panning");
    drag = null;
  }
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const worldX = camX + sx / zoom;
    const worldY = camY + sy / zoom;
    zoom = Math.min(3, Math.max(0.2, zoom * Math.exp(-event.deltaY * 0.0012)));
    camX = worldX - sx / zoom;
    camY = worldY - sy / zoom;
    viewDirty = true;
  },
  { passive: false },
);

function setPaused(next) {
  paused = next;
  pauseBtn.textContent = paused ? "继续" : "暂停";
  exportBtn.hidden = !paused;
}

function exportImage() {
  if (!paused) return;
  if (mode === "3d") NN3D.draw();
  else draw();
  const source = mode === "3d" ? view3d : canvas;
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const outCtx = out.getContext("2d");
  outCtx.fillStyle = exportBackground;
  outCtx.fillRect(0, 0, out.width, out.height);
  outCtx.drawImage(source, 0, 0);
  const stamp = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const name = `nn-${mode === "3d" ? "3d" : "plane"}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

pauseBtn.addEventListener("click", () => {
  setPaused(!paused);
});

exportBtn.addEventListener("click", exportImage);

clearBtn.addEventListener("click", () => {
  if (mode === "3d") NN3D.clear();
  else clearScene();
  if (paused) setPaused(false);
});

mode2dBtn.addEventListener("click", () => setMode("2d"));
mode3dBtn.addEventListener("click", () => setMode("3d"));
if (!NN3D.supported) mode3dBtn.disabled = true;
NN3D.onChange = syncChrome;
NN3D.bindInput(stage, () => ({ ...params }));

window.addEventListener("keydown", (event) => {
  if (event.code !== "Space") return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
  event.preventDefault();
  if (event.repeat || mode !== "2d") return;
  setSpaceHeld(true);
});

window.addEventListener("keyup", (event) => {
  if (event.code !== "Space") return;
  setSpaceHeld(false);
});

window.addEventListener("blur", () => setSpaceHeld(false));

new ResizeObserver(resize).observe(stage);
bindControls();
resize();

let last = performance.now();
let statTick = 0;
function frame(now) {
  const dt = Math.min(32, now - last);
  last = now;
  if (!paused && !document.hidden) {
    if (mode === "3d") NN3D.step(dt);
    else step(dt);
  }
  if (mode === "3d") NN3D.draw();
  else draw();
  if (now - statTick > 200) {
    updateStat();
    statTick = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
