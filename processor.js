/* OpenCV runs only in this worker. No image network requests. */
const cvReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('OpenCVの初期化がタイムアウトしました。再読み込みしてください。')), 60000);
  self.Module = { onRuntimeInitialized() { clearTimeout(timer); resolve(); } };
  try {
    importScripts('assets/opencv.js');
    // Emscripten's Module is itself thenable. Never resolve a native Promise with it.
    if (self.cv?.then) self.cv.then(c => { self.cv = c; clearTimeout(timer); resolve(); });
    else if (self.cv?.Mat) { clearTimeout(timer); resolve(); }
  } catch (e) { clearTimeout(timer); reject(e); }
});
cvReady.then(() => self.postMessage({ type: 'ready' })).catch(e => self.postMessage({ type: 'fatal', error: e.message }));
const clamp = n => Math.min(255, Math.max(0, n));
self.onmessage = async ({ data: m }) => {
  const mats = [];
  const keep = x => (mats.push(x), x);
  try {
    await cvReady;
    const { width: w, height: h } = m;
    if (m.type === 'perspective') {
      const src = keep(cv.matFromImageData(new ImageData(new Uint8ClampedArray(m.buffer), w, h)));
      const p = m.points.map(p => [p.x * (w - 1), p.y * (h - 1)]);
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      let ow = Math.max(2, Math.round(Math.max(dist(p[0], p[1]), dist(p[3], p[2]))));
      let oh = Math.max(2, Math.round(Math.max(dist(p[0], p[3]), dist(p[1], p[2]))));
      const scale = Math.min(1, Math.sqrt(w * h / (ow * oh)), w / ow, h / oh);
      ow = Math.max(2, Math.floor(ow * scale)); oh = Math.max(2, Math.floor(oh * scale));
      const from = keep(cv.matFromArray(4, 1, cv.CV_32FC2, p.flat()));
      const to = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, ow - 1, 0, ow - 1, oh - 1, 0, oh - 1]));
      const matrix = keep(cv.getPerspectiveTransform(from, to));
      const out = keep(new cv.Mat());
      cv.warpPerspective(src, out, matrix, new cv.Size(ow, oh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
      const pixels = new Uint8ClampedArray(out.data);
      self.postMessage({ id: m.id, width: ow, height: oh, buffer: pixels.buffer }, [pixels.buffer]);
      return;
    }
    // Estimate a smooth, per-channel illumination field from a small image.
    const small = keep(cv.matFromImageData(new ImageData(new Uint8ClampedArray(m.small.buffer), m.small.width, m.small.height)));
    const dilated = keep(new cv.Mat()), field = keep(new cv.Mat());
    const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(13, 13)));
    // Filter only the illumination estimate here, never the original strokes.
    const illuminationInput = keep(new cv.Mat());
    cv.medianBlur(small, illuminationInput, 3);
    // Closing fills narrow dark strokes without shifting a sloping illumination
    // gradient upward as a standalone dilation would.
    cv.morphologyEx(illuminationInput, dilated, cv.MORPH_CLOSE, kernel);
    cv.GaussianBlur(dilated, field, new cv.Size(31, 31), 0);
    const pixels = new Uint8ClampedArray(m.buffer), out = new Uint8ClampedArray(pixels.length);
    const s = m.settings, fw = field.cols, fh = field.rows, fieldData = field.data;
    // Estimate the photographed paper colour from the brightest tenth of the
    // thumbnail. Local RGB normalization alone can erase a broad colour fill.
    const histogram = new Uint32Array(256);
    for (let i = 0; i < small.data.length; i += 4) histogram[Math.round(small.data[i] * .2126 + small.data[i + 1] * .7152 + small.data[i + 2] * .0722)]++;
    let cutoff = 255, count = 0;
    while (cutoff > 0 && count < fw * fh * .1) count += histogram[cutoff--];
    const paperRGB = [0, 0, 0]; let paperCount = 0;
    for (let i = 0; i < small.data.length; i += 4) {
      if (small.data[i] * .2126 + small.data[i + 1] * .7152 + small.data[i + 2] * .0722 < cutoff) continue;
      for (let c = 0; c < 3; c++) paperRGB[c] += small.data[i + c];
      paperCount++;
    }
    for (let c = 0; c < 3; c++) paperRGB[c] = Math.max(40, paperRGB[c] / Math.max(1, paperCount));
    const at = (x, y, c) => fieldData[(y * fw + x) * 4 + c];
    // Tiles with a halo keep the OpenCV working set bounded and avoid seams.
    for (let ty = 0; ty < h; ty += 384) {
      for (let tx = 0; tx < w; tx += 512) {
        const x0 = Math.max(0, tx - 2), y0 = Math.max(0, ty - 2);
        const x1 = Math.min(w, tx + 514), y1 = Math.min(h, ty + 386), tw = x1 - x0, th = y1 - y0;
        const tile = new Uint8ClampedArray(tw * th * 4);
        for (let y = 0; y < th; y++) tile.set(pixels.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1) * 4), y * tw * 4);
        let a, blur, rgb, filtered, denoised;
        try {
          a = cv.matFromImageData(new ImageData(tile, tw, th)); blur = new cv.Mat();
          cv.GaussianBlur(a, blur, new cv.Size(3, 3), 0.7);
          const blurData = blur.data;
          let denoiseData = tile;
          if (s.noise > 0) {
            rgb = new cv.Mat(); filtered = new cv.Mat(); denoised = new cv.Mat();
            cv.cvtColor(a, rgb, cv.COLOR_RGBA2RGB);
            // Smooth small camera fluctuations while preserving intensity edges.
            cv.bilateralFilter(rgb, filtered, 5, 8 + Math.min(200, s.noise) * .06, 2);
            cv.cvtColor(filtered, denoised, cv.COLOR_RGB2RGBA);
            denoiseData = denoised.data;
          }
          for (let y = ty; y < Math.min(h, ty + 384); y++) for (let x = tx; x < Math.min(w, tx + 512); x++) {
            const i = (y * w + x) * 4, j = ((y - y0) * tw + x - x0) * 4;
            const fx = x / Math.max(1, w - 1) * (fw - 1), fy = y / Math.max(1, h - 1) * (fh - 1);
            const ix = Math.floor(fx), iy = Math.floor(fy), nx = Math.min(fw - 1, ix + 1), ny = Math.min(fh - 1, iy + 1), dx = fx - ix, dy = fy - iy;
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            // Yellow paper has both R>G and G>B. Exclude that warm cast from red-ink protection.
            const redExcess = r - Math.max(g, b) - Math.max(0, g - b) * 1.25 - 6;
            const red = Math.min(1, Math.max(0, redExcess / 55) * s.red / 100);
            let lightR, lightG, lightB, baseR, baseG, baseB;
            for (let c = 0; c < 3; c++) {
              const original = pixels[i + c], smooth = blurData[j + c];
              const amount = Math.min(1, s.noise / 100);
              const filteredValue = original + (denoiseData[j + c] - original) * amount;
              // Do not sharpen the fine fluctuations we just denoised. Apply a
              // soft detail gate, with a bounded boost only on stronger strokes.
              const detail = filteredValue - smooth;
              const edgeWeight = Math.min(1, Math.max(0, (Math.abs(detail) - 5) / 15));
              const base = filteredValue + detail * Math.min(1, s.sharp / 100) * .3 * edgeWeight;
              const light = (at(ix, iy, c) * (1 - dx) + at(nx, iy, c) * dx) * (1 - dy) + (at(ix, ny, c) * (1 - dx) + at(nx, ny, c) * dx) * dy;
              if (c === 0) { lightR = light; baseR = base; }
              else if (c === 1) { lightG = light; baseG = base; }
              else { lightB = light; baseB = base; }
              // Set the paper endpoint first, then subtract the local ink deficit.
              // Clipping a brightened whole image would also erase faint pencil lines.
              const whiteMix = Math.min(1, s.white / 100);
              const paper = clamp(light + (255 - light) * whiteMix + s.brightness);
              const deficit = Math.max(0, light - base);
              // Continuous document-tone curve, not binary thresholding. Remove only
              // very small paper texture, then deepen existing ink without widening it.
              const scanMix = Math.min(1, s.white / 100);
              const textureFloor = (0.6 + Math.min(200, s.noise) / 100 * 5) * scanMix;
              const clean = Math.max(0, deficit - textureFloor);
              const gain = (1 + s.contrast / 100) * (1 + s.white / 100 * 1.6);
              const scanInk = 255 * (1 - Math.exp(-clean * gain / 255));
              const naturalInk = deficit * (1 + s.contrast / 100);
              const ink = naturalInk * (1 - scanMix) + scanInk * scanMix;
              const value = paper - ink;
              out[i + c] = clamp(value);
            }
            // Camera/JPEG colour speckle must not become coloured paper texture.
            // Neutral ink/paper use luminance; explicitly protected red keeps its colour.
            const neutral = out[i] * .2126 + out[i + 1] * .7152 + out[i + 2] * .0722;
            const neutralMix = Math.min(1, s.white / 100);
            let colorWeight = 0, illumination = 1;
            if (s.colorMode === 'color') {
              const nr = denoiseData[j] / paperRGB[0], ng = denoiseData[j + 1] / paperRGB[1], nb = denoiseData[j + 2] / paperRGB[2];
              const high = Math.max(nr, ng, nb), low = Math.min(nr, ng, nb);
              colorWeight = Math.min(1, Math.max(0, ((high - low) / Math.max(.01, high) - .04) / .12));
              if (nr > ng && nr > nb) colorWeight = Math.min(1, colorWeight * Math.max(.25, s.red / 100));
              // Common exposure for all channels preserves coloured regions even
              // when they are wider than the background-estimation kernel.
              illumination = Math.max(.35, Math.min(1.25, Math.max(lightR / paperRGB[0], lightG / paperRGB[1], lightB / paperRGB[2])));
            }
            for (let c = 0; c < 3; c++) {
              const value = out[i + c] * (1 - neutralMix) + neutral * neutralMix;
              const preserved = pixels[i + c] * (1 + s.white / 100 * 0.12) + s.brightness * .3;
              if (s.colorMode === 'color') {
                const base = c === 0 ? baseR : c === 1 ? baseG : baseB;
                const balanced = base * 255 / (paperRGB[c] * illumination);
                const colored = clamp((balanced - 128) * (1 + s.contrast / 500) + 128 + s.brightness * .1);
                out[i + c] = clamp(value * (1 - colorWeight) + colored * colorWeight);
              } else out[i + c] = clamp(value * (1 - red) + preserved * red);
            }
            out[i + 3] = 255;
          }
        } finally { a?.delete(); blur?.delete(); rgb?.delete(); filtered?.delete(); denoised?.delete(); }
      }
      self.postMessage({ type: 'progress', id: m.id, value: Math.round(Math.min(h, ty + 384) / h * 100) });
    }
    self.postMessage({ id: m.id, width: w, height: h, buffer: out.buffer }, [out.buffer]);
  } catch (e) { self.postMessage({ id: m.id, error: typeof e === 'number' ? '画像処理に失敗しました。画像を小さくして再試行してください。' : e.message }); }
  finally { mats.reverse().forEach(m => m.delete()); }
};
