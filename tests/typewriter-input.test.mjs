import assert from "node:assert/strict";
import test from "node:test";
import machineInput from "../dist/typewriter-input.js";

function fire(target, type, values = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), values);
  target.dispatchEvent(event);
  return event;
}

function editor(initial = "Рукопись") {
  const document = new EventTarget();
  const field = Object.assign(new EventTarget(), {
    ownerDocument: document, value: initial,
    selectionStart: initial.length, selectionEnd: initial.length,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    focus() { document.activeElement = this; }
  });
  field.focus();
  const state = { machine: true, erase: false, committed: initial };
  const guard = machineInput(field, {
    enabled: () => state.machine, backspace: () => state.erase, committed: () => state.committed,
    blocked() {}, activity() {}
  });
  function input(value, inputType, data) {
    field.value = value;
    if (!guard.accept({ inputType, data })) return false;
    state.committed = field.value;
    return true;
  }
  return { document, field, state, guard, input };
}

test("machine pins the caret after native selection changes and blocks navigation and selection shortcuts", () => {
  const { document, field } = editor();
  for (const [key, modifiers] of [["Home", {}], ["ArrowLeft", { shiftKey: true }], ["a", { metaKey: true }]]) {
    field.setSelectionRange(0, 1);
    assert.ok(fire(field, "keydown", { key, ...modifiers }).defaultPrevented);
    assert.equal(field.selectionStart, field.value.length);
    assert.equal(field.selectionEnd, field.value.length);
  }
  field.setSelectionRange(0, 1);
  fire(document, "selectionchange");
  assert.equal(field.selectionStart, field.value.length);
  assert.ok(fire(field, "cut").defaultPrevented);
  assert.ok(fire(field, "selectstart").defaultPrevented);
  assert.ok(fire(field, "mousedown", { button: 0 }).defaultPrevented);
  assert.ok(!fire(field, "wheel").defaultPrevented);
  assert.ok(!fire(field, "keydown", { key: "Tab" }).defaultPrevented);
});

test("Backspace preference is enforced on mobile beforeinput and noncancelable edits", () => {
  const { field, input, state } = editor("Аё👩‍🔬");
  assert.ok(fire(field, "beforeinput", { inputType: "deleteContentBackward" }).defaultPrevented);
  assert.equal(input("Аё", "deleteContentBackward"), false);
  assert.equal(field.value, "Аё👩‍🔬");
  state.erase = true;
  assert.ok(!fire(field, "beforeinput", { inputType: "deleteContentBackward" }).defaultPrevented);
  assert.equal(input("Аё", "deleteContentBackward"), true);
  assert.equal(input("", "deleteContentBackward"), false);
  assert.equal(input("А", "historyUndo"), false);
  assert.equal(input("А", "deleteWordBackward"), false);
  assert.equal(input("А", "deleteContentBackward"), true);
  assert.equal(field.value, "А");
});

test("native composition, dictation and paste preserve all previously committed text", () => {
  const { document, field, guard, input } = editor("До. ");
  fire(field, "compositionstart");
  field.value = "До. к";
  field.setSelectionRange(4, 5);
  fire(document, "selectionchange");
  assert.equal(field.selectionStart, 4);
  assert.ok(guard.composing);
  fire(field, "compositionend");
  assert.equal(input("До. кот", "insertCompositionText", "кот"), true);
  assert.equal(input("До. коник", "insertFromDictation", "ник"), true);
  assert.equal(field.value, "До. котник");
  fire(field, "paste", { clipboardData: { getData: () => "Первое\r\nВторое" } });
  assert.equal(input("Первое\nВторое", "insertFromPaste"), true);
  assert.equal(field.value, "До. котникПервое\nВторое");
  assert.equal(input("Автозамена", "insertReplacementText", "замена"), false);
});

test("edit mode retains ordinary native input, cursor selection and deletion", () => {
  const { state, document, field, input } = editor();
  state.machine = false;
  field.setSelectionRange(1, 3);
  fire(document, "selectionchange");
  assert.deepEqual([field.selectionStart, field.selectionEnd], [1, 3]);
  for (const key of ["Backspace", "Delete", "ArrowLeft", "Home"])
    assert.equal(fire(field, "keydown", { key }).defaultPrevented, false);
  assert.equal(fire(field, "cut").defaultPrevented, false);
  assert.equal(input("Исправление", "insertReplacementText"), true);
  assert.equal(field.value, "Исправление");
});
