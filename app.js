'use strict';
const $ = id => document.getElementById(id);
const presets = { weak: [0, 2, 32, 12, 0, 100], standard: [40, 20, 160, 100, 100, 200], strong: [60, 36, 220, 140, 130, 200] };
const controls = [["brightness","明るさ",-80,160],["contrast","コントラスト",-60,100],["white","背景白色化・影軽減",0,320],["sharp","シャープネス",0,200],["noise","ノイズ軽減",0,200],["red","赤色保護",0,400]];
const state = { original: null, geometry: null, corrected: null, file: null, jpeg: null, mode: 'corrected', split: .5, zoom: 1, panX: 0, panY: 0, busy: false, ready: false, points: [], picking: false, revision: 0 };
const view = $('view'), ctx = view.getContext('2d');
let worker, nextId = 0, pending = new Map(), timer, outputURL, deferredInstall;
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function copyCanvas(src) { const c = makeCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; }
function free(c) { if (c && c !== state.original && c !== state.geometry && c !== state.corrected) { c.width = c.height = 1; } }
function syncButtons() {
  $('auto').disabled = !state.ready || !state.geometry || state.busy;
  $('save').disabled = $('share').disabled = !state.jpeg || state.busy;
  for (const id of ['cameraBtn', 'fileBtn', 'demoBtn', 'rotateLeft', 'rotateRight', 'applyAngle', 'corners', 'resetGeometry', 'reset']) $(id).disabled = state.busy;
  document.querySelectorAll('#sliders input,#presets button,#angle,#quality').forEach(el => el.disabled = state.busy);
  $('applyCorners').disabled = state.busy || state.points.length !== 4;
  $('exportState').textContent = state.busy ? '画像を処理しています…' : state.jpeg ? 'JPGの準備ができました' : state.geometry ? '「自動補正する」を押してください' : '図面を選んで開始';
}
function invalidate() { state.revision++; state.jpeg = null; syncButtons(); }
function startWorker() {
  worker = new Worker('processor.js?v=10');
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'ready') { state.ready = true; status('準備ができました。画像を選んでください。'); syncButtons(); return; }
    if (m.type === 'fatal') { status(m.error, true); return; }
    if (m.type === 'progress') { status(`補正しています… ${m.value}%`); return; }
    const job = pending.get(m.id); if (!job) return;
    clearTimeout(job.timeout); pending.delete(m.id); m.error ? job.reject(new Error(m.error)) : job.resolve(m);
  };
  worker.onerror = () => { for (const j of pending.values()) { clearTimeout(j.timeout); j.reject(new Error('画像処理を継続できませんでした。再読み込みして、小さな画像でお試しください。')); } pending.clear(); state.ready = false; status('OpenCVを読み込めませんでした。再読み込みしてください。', true); syncButtons(); };
}
function job(data, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); worker.terminate(); state.ready = false; reject(new Error('処理時間の上限を超えました。再読み込みして小さな画像でお試しください。')); }, 120000);
    pending.set(id, { resolve, reject, timeout }); worker.postMessage({ ...data, id }, transfer);
  });
}
for (const [id, title, min, max] of controls) {
  const label = document.createElement('label'); label.htmlFor = id; label.append(document.createTextNode(title));
  const out = document.createElement('output'); out.id = `${id}Value`; label.append(out);
  const input = document.createElement('input'); Object.assign(input, { id, type: 'range', min, max }); label.append(input); $('sliders').append(label);
  input.addEventListener('input', () => { out.value = input.value; document.querySelectorAll('#presets button').forEach(b => { b.classList.remove('selected'); b.setAttribute('aria-pressed', 'false'); }); invalidate(); schedule(); });
}
function setPreset(name) { controls.forEach(([id], i) => { $(id).value = presets[name][i]; $(`${id}Value`).value = $(id).value; }); document.querySelectorAll('#presets button').forEach(b => { const selected = b.dataset.preset === name; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', String(selected)); }); }
setPreset('standard');
function settings() { return Object.fromEntries(controls.map(([id]) => [id, Number($(id).value)])); }
function schedule() { clearTimeout(timer); if (state.geometry && state.ready) timer = setTimeout(processImage, 300); }
async function processImage() {
  clearTimeout(timer); if (state.busy || !state.geometry || !state.ready) return;
  state.busy = true; invalidate(); const revision = state.revision; syncButtons(); status('補正を開始しています…');
  try {
    const source = state.geometry, pixels = source.getContext('2d').getImageData(0, 0, source.width, source.height);
    const scale = Math.min(1, 384 / Math.max(source.width, source.height));
    const small = makeCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
    small.getContext('2d').drawImage(source, 0, 0, small.width, small.height);
    const thumb = small.getContext('2d').getImageData(0, 0, small.width, small.height); small.width = small.height = 1;
    const result = await job({ type: 'correct', width: pixels.width, height: pixels.height, buffer: pixels.data.buffer, small: { width: thumb.width, height: thumb.height, buffer: thumb.data.buffer }, settings: settings() }, [pixels.data.buffer, thumb.data.buffer]);
    const old = state.corrected; state.corrected = makeCanvas(result.width, result.height); free(old);
    state.corrected.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(result.buffer), result.width, result.height), 0, 0);
    await prepareJPEG(revision); state.mode = 'corrected'; updateModes(); render(); status('補正が完了しました。拡大して数字・薄い線・赤い寸法を確認してください。');
  } catch (e) { state.jpeg = null; status(e.message || 'メモリが不足しました。画像を小さくして再試行してください。', true); }
  finally { state.busy = false; syncButtons(); }
}
async function prepareJPEG(revision = state.revision) {
  const source = state.corrected; if (!source) return;
  const blob = await new Promise(resolve => source.toBlob(resolve, 'image/jpeg', Number($('quality').value) / 100));
  if (!blob || !blob.size) throw new Error('JPGを作成できませんでした。画像を小さくしてください。');
  if (revision !== state.revision) return;
  const base = (state.file?.name || '図面').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  state.jpeg = new File([blob], `${base}_補正.jpg`, { type: 'image/jpeg' }); syncButtons();
}
function fit() { state.zoom = 1; state.panX = state.panY = 0; if (state.geometry) $('viewer').style.setProperty('--image-ratio', state.geometry.width + ' / ' + state.geometry.height); render(); }
function boundPan(panX, panY, imageWidth, imageHeight, viewportWidth, viewportHeight) {
  const limitX = Math.max(0, (imageWidth - viewportWidth) / 2);
  const limitY = Math.max(0, (imageHeight - viewportHeight) / 2);
  return [Math.max(-limitX, Math.min(limitX, panX)), Math.max(-limitY, Math.min(limitY, panY))];
}
function layout() {
  const source = state.geometry; if (!source) return null;
  const rect = $('viewer').getBoundingClientRect(), padding = rect.width < 820 ? 8 : 16;
  const scale = Math.min((rect.width - padding * 2) / source.width, (rect.height - padding * 2) / source.height) * state.zoom;
  [state.panX, state.panY] = boundPan(state.panX, state.panY, source.width * scale, source.height * scale, rect.width - padding * 2, rect.height - padding * 2);
  return { scale, x: (rect.width - source.width * scale) / 2 + state.panX, y: (rect.height - source.height * scale) / 2 + state.panY, w: source.width * scale, h: source.height * scale, cw: rect.width, ch: rect.height };
}
function render() {
  const rect = $('viewer').getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  view.width = Math.round(rect.width * dpr); view.height = Math.round(rect.height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
  const l = layout(); if (!l) return;
  const original = state.geometry, corrected = state.corrected || original;
  ctx.drawImage(state.mode === 'original' || state.picking ? original : corrected, l.x, l.y, l.w, l.h);
  if (state.mode === 'compare' && !state.picking) { const sx = rect.width * state.split; ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, rect.height); ctx.clip(); ctx.drawImage(original, l.x, l.y, l.w, l.h); ctx.restore(); ctx.strokeStyle = '#176457'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, rect.height); ctx.stroke(); }
  if (state.picking) {
    ctx.lineWidth = 2; ctx.strokeStyle = '#d36c25'; ctx.beginPath(); state.points.forEach((p, i) => { const x = l.x + p.x * l.w, y = l.y + p.y * l.h; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); if (state.points.length === 4) ctx.closePath(); ctx.stroke();
    state.points.forEach((p, i) => { const x = l.x + p.x * l.w, y = l.y + p.y * l.h; ctx.fillStyle = '#176457'; ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = 'white'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(i + 1, x, y + 5); });
  }
  $('zoomValue').value = `${Math.round(state.zoom * 100)}%`; $('dimensions').textContent = `${original.width.toLocaleString()} × ${original.height.toLocaleString()} px`;
}
function updateModes() { document.querySelector('.compare-slider').hidden = state.mode !== 'compare'; document.querySelectorAll('#modes button').forEach(b => { const selected = b.dataset.mode === state.mode; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', String(selected)); }); $('viewLabels').hidden = state.mode !== 'compare' || state.picking; }
async function decode(file) {
  if ('createImageBitmap' in window) { try { return await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'default' }); } catch {} }
  const url = URL.createObjectURL(file); const img = new Image(); img.decoding = 'async';
  try { img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
}
const pixelLimit = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform)) ? 12000000 : 20000000;
async function allowReduction(w, h) {
  $('largeInfo').textContent = `画像は ${w.toLocaleString()} × ${h.toLocaleString()} px です。作業画像を約${Math.round(pixelLimit / 1000000)}百万画素以内・長辺8,192px以内に縮小します。`;
  const dialog = $('largeDialog'); dialog.showModal();
  return new Promise(resolve => { dialog.onclose = () => resolve(dialog.returnValue === 'reduce'); });
}
async function load(file) {
  if (state.busy || !file) return;
  if (!/\.(jpe?g|png|heic|heif)$/i.test(file.name) || (file.type && !/^image\/(jpeg|png|heic|heif|heic-sequence|heif-sequence)$/i.test(file.type))) { status('JPG・PNG・対応端末のHEICを選択してください。', true); return; }
  if (!file.size || file.size > 60 * 1024 * 1024) { status('空のファイル、または60MBを超える画像は読み込めません。', true); return; }
  state.busy = true; syncButtons(); status('画像を端末内で読み込んでいます…'); let img, c;
  try {
    img = await decode(file); const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    if (!w || !h) throw new Error('画像サイズを取得できませんでした。');
    let scale = Math.min(1, Math.sqrt(pixelLimit / (w * h)), 8192 / w, 8192 / h);
    if (scale < 1 && !await allowReduction(w, h)) { status('読み込みをキャンセルしました。'); return; }
    c = makeCanvas(Math.max(1, Math.floor(w * scale)), Math.max(1, Math.floor(h * scale)));
    const cx = c.getContext('2d', { colorSpace: 'srgb' }); cx.fillStyle = 'white'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(img, 0, 0, c.width, c.height);
    cx.getImageData(0, 0, 1, 1); // Fail early if the browser rejected the canvas allocation.
    const old = [state.original, state.geometry, state.corrected]; state.original = c; state.geometry = c; state.corrected = null; old.forEach(free);
    clearTimeout(timer); setPreset('standard'); state.file = file; state.points = []; state.picking = false; state.mode = 'original'; invalidate(); $('angle').value = 0; $('angleValue').value = '0°'; $('empty').style.display = 'none'; updateModes(); fit();
    $('fileInfo').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB · 元画像 ${w} × ${h} px${scale < 1 ? ' → 同意に基づき作業画像を縮小しました' : ' · 解像度を維持'}。原本ファイルは保持されています。`;
    status(state.ready ? '画像を読み込みました。「自動補正する」を押してください。' : '画像を読み込みました。OpenCVの準備を待っています。');
  } catch (e) { free(c); status(`画像を読み込めませんでした。HEICは端末の対応が必要です。JPGへの変換や小さい画像でお試しください。${e.message ? ' ' + e.message : ''}`, true); }
  finally { img?.close?.(); state.busy = false; syncButtons(); }
}
async function geometryChanged(next) {
  const old = [state.geometry, state.corrected]; state.geometry = next; state.corrected = null; state.points = []; state.picking = false; old.forEach(free); invalidate(); updateModes(); fit(); await processImage();
}
async function rotate(deg) {
  if (!state.geometry || state.busy) return;
  const src = state.geometry, r = deg * Math.PI / 180, quarter = Math.abs(deg) === 90;
  const w = quarter ? src.height : Math.ceil(Math.abs(src.width * Math.cos(r)) + Math.abs(src.height * Math.sin(r)));
  const h = quarter ? src.width : Math.ceil(Math.abs(src.width * Math.sin(r)) + Math.abs(src.height * Math.cos(r)));
  if (w * h > pixelLimit * 1.55 || Math.max(w, h) > 10000) { status('回転後の画像が大きすぎます。小さな角度でお試しください。', true); return; }
  try { const c = makeCanvas(w, h), cx = c.getContext('2d'); cx.fillStyle = 'white'; cx.fillRect(0, 0, w, h); cx.translate(w / 2, h / 2); cx.rotate(r); cx.drawImage(src, -src.width / 2, -src.height / 2); await geometryChanged(c); }
  catch { status('回転に必要なメモリが不足しています。画像を小さくしてください。', true); }
}
function validQuad(points) {
  if (points.length !== 4) return false;
  const crosses = points.map((a, i) => { const b = points[(i + 1) % 4], c = points[(i + 2) % 4]; return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); });
  const area = Math.abs(points.reduce((sum, a, i) => { const b = points[(i + 1) % 4]; return sum + a.x * b.y - a.y * b.x; }, 0)) / 2;
  return crosses.every(c => c > .0001) && area > .02;
}
$('applyCorners').onclick = async () => {
  if (!state.ready || state.busy || !state.geometry) return;
  if (!validQuad(state.points)) { status('四隅を左上→右上→右下→左下の順で、交差しないよう選び直してください。', true); return; }
  state.busy = true; invalidate(); status('台形補正しています…');
  try { const src = state.geometry, data = src.getContext('2d').getImageData(0, 0, src.width, src.height); const result = await job({ type: 'perspective', width: src.width, height: src.height, buffer: data.data.buffer, points: state.points }, [data.data.buffer]); const c = makeCanvas(result.width, result.height); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(result.buffer), result.width, result.height), 0, 0); state.busy = false; await geometryChanged(c); }
  catch (e) { status(e.message, true); } finally { state.busy = false; syncButtons(); }
};
$('corners').onclick = () => { if (!state.geometry || state.busy) return; state.picking = !state.picking; state.points = []; fit(); updateModes(); syncButtons(); status(state.picking ? '左上→右上→右下→左下の順に四隅をタップしてください。範囲外は切り取られます。再度ボタンを押すとキャンセルします。' : '四隅の指定をキャンセルしました。'); };
$('rotateLeft').onclick = () => rotate(-90); $('rotateRight').onclick = () => rotate(90);
$('angle').oninput = () => { $('angleValue').value = `${$('angle').value}°`; };
$('applyAngle').onclick = async () => { const angle = Number($('angle').value); if (angle) { await rotate(angle); $('angle').value = 0; $('angleValue').value = '0°'; } };
$('resetGeometry').onclick = () => { if (state.original && !state.busy) geometryChanged(state.original); };
$('reset').onclick = () => { if (!state.original || state.busy) return; clearTimeout(timer); setPreset('standard'); const old = [state.geometry, state.corrected]; state.geometry = state.original; state.corrected = null; old.forEach(free); state.points = []; state.picking = false; state.mode = 'original'; $('angle').value = 0; $('angleValue').value = '0°'; $('quality').value = 95; $('qualityValue').value = '95%'; invalidate(); updateModes(); fit(); status('原本に戻しました。補正設定も初期値に戻しました。'); };
$('auto').onclick = processImage;
$('presets').onclick = e => { const name = e.target.dataset.preset; if (name && !state.busy) { setPreset(name); invalidate(); schedule(); } };
$('modes').onclick = e => { if (e.target.dataset.mode) { state.mode = e.target.dataset.mode; state.picking = false; state.points = []; updateModes(); syncButtons(); render(); } };
$('split').oninput = () => { state.split = Number($('split').value) / 100; render(); };
$('quality').oninput = async () => { $('qualityValue').value = `${$('quality').value}%`; invalidate(); if (state.corrected) { try { await prepareJPEG(); } catch (e) { status(e.message, true); } } };
$('cameraBtn').onclick = () => $('camera').click(); $('fileBtn').onclick = () => $('file').click();
for (const id of ['camera', 'file']) $(id).onchange = e => { load(e.target.files[0]); e.target.value = ''; };
for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) $('drop').addEventListener(type, e => { e.preventDefault(); $('drop').classList.toggle('dragover', type === 'dragenter' || type === 'dragover'); if (type === 'drop') load(e.dataTransfer.files[0]); });
$('save').onclick = () => {
  if (!state.jpeg || state.busy) return;
  if (outputURL) URL.revokeObjectURL(outputURL); outputURL = URL.createObjectURL(state.jpeg);
  const a = document.createElement('a'); a.href = outputURL; a.download = state.jpeg.name; document.body.append(a); a.click(); a.remove();
  status('JPGの保存操作を開始しました。ダウンロード先を確認してください。保存できない場合は「共有・メール送信」→「ファイルに保存」を選んでください。ブラウザーから保存完了は検出できません。');
};
$('share').onclick = () => {
  const file = state.jpeg; if (!file || state.busy) return;
  if (!window.isSecureContext || !navigator.share || !navigator.canShare?.({ files: [file] })) { status('この環境はJPGのファイル共有に対応していません。「JPG保存」で保存し、メールアプリから手動で添付してください。'); return; }
  // File already exists. Call share synchronously in the click handler to retain activation.
  try { navigator.share({ files: [file], title: '図面資料をお送りします', text: 'お世話になります。\n図面資料をお送りします。\nご確認をお願いいたします。' }).then(() => status('共有先への受け渡し操作が終了しました。メールの宛先はメールアプリの連絡先から選択してください。送信完了はこのアプリでは確認できません。')).catch(e => { if (e.name === 'AbortError') status('共有をキャンセルしました。'); else status('共有できませんでした。JPGを保存し、メールに手動で添付してください。', true); }); }
  catch { status('共有できませんでした。JPG保存から手動添付をご利用ください。', true); }
};
const pointers = new Map(); let drag, pinch;
view.addEventListener('pointerdown', e => {
  if (!state.geometry || state.busy) return; view.setPointerCapture(e.pointerId);
  if (state.picking) { const l = layout(), r = view.getBoundingClientRect(), x = (e.clientX - r.left - l.x) / l.w, y = (e.clientY - r.top - l.y) / l.h; if (x < 0 || x > 1 || y < 0 || y > 1) return; if (state.points.length === 4) state.points = []; state.points.push({ x, y }); render(); syncButtons(); return; }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); drag = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom }; }
});
view.addEventListener('pointermove', e => { if (!pointers.has(e.pointerId)) return; pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pointers.size === 2 && pinch) { const [a, b] = [...pointers.values()]; state.zoom = Math.max(1, Math.min(12, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance))); } else if (drag) { state.panX = drag.px + e.clientX - drag.x; state.panY = drag.py + e.clientY - drag.y; } render(); if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY }; });
function endPointer(e) { pointers.delete(e.pointerId); pinch = null; const p = [...pointers.values()][0]; drag = p ? { ...p, px: state.panX, py: state.panY } : null; }
view.addEventListener('pointerup', endPointer); view.addEventListener('pointercancel', endPointer);
view.addEventListener('wheel', e => { if (!state.geometry) return; e.preventDefault(); state.zoom = Math.max(1, Math.min(12, state.zoom * (e.deltaY > 0 ? .9 : 1.1))); render(); }, { passive: false });
$('zoomIn').onclick = () => { state.zoom = Math.min(12, state.zoom * 1.25); render(); }; $('zoomOut').onclick = () => { state.zoom = Math.max(1, state.zoom / 1.25); render(); }; $('fit').onclick = fit;
new ResizeObserver(render).observe($('viewer'));
$('reduce').onclick = () => $('largeDialog').close('reduce'); $('cancelLarge').onclick = () => $('largeDialog').close('cancel');
$('install').onclick = () => $('installDialog').showModal(); $('closeInstall').onclick = () => $('installDialog').close();
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('nativeInstall').hidden = false; });
$('nativeInstall').onclick = async () => { await deferredInstall?.prompt(); deferredInstall = null; $('nativeInstall').hidden = true; };
$('demoBtn').onclick = async () => {
  const c = makeCanvas(1600, 1100), cx = c.getContext('2d'), grad = cx.createLinearGradient(0, 0, 1600, 1100); grad.addColorStop(0, '#d5c7a4'); grad.addColorStop(.65, '#eee5cf'); grad.addColorStop(1, '#b0aaa0'); cx.fillStyle = grad; cx.fillRect(0, 0, c.width, c.height);
  cx.strokeStyle = '#60625d'; cx.lineWidth = 2; cx.strokeRect(240, 270, 1000, 510); cx.strokeRect(265, 295, 950, 460); cx.beginPath(); cx.moveTo(720, 270); cx.lineTo(720, 780); cx.stroke();
  cx.strokeStyle = '#aaa99d'; cx.lineWidth = 1; for (let i = 0; i < 8; i++) { cx.beginPath(); cx.moveTo(270 + i * 40, 300); cx.lineTo(310 + i * 40, 450); cx.stroke(); }
  cx.fillStyle = '#4c514c'; cx.font = '30px sans-serif'; cx.fillText('家具製作指示書  /  KN-2527', 220, 150); cx.font = '25px sans-serif'; cx.fillText('材料：合板  t=25  数量 2', 240, 900); cx.fillText('27', 650, 560); cx.fillText('25', 760, 560);
  cx.strokeStyle = '#ba3131'; cx.fillStyle = '#ba3131'; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(240, 210); cx.lineTo(1240, 210); cx.moveTo(240, 190); cx.lineTo(240, 250); cx.moveTo(1240, 190); cx.lineTo(1240, 250); cx.stroke(); cx.font = '32px sans-serif'; cx.fillText('1,200 mm', 630, 195); cx.fillText('赤字寸法を確認', 950, 950);
  const blob = await new Promise(r => c.toBlob(r, 'image/png')); c.width = c.height = 1; await load(new File([blob], 'サンプル図面.png', { type: 'image/png' }));
};
async function offlineStatus() { try { const cache = await caches.open('kawazunext-drawing-scan-v10'); const response = await cache.match(new URL('assets/opencv.js', location.href)); $('offline').textContent = response ? 'オフライン準備完了 · アプリとOpenCVを端末に保存しました。画像はキャッシュしません。' : 'オフライン準備中です。通信環境でしばらくお待ちください。'; } catch { $('offline').textContent = 'オフライン保存が利用できません。通常の通信環境でご利用ください。'; } }
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('service-worker.js').then(reg => { if (reg.active) offlineStatus(); reg.addEventListener('updatefound', () => { const installing = reg.installing; installing?.addEventListener('statechange', () => { if (installing.state === 'installed') { offlineStatus(); if (navigator.serviceWorker.controller) status('アプリの更新があります。作業を保存してから、アプリを閉じて開き直してください。'); } }); }); navigator.serviceWorker.ready.then(offlineStatus); }).catch(() => { $('offline').textContent = 'オフライン準備に失敗しました。HTTPSまたはlocalhostで開いてください。'; });
} else $('offline').textContent = 'PWA・共有にはHTTPSまたはlocalhostが必要です。';
startWorker(); syncButtons();
