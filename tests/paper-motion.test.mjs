import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../dist/paper-motion.js", import.meta.url), "utf8");
const { bendGeometry, phase, stripProjection } = createRequire(import.meta.url)("../dist/paper-motion.js");

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
}
function machine(reduced = false) {
  const dom = Object.fromEntries(["sheet", "paperSurface", "paperTurn", "stage", "writingArea", "writer", "paperKnob"].map((name) => [name, new Element()]));
  const { writer, writingArea: area, paperSurface: surface, paperKnob: knob, paperTurn: turn } = dom;
  const header = new Element(), curl = new Element(), frames = new Map();
  dom.sheet.querySelector = () => header;
  surface.querySelector = () => curl;
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
  return { writer, area, surface, knob, turn, motion, align, step, checkPhase };
}
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
test("ink reaching the bend is sampled from the manuscript; reduced motion keeps instant alignment", () => {
  const m = machine(true);
  m.align(0); m.writer.value = "а".repeat(210); m.align(20, true);
  assert.equal(m.writer.scrollTop, 600); m.checkPhase();
  assert.ok(m.turn.classList.contains("has-ink"));
  const painted = m.turn.children[3].children[0].children[1].textContent;
  assert.ok(painted.length > 0 && painted.length < m.writer.value.length);
  assert.equal(m.knob.attributes["aria-valuenow"], "21");
  m.knob.fire("keydown", { key: "Home" });
  assert.equal(m.turn.classList.contains("has-ink"), false);
  m.motion.reset();
  assert.equal(m.surface.style["clip-path"], undefined);
});
