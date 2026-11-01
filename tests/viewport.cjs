const assert = require('node:assert/strict'), fs = require('node:fs');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const source = app.match(/function boundPan\([\s\S]*?\n}/)[0];
const boundPan = new Function(source + ';return boundPan;')();
// A fitted sheet cannot be dragged out of its centered position.
const fitted = boundPan(1e6, -1e6, 260, 300, 340, 400);
assert.ok(fitted.every(v => Math.abs(v) === 0));
// Zoomed sheets can pan across the full drawing but cannot uncover blank edges.
for (const [w,h,vw,vh] of [[800,1200,340,450],[1200,600,340,450],[240,1400,340,450]]) {
  for (const dx of [-1e6,-50,0,50,1e6]) for (const dy of [-1e6,-50,0,50,1e6]) {
    const [px,py] = boundPan(dx,dy,w,h,vw,vh);
    const left = (vw-w)/2+px, top = (vh-h)/2+py;
    if(w>=vw) { assert.ok(left<=0 && left+w>=vw); } else assert.equal(Math.abs(px),0);
    if(h>=vh) { assert.ok(top<=0 && top+h>=vh); } else assert.equal(Math.abs(py),0);
  }
}
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
assert.ok(!html.includes('DRAWING SCAN'));
assert.ok(html.indexOf('id="drop"') < html.indexOf('class="card controls"'));
assert.ok(html.indexOf('class="card controls"') < html.indexOf('class="card preview-card"'));
assert.ok(html.includes('<details id="adjustments">'));
assert.ok(!html.includes('<details id="adjustments" open'));
const headings=[...html.matchAll(/<h2><span class="step">(\d)<\/span>(.*?)<\/h2>/g)].map(m=>m[1]+':'+m[2]);
assert.deepEqual(headings,['1:図面を取り込む','2:図面を補正','3:プレビュー']);
console.log('PASS: fitted/zoomed pan bounds, 1 → 2 → 3 order, collapsed adjustments');
