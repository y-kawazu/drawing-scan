// Real bundled OpenCV + actual processor.js; no browser / API mocks for pixel operations.
const fs = require('node:fs'), assert = require('node:assert/strict');
const cv = require('../assets/opencv.js');
const initialized = new Promise(resolve => cv.then(() => resolve()));
(async () => {
  await initialized;
  let response;
  const context = { cv, self: null, Uint8ClampedArray, console, setTimeout, clearTimeout,
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    importScripts() {}, postMessage(m) { if (m.id && m.type !== 'progress') response = m; }
  };
  context.self = context;
  // Run in the normal JS realm: vm globals distort the performance of per-pixel loops.
  new Function('self', 'importScripts', 'ImageData', 'cv', fs.readFileSync(require.resolve('../processor.js'), 'utf8'))(context, context.importScripts, context.ImageData, cv);
  const started = performance.now();
  const width = process.env.STRESS ? 4000 : 1030, height = process.env.STRESS ? 3000 : 780, pixels = new Uint8ClampedArray(width * height * 4);
  // Yellow/uneven paper with single pixel pencil lines crossing both tile boundaries.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4, light = 205 + Math.round(30 * x / width); pixels.set([light + 8, light, light - 15, 255], i); if (x === 512 || y === 384) pixels.set([light - 17, light - 22, light - 28, 255], i); if (y === 200 && x > 100 && x < 900) pixels.set([180, 45, 40, 255], i); }
  const input = pixels.slice(), smallW = 128, smallH = 97, small = new Uint8ClampedArray(smallW * smallH * 4);
  for (let y = 0; y < smallH; y++) for (let x = 0; x < smallW; x++) { const sx = Math.floor(x * width / smallW), sy = Math.floor(y * height / smallH); small.set(input.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * smallW + x) * 4); }
  await context.onmessage({ data: { id: 1, type: 'correct', width, height, buffer: pixels.buffer, small: { width: smallW, height: smallH, buffer: small.buffer }, settings: { brightness: 0, contrast: 2, white: 32, sharp: 12, noise: 0, red: 100 } } });
  assert.ok(!response.error, response.error); assert.equal(response.width, width); assert.equal(response.height, height); assert.deepEqual(pixels, input, 'input pixels changed');
  const out = new Uint8ClampedArray(response.buffer), gray = (x, y) => (out[(y * width + x) * 4] + out[(y * width + x) * 4 + 1] + out[(y * width + x) * 4 + 2]) / 3;
  assert.ok(gray(512, 400) + 12 < gray(510, 400), 'faint vertical line lost');
  assert.ok(gray(600, 384) + 12 < gray(600, 382), 'faint horizontal line lost');
  const ri = (200 * width + 400) * 4; assert.ok(out[ri] - out[ri + 1] > 120, 'red chroma lost');
  assert.ok(gray(100, 100) > (input[(100 * width + 100) * 4] + input[(100 * width + 100) * 4 + 1] + input[(100 * width + 100) * 4 + 2]) / 3, 'paper did not brighten');
  // Regression: high red protection must not preserve yellow paper, and standard
  // brightness must not clip the faint ink deficit away with the paper endpoint.
  const warmW = 160, warmH = 128, warm = new Uint8ClampedArray(warmW * warmH * 4);
  for (let y = 0; y < warmH; y++) for (let x = 0; x < warmW; x++) {
    const shadow = .65 + .35 * x / (warmW - 1);
    const paper = [245, 210, 155].map(v => Math.round(v * shadow));
    warm.set([...paper, 255], (y * warmW + x) * 4);
    if (y === 64) warm.set([...paper.map(v => v - 18), 255], (y * warmW + x) * 4);
    if (y === 90 && x > 30 && x < 130) warm.set([210, 80, 75, 255], (y * warmW + x) * 4);
  }
  const warmOriginal = warm.slice();
  const defaults = new Function(fs.readFileSync(require.resolve('../app.js'), 'utf8').match(/const presets = .*;/)[0] + ';return presets.standard;')();
  const names = ['brightness', 'contrast', 'white', 'sharp', 'noise', 'red'];
  await context.onmessage({ data: { id: 3, type: 'correct', width: warmW, height: warmH, buffer: warm.buffer, small: { width: warmW, height: warmH, buffer: warm.slice().buffer }, settings: Object.fromEntries(names.map((n,i) => [n,defaults[i]])) } });
  assert.ok(!response.error, response.error);
  const warmOut = new Uint8ClampedArray(response.buffer);
  const sample = (x,y) => Array.from(warmOut.subarray((y * warmW + x) * 4, (y * warmW + x) * 4 + 3));
  for (const x of [20,80,140]) {
    assert.ok(Math.min(...sample(x,30)) >= 248, 'warm/shadowed paper was not white');
    assert.ok(Math.min(...sample(x,30)) - Math.max(...sample(x,64)) >= 35, 'standard settings did not deepen faint line');
  }
  assert.ok(sample(80,90)[0] - sample(80,90)[1] > 100, 'red ink lost on warm paper');
  assert.deepEqual(warm, warmOriginal, 'warm original changed');
  console.log('PASS: standard settings whiten yellow/shadowed paper, retain faint line and red ink');
  const nw = 192, nh = 128, noisy = new Uint8ClampedArray(nw * nh * 4);
  let seed = 713;
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = 190 + seed % 13 - 6;
    noisy.set([value, value, value, 255], (y * nw + x) * 4);
    if (y === 80) noisy.set([172,172,172,255], (y * nw + x) * 4);
  }
  await context.onmessage({ data: { id: 4, type: 'correct', width: nw, height: nh, buffer: noisy.buffer, small: { width: nw, height: nh, buffer: noisy.slice().buffer }, settings: Object.fromEntries(names.map((n,i) => [n,defaults[i]])) } });
  assert.ok(!response.error, response.error);
  const cleaned = new Uint8ClampedArray(response.buffer), background = [];
  for(let y=20;y<50;y++) for(let x=20;x<170;x++) background.push(cleaned[(y*nw+x)*4]);
  const mean = background.reduce((a,b)=>a+b,0)/background.length;
  const deviation = Math.sqrt(background.reduce((a,b)=>a+(b-mean)**2,0)/background.length);
  assert.ok(mean >= 253 && deviation <= 3, `background noise amplified: mean=${mean}, sd=${deviation}`);
  assert.ok(cleaned[(80*nw+90)*4] < 225, 'noise reduction erased faint one-pixel line');
  console.log(`PASS: noisy-paper background mean=${mean.toFixed(2)}, sd=${deviation.toFixed(2)}; faint line retained`);
  await context.onmessage({ data: { id: 2, type: 'perspective', width, height, buffer: input.buffer, points: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}] } });
  assert.ok(!response.error, response.error); assert.ok(response.width <= width && response.height <= height); assert.ok(response.buffer.byteLength > 0);
  console.log(JSON.stringify({ result: 'PASS', elapsedSeconds: ((performance.now()-started)/1000).toFixed(2), correctionSize: `${width}x${height}`, originalUnchanged: true, faintLineContrast: gray(510,400)-gray(512,400), redChroma: out[ri]-out[ri+1], perspectiveSize: `${response.width}x${response.height}` }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
