import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../dist/paper-motion.js", import.meta.url), "utf8");
const { bendGeometry, phase, stripProjection, leadingEdge } = createRequire(import.meta.url)("../dist/paper-motion.js");

test("the cylinder narrows only toward the back and meets the unscaled flat paper", () => {
  for (const width of [360, 820, 1280]) {
    for (const angle of [.62, 1, 1.34]) {
      const points = bendGeometry(width, 80, angle);
      const front = points.at(-1);
      assert.equal(front.y, 80);
      assert.equal(front.material, 80);
      assert.equal(front.scale, 1);
      assert.equal(front.x, 0);
      assert.ok(points[0].y < .001 && points[0].material < 0 && points[0].x > 0);
      for (let i = 1; i < points.length; i++) {
        assert.ok(points[i].y > points[i - 1].y);
        assert.ok(points[i].material > points[i - 1].material);
        assert.ok(points[i].scale > points[i - 1].scale);
        const p = points[i - 1], q = points[i];
        const m = stripProjection(p, q), length = q.material - p.material, w = 1 + m.perspective * length;
        assert.ok(Math.abs(m.xScale / w - q.scale) < 1e-8);
        assert.ok(Math.abs(m.yScale * length / w - (q.y - p.y)) < 1e-8);
      }
    }
  }
});

test("the cut edge follows the same projection as the ink from the flat face through the bend", () => {
  const points = bendGeometry(820, 72);
  assert.deepEqual(leadingEdge(170, points), { x: 0, y: 170 });
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1], q = points[i];
    const end = leadingEdge(q.material, points);
    assert.ok(Math.abs(end.x - q.x) < .001 && Math.abs(end.y - q.y) < .001);
    const halfway = leadingEdge((p.material + q.material) / 2, points);
    assert.ok(halfway.x < p.x && halfway.x > q.x && halfway.y > p.y && halfway.y < q.y);
  }
  assert.deepEqual(leadingEdge(points[0].material - 100, points), { x: points[0].x, y: 0 });
});

class Element {
  children = [];
  listeners = {};
  attributes = {};
  data = "";
  textContent = "";
  offsetHeight = 0;
  scrollTop = 0;
  style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
  classList = { values: new Set(), toggle(k, on) { if (on) this.values.add(k); else this.values.delete(k); },
    contains(k) { return this.values.has(k); }, remove(k) { this.values.delete(k); } };
  append(el) { this.children.push(el); }
  appendChild(el) { this.append(el); return el; }
  get length() { return this.data.length; }
  appendData(s) { this.data += s; }
  addEventListener(event, cb) { this.listeners[event] = cb; }
  setAttribute(k, v) { this.attributes[k] = v; }
  fire(event, extra = {}) { this.listeners[event]?.({ preventDefault() {}, ...extra }); }
  focus() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { height: this.offsetHeight }; }
  cloneNode() { return Object.assign(new Element(), { textContent: this.textContent }); }
  querySelectorAll() { return []; }
}
function machine(reduced = false) {
  const dom = Object.fromEntries(["sheet", "paperSurface", "paperTurn", "stage", "writingArea", "writer", "paperKnob"].map((name) => [name, new Element()]));
  const { writer, writingArea: area, paperSurface: surface, paperKnob: knob, paperTurn: turn } = dom;
  const header = new Element(), curl = new Element(), grain = new Element(), frames = new Map();
  header.offsetHeight = 62;
  header.textContent = "Глава 01 Первое письмо";
  dom.sheet.querySelector = () => header;
  surface.querySelector = selector => selector === ".paper-grain" ? grain : curl;
  surface.clientWidth = 820;
  surface.offsetTop = 20;
  curl.offsetHeight = 60;
  Object.assign(area, { offsetTop: 80, clientHeight: 360, offsetLeft: 60, clientWidth: 700 });
  writer.value = "";
  writer.selectionStart = 0;
  let now = 0, frameId = 0;
  const env = {
    module: { exports: {} },
    document: { getElementById: (id) => dom[id], createElement: () => new Element(),
      createTextNode: (s) => Object.assign(new Element(), { data: s }),
      createRange: () => ({ setStart(_node, index) { this.start = index; }, setEnd() {},
        getBoundingClientRect() { return { top: Math.floor(this.start / 10) * 30 }; } }) },
    performance: { now: () => now },
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  runInNewContext(source, env);
  const motion = env.module.exports;
  const align = (row, feed = false) => motion.align({ row, lh: 30, partId: "section", feed, resetView: false, font: "test" });
  function step(ms) {
    now += ms;
    const work = [...frames.values()];
    frames.clear();
    for (const fn of work) fn(now);
  }
  function checkPhase() {
    const ink = area.offsetTop + area.clientHeight - 30 - writer.scrollTop;
    const fiber = parseFloat(surface.style["--paper-phase"]);
    assert.equal(fiber, phase(ink - surface.offsetTop));
  }
  return { writer, area, surface, sheet: dom.sheet, knob, turn, grain, motion, align, step, checkPhase };
}
test("opaque fiber bands cover fractional seams and retain the projection of the printed ink", () => {
  const m = machine();
  m.align(0);
  const bands = m.grain.children;
  assert.equal(bands.length, m.turn.children.length);
  assert.ok(bands.length > 1);
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i], ink = m.turn.children[i];
    assert.equal(band.children[0].style.transform, ink.children[0].style.transform);
    assert.equal(band.children[0].style["--strip-start"], ink.children[0].style["--strip-start"]);
    const end = parseFloat(band.style.top) + parseFloat(band.style.height);
    const next = i + 1 < bands.length ? parseFloat(bands[i + 1].style.top) : 60;
    assert.ok(end > next + 1);
  }
});
test("the first return lifts the edge and heading with the first line; rewinding restores the beginning", () => {
  const m = machine();
  const offset = (key) => parseFloat(m.sheet.style[key]);
  m.align(0);
  const edge = offset("--edge-y"), heading = offset("--heading-y");
  assert.ok(edge > 60 && heading > edge);
  m.writer.value = "Начало\n"; m.align(1, true);
  for (const ms of [18, 32, 60, 100]) {
    m.step(ms);
    assert.equal(offset("--edge-y"), edge - m.writer.scrollTop);
    assert.equal(offset("--heading-y"), heading - m.writer.scrollTop);
    m.checkPhase();
  }
  m.align(9);
  assert.ok(m.turn.classList.contains("has-heading"));
  assert.equal(m.turn.children[0].children[0].children[1].textContent, "Глава 01 Первое письмо");
  m.align(24);
  assert.equal(m.sheet.style["--edge-visible"], "0");
  assert.equal(m.turn.classList.contains("has-heading"), false);
  m.knob.fire("keydown", {key: "Home"});
  assert.equal(offset("--edge-y"), edge);
  assert.equal(offset("--heading-y"), heading);
  assert.equal(m.sheet.style["--edge-visible"], "1");
  m.motion.reset();
  assert.equal(m.sheet.style["--edge-y"], undefined);
});
test("manual and soft returns feed native ink and fibers by the same distance on every frame", () => {
  const m = machine();
  m.align(0); m.checkPhase();
  m.writer.value = "А\n"; m.align(1, true);
  assert.equal(m.writer.scrollTop, 0);
  m.step(50); const first = m.writer.scrollTop;
  assert.ok(first > 0 && first < 30); m.checkPhase();
  m.align(1); assert.equal(m.writer.scrollTop, first);
  m.writer.value += "Б".repeat(11); m.align(2, true);
  m.step(70); assert.ok(m.writer.scrollTop > first && m.writer.scrollTop < 60); m.checkPhase();
  m.step(200); assert.equal(m.writer.scrollTop, 60); m.checkPhase();
  m.knob.fire("keydown", { key: "ArrowUp" });
  assert.equal(m.writer.scrollTop, 30); m.checkPhase();
  m.knob.fire("keydown", { key: "Home" });
  assert.equal(m.writer.scrollTop, 0); assert.equal(m.writer.selectionStart, 0); m.checkPhase();
  m.writer.fire("beforeinput"); assert.equal(m.writer.scrollTop, 60); m.checkPhase();
  m.knob.fire("wheel", { deltaMode: 1, deltaY: -1 });
  assert.equal(m.writer.scrollTop, 30);
  m.knob.fire("keydown", { key: "Enter" });
  assert.equal(m.writer.scrollTop, 60); m.checkPhase();
});
test("rolling toward the typist raises the page, including from the typing line; typing reseats the platen", () => {
  const m = machine(true);
  m.align(20);
  const heading = () => parseFloat(m.sheet.style["--heading-y"]);
  const resting = heading();
  m.sheet.fire("wheel", { deltaMode: 0, deltaY: 45 });
  assert.equal(heading(), resting - 45);
  assert.equal(m.writer.style.transform, "translateY(-45.000px)");
  m.sheet.fire("wheel", { deltaMode: 0, deltaY: -45 });
  assert.equal(heading(), resting);
  m.knob.fire("wheel", { deltaMode: 1, deltaY: 2 });
  assert.equal(heading(), resting - 60);
  m.writer.fire("beforeinput");
  assert.equal(heading(), resting);
  assert.equal(m.writer.style.transform, "");
  m.sheet.fire("wheel", { deltaMode: 2, deltaY: -1 });
  assert.equal(m.writer.scrollTop, 240);
  m.sheet.fire("wheel", { deltaMode: 0, deltaY: 30, ctrlKey: true });
  assert.equal(m.writer.scrollTop, 240);
  m.knob.fire("pointerdown", { button: 0, clientY: 20, pointerId: 1 });
  m.knob.fire("pointermove", { clientY: 30 });
  m.knob.fire("lostpointercapture");
  m.knob.fire("click");
  assert.equal(m.writer.scrollTop, 260);
  m.sheet.fire("touchstart", {touches: [{clientY: 20}]});
  m.sheet.fire("touchmove", {touches: [{clientY: 30}]});
  assert.equal(m.writer.scrollTop, 250);
  const blank = machine(true);
  blank.align(0);
  blank.sheet.fire("wheel", { deltaMode: 1, deltaY: 1 });
  assert.equal(blank.writer.style.transform, "translateY(-30.000px)");
  blank.motion.reset();
  assert.equal(blank.writer.style.transform, "");
});
test("ink reaching the bend is sampled from the manuscript; reduced motion keeps instant alignment", () => {
  const m = machine(true);
  m.align(0); m.writer.value = "а".repeat(210); m.align(20, true);
  assert.equal(m.writer.scrollTop, 600); m.checkPhase();
  assert.ok(m.turn.classList.contains("has-ink"));
  const painted = m.turn.children[3].children[0].children[0].textContent;
  assert.ok(painted.length > 0 && painted.length < m.writer.value.length);
  assert.equal(m.knob.attributes["aria-valuenow"], "21");
  m.knob.fire("keydown", { key: "Home" });
  assert.equal(m.turn.classList.contains("has-ink"), false);
  m.motion.reset();
  assert.equal(m.surface.style["clip-path"], undefined);
});
