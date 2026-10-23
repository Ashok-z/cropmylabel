'use strict';
/* ShipLabelCrop — client-side PDF label cropper.
 * Deps (CDN): pdf.js (render + bbox detection), pdf-lib (output PDF assembly).
 * Everything runs locally in the browser: no uploads, no watermark, no accounts.
 * Output sizes: 4x6 in (288x432 pt) or 100x150 mm (~283.46x425.20 pt), selectable.
 * Crop regions are rasterized at 200 DPI and embedded as PNGs, scaled to FIT
 * inside the output page (aspect preserved, centered, white background — never
 * stretched). Each page keeps an independent crop box and rotation; blank
 * pages are detected and can be skipped on export. */

(function () {
  if (typeof pdfjsLib === 'undefined' || typeof PDFLib === 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      var s = document.getElementById('status');
      if (s) {
        s.textContent = 'Could not load the required libraries. Please check your connection and reload.';
        s.classList.add('error');
      }
    });
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  var $ = function (id) { return document.getElementById(id); };

  // ---- output sizes: double-check the math ----
  // PDF points: 72 pt = 1 inch  =>  4 in = 288 pt, 6 in = 432 pt. Correct.
  // 100 mm = 100/25.4 in = 3.9370 in => 283.46 pt; 150 mm = 5.9055 in => 425.20 pt.
  var OUT_DPI = 200; // raster resolution of output pages
  var SIZES = {
    '4x6': {
      wPt: 288, hPt: 432,
      wPx: 800, hPx: 1200, // 800x1200 keeps the 4:6 = 2:3 ratio
      fileSuffix: '-4x6.pdf',
      shortName: '4×6',
      paperName: '4×6 in (101.6 × 152.4 mm)',
      hint: 'Output pages are exactly 4×6 in (101.6×152.4 mm, 288×432 pt). The cropped label is scaled to fit inside — never stretched — and centered on a white background.'
    },
    '100x150': {
      wPt: 100 * 72 / 25.4, hPt: 150 * 72 / 25.4,
      wPx: 787, hPx: 1181, // 100/25.4*200 = 787.4 px, 150/25.4*200 = 1181.1 px
      fileSuffix: '-100x150mm.pdf',
      shortName: '100×150',
      paperName: '100 × 150 mm',
      hint: 'Output pages are exactly 100×150 mm (≈283.5×425.2 pt). The cropped label is scaled to fit inside — never stretched — and centered on a white background.'
    }
  };
  function outSize() {
    var sel = $('sizeSelect');
    var v = sel && sel.value;
    return SIZES[v] || SIZES['4x6'];
  }
  function exportPages() {
    var skip = $('skipBlank') && $('skipBlank').checked;
    return state.pages.filter(function (p) { return !(skip && p.blank); });
  }
  function distinctSrcs() {
    var seen = {}, out = [];
    state.pages.forEach(function (p) {
      if (!seen[p.srcId]) { seen[p.srcId] = 1; out.push({ id: p.srcId, name: p.src }); }
    });
    return out;
  }
  function syncZipBtn() {
    var b = $('btnZip');
    if (!b) return;
    // ZIP export only makes sense with 2+ source files (and JSZip loaded).
    b.hidden = !(typeof JSZip !== 'undefined' && distinctSrcs().length >= 2);
  }

  var MIN_SIZE = 0.03; // min crop-box edge, normalized units

  var state = { docs: [], pages: [], current: 0, srcSeq: 0 };
  // pages[i] = { page, wPt, hPt,
  //   rect:{x,y,w,h} normalized 0..1 (y-down) in the page's ROTATED frame,
  //   rot: 0|90|180|270, blank: bool, extra: bool, thumb,
  //   srcId: unique id of the imported file this page came from,
  //   src: that file's base name (display / export naming only) }

  function setStatus(msg, isError) {
    var el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function resetAll() {
    state.docs = [];
    state.pages = [];
    state.current = 0;
    state.srcSeq = 0;
    $('pageList').innerHTML = '';
    $('toolUI').hidden = true;
    $('emptyState').hidden = false;
    var fi = $('fileInput');
    if (fi) fi.value = '';
    syncZipBtn();
    setStatus('');
  }

  // ---------------- file intake ----------------
  function initIntake() {
    var dropZone = $('dropZone'), fileInput = $('fileInput'), browseBtn = $('browseBtn');
    browseBtn.addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
    dropZone.addEventListener('click', function () { fileInput.click(); });
    ['dragover', 'dragenter'].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) { e.preventDefault(); dropZone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) { e.preventDefault(); dropZone.classList.remove('drag'); });
    });
    dropZone.addEventListener('drop', function (e) {
      var fs = e.dataTransfer.files;
      if (fs && fs.length) loadFiles(fs);
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length) loadFiles(fileInput.files);
    });
    var addBtn = $('btnAdd');
    if (addBtn) {
      addBtn.addEventListener('click', function () { fileInput.click(); });
    }
  }

  // Batch intake: one or more PDFs at once. Pages from every file are
  // APPENDED to the workspace (use "Start over" to clear); each page
  // remembers its source file so ZIP export can emit one PDF per file.
  // A bad file is skipped and reported; the rest still load.
  async function loadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var addedPages = 0, problems = [];
    for (var fi = 0; fi < files.length; fi++) {
      var file = files[fi];
      if (!/\.pdf$/i.test(file.name || '')) {
        problems.push((file.name || 'a file') + ' (not a PDF)');
        continue;
      }
      setStatus('Loading file ' + (fi + 1) + ' of ' + files.length + ': ' + file.name + '\u2026');
      var base = (file.name || 'labels').replace(/\.pdf$/i, '') || 'labels';
      var res = await loadOnePdf(file, base, ++state.srcSeq);
      if (res.error) problems.push(file.name + ' (' + res.error + ')');
      else addedPages += res.pages;
    }
    if (!state.pages.length) {
      setStatus('Could not load any of the selected files.' +
        (problems.length ? ' Skipped: ' + problems.join('; ') + '.' : ''), true);
      return;
    }
    $('emptyState').hidden = true;
    $('toolUI').hidden = false;
    await selectPage(state.current);
    syncZipBtn();
    if (addedPages === 0) {
      setStatus('No new pages were added.' +
        (problems.length ? ' Skipped: ' + problems.join('; ') + '.' : ''), true);
      return;
    }
    var srcs = distinctSrcs();
    var blanks = state.pages.filter(function (p) { return p.blank; }).length;
    var msg = 'Ready \u2014 ' + state.pages.length + ' page' + (state.pages.length === 1 ? '' : 's') +
      ' from ' + srcs.length + (srcs.length === 1 ? ' file' : ' files') + '.';
    if (blanks > 0) {
      msg += ' ' + blanks + ' blank page' + (blanks === 1 ? '' : 's') + ' will be skipped on export.';
    }
    if (problems.length) msg += ' Skipped: ' + problems.join('; ') + '.';
    msg += ' Drag the blue box to adjust the crop, then download.';
    setStatus(msg);
  }

  // Load one PDF and append its pages. Returns {pages:n} or {error:'…'}.
  async function loadOnePdf(file, base, srcId) {
    var bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      return { error: 'could not be read' };
    }
    // Magic-byte check: %PDF-
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
          bytes[3] === 0x46 && bytes[4] === 0x2D)) {
      return { error: 'not a real PDF' };
    }
    var doc;
    try {
      // Timeout guard: a misconfigured worker (or a stalled CDN) must never
      // leave the UI stuck on "Loading PDF…" forever.
      var loadPromise = pdfjsLib.getDocument({ data: bytes }).promise;
      var timeoutPromise = new Promise(function (_, reject) {
        setTimeout(function () {
          reject({ name: 'LoadTimeout', message: 'Timed out while loading the PDF.' });
        }, 30000);
      });
      doc = await Promise.race([loadPromise, timeoutPromise]);
    } catch (err) {
      if (err && err.name === 'PasswordException') return { error: 'password-protected' };
      if (err && err.name === 'LoadTimeout') return { error: 'loading timed out' };
      return { error: 'corrupted or unreadable' };
    }
    state.docs.push(doc);
    var n = doc.numPages, added = 0;
    for (var i = 1; i <= n; i++) {
      var page = await doc.getPage(i);
      var vp1 = page.getViewport({ scale: 1 }); // scale 1 => 72 DPI => CSS px == PDF points
      var det = await autoDetect(page, 0);
      var thumb = await renderThumb(page, 0);
      state.pages.push({
        page: page, wPt: vp1.width, hPt: vp1.height,
        rect: { x: det.x, y: det.y, w: det.w, h: det.h },
        rot: 0, blank: det.blank, extra: det.extra, thumb: thumb,
        srcId: srcId, src: base
      });
      added++;
      renderPageList();
    }
    return { pages: added };
  }

  // ---------------- bbox auto-detect ----------------
  // Render at ~100 DPI offscreen, build a coarse ink grid, dilate it to bridge
  // small intra-block gaps (text line spacing, barcode quiet zones), then split
  // the page into connected components (blocks) separated by significant
  // whitespace. Blocks near the largest block (gap <= ~15% of page height)
  // are merged as sections of the same label (address + barcode + tracking);
  // a distant block (e.g. footer instructions) stays separate and raises the
  // "extra content" hint instead of being silently included or dropped.
  // Detection runs in canvas pixel space (y-down), in the page's rotated frame;
  // the rect is stored normalized 0..1 so it is resolution-independent.
  // Padding ~4pt, clamped to the page.
  async function autoDetect(page, rot) {
    var scale = 100 / 72;
    var viewport = page.getViewport({ scale: scale, rotation: rot || 0 });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    var W = canvas.width, H = canvas.height;
    var data = ctx.getImageData(0, 0, W, H).data;

    var TH = 240; // a pixel counts as "ink" if any channel is darker than this
    var CELL = 10; // coarse grid cell size, px at 100 DPI
    var gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL);
    var grid = new Uint8Array(gw * gh); // 1 = cell holds ink
    var inkTotal = 0;
    for (var y = 0; y < H; y++) {
      var rowOff = y * W, grow = (((y / CELL) | 0) * gw);
      for (var x = 0; x < W; x++) {
        var o = (rowOff + x) * 4;
        if (data[o] < TH || data[o + 1] < TH || data[o + 2] < TH) {
          inkTotal++;
          grid[grow + ((x / CELL) | 0)] = 1;
        }
      }
    }

    var BLANK_INK_MAX = 200; // fewer ink px than this => blank page
    if (inkTotal < BLANK_INK_MAX) {
      return { x: 0.05, y: 0.05, w: 0.9, h: 0.9, blank: true, extra: false };
    }

    // Dilate (Chebyshev radius DIL cells) so intra-block gaps merge while
    // blocks separated by significant whitespace stay apart.
    var DIL = 2;
    var dg = new Uint8Array(gw * gh);
    for (var cy = 0; cy < gh; cy++) {
      for (var cx = 0; cx < gw; cx++) {
        if (!grid[cy * gw + cx]) continue;
        for (var dy = -DIL; dy <= DIL; dy++) {
          var ny = cy + dy;
          if (ny < 0 || ny >= gh) continue;
          var nrow = ny * gw;
          for (var dx = -DIL; dx <= DIL; dx++) {
            var nx = cx + dx;
            if (nx < 0 || nx >= gw) continue;
            dg[nrow + nx] = 1;
          }
        }
      }
    }

    // Connected components (4-connectivity) on the dilated grid.
    var comp = new Int32Array(gw * gh);
    for (var z = 0; z < comp.length; z++) comp[z] = -1;
    var boxes = [];
    var stack = [];
    for (var s = 0; s < gw * gh; s++) {
      if (!dg[s] || comp[s] !== -1) continue;
      var ci = boxes.length;
      var b = { minx: gw, miny: gh, maxx: -1, maxy: -1, cells: 0 };
      boxes.push(b);
      stack.length = 0;
      stack.push(s);
      comp[s] = ci;
      while (stack.length) {
        var c = stack.pop();
        var px = c % gw, py = (c / gw) | 0;
        b.cells++;
        if (px < b.minx) b.minx = px;
        if (px > b.maxx) b.maxx = px;
        if (py < b.miny) b.miny = py;
        if (py > b.maxy) b.maxy = py;
        if (px > 0 && dg[c - 1] && comp[c - 1] === -1) { comp[c - 1] = ci; stack.push(c - 1); }
        if (px < gw - 1 && dg[c + 1] && comp[c + 1] === -1) { comp[c + 1] = ci; stack.push(c + 1); }
        if (py > 0 && dg[c - gw] && comp[c - gw] === -1) { comp[c - gw] = ci; stack.push(c - gw); }
        if (py < gh - 1 && dg[c + gw] && comp[c + gw] === -1) { comp[c + gw] = ci; stack.push(c + gw); }
      }
    }

    // Drop noise specks; the rest are significant blocks, largest first.
    var sig = boxes.filter(function (bb) { return bb.cells >= 3; });
    if (!sig.length) {
      return { x: 0.05, y: 0.05, w: 0.9, h: 0.9, blank: true, extra: false };
    }
    sig.sort(function (a, bb) { return bb.cells - a.cells; });

    // Tight bbox from ORIGINAL (undilated) ink cells, for one component.
    function tightBox(topIdx) {
      var minX = W, minY = H, maxX = -1, maxY = -1;
      for (var yy = 0; yy < gh; yy++) {
        for (var xx = 0; xx < gw; xx++) {
          var gi = yy * gw + xx;
          if (comp[gi] === topIdx && grid[gi]) {
            var x0 = xx * CELL, y0 = yy * CELL;
            if (x0 < minX) minX = x0;
            if (y0 < minY) minY = y0;
            if (x0 + CELL - 1 > maxX) maxX = x0 + CELL - 1;
            if (y0 + CELL - 1 > maxY) maxY = y0 + CELL - 1;
          }
        }
      }
      if (maxX < 0) return null;
      return { x0: minX, y0: minY, x1: maxX, y1: maxY };
    }

    // Merge blocks that belong to the same label: seed with the largest block
    // and absorb any significant block whose edge-to-edge gap to the running
    // union is within GAP_MAX. Sections of one label (e.g. address block +
    // barcode block with whitespace between them) merge; a distant footer /
    // instructions block stays separate and keeps the "extra content" hint.
    var GAP_MAX = Math.max(60, H * 0.15); // px at 100 DPI
    var mergedIdx = [boxes.indexOf(sig[0])];
    var ub = tightBox(mergedIdx[0]);
    var changed = true;
    while (changed && ub) {
      changed = false;
      for (var i = 1; i < sig.length; i++) {
        var bi = boxes.indexOf(sig[i]);
        if (mergedIdx.indexOf(bi) !== -1) continue;
        var b = tightBox(bi);
        if (!b) continue;
        var dx = Math.max(ub.x0 - b.x1, b.x0 - ub.x1, 0);
        var dy = Math.max(ub.y0 - b.y1, b.y0 - ub.y1, 0);
        if (Math.sqrt(dx * dx + dy * dy) <= GAP_MAX) {
          mergedIdx.push(bi);
          if (b.x0 < ub.x0) ub.x0 = b.x0;
          if (b.y0 < ub.y0) ub.y0 = b.y0;
          if (b.x1 > ub.x1) ub.x1 = b.x1;
          if (b.y1 > ub.y1) ub.y1 = b.y1;
          changed = true;
        }
      }
    }
    if (!ub) return { x: 0.05, y: 0.05, w: 0.9, h: 0.9, blank: true, extra: false };
    var pad = 6; // px at 100 DPI ~= 4.3 pt
    var minX = Math.max(0, ub.x0 - pad);
    var minY = Math.max(0, ub.y0 - pad);
    var maxX = Math.min(W - 1, ub.x1 + pad);
    var maxY = Math.min(H - 1, ub.y1 + pad);
    return {
      x: minX / W,
      y: minY / H,
      w: (maxX - minX + 1) / W,
      h: (maxY - minY + 1) / H,
      blank: false,
      extra: sig.length > mergedIdx.length // some block(s) left out: genuinely separate content
    };
  }

  async function renderThumb(page, rot) {
    var base = page.getViewport({ scale: 1, rotation: rot || 0 });
    var scale = 150 / base.width;
    var viewport = page.getViewport({ scale: scale, rotation: rot || 0 });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  // ---------------- page list + preview ----------------
  function renderPageList() {
    var list = $('pageList');
    list.innerHTML = '';
    state.pages.forEach(function (p, idx) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'page-thumb' + (idx === state.current ? ' active' : '') + (p.blank ? ' blank' : '');
      var img = document.createElement('img');
      img.src = p.thumb;
      img.alt = 'Page ' + (idx + 1) + ' thumbnail';
      b.appendChild(img);
      var cap = document.createElement('div');
      cap.textContent = 'Page ' + (idx + 1);
      if (p.blank) {
        var tag = document.createElement('span');
        tag.className = 'blank-tag';
        tag.textContent = ' · blank';
        cap.appendChild(tag);
      }
      b.appendChild(cap);
      b.addEventListener('click', function () { selectPage(idx); });
      list.appendChild(b);
    });
  }

  async function selectPage(i) {
    state.current = i;
    var p = state.pages[i];
    var wrap = $('previewWrap');
    var cssW = Math.min(680, wrap.clientWidth || 680);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var v1 = p.page.getViewport({ scale: 1, rotation: p.rot });
    p.wPt = v1.width; p.hPt = v1.height;
    var scale = (cssW * dpr) / p.wPt;
    var viewport = p.page.getViewport({ scale: scale, rotation: p.rot });
    var canvas = $('previewCanvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    canvas.style.width = cssW + 'px';
    canvas.style.height = (viewport.height / dpr) + 'px';
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setStatus('Rendering page ' + (i + 1) + '\u2026');
    await p.page.render({ canvasContext: ctx, viewport: viewport }).promise;
    drawOverlay();
    var label = 'Page ' + (i + 1) + ' of ' + state.pages.length;
    if (p.rot) label += ' \u00b7 ' + p.rot + '\u00b0';
    if (p.blank) label += ' \u00b7 blank';
    $('pageLabel').textContent = label;
    Array.prototype.forEach.call($('pageList').children, function (el, idx) {
      el.classList.toggle('active', idx === i);
    });
    updatePageHint();
    setStatus('');
  }

  function updatePageHint() {
    var el = $('pageHint');
    if (!el) return;
    var msg = '';
    if (state.pages.length) {
      var p = state.pages[state.current];
      if (p.blank) {
        msg = ($('skipBlank') && $('skipBlank').checked)
          ? 'Blank page detected \u2014 it will be skipped on export.'
          : 'Blank page detected \u2014 it will be exported as a blank page.';
      } else if (p.extra) {
        msg = 'Detected extra content outside the label \u2014 drag the blue box to adjust if needed.';
      }
    }
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  function drawOverlay() {
    var r = state.pages[state.current].rect;
    var o = $('cropOverlay');
    o.style.left = (r.x * 100) + '%';
    o.style.top = (r.y * 100) + '%';
    o.style.width = (r.w * 100) + '%';
    o.style.height = (r.h * 100) + '%';
  }

  function clampRect(r) {
    r.w = Math.max(MIN_SIZE, Math.min(1, r.w));
    r.h = Math.max(MIN_SIZE, Math.min(1, r.h));
    r.x = Math.max(0, Math.min(1 - r.w, r.x));
    r.y = Math.max(0, Math.min(1 - r.h, r.y));
    return r;
  }

  // ---------------- overlay drag + resize ----------------
  function initOverlay() {
    var overlay = $('cropOverlay');
    var wrap = $('previewWrap');
    var drag = null; // {mode:'move'|'resize', corner, startX, startY, rect}

    function pos(e) {
      var b = wrap.getBoundingClientRect();
      return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
    }

    overlay.addEventListener('pointerdown', function (e) {
      if (!state.pages.length) return;
      e.preventDefault();
      var r = state.pages[state.current].rect;
      var corner = e.target.getAttribute && e.target.getAttribute('data-corner');
      drag = {
        mode: corner ? 'resize' : 'move',
        corner: corner,
        startX: e.clientX, startY: e.clientY,
        rect: { x: r.x, y: r.y, w: r.w, h: r.h }
      };
      overlay.setPointerCapture && overlay.setPointerCapture(e.pointerId);
    });

    overlay.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var r = state.pages[state.current].rect;
      var b = wrap.getBoundingClientRect();
      if (drag.mode === 'move') {
        var dx = (e.clientX - drag.startX) / b.width;
        var dy = (e.clientY - drag.startY) / b.height;
        r.x = drag.rect.x + dx;
        r.y = drag.rect.y + dy;
        clampRect(r);
      } else {
        var p = pos(e);
        var s = drag.rect;
        var right = s.x + s.w, bottom = s.y + s.h;
        if (drag.corner.indexOf('w') !== -1 || drag.corner === 'nw' || drag.corner === 'sw') {
          var nx = Math.max(0, Math.min(p.x, right - MIN_SIZE));
          r.w = right - nx; r.x = nx;
        }
        if (drag.corner.indexOf('e') !== -1 || drag.corner === 'ne' || drag.corner === 'se') {
          r.w = Math.max(MIN_SIZE, Math.min(1 - s.x, p.x - s.x));
          r.x = s.x;
        }
        if (drag.corner === 'nw' || drag.corner === 'ne' || drag.corner === 'n') {
          var ny = Math.max(0, Math.min(p.y, bottom - MIN_SIZE));
          r.h = bottom - ny; r.y = ny;
        }
        if (drag.corner === 'sw' || drag.corner === 'se' || drag.corner === 's') {
          r.h = Math.max(MIN_SIZE, Math.min(1 - s.y, p.y - s.y));
          r.y = s.y;
        }
        clampRect(r);
      }
      drawOverlay();
    });

    function endDrag() { drag = null; }
    overlay.addEventListener('pointerup', endDrag);
    overlay.addEventListener('pointercancel', endDrag);
  }

  // ---------------- output: build the PDF ----------------
  // For each exported page: render the page at 200 DPI in its rotated frame,
  // cut out the crop rect, scale to FIT inside the output page (aspect
  // preserved, centered, white background — never stretched), embed as PNG.
  async function buildOutputPdf(work) {
    var sz = outSize();
    if (!work.length) throw new Error('all pages are blank');
    var out = await PDFLib.PDFDocument.create();
    var total = work.length;
    for (var idx = 0; idx < total; idx++) {
      var p = work[idx];
      setStatus('Building page ' + (idx + 1) + ' of ' + total + '\u2026');
      var viewport = p.page.getViewport({ scale: OUT_DPI / 72, rotation: p.rot });
      var src = document.createElement('canvas');
      src.width = Math.max(1, Math.ceil(viewport.width));
      src.height = Math.max(1, Math.ceil(viewport.height));
      var sctx = src.getContext('2d');
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(0, 0, src.width, src.height);
      await p.page.render({ canvasContext: sctx, viewport: viewport }).promise;

      var r = p.rect;
      var sx = Math.round(r.x * src.width), sy = Math.round(r.y * src.height);
      var sw = Math.max(1, Math.round(r.w * src.width));
      var sh = Math.max(1, Math.round(r.h * src.height));

      var dst = document.createElement('canvas');
      dst.width = sz.wPx; dst.height = sz.hPx;
      var dctx = dst.getContext('2d');
      dctx.fillStyle = '#ffffff';
      dctx.fillRect(0, 0, sz.wPx, sz.hPx);
      var fit = Math.min(sz.wPx / sw, sz.hPx / sh); // fit INSIDE: never stretches
      var dw = sw * fit, dh = sh * fit;
      dctx.drawImage(src, sx, sy, sw, sh, (sz.wPx - dw) / 2, (sz.hPx - dh) / 2, dw, dh);

      var blob = await new Promise(function (resolve) { dst.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('canvas render failed');
      var pngBytes = new Uint8Array(await blob.arrayBuffer());
      var png = await out.embedPng(pngBytes);
      var pg = out.addPage([sz.wPt, sz.hPt]);
      // PNG top row maps to the top of the page in pdf-lib's drawImage: upright.
      pg.drawImage(png, { x: 0, y: 0, width: sz.wPt, height: sz.hPt });
    }
    return await out.save();
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
  }

  function downloadBytes(bytes, filename) {
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
  }

  // ---------------- buttons ----------------
  function initButtons() {
    $('btnDetectAll').addEventListener('click', async function () {
      if (!state.pages.length) return;
      setStatus('Re-detecting labels on all pages\u2026');
      for (var i = 0; i < state.pages.length; i++) {
        var p = state.pages[i];
        var det = await autoDetect(p.page, p.rot);
        p.rect = { x: det.x, y: det.y, w: det.w, h: det.h };
        p.blank = det.blank;
        p.extra = det.extra;
      }
      renderPageList();
      drawOverlay();
      updatePageHint();
      setStatus('Auto-detect applied to all pages. Adjust any box by dragging.');
    });

    $('btnRotate').addEventListener('click', async function () {
      if (!state.pages.length) return;
      var p = state.pages[state.current];
      p.rot = (p.rot + 90) % 360;
      setStatus('Rotating page ' + (state.current + 1) + '\u2026');
      var det = await autoDetect(p.page, p.rot);
      p.rect = { x: det.x, y: det.y, w: det.w, h: det.h };
      p.blank = det.blank;
      p.extra = det.extra;
      p.thumb = await renderThumb(p.page, p.rot);
      renderPageList();
      await selectPage(state.current);
      setStatus('Page rotated to ' + p.rot + '\u00b0. Adjust the crop box if needed.');
    });

    $('btnCopyAll').addEventListener('click', function () {
      if (!state.pages.length) return;
      var r = state.pages[state.current].rect;
      state.pages.forEach(function (p) {
        p.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
      });
      setStatus('This page\u2019s crop box was copied to all pages.');
    });

    $('btnDownload').addEventListener('click', async function () {
      var btn = $('btnDownload');
      try {
        btn.disabled = true;
        var sz = outSize();
        var work = exportPages();
        var bytes = await buildOutputPdf(work);
        var srcs = distinctSrcs();
        var fname = (srcs.length === 1 ? srcs[0].name : 'labels') + sz.fileSuffix;
        downloadBytes(bytes, fname);
        var n = work.length;
        setStatus('Done \u2014 ' + fname + ' downloaded (' + n + ' page' + (n === 1 ? '' : 's') +
          '). Print it at 100% scale on ' + sz.paperName + ' paper.');
      } catch (e) {
        if (e && /blank/.test(e.message || '')) {
          setStatus('All pages are blank \u2014 nothing to export.', true);
        } else {
          setStatus('Something went wrong while building the PDF. Please try again.', true);
        }
      } finally {
        btn.disabled = false;
      }
    });

    // Batch ZIP: one cropped PDF per source file, zipped together.
    var zipBtn = $('btnZip');
    if (zipBtn) {
      zipBtn.addEventListener('click', async function () {
        try {
          zipBtn.disabled = true;
          var sz = outSize();
          var work = exportPages();
          if (!work.length) throw new Error('all pages are blank');
          var groups = {}, order = [];
          work.forEach(function (p) {
            if (!groups[p.srcId]) { groups[p.srcId] = { name: p.src, pages: [] }; order.push(p.srcId); }
            groups[p.srcId].pages.push(p);
          });
          var zip = new JSZip();
          var nameCounts = {};
          var usedNames = {};
          for (var gi = 0; gi < order.length; gi++) {
            var g = groups[order[gi]];
            var gbytes = await buildOutputPdf(g.pages);
            // Output names must be unique across the WHOLE zip, not just per
            // source name: the 2nd "label.pdf" takes "label-2-4x6.pdf",
            // which a source literally named "label-2.pdf" would also claim.
            // Keep incrementing until the full candidate name is free.
            var n = (nameCounts[g.name] || 0) + 1;
            var candidate;
            do {
              candidate = g.name + (n > 1 ? '-' + n : '') + sz.fileSuffix;
              n++;
            } while (usedNames[candidate]);
            nameCounts[g.name] = n - 1;
            usedNames[candidate] = 1;
            zip.file(candidate, gbytes);
          }
          var blob = await zip.generateAsync({ type: 'blob' });
          var zname = 'labels' + sz.fileSuffix.replace(/\.pdf$/i, '.zip');
          downloadBlob(blob, zname);
          setStatus('Done \u2014 ' + zname + ' downloaded (' + order.length +
            ' cropped PDFs, ' + work.length + ' page' + (work.length === 1 ? '' : 's') + ' total).');
        } catch (e) {
          if (e && /blank/.test(e.message || '')) {
            setStatus('All pages are blank \u2014 nothing to export.', true);
          } else {
            setStatus('Something went wrong while building the ZIP. Please try again.', true);
          }
        } finally {
          zipBtn.disabled = false;
        }
      });
    }

    var printFrame = null;
    $('btnPrint').addEventListener('click', async function () {
      var btn = $('btnPrint');
      try {
        btn.disabled = true;
        setStatus('Preparing print\u2026');
        var bytes = await buildOutputPdf(exportPages());
        var blob = new Blob([bytes], { type: 'application/pdf' });
        var url = URL.createObjectURL(blob);
        if (!printFrame) {
          printFrame = document.createElement('iframe');
          printFrame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0;';
          printFrame.setAttribute('title', 'Print preview');
          document.body.appendChild(printFrame);
        }
        printFrame.onload = function () {
          try {
            printFrame.contentWindow.focus();
            printFrame.contentWindow.print();
          } catch (e) { /* popup/print blocked: user can download instead */ }
          setStatus('Print dialog opened \u2014 set paper size to 4\u00d76 in (101.6\u00d7152.4 mm) and scale to 100%.');
        };
        printFrame.src = url;
      } catch (e) {
        setStatus('Something went wrong while preparing the print. Please try the download instead.', true);
      } finally {
        btn.disabled = false;
      }
    });

    $('btnReset').addEventListener('click', resetAll);
  }

  // ---------------- export options ----------------
  function initExportOpts() {
    var sel = $('sizeSelect');
    function sync() {
      var sz = outSize();
      $('outputHint').textContent = sz.hint;
      $('btnDownload').textContent = 'Download ' + sz.shortName + ' PDF';
    }
    sel.addEventListener('change', sync);
    $('skipBlank').addEventListener('change', updatePageHint);
    sync();
  }

  document.addEventListener('DOMContentLoaded', function () {
    initIntake();
    initOverlay();
    initButtons();
    initExportOpts();
  });
})();
