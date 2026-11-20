"use strict";

/* Vertical distances are physical paper coordinates. The flat ink and flat fibers share
   the textarea's ACTUAL scroll offset; the same coordinates wrap around the top. */
const KaretkaPaper = (() => {
  const TILE = 256, SLICES = 12;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const phase = (value) => ((value % TILE) + TILE) % TILE;
  function bendGeometry(width, depth, angle = 1.34, inset = .048) {
    const backScale = 1 - 2 * inset;
    const lens = (1 / backScale - 1) / (1 - Math.cos(angle));
    const radius = depth / (Math.sin(angle) * backScale);
    const points = [];
    for (let i = 0; i <= SLICES; i++) {
      const theta = angle * (1 - i / SLICES);
      const scale = 1 / (1 + lens * (1 - Math.cos(theta)));
      points.push({
        y: clamp(depth - radius * Math.sin(theta) * scale, 0, depth),
        x: (1 - scale) * width / 2, scale,
        material: depth - radius * theta
      });
    }
    return points;
  }
  function paperOrigin(areaTop, leadingSpace, scroll, rimTop) {
    return areaTop + leadingSpace - scroll - rimTop;
  }
  function stripProjection(p, q) {
    const length = q.material - p.material, w = p.scale / q.scale;
    return { xScale: p.scale, yScale: (q.y - p.y) * w / length, perspective: (w - 1) / length };
  }
  function leadingEdge(material, points) {
    if (material >= points.at(-1).material) return { x: 0, y: material };
    if (material <= points[0].material) return { x: points[0].x, y: 0 };
    const next = points.findIndex(p => p.material >= material);
    const p = points[next - 1], q = points[next], delta = material - p.material;
    const { yScale, perspective } = stripProjection(p, q);
    const dy = delta * yScale / (1 + delta * perspective);
    return { x: p.x + (q.x - p.x) * dy / (q.y - p.y), y: p.y + dy };
  }
  if (typeof document === "undefined") return { bendGeometry, phase, paperOrigin, stripProjection, leadingEdge };

  const id = (name) => document.getElementById(name);
  const sheet = id("sheet"), surface = id("paperSurface"), turn = id("paperTurn");
  const stage = id("stage"), area = id("writingArea"), writer = id("writer"), knob = id("paperKnob");
  const header = sheet.querySelector(".paper-head"), curl = surface.querySelector(".paper-curl");
  const grain = surface.querySelector(".paper-grain");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  function make(className, parent) {
    const node = document.createElement("div");
    node.className = className;
    parent.append(node);
    return node;
  }
  const strips = Array.from({ length: SLICES }, () => {
    const strip = make("bend-strip", turn), plane = make("bend-plane", strip);
    const fiberStrip = make("bend-strip", grain), fibers = make("bend-plane bend-fibers", fiberStrip);
    return { strip, plane, ink: make("ink bend-ink", plane), fiberStrip, fibers };
  });
  let points = [], width = 0, depth = 0, angle = 0, opening = null;
  let animationFrame = 0, travel = null, latest = 0, position = 0, lift = 0, extraRows = 0, reviewing = false;
  let section, signature = "", lineHeight = 30, lastValue = "", ready = false;
  let flatTop = 0, leading = 0, rim = 0, visibleRows = 0, bounds = null, measureNode, measuredValue = null;
  let headerHeight = 0, headingGap = 0, topMargin = 0, headingText = "";
  const px = (n) => n.toFixed(3) + "px";

  function shape(a) {
    if (angle === a && points.length) return;
    angle = a;
    const narrow = clamp(38 / Math.max(width, 1), .033, .067);
    // For the entry motion, the back edge first lies nearly flat, then recedes.
    const inset = narrow * (1 - Math.cos(a)) / (1 - Math.cos(1.34));
    points = bendGeometry(width, depth, a, inset);
    const left = points.map((p) => px(p.x) + " " + px(p.y));
    const right = [...points].reverse().map((p) => px(width - p.x) + " " + px(p.y));
    surface.style.setProperty("clip-path", "polygon(" + [...left, "0 100%", "100% 100%", ...right].join(",") + ")");
    for (let i = 0; i < strips.length; i++) {
      const p = points[i], q = points[i + 1], { strip, plane, fiberStrip, fibers } = strips[i];
      const h = q.y - p.y, len = q.material - p.material;
      strip.style.top = fiberStrip.style.top = px(p.y);
      strip.style.height = px(h + .02);
      plane.style.height = px(len + .03);
      // Opaque fiber samples overlap inside one translucent grain layer. Subpixel
      // rounding can no longer expose a bright row or multiply two translucent edges.
      fiberStrip.style.height = px(h + 2);
      fibers.style.height = px(len + 2 * len / h + 1);
      // A projective trapezoid joins both edges exactly with the adjacent strips.
      const { xScale, yScale, perspective } = stripProjection(p, q);
      plane.style.transform = fibers.style.transform = "matrix3d(" + [xScale, 0, 0, 0, 0, yScale, 0, perspective, 0, 0, 1, 0, 0, 0, 0, 1].join(",") + ")";
      plane.style.setProperty("--strip-start", px(p.material));
      fibers.style.setProperty("--strip-start", px(p.material));
    }
  }
  function syncMeasure() {
    if (!measureNode) {
      const box = make("ink bend-measure", area);
      box.setAttribute("aria-hidden", "true");
      measureNode = box.appendChild(document.createTextNode(""));
    }
    if (measuredValue === writer.value) return;
    const next = writer.value;
    if (measuredValue !== null && next.startsWith(measuredValue)) {
      measureNode.appendData(next.slice(measuredValue.length));
    } else measureNode.data = next;
    measuredValue = next;
  }
  // Locate a visible window with the browser's own word wrapping and active font.
  // Only that small range of text is projected into the curved strips.
  function indexAtLine(line, range, origin) {
    if (line <= 0) return 0;
    let low = 0, high = measureNode.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      range.setStart(measureNode, mid);
      range.setEnd(measureNode, mid + 1);
      const top = range.getBoundingClientRect().top;
      if (Math.round((top - origin) / lineHeight) < line) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  function feedCurveInk(origin) {
    const bottom = Math.ceil((depth - origin) / lineHeight) + 1;
    const top = Math.max(0, Math.floor((points[0].material - origin) / lineHeight) - 1);
    const visible = writer.value.length > 0 && depth > origin && bottom > top;
    turn.classList.toggle("has-ink", visible);
    if (!visible) return;
    const value = writer.value;
    const unaffected = bounds && (bounds.value === value ||
      (bounds.end < bounds.value.length - 1 && value.startsWith(bounds.value)));
    if (!unaffected || bounds.top !== top || bounds.bottom !== bottom || bounds.signature !== signature) {
      syncMeasure();
      const range = document.createRange();
      range.setStart(measureNode, 0);
      range.setEnd(measureNode, 1);
      const first = range.getBoundingClientRect().top;
      const start = indexAtLine(top, range, first), end = indexAtLine(bottom, range, first);
      const text = value.slice(start, end);
      if (!bounds || bounds.text !== text) for (const { ink } of strips) ink.textContent = text;
      bounds = { top, bottom, value, signature, text, end };
    }
    turn.style.setProperty("--sample-y", px(origin + top * lineHeight));
  }
  function paint(target) {
    if (!ready) return;
    const feed = Math.round(clamp(target, 0, latest + extraRows * lineHeight));
    writer.scrollTop = Math.min(feed, latest);
    // The platen can lift the last printed line without inserting blank lines.
    lift = Math.max(0, feed - latest);
    writer.style.transform = lift ? "translateY(" + px(-lift) + ")" : "";
    position = writer.scrollTop + lift;
    const origin = paperOrigin(flatTop, leading, position, rim);
    surface.style.setProperty("--paper-phase", px(phase(origin)));
    // The edge, folio and title have fixed offsets from the manuscript's first line.
    const y = origin - headingGap - headerHeight;
    const edge = y - topMargin;
    const projected = leadingEdge(edge, points);
    sheet.style.setProperty("--edge-y", px(projected.y));
    sheet.style.setProperty("--edge-inset", px(projected.x));
    sheet.style.setProperty("--edge-visible", edge >= points[0].material ? "1" : "0");
    if (headerHeight) {
      sheet.style.setProperty("--heading-y", px(y));
      const inBend = y < depth && y + headerHeight > points[0].material;
      turn.classList.toggle("has-heading", inBend);
      if (inBend && headingText !== header.textContent) {
        headingText = header.textContent;
        for (const band of strips) {
          const copy = header.cloneNode(true);
          copy.className = "bend-heading";
          copy.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
          band.heading?.remove();
          band.plane.append(copy);
          band.heading = copy;
        }
      }
    } else turn.classList.remove("has-heading");
    feedCurveInk(origin);
    const current = Math.round(position / lineHeight) + 1, end = Math.round(latest / lineHeight) + 1;
    knob.style.setProperty("--knurl", px(phase(position / 2) % 5));
    knob.setAttribute("aria-valuemax", String(end + extraRows));
    knob.setAttribute("aria-valuenow", String(current));
    knob.setAttribute("aria-valuetext", current > end ? "Лист поднят над местом набора" : "Строка " + current + " из " + end);
    stage.classList.toggle("paper-review", reviewing);
  }
  function tick(now) {
    animationFrame = 0;
    let a = 1.34, pos = position;
    if (opening !== null) {
      const t = clamp((now - opening) / 480, 0, 1);
      a = .62 + .72 * (1 - (1 - t) ** 3);
      if (t === 1) opening = null;
    }
    if (travel) {
      const t = clamp((now - travel.start) / travel.duration, 0, 1);
      pos = travel.from + (travel.to - travel.from) * (1 - (1 - t) ** 3);
      if (t === 1) travel = null;
    }
    if (ready) { shape(a); paint(pos); }
    if (opening !== null || travel) frame();
  }
  function frame() {
    if (!animationFrame) animationFrame = requestAnimationFrame(tick);
  }
  function open() {
    reviewing = false;
    travel = null;
    opening = reduce.matches ? null : performance.now();
    if (opening !== null) angle = 0;
    if (opening !== null) frame();
  }
  function reset() {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0; opening = null; travel = null; reviewing = false; ready = false; bounds = null;
    stage.classList.remove("paper-review");
    lift = 0;
    writer.style.transform = "";
    surface.style.removeProperty("clip-path");
    sheet.style.removeProperty("--heading-y");
    sheet.style.removeProperty("--edge-y");
    sheet.style.removeProperty("--edge-inset");
    sheet.style.removeProperty("--edge-visible");
    surface.style.removeProperty("--paper-phase");
    points = [];
  }
  function align({ row, lh, partId, feed, resetView, font }) {
    const newWidth = surface.clientWidth, newDepth = curl.getBoundingClientRect().height;
    if (!newWidth || !newDepth || area.clientHeight < 1) return;
    const nextSignature = [partId, newWidth, newDepth, area.clientWidth, area.clientHeight, font, lh].join("|");
    const changed = !ready || section !== partId || nextSignature !== signature || resetView;
    const resized = width !== newWidth || depth !== newDepth;
    if (resized) { width = newWidth; depth = newDepth; points = []; }
    const wasReviewing = reviewing;
    const textChanged = writer.value !== lastValue;
    if (changed || textChanged) reviewing = false;
    const previousTarget = latest, desired = Math.round(row * lh);
    latest = desired; section = partId; signature = nextSignature; lineHeight = lh;
    flatTop = area.offsetTop; leading = Math.max(0, area.clientHeight - lh); rim = surface.offsetTop;
    headerHeight = header.offsetHeight;
    const availableMargin = Math.max(0, flatTop + leading - rim - depth / 2 - headerHeight);
    headingGap = Math.min(clamp(lineHeight * 1.75, 46, 66), availableMargin * .48);
    topMargin = Math.min(clamp(lineHeight * 2, 36, 76), availableMargin - headingGap);
    visibleRows = Math.max(1, Math.floor(area.clientHeight / lh));
    extraRows = clamp(Math.floor(visibleRows / 2), 1, 3);
    sheet.style.setProperty("--ink-left", px(area.offsetLeft));
    sheet.style.setProperty("--ink-width", px(area.clientWidth));
    ready = true;
    shape(opening === null ? 1.34 : angle || .62);
    if (!changed && !wasReviewing && !reviewing && feed && desired !== previousTarget &&
        Math.abs(desired - position) <= 3.2 * lh && !reduce.matches) {
      travel = { from: position, to: desired, start: performance.now(), duration: 185 };
      frame();
    } else if (changed || wasReviewing && !reviewing || desired !== previousTarget) {
      travel = null;
    }
    paint((travel || reviewing) ? position : desired);
    lastValue = writer.value;
  }
  function review(value) {
    if (!ready || stage.classList.contains("editing")) return;
    const pos = clamp(value, 0, latest + extraRows * lineHeight);
    travel = null;
    reviewing = Math.round(pos) !== latest;
    paint(pos);
  }
  function resume(focus = false) {
    if (ready) review(latest);
    if (focus) writer.focus({ preventScroll: true });
  }
  function wheel(e) {
    if (!ready || e.ctrlKey || stage.classList.contains("editing") || !e.deltaY) return;
    const multiplier = e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? visibleRows * lineHeight : 1;
    review(position + e.deltaY * multiplier);
    e.preventDefault();
  }
  sheet.addEventListener("wheel", wheel, { passive: false });
  knob.addEventListener("wheel", wheel, { passive: false });
  let drag = null, dragged = false;
  knob.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, pos: position }; dragged = false;
    knob.setPointerCapture(e.pointerId);
  });
  knob.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const distance = e.clientY - drag.y;
    if (Math.abs(distance) > 2) dragged = true;
    if (dragged) review(drag.pos + distance * 2);
  });
  knob.addEventListener("lostpointercapture", () => { drag = null; });
  knob.addEventListener("click", () => {
    if (dragged) { dragged = false; return; }
    if (reviewing) resume(true);
    else review(position - Math.max(1, visibleRows - 1) * lineHeight);
  });
  knob.addEventListener("keydown", (e) => {
    const change = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, PageUp: -visibleRows, PageDown: visibleRows };
    if (Object.hasOwn(change, e.key)) review(position + change[e.key] * lineHeight);
    else if (e.key === "Home") review(0);
    else if (["End", "Enter", " "].includes(e.key)) { dragged = false; resume(true); }
    else return;
    e.preventDefault();
  });
  let touch = null;
  sheet.addEventListener("touchstart", (e) => {
    if (!ready || e.touches.length !== 1 || stage.classList.contains("editing")) { touch = null; return; }
    touch = { y: e.touches[0].clientY, pos: position };
  }, { passive: true });
  sheet.addEventListener("touchmove", (e) => {
    if (!touch || e.touches.length !== 1 || stage.classList.contains("editing")) return;
    const delta = e.touches[0].clientY - touch.y;
    if (Math.abs(delta) < 5) return;
    review(touch.pos - delta);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  sheet.addEventListener("touchend", () => { touch = null; }, { passive: true });
  sheet.addEventListener("touchcancel", () => { touch = null; }, { passive: true });
  writer.addEventListener("beforeinput", () => { if (reviewing) resume(); }, true);
  writer.addEventListener("scroll", () => {
    // Some mobile IMEs scroll the focused textarea independently after an input event.
    // The feed controller owns the platen position even while the keyboard is opening.
    if (ready && writer.scrollTop !== position - lift) paint(position);
  });
  reduce.addEventListener?.("change", () => {
    opening = null; travel = null;
    if (ready) { shape(1.34); paint(reviewing ? position : latest); }
  });
  return { align, open, reset };
})();
if (typeof module !== "undefined" && module.exports) module.exports = KaretkaPaper;
