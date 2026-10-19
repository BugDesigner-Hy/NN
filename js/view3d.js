const NN3D = (() => {
  const MAX_ALIVE = 900;
  const FLOATS = 13;
  const FOV = (48 * Math.PI) / 180;

  const canvas = document.querySelector("#view3d");
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });

  const networks = [];
  const somas = [];
  const branches = [];

  let nextId = 1;
  let alive = 0;
  let width = 1;
  let height = 1;
  let dpr = 1;

  const camera = {
    target: { x: 0, y: 40, z: 0 },
    radius: 780,
    theta: 0.7,
    phi: 1.05,
  };

  let vertCapacity = 2048;
  let vertData = new Float32Array(vertCapacity * 4 * FLOATS);
  let indexData = new Uint32Array(vertCapacity * 6);
  let segmentCount = 0;
  let gpuSegments = 0;

  let lineProgram = null;
  let pointProgram = null;
  let vao = null;
  let vertBuf = null;
  let indexBuf = null;
  let gridVao = null;
  let gridCount = 0;
  let pointVao = null;
  let pointBuf = null;
  let pointCapacity = 256;
  let pointData = new Float32Array(pointCapacity * 6);

  const view = new Float32Array(16);
  const proj = new Float32Array(16);
  const viewProj = new Float32Array(16);

  function randomPace(parentPace) {
    if (parentPace == null) return 0.08 * 50 ** Math.random();
    return Math.min(4.2, Math.max(0.05, parentPace * (0.62 + Math.random() * 0.75)));
  }

  function hslToRgb(h, s, l) {
    const hue = ((h % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const chan = (t) => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return [chan(hue + 1 / 3), chan(hue), chan(hue - 1 / 3)];
  }

  function normalize(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    v.x /= len;
    v.y /= len;
    v.z /= len;
    return v;
  }

  function randomDir() {
    const y = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return { x: r * Math.cos(a), y, z: r * Math.sin(a) };
  }

  function deflect(dir, angle) {
    const up = Math.abs(dir.y) < 0.85 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const side = normalize({
      x: dir.y * up.z - dir.z * up.y,
      y: dir.z * up.x - dir.x * up.z,
      z: dir.x * up.y - dir.y * up.x,
    });
    const spin = Math.random() * Math.PI * 2;
    const lift = {
      x: side.x * Math.cos(spin) + (dir.y * side.z - dir.z * side.y) * Math.sin(spin),
      y: side.y * Math.cos(spin) + (dir.z * side.x - dir.x * side.z) * Math.sin(spin),
      z: side.z * Math.cos(spin) + (dir.x * side.y - dir.y * side.x) * Math.sin(spin),
    };
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return normalize({
      x: dir.x * c + lift.x * s,
      y: dir.y * c + lift.y * s,
      z: dir.z * c + lift.z * s,
    });
  }

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "shader");
    }
    return shader;
  }

  function program(vs, fs) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || "link");
    }
    return prog;
  }

  function fillIndices(from, to) {
    for (let s = from; s < to; s += 1) {
      const v = s * 4;
      const i = s * 6;
      indexData[i] = v;
      indexData[i + 1] = v + 1;
      indexData[i + 2] = v + 2;
      indexData[i + 3] = v + 2;
      indexData[i + 4] = v + 1;
      indexData[i + 5] = v + 3;
    }
  }

  function initGl() {
    if (!gl) return;
    lineProgram = program(
      `#version 300 es
      precision highp float;
      layout(location=0) in vec3 aPos;
      layout(location=1) in vec3 bPos;
      layout(location=2) in vec3 aColor;
      layout(location=3) in vec4 aMeta;
      uniform mat4 uViewProj;
      uniform vec2 uResolution;
      uniform float uGlowPass;
      out vec3 vColor;
      out float vGlow;
      void main() {
        vec4 ca = uViewProj * vec4(aPos, 1.0);
        vec4 cb = uViewProj * vec4(bPos, 1.0);
        vec2 na = ca.xy / max(ca.w, 0.0001);
        vec2 nb = cb.xy / max(cb.w, 0.0001);
        vec2 dir = nb - na;
        float len = length(dir);
        dir = len > 0.00001 ? dir / len : vec2(1.0, 0.0);
        vec2 normal = vec2(-dir.y, dir.x);
        vec4 clip = mix(ca, cb, aMeta.y);
        float glow = aMeta.w;
        float width = max(aMeta.z, 0.7) * mix(1.0, 1.4 + glow * 3.4, uGlowPass);
        vec2 offset = normal * aMeta.x * width / uResolution;
        gl_Position = vec4(clip.xy + offset * clip.w, clip.z, clip.w);
        vColor = aColor;
        vGlow = glow;
      }`,
      `#version 300 es
      precision highp float;
      in vec3 vColor;
      in float vGlow;
      uniform float uGlowPass;
      out vec4 fragColor;
      void main() {
        float alpha = mix(0.92, 0.08 + vGlow * 0.22, uGlowPass);
        fragColor = vec4(vColor, alpha);
      }`,
    );
    pointProgram = program(
      `#version 300 es
      precision highp float;
      layout(location=0) in vec3 aPos;
      layout(location=1) in vec3 aColor;
      uniform mat4 uViewProj;
      uniform float uSize;
      out vec3 vColor;
      void main() {
        gl_Position = uViewProj * vec4(aPos, 1.0);
        gl_PointSize = uSize;
        vColor = aColor;
      }`,
      `#version 300 es
      precision highp float;
      in vec3 vColor;
      out vec4 fragColor;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        if (dot(p, p) > 1.0) discard;
        fragColor = vec4(vColor, 0.95);
      }`,
    );

    vao = gl.createVertexArray();
    vertBuf = gl.createBuffer();
    indexBuf = gl.createBuffer();
    fillIndices(0, vertCapacity);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertBuf);
    gl.bufferData(gl.ARRAY_BUFFER, vertData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 36);
    gl.bindVertexArray(null);

    const grid = [];
    const extent = 1800;
    const step = 120;
    const pushGrid = (x1, y1, z1, x2, y2, z2) => {
      grid.push(x1, y1, z1, x2, y2, z2, 0.45, 0.62, 0.7, -1, 0, 1, 0.15);
      grid.push(x1, y1, z1, x2, y2, z2, 0.45, 0.62, 0.7, 1, 0, 1, 0.15);
      grid.push(x1, y1, z1, x2, y2, z2, 0.45, 0.62, 0.7, -1, 1, 1, 0.15);
      grid.push(x1, y1, z1, x2, y2, z2, 0.45, 0.62, 0.7, 1, 1, 1, 0.15);
    };
    for (let i = -extent; i <= extent; i += step) {
      pushGrid(i, 0, -extent, i, 0, extent);
      pushGrid(-extent, 0, i, extent, 0, i);
    }
    gridCount = grid.length / FLOATS / 4;
    const gridVerts = new Float32Array(grid);
    const gridIndex = new Uint32Array(gridCount * 6);
    for (let s = 0; s < gridCount; s += 1) {
      const v = s * 4;
      const o = s * 6;
      gridIndex[o] = v;
      gridIndex[o + 1] = v + 1;
      gridIndex[o + 2] = v + 2;
      gridIndex[o + 3] = v + 2;
      gridIndex[o + 4] = v + 1;
      gridIndex[o + 5] = v + 3;
    }
    gridVao = gl.createVertexArray();
    gl.bindVertexArray(gridVao);
    const gridBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, gridVerts, gl.STATIC_DRAW);
    const gridIndexBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gridIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, gridIndex, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 36);
    gl.bindVertexArray(null);

    pointVao = gl.createVertexArray();
    pointBuf = gl.createBuffer();
    gl.bindVertexArray(pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pointData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }

  function ensure(extra) {
    if (segmentCount + extra <= vertCapacity) return;
    const next = Math.max(vertCapacity * 2, segmentCount + extra);
    const nextVerts = new Float32Array(next * 4 * FLOATS);
    nextVerts.set(vertData.subarray(0, segmentCount * 4 * FLOATS));
    vertData = nextVerts;
    vertCapacity = next;
    indexData = new Uint32Array(vertCapacity * 6);
    fillIndices(0, vertCapacity);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertBuf);
    gl.bufferData(gl.ARRAY_BUFFER, vertData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);
    gpuSegments = 0;
  }

  function pushSegment(ax, ay, az, bx, by, bz, color, width, glow) {
    if (!gl) return;
    ensure(1);
    const base = segmentCount * 4 * FLOATS;
    const corners = [
      [-1, 0],
      [1, 0],
      [-1, 1],
      [1, 1],
    ];
    for (let i = 0; i < 4; i += 1) {
      const o = base + i * FLOATS;
      vertData[o] = ax;
      vertData[o + 1] = ay;
      vertData[o + 2] = az;
      vertData[o + 3] = bx;
      vertData[o + 4] = by;
      vertData[o + 5] = bz;
      vertData[o + 6] = color[0];
      vertData[o + 7] = color[1];
      vertData[o + 8] = color[2];
      vertData[o + 9] = corners[i][0];
      vertData[o + 10] = corners[i][1];
      vertData[o + 11] = width;
      vertData[o + 12] = glow;
    }
    segmentCount += 1;
  }

  function uploadLines() {
    if (segmentCount === gpuSegments) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertBuf);
    if (gpuSegments === 0) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertData.subarray(0, segmentCount * 4 * FLOATS));
    } else {
      const start = gpuSegments * 4 * FLOATS;
      gl.bufferSubData(gl.ARRAY_BUFFER, start * 4, vertData.subarray(start, segmentCount * 4 * FLOATS));
    }
    gpuSegments = segmentCount;
  }

  function basis() {
    const eye = {
      x: camera.target.x + camera.radius * Math.sin(camera.phi) * Math.sin(camera.theta),
      y: camera.target.y + camera.radius * Math.cos(camera.phi),
      z: camera.target.z + camera.radius * Math.sin(camera.phi) * Math.cos(camera.theta),
    };
    const forward = normalize({
      x: camera.target.x - eye.x,
      y: camera.target.y - eye.y,
      z: camera.target.z - eye.z,
    });
    const worldUp = { x: 0, y: 1, z: 0 };
    const right = normalize({
      x: forward.y * worldUp.z - forward.z * worldUp.y,
      y: forward.z * worldUp.x - forward.x * worldUp.z,
      z: forward.x * worldUp.y - forward.y * worldUp.x,
    });
    const up = normalize({
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x,
    });
    return { eye, forward, right, up };
  }

  function lookAt(eye, forward, right, up) {
    view[0] = right.x;
    view[1] = up.x;
    view[2] = -forward.x;
    view[3] = 0;
    view[4] = right.y;
    view[5] = up.y;
    view[6] = -forward.y;
    view[7] = 0;
    view[8] = right.z;
    view[9] = up.z;
    view[10] = -forward.z;
    view[11] = 0;
    view[12] = -(right.x * eye.x + right.y * eye.y + right.z * eye.z);
    view[13] = -(up.x * eye.x + up.y * eye.y + up.z * eye.z);
    view[14] = forward.x * eye.x + forward.y * eye.y + forward.z * eye.z;
    view[15] = 1;
  }

  function perspective(aspect) {
    proj.fill(0);
    const f = 1 / Math.tan(FOV / 2);
    const near = 2;
    const far = 20000;
    proj[0] = f / aspect;
    proj[5] = f;
    proj[10] = (far + near) / (near - far);
    proj[11] = -1;
    proj[14] = (2 * far * near) / (near - far);
  }

  function multiply(a, b, out) {
    for (let c = 0; c < 4; c += 1) {
      for (let r = 0; r < 4; r += 1) {
        out[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
  }

  function updateCamera() {
    const { eye, forward, right, up } = basis();
    lookAt(eye, forward, right, up);
    perspective(width / Math.max(1, height));
    const tmp = new Float32Array(16);
    multiply(proj, view, tmp);
    viewProj.set(tmp);
    return { eye, forward, right, up };
  }

  function colorOf(network, widthScale, hueShift) {
    const light = (50 + (1 - widthScale) * 28) / 100;
    return hslToRgb(network.params.hue + hueShift, 0.8, light);
  }

  function spawnBranch(network, x, y, z, dir, depth, width, hueShift, pace) {
    if (network.full || network.alive >= MAX_ALIVE) {
      network.full = true;
      return false;
    }
    network.alive += 1;
    alive += 1;
    const branchPace = pace == null ? randomPace() : pace;
    branches.push({
      network,
      x,
      y,
      z,
      lx: x,
      ly: y,
      lz: z,
      since: 0,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      depth,
      w: width,
      hueShift,
      traveled: 0,
      interval: network.params.gap * (0.28 + Math.random() * 1.85) * (1 + depth * 0.06),
      pace: branchPace,
      drift: (Math.random() - 0.5) * 0.02,
      driftAxis: randomDir(),
      alive: true,
      mature: false,
      phase: Math.random() * Math.PI * 2,
    });
    return true;
  }

  function spawn(x, y, z, settings) {
    const network = {
      id: nextId,
      params: { ...settings },
      hueShift: (Math.random() - 0.5) * 24,
      alive: 0,
      full: false,
    };
    nextId += 1;
    networks.push(network);
    somas.push({ network, x, y, z });
    const count = network.params.sprouts;
    for (let i = 0; i < count; i += 1) {
      spawnBranch(network, x, y, z, randomDir(), 0, 1, network.hueShift, randomPace());
    }
    if (typeof NN3D.onChange === "function") NN3D.onChange();
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
    const probability = settings.branchProb * 0.86 ** branch.depth;
    if (Math.random() > probability) return;
    const spread = (settings.branchAngle * Math.PI) / 180;
    const roll = Math.random();
    const dir = { x: branch.dx, y: branch.dy, z: branch.dz };
    let spawned = false;
    if (roll < 0.74) {
      const child = deflect(dir, spread * (0.45 + Math.random() * 0.7));
      const kept = deflect(dir, spread * (0.12 + Math.random() * 0.28));
      branch.dx = kept.x;
      branch.dy = kept.y;
      branch.dz = kept.z;
      spawned = spawnBranch(
        network,
        branch.x,
        branch.y,
        branch.z,
        child,
        branch.depth + 1,
        branch.w * 0.74,
        branch.hueShift + (Math.random() - 0.5) * 18,
        randomPace(branch.pace),
      );
    } else if (roll < 0.9) {
      spawned = spawnBranch(
        network,
        branch.x,
        branch.y,
        branch.z,
        deflect(dir, spread * (0.7 + Math.random() * 0.5)),
        branch.depth + 1,
        branch.w * 0.58,
        branch.hueShift + (Math.random() - 0.5) * 18,
        randomPace(branch.pace),
      );
    } else {
      const a = spawnBranch(
        network,
        branch.x,
        branch.y,
        branch.z,
        deflect(dir, spread * (0.4 + Math.random() * 0.4)),
        branch.depth + 1,
        branch.w * 0.66,
        branch.hueShift + (Math.random() - 0.5) * 18,
        randomPace(branch.pace),
      );
      const b = spawnBranch(
        network,
        branch.x,
        branch.y,
        branch.z,
        deflect(dir, -spread * (0.4 + Math.random() * 0.4)),
        branch.depth + 1,
        branch.w * 0.66,
        branch.hueShift + (Math.random() - 0.5) * 18,
        randomPace(branch.pace),
      );
      spawned = a || b;
    }
    if (!spawned) return;
  }

  function commit(branch) {
    const color = colorOf(branch.network, branch.w, branch.hueShift);
    const width = Math.max(0.8, branch.network.params.thickness * branch.w);
    pushSegment(branch.lx, branch.ly, branch.lz, branch.x, branch.y, branch.z, color, width, branch.network.params.glow);
    branch.lx = branch.x;
    branch.ly = branch.y;
    branch.lz = branch.z;
    branch.since = 0;
  }

  function grow(branch, distance) {
    const settings = branch.network.params;
    branch.phase += distance * 0.08;
    const flutter = (Math.random() - 0.5) * settings.wander * 0.05;
    branch.dx += branch.driftAxis.x * branch.drift * distance + flutter;
    branch.dy += branch.driftAxis.y * branch.drift * distance + flutter;
    branch.dz += branch.driftAxis.z * branch.drift * distance + flutter;
    const dir = normalize({ x: branch.dx, y: branch.dy, z: branch.dz });
    branch.dx = dir.x;
    branch.dy = dir.y;
    branch.dz = dir.z;
    branch.x += dir.x * distance;
    branch.y += dir.y * distance;
    branch.z += dir.z * distance;
    branch.since += distance;
    branch.traveled += distance;
    if (branch.since >= 5) commit(branch);
    if (branch.mature || branch.traveled < branch.interval) return;
    branch.traveled = 0;
    branch.interval = settings.gap * (0.28 + Math.random() * 1.85) * (1 + branch.depth * 0.06);
    considerFork(branch);
  }

  function step(dt) {
    if (!gl) return;
    for (const branch of branches) {
      if (!branch.alive) continue;
      const flutter = 0.74 + 0.52 * (0.5 + 0.5 * Math.sin(branch.phase * 0.37));
      let left = (branch.network.params.speed * branch.pace * flutter * 78 * dt) / 1000;
      while (left > 0 && branch.alive) {
        const distance = Math.min(2.6, left);
        left -= distance;
        grow(branch, distance);
      }
    }
  }

  function drawPoints(frame) {
    const count = somas.length + branches.length;
    if (count === 0) return;
    if (count > pointCapacity) {
      pointCapacity = count * 2;
      pointData = new Float32Array(pointCapacity * 6);
      gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pointData.byteLength, gl.DYNAMIC_DRAW);
    }
    let n = 0;
    const write = (x, y, z, color) => {
      const o = n * 6;
      pointData[o] = x;
      pointData[o + 1] = y;
      pointData[o + 2] = z;
      pointData[o + 3] = color[0];
      pointData[o + 4] = color[1];
      pointData[o + 5] = color[2];
      n += 1;
    };
    for (const soma of somas) write(soma.x, soma.y, soma.z, [1, 1, 1]);
    for (const branch of branches) {
      if (!branch.alive) continue;
      write(branch.x, branch.y, branch.z, colorOf(branch.network, branch.w, branch.hueShift));
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pointData.subarray(0, n * 6));
    gl.useProgram(pointProgram);
    gl.uniformMatrix4fv(gl.getUniformLocation(pointProgram, "uViewProj"), false, viewProj);
    gl.uniform1f(gl.getUniformLocation(pointProgram, "uSize"), 7);
    gl.bindVertexArray(pointVao);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.bindVertexArray(null);
  }

  function drawLines(glowPass) {
    gl.useProgram(lineProgram);
    gl.uniformMatrix4fv(gl.getUniformLocation(lineProgram, "uViewProj"), false, viewProj);
    gl.uniform2f(gl.getUniformLocation(lineProgram, "uResolution"), width, height);
    gl.uniform1f(gl.getUniformLocation(lineProgram, "uGlowPass"), glowPass);
    gl.bindVertexArray(vao);
    gl.drawElements(gl.TRIANGLES, segmentCount * 6, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  function draw() {
    if (!gl) return;
    updateCamera();
    uploadLines();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.027, 0.035, 0.059, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(lineProgram);
    gl.uniformMatrix4fv(gl.getUniformLocation(lineProgram, "uViewProj"), false, viewProj);
    gl.uniform2f(gl.getUniformLocation(lineProgram, "uResolution"), width, height);
    gl.uniform1f(gl.getUniformLocation(lineProgram, "uGlowPass"), 0);
    gl.bindVertexArray(gridVao);
    gl.drawElements(gl.TRIANGLES, gridCount * 6, gl.UNSIGNED_INT, 0);

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    if (segmentCount > 0) {
      drawLines(1);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      drawLines(0);
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    drawPoints();
  }

  function resize(viewWidth, viewHeight) {
    if (!gl) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, viewWidth);
    height = Math.max(1, viewHeight);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  function rayPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const { eye, forward, right, up } = basis();
    const tan = Math.tan(FOV / 2);
    const aspect = width / Math.max(1, height);
    const dir = normalize({
      x: forward.x + right.x * nx * tan * aspect + up.x * ny * tan,
      y: forward.y + right.y * nx * tan * aspect + up.y * ny * tan,
      z: forward.z + right.z * nx * tan * aspect + up.z * ny * tan,
    });
    if (Math.abs(dir.y) < 1e-4) return { x: camera.target.x, y: 0, z: camera.target.z };
    const t = -eye.y / dir.y;
    const hit = t > 0
      ? { x: eye.x + dir.x * t, y: 0, z: eye.z + dir.z * t }
      : { x: eye.x + dir.x * camera.radius, y: 0, z: eye.z + dir.z * camera.radius };
    const dx = hit.x - camera.target.x;
    const dz = hit.z - camera.target.z;
    const dist = Math.hypot(dx, dz);
    const limit = Math.max(360, camera.radius * 1.8);
    if (dist > limit) {
      hit.x = camera.target.x + (dx / dist) * limit;
      hit.z = camera.target.z + (dz / dist) * limit;
    }
    return hit;
  }

  let drag = null;

  function bindInput(stage, readParams) {
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        /* optional */
      }
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        moved: false,
        theta: camera.theta,
        phi: camera.phi,
        target: { ...camera.target },
        radius: camera.radius,
      };
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      stage.classList.add("is-panning");
      if (drag.button === 2 || drag.button === 1) {
        const { right, up } = basis();
        const scale = drag.radius * 0.0016;
        camera.target.x = drag.target.x - right.x * dx * scale + up.x * dy * scale;
        camera.target.y = drag.target.y - right.y * dx * scale + up.y * dy * scale;
        camera.target.z = drag.target.z - right.z * dx * scale + up.z * dy * scale;
        return;
      }
      camera.theta = drag.theta - dx * 0.007;
      camera.phi = Math.min(Math.PI - 0.08, Math.max(0.08, drag.phi + dy * 0.007));
    });
    const end = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved && drag.button === 0) {
        const hit = rayPoint(event.clientX, event.clientY);
        spawn(hit.x, hit.y, hit.z, readParams());
      }
      stage.classList.remove("is-panning");
      drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        camera.radius = Math.min(9000, Math.max(80, camera.radius * Math.exp(event.deltaY * 0.0011)));
      },
      { passive: false },
    );
  }

  function clear() {
    networks.length = 0;
    somas.length = 0;
    branches.length = 0;
    alive = 0;
    segmentCount = 0;
    gpuSegments = 0;
    camera.target.x = 0;
    camera.target.y = 40;
    camera.target.z = 0;
    camera.radius = 780;
    if (typeof NN3D.onChange === "function") NN3D.onChange();
  }

  let ready = false;
  if (gl) {
    try {
      initGl();
      ready = true;
    } catch (error) {
      window.__nn3dError = String(error && error.stack ? error.stack : error);
    }
  }

  return {
    supported: ready,
    onChange: null,
    bindInput,
    resize,
    step,
    draw,
    clear,
    networkCount: () => networks.length,
    aliveCount: () => alive,
  };
})();

window.NN3D = NN3D;
