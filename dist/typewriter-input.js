"use strict";

// The textarea remains a native input, including during IME composition. A machine
// can advance through new text and, optionally, erase a mark from its trailing edge.
function KaretkaMachineInput(editor, { enabled, backspace, committed, blocked, activity }) {
  const doc = editor.ownerDocument;
  const segmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  let composing = false, pendingKind = "", pasteText = "";

  function pin() {
    if (!enabled() || composing) return;
    const end = editor.value.length;
    if (editor.selectionStart !== end || editor.selectionEnd !== end)
      editor.setSelectionRange(end, end);
  }
  function reject(e) {
    e.preventDefault();
    blocked();
  }
  function prohibited(kind) {
    if (kind === "deleteContentBackward") return !backspace();
    return /^(delete|history|format)/.test(kind) ||
      kind === "insertFromDrop" || kind === "insertTranspose";
  }

  editor.addEventListener("keydown", (e) => {
    activity();
    if (!enabled() || e.isComposing || composing || e.keyCode === 229) return;
    const key = e.key.toLowerCase();
    pendingKind = key === "backspace" ? "deleteContentBackward" : "";
    const command = e.ctrlKey || e.metaKey;
    if (/^(arrow(up|down|left|right)|home|end|pageup|pagedown)$/.test(key) ||
        command && key === "a") {
      e.preventDefault();
      pin();
      return;
    }
    if (key === "delete" || key === "backspace" && (!backspace() || command || e.altKey) ||
        command && ["x", "z", "y"].includes(key)) {
      reject(e);
      return;
    }
    pin();
  });
  editor.addEventListener("beforeinput", (e) => {
    activity();
    if (!enabled()) return;
    pendingKind = e.inputType || pendingKind;
    if (e.isComposing || composing) return;
    pin();
    if (prohibited(pendingKind)) reject(e);
  });
  editor.addEventListener("compositionstart", () => {
    pin();
    composing = true;
  });
  editor.addEventListener("compositionend", () => {
    composing = false;
    pendingKind = "insertCompositionText";
  });
  // Prevent native mouse drag or double-click selection. Leave touch panning and
  // pen scrolling available to the paper roller; its gesture handlers run normally.
  editor.addEventListener("mousedown", (e) => {
    if (!enabled() || e.button !== 0 || composing) return;
    e.preventDefault();
    editor.focus({ preventScroll: true });
    pin();
  });
  for (const name of ["focus", "select", "click", "pointerup"]) editor.addEventListener(name, pin);
  doc.addEventListener("selectionchange", () => {
    if (doc.activeElement === editor) pin();
  });
  for (const name of ["selectstart", "dragstart", "contextmenu"]) {
    editor.addEventListener(name, (e) => { if (enabled() && !composing) e.preventDefault(); });
  }
  for (const name of ["cut", "drop"]) {
    editor.addEventListener(name, (e) => { if (enabled()) reject(e); });
  }
  editor.addEventListener("paste", (e) => {
    if (!enabled()) return;
    pin();
    pasteText = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
  });

  function isLastMark(before, after) {
    if (!backspace() || before.length <= after.length || !before.startsWith(after)) return false;
    const lastCodePoint = before.codePointAt(before.length - 2);
    const lastStart = lastCodePoint > 0xffff ? before.length - 2 : before.length - 1;
    const shortest = segmenter ? segmenter.segment(before).containing(before.length - 1).index : lastStart;
    // Several mobile keyboards delete just the combining mark of a full glyph.
    return after.length >= shortest &&
      !(after.length && /[\uD800-\uDBFF]/.test(after[after.length - 1]));
  }
  function accept(e) {
    if (!enabled() || composing || e.isComposing) return true;
    const kind = e.inputType || pendingKind || "";
    pendingKind = "";
    const added = kind === "insertFromPaste" ? e.data || pasteText : e.data;
    pasteText = "";
    const before = committed(), after = editor.value;
    if (!prohibited(kind)) {
      if (before === after || kind !== "deleteContentBackward" && after.startsWith(before) ||
          (!kind || kind === "deleteContentBackward") && isLastMark(before, after)) {
        pin();
        return true;
      }
      // Some native keyboards issue a non-cancelable input before the selection
      // notification arrives. Retain all committed text and append the new input.
      if (typeof added === "string" && added.length &&
          ["insertText", "insertFromPaste", "insertCompositionText", "insertFromComposition", "insertFromDictation"].includes(kind)) {
        editor.value = before + added;
        pin();
        return true;
      }
    }
    editor.value = before;
    pin();
    blocked();
    return false;
  }
  return {
    accept, pin,
    get composing() { return composing; },
    reset() { composing = false; pendingKind = ""; pasteText = ""; pin(); }
  };
}
if (typeof module !== "undefined" && module.exports) module.exports = KaretkaMachineInput;
