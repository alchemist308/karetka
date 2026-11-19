import test from "node:test";
import assert from "node:assert/strict";
import mechanicalKey from "../dist/sound.js";

test("keystrokes and carriage return have quiet edges and limited peaks at device sample rates", () => {
  for (const rate of [44100, 48000]) {
    for (const kind of ["key", "space", "return"]) {
      for (const variant of kind === "key" ? [0, 1, 2] : [0]) {
        const samples = mechanicalKey(rate, kind, variant);
        assert.equal(Math.abs(samples[0]), 0);
        assert.equal(Math.abs(samples.at(-1)), 0);
        const peak = Math.max(...samples.map(Math.abs));
        assert.ok(peak > 0.07 && peak < 0.23, kind + " gain");
        const attack = samples.subarray(0, Math.floor(rate / 1000));
        assert.ok(Math.max(...attack.map(Math.abs)) < peak * 0.4, kind + " onset");
      }
    }
  }
});
