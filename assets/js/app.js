'use strict';
/* ShipLabelCrop — client-side PDF label cropper.
 * Deps (CDN): pdf.js (render + bbox detection), pdf-lib (output PDF assembly).
 * Output pages are 4x6 inch = 288x432 pt. Crop regions are rasterized at 200 DPI
 * and embedded as PNGs, scaled to FIT inside 4x6 (aspect preserved, centered,
 * white background — never stretched). */

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

  // ---- constants: double-check the math ----
  // PDF points: 72 pt = 1 inch  =>  4 in = 288 pt, 6 in = 432 pt. Correct.
  var OUT_W_PT = 288, OUT_H_PT = 432;
  var OUT_DPI = 200;                       // raster resolution of output pages
  var OUT_W_PX = Math.round(4 * OUT_DPI);  // 800 px
  var OUT_H_PX = Math.round(6 * OUT_DPI);  // 1200 px  (800x1200 keeps the 4:6 = 2:3 ratio)
  var MIN_SIZE = 0.03;                     // min crop-box edge, normalized units

  var state = { pdfDoc: null, pages: [], current: 0, fileName: 'labels' };
  // pages[i] = { page, wPt, hPt, rect:{x,y,w,h} normalized 0..1 (y-down), thumb }

  function setStatus(msg, isError) {
    var el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function resetAll() {
    state.pdfDoc = null;
    state.pages = [];
    state.current = 0;
    $('pageList').innerHTML = '';
    $('toolUI').hidden = true;
    $('emptyState').hidden = false;
    var fi = $('fileInput');
    if (fi) fi.value = '';
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
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (f) loadFile(f);
    });
  }

  async function loadFile(file) {
    resetAll();
    if (!/\.pdf$/i.test(file.name || '')) {
      setStatus('Please choose a PDF file (.pdf).', true);
      return;
    }
    state.fileName = (file.name || 'labels').replace(/\.pdf$/i, '') || 'labels';
    var bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      setStatus('Could not read that file. Please try again.', true);
      return;
    }
    // Magic-byte check: %PDF-
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
          bytes[3] === 0x46 && bytes[4] === 0x2D)) {
      setStatus('That file does not look like a PDF.', true);
      return;
    }
    setStatus('Loading PDF\u2026');
    try {
      state.pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') {
        setStatus('This PDF is password-protected. Please remove the password in your PDF reader and try again.', true);
      } else {
        setStatus('Could not read this PDF. It may be corrupted.', true);
      }
      return;
    }
    var n = state.pdfDoc.numPages;
    setStatus('Detecting the label on ' + n + (n === 1 ? ' page\u2026' : ' pages\u2026'));
    for (var i = 1; i <= n; i++) {
      var page = await state.pdfDoc.getPage(i);
      var vp1 = page.getViewport({ scale: 1 }); // scale 1 => 72 DPI => CSS px == PDF points
      var rect = await autoDetect(page, vp1);
      var thumb = await renderThumb(page, vp1);
      state.pages.push({ page: page, wPt: vp1.width, hPt: vp1.height, rect: rect, thumb: thumb });
      renderPageList();
    }
    $('emptyState').hidden = true;
    $('toolUI').hidden = false;
    selectPage(0);
    setStatus('Ready \u2014 drag the blue box to adjust the crop, then download.');
  }

  // ---------------- bbox auto-detect ----------------
  // Render at ~100 DPI offscreen, find the bounding box of non-white pixels.
  // Detection runs in canvas pixel space (y-down); the rect is stored normalized
  // 0..1 so it is resolution-independent. Padding ~4pt, clamped to the page.
  async function autoDetect(page, vp1) {
    var scale = 100 / 72;
    var viewport = page.getViewport({ scale: scale });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var TH = 240; // a pixel counts as "ink" if any channel is darker than this
    var minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
    for (var y = 0; y < canvas.height; y++) {
      var row = y * canvas.width;
      for (var x = 0; x < canvas.width; x++) {
        var o = (row + x) * 4;
        if (data[o] < TH || data[o + 1] < TH || data[o + 2] < TH) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }; // blank page fallback
    var pad = 6; // px at 100 DPI ~= 4.3 pt
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(canvas.width - 1, maxX + pad);
    maxY = Math.min(canvas.height - 1, maxY + pad);
    return {
      x: minX / canvas.width,
      y: minY / canvas.height,
      w: (maxX - minX + 1) / canvas.width,
      h: (maxY - minY + 1) / canvas.height
    };
  }

  async function renderThumb(page, vp1) {
    var scale = 150 / vp1.width;
    var viewport = page.getViewport({ scale: scale });
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
      b.className = 'page-thumb' + (idx === state.current ? ' active' : '');
      var img = document.createElement('img');
      img.src = p.thumb;
      img.alt = 'Page ' + (idx + 1) + ' thumbnail';
      b.appendChild(img);
      var cap = document.createElement('div');
      cap.textContent = 'Page ' + (idx + 1);
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
    var scale = (cssW * dpr) / p.wPt;
    var viewport = p.page.getViewport({ scale: scale });
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
    $('pageLabel').textContent = 'Page ' + (i + 1) + ' of ' + state.pages.length;
    Array.prototype.forEach.call($('pageList').children, function (el, idx) {
      el.classList.toggle('active', idx === i);
    });
    setStatus('');
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

  // ---------------- output: build the 4x6 PDF ----------------
  // For each page: render at 200 DPI, cut out the crop rect, scale to FIT inside
  // 800x1200 px (the 4:6 ratio), center on white, embed as PNG into a 288x432 pt page.
  async function buildOutputPdf() {
    var out = await PDFLib.PDFDocument.create();
    var total = state.pages.length;
    for (var idx = 0; idx < total; idx++) {
      var p = state.pages[idx];
      setStatus('Building page ' + (idx + 1) + ' of ' + total + '\u2026');
      var viewport = p.page.getViewport({ scale: OUT_DPI / 72 });
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
      dst.width = OUT_W_PX; dst.height = OUT_H_PX;
      var dctx = dst.getContext('2d');
      dctx.fillStyle = '#ffffff';
      dctx.fillRect(0, 0, OUT_W_PX, OUT_H_PX);
      var fit = Math.min(OUT_W_PX / sw, OUT_H_PX / sh); // fit INSIDE: never stretches
      var dw = sw * fit, dh = sh * fit;
      dctx.drawImage(src, sx, sy, sw, sh, (OUT_W_PX - dw) / 2, (OUT_H_PX - dh) / 2, dw, dh);

      var blob = await new Promise(function (resolve) { dst.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('canvas render failed');
      var pngBytes = new Uint8Array(await blob.arrayBuffer());
      var png = await out.embedPng(pngBytes);
      var pg = out.addPage([OUT_W_PT, OUT_H_PT]);
      // PNG top row maps to the top of the page in pdf-lib's drawImage: upright.
      pg.drawImage(png, { x: 0, y: 0, width: OUT_W_PT, height: OUT_H_PT });
    }
    return await out.save();
  }

  function downloadBytes(bytes, filename) {
    var blob = new Blob([bytes], { type: 'application/pdf' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
    return url;
  }

  // ---------------- buttons ----------------
  function initButtons() {
    $('btnDetectAll').addEventListener('click', async function () {
      if (!state.pages.length) return;
      setStatus('Re-detecting labels on all pages\u2026');
      for (var i = 0; i < state.pages.length; i++) {
        var p = state.pages[i];
        p.rect = await autoDetect(p.page, p.page.getViewport({ scale: 1 }));
      }
      drawOverlay();
      setStatus('Auto-detect applied to all pages. Adjust any box by dragging.');
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
        var bytes = await buildOutputPdf();
        downloadBytes(bytes, state.fileName + '-4x6.pdf');
        setStatus('Done \u2014 ' + state.fileName + '-4x6.pdf downloaded. Print it at 100% scale on 4\u00d76 paper.');
      } catch (e) {
        setStatus('Something went wrong while building the PDF. Please try again.', true);
      } finally {
        btn.disabled = false;
      }
    });

    var printFrame = null;
    $('btnPrint').addEventListener('click', async function () {
      var btn = $('btnPrint');
      try {
        btn.disabled = true;
        setStatus('Preparing print\u2026');
        var bytes = await buildOutputPdf();
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
          setStatus('Print dialog opened \u2014 set paper size to 4\u00d76 in (100\u00d7150 mm) and scale to 100%.');
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

  document.addEventListener('DOMContentLoaded', function () {
    initIntake();
    initOverlay();
    initButtons();
  });
})();
