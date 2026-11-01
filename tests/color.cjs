const assert = require('node:assert/strict'), fs = require('node:fs');
const cv = require('../assets/opencv.js');
(async () => {
  await new Promise(resolve => cv.then(() => resolve()));
  let result;
  const context = { cv, postMessage(m) { if (m.error) throw Error(m.error); if (m.buffer) result = m; } };
  class LocalImageData { constructor(data, width, height) { Object.assign(this, { data, width, height }); } }
  new Function('self', 'importScripts', 'ImageData', 'cv', fs.readFileSync(require.resolve('../processor.js'), 'utf8'))(context, () => {}, LocalImageData, cv);
  const w=320, h=200, pixels=new Uint8ClampedArray(w*h*4);
  const swatches=[[200,40,45],[35,75,205],[45,165,65],[225,195,45]];
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const shade=.8+.2*x/(w-1), paper=[235,225,205];
    let color=paper;
    // Broad 60x70 fills, larger than the background-estimation kernel.
    for(let n=0;n<4;n++) if(x>=20+n*75&&x<80+n*75&&y>=65&&y<135) color=swatches[n];
    if(y===165&&x>20&&x<300) color=[200,190,170]; // faint warm pencil
    pixels.set([...color.map(v=>Math.round(v*shade)),255],(y*w+x)*4);
  }
  const original=pixels.slice();
  const settings={brightness:40,contrast:20,white:160,sharp:100,noise:100,red:200,colorMode:'color'};
  const run=async mode=>{ await context.onmessage({data:{id:1,type:'correct',width:w,height:h,buffer:pixels.buffer,small:{width:w,height:h,buffer:pixels.slice().buffer},settings:{...settings,colorMode:mode}}}); return new Uint8ClampedArray(result.buffer); };
  const color=await run('color'), scan=await run('scan');
  const at=(array,x,y)=>Array.from(array.subarray((y*w+x)*4,(y*w+x)*4+3));
  const [red,blue,green,yellow]=[0,1,2,3].map(n=>at(color,45+n*75,100));
  assert.ok(red[0]>red[1]+60&&red[0]>red[2]+60,'red fill lost');
  assert.ok(blue[2]>blue[0]+60&&blue[2]>blue[1]+60,'broad blue fill lost');
  assert.ok(green[1]>green[0]+60&&green[1]>green[2]+60,'broad green fill lost');
  assert.ok(yellow[0]>yellow[2]+60&&yellow[1]>yellow[2]+60,'yellow fill lost');
  assert.ok(Math.min(...at(color,160,25))>=248,'paper not white');
  assert.ok(Math.max(...at(color,160,165))<225,'faint pencil lost in colour mode');
  for(const n of [1,2]){const rgb=at(scan,45+n*75,100);assert.ok(Math.max(...rgb)-Math.min(...rgb)<=1,'scan mode changed');}
  assert.deepEqual(pixels,original,'original changed');
  const noisePixels=new Uint8ClampedArray(w*h*4);let seed=91;
  for(let i=0;i<noisePixels.length;i+=4){for(let c=0;c<3;c++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;noisePixels[i+c]=[210,200,180][c]+seed%13-6;}noisePixels[i+3]=255;}
  await context.onmessage({data:{id:2,type:'correct',width:w,height:h,buffer:noisePixels.buffer,small:{width:w,height:h,buffer:noisePixels.slice().buffer},settings}});
  const cleaned=new Uint8ClampedArray(result.buffer), values=[];let maxChroma=0;
  for(let y=20;y<h-20;y++)for(let x=20;x<w-20;x++){const rgb=at(cleaned,x,y);values.push((rgb[0]+rgb[1]+rgb[2])/3);maxChroma=Math.max(maxChroma,Math.max(...rgb)-Math.min(...rgb));}
  const mean=values.reduce((a,b)=>a+b,0)/values.length,sd=Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length);
  assert.ok(mean>=251&&sd<=4&&maxChroma<=10,`colour speckle amplified: ${mean}, ${sd}, ${maxChroma}`);
  console.log(`PASS: colour paper noise mean=${mean.toFixed(2)}, sd=${sd.toFixed(2)}, maximum chroma=${maxChroma}`);
  console.log(JSON.stringify({result:'PASS',red,blue,green,yellow,paper:at(color,160,25),originalUnchanged:true,scanModeAvailable:true},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
