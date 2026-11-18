"use strict";
const $ = (id) => document.getElementById(id);
const F = KaretkaFormats,
  S = KaretkaStore;
const iconPaths = {
  machine:
    '<path d="M7 10V3.5h10V10M9 6h6M4 10h16M5.5 11 3 18v2h18v-2l-2.5-7M6 16h12M9 18h6"/><path d="M8 13.2h.2m2.3 0h.2m2.3 0h.2m2.3 0h.2"/>',
  desk: '<path d="M3 11h18M5 11v9m14-9v9M7 8.5h10M10 8.5V4h6"/>',
  library: '<path d="M3.5 4.5h3v15h-3zM9 4h3v15.5H9zM14.5 6l3-1 4.2 13.8-3 1z"/>',
  settings:
    '<path d="m10 3-.55 2.3-2 .9-2.1-.9-1.8 3.2 1.7 1.6-.2 2.2-1.6 1.7 1.8 3.2 2.3-.6 1.8 1.2.6 2.2h3.9l.6-2.2 1.8-1.2 2.3.6 1.8-3.2-1.6-1.7-.2-2.2 1.7-1.6-1.8-3.2-2.1.9-2-.9L14 3z"/><circle cx="12" cy="11.8" r="3"/>',
  focus: '<path d="M8.5 4H4v4.5M15.5 4H20v4.5M20 15.5V20h-4.5M8.5 20H4v-4.5"/>',
  collapse: '<path d="M4 9h5V4m11 5h-5V4m5 11h-5v5M4 15h5v5"/>',
  download: '<path d="M12 3v12m-4.5-4.5L12 15l4.5-4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  outline: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 5v14m3-10h5m-5 4h4"/>',
  chevron: '<path d="m7.5 10 4.5 4.5 4.5-4.5"/>',
  edit: '<path d="m4 16-1 5 5-1L20 8l-4-4zM13.5 6.5l4 4"/>',
  speakerOff: '<path d="M3 10h4l5-4v12l-5-4H3zM16 9l5 6m0-6-5 6"/>',
  speaker: '<path d="M3 10h4l5-4v12l-5-4H3zM15 9c2 1.6 2 4.4 0 6m2.5-9c4.5 3.3 4.5 8.7 0 12"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.7 2.7 5.3-5.4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  book: '<path d="M5 5a2 2 0 0 1 2-2h12v16H7a2 2 0 0 0 0 4M5 5v16m2-2h12M9 7h6"/>',
  page: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7m-7 4h6"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  back: '<path d="m13 6-6 6 6 6m-6-6h13"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/>',
  notebook: '<path d="M5 4h14v16H5zM8 4v16M3 7h3m-3 5h3m-3 5h3m7-8h4m-4 4h4"/>',
  cloud: '<path d="M6 17h12a4 4 0 0 0 .1-8A6.2 6.2 0 0 0 6 8.5 4.3 4.3 0 0 0 6 17z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
function icon(name) {
  return (
    '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">' + (iconPaths[name] || "") + "</svg>"
  );
}
document.querySelectorAll("i[data-icon]").forEach((el) => {
  el.outerHTML = icon(el.dataset.icon);
});
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
const uid = () =>
  crypto.randomUUID?.() ||
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
    x.toString(16).padStart(2, "0")
  ).join("");
const labels = { single: "Один текст", chapters: "Главы", scenes: "Сцены" };
const idDemo = "00000000-0000-4000-a000-000000000001";
const newUnit = (title) => ({ id: uid(), title, text: "", scenes: [], plan: {} });
function newBook(title, kind) {
  const now = Date.now();
  return {
    id: uid(),
    title,
    kind,
    sections: [
      newUnit(kind === "single" ? title : kind === "scenes" ? "Первая сцена" : "Первая глава")
    ],
    cards: [],
    created: now,
    updated: now,
    version: uid(),
    rev: 0
  };
}
function sampleBook() {
  const b = newBook("Письма с маяка", "chapters");
  b.id = idDemo;
  b.demo = true;
  b.sections[0].id = "sample-first";
  b.sections[0].title = "Первое письмо";
  b.sections[0].text =
    "К вечеру море стихло. Старик зажёг маяк на десять минут раньше и сел у окна разбирать почту.\n\nНа дне сумки лежал конверт без марки. Он узнал почерк раньше, чем прочитал своё имя.";
  return b;
}
const diskVersions = new Map();
const books = new Map(),
  pending = new Set(),
  saving = new Map(),
  errors = new Set(),
  persisted = new Map();
let book,
  part,
  mode = "machine",
  ready = false,
  storageReady = false,
  panelView = "",
  toastTimeout,
  layoutTicket,
  lastLine,
  lastColumn,
  countTimer,
  firstGeometry = true;
const writer = $("writer"),
  stage = $("stage"),
  area = $("writingArea"),
  sheet = $("sheet"),
  mirror = $("mirror"),
  dialog = $("panel");
const prefs = Object.assign(
  { correction: "free", size: 18, paper: "cream", sound: false, lamp: true },
  S.readPref("settings", {})
);
let cloud,
  offlineReady = false;
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $("toast").classList.remove("show"), 3600);
}
function badge() {
  if (!book) return;
  const fail = errors.has(book.id) || !storageReady;
  let message = fail
    ? "Локальное сохранение недоступно"
    : pending.has(book.id) || saving.has(book.id)
      ? "Сохраняется…"
      : "Сохранено на устройстве";
  if (!fail && !pending.has(book.id) && !saving.has(book.id) && cloud?.connected && !book.demo)
    message = cloud.badge(book);
  $("saveText").textContent = message;
  $("saveBadge").classList.toggle("problem", fail);
}
function touch(b = book, content = true) {
  if (!b) return;
  if (content && b.demo) {
    const oldId = b.id;
    b.id = uid();
    b.rev = 0;
    b.demo = false;
    b.cloud = null;
    const sample = sampleBook();
    sample.rev = persisted.get(oldId) || 0;
    books.set(oldId, sample);
    books.set(b.id, b);
    if (book === b) {
      S.writePref("selected", { book: b.id, part: part.id });
      renderHeader();
    }
  }
  if (content) {
    b.version = uid();
    b.updated = Date.now();
  }
  pending.add(b.id);
  badge();
  void persist(b.id);
}
async function persist(id) {
  if (!storageReady || saving.has(id)) return;
  const work = (async () => {
    while (pending.has(id)) {
      pending.delete(id);
      const b = books.get(id);
      if (!b) continue;
      const expected = persisted.get(id) || 0;
      const snap = structuredClone(b);
      snap.rev = expected + 1;
      const matched = await S.save(snap, expected);
      if (!matched) {
        const old = (await S.readAll()).find((v) => v.id === id);
        if (old && (old.version === snap.version || old.version === diskVersions.get(id))) {
          persisted.set(id, old.rev);
          diskVersions.set(id, old.version);
          b.rev = old.rev;
          if (old.cloud && (!b.cloud || b.cloud.version === old.version)) b.cloud = old.cloud;
          if (old.version !== b.version || JSON.stringify(old.cloud) !== JSON.stringify(b.cloud))
            pending.add(id);
          continue;
        }
        const local = structuredClone(b);
        local.id = uid();
        local.title += " (параллельная версия)";
        local.rev = 0;
        local.cloud = null;
        local.version = uid();
        local.demo = false;
        pending.delete(id);
        if (old) {
          books.set(id, old);
          persisted.set(id, old.rev);
        }
        books.set(local.id, local);
        touch(local, false);
        if (book?.id === id) selectBook(local, part?.id);
        toast("Обе версии сохранены. Открыта ваша параллельная версия.");
        break;
      }
      b.rev = snap.rev;
      persisted.set(id, snap.rev);
      diskVersions.set(id, snap.version);
      errors.delete(id);
      const journalKey = "journal." + id;
      try {
        const saved = S.readPref(journalKey, null);
        if (saved?.book?.version === snap.version)
          localStorage.removeItem("karetka.v1." + journalKey);
      } catch {}
    }
  })();
  saving.set(id, work);
  try {
    await work;
  } catch {
    errors.add(id);
    pending.add(id);
  } finally {
    saving.delete(id);
    badge();
    if (!errors.has(id)) cloud?.schedule();
  }
}
async function flush() {
  for (const id of [...pending]) void persist(id);
  await Promise.allSettled([...saving.values()]);
}
function journal() {
  for (const id of new Set([...pending, ...saving.keys()])) {
    const b = books.get(id);
    if (b) S.writePref("journal." + id, { book: b, base: persisted.get(id) || 0 });
  }
}
function repairJournal() {
  let keys = [];
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith("karetka.v1.journal."));
  } catch {}
  for (const key of keys) {
    try {
      const { book: b, base } = JSON.parse(localStorage.getItem(key));
      const live = books.get(b.id);
      if (live?.version === b.version) {
        localStorage.removeItem(key);
        continue;
      }
      if (live && live.rev !== base) {
        b.id = uid();
        b.rev = 0;
        b.title += " (восстановлено)";
        b.cloud = null;
        b.demo = false;
      }
      books.set(b.id, b);
      pending.add(b.id);
      void persist(b.id).then(() => {
        if (!errors.has(b.id)) localStorage.removeItem(key);
      });
    } catch {}
  }
}
let audioCtx, noiseBuffer;
function audioReady() {
  if (!prefs.sound) return;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
  } catch {}
}
function clickSound(kind) {
  if (!prefs.sound || !audioCtx || audioCtx.state !== "running") return;
  const ctx = audioCtx,
    t = ctx.currentTime;
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.095), ctx.sampleRate);
    const v = noiseBuffer.getChannelData(0);
    for (let i = 0; i < v.length; i++)
      v[i] = (Math.random() * 2 - 1) * Math.exp(-i / (v.length * 0.18));
  }
  const noise = ctx.createBufferSource(),
    filter = ctx.createBiquadFilter(),
    gain = ctx.createGain();
  noise.buffer = noiseBuffer;
  filter.type = "bandpass";
  filter.frequency.value = kind === "return" ? 850 : 1650 + Math.random() * 600;
  filter.Q.value = 0.8;
  gain.gain.value = kind === "return" ? 0.12 : 0.13;
  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start(t);
  const tone = ctx.createOscillator(),
    g = ctx.createGain();
  tone.frequency.value = kind === "return" ? 1396 : kind === "space" ? 110 : 175;
  g.gain.setValueAtTime(kind === "return" ? 0.042 : 0.045, t);
  g.gain.exponentialRampToValueAtTime(0.0002, t + (kind === "return" ? 0.26 : 0.032));
  tone.connect(g).connect(ctx.destination);
  tone.start(t);
  tone.stop(t + (kind === "return" ? 0.28 : 0.04));
}
function wordLabel(n) {
  return n.toLocaleString("ru-RU") + " " + F.plural(n, "слово", "слова", "слов");
}
function partType(sec = part) {
  if (!book || !sec) return "Текст";
  return book.kind === "single"
    ? "Текст"
    : book.kind === "scenes" || book.sections.every((s) => s.id !== sec.id)
      ? "Сцена"
      : "Глава";
}
function allParts(b) {
  return b.sections.flatMap((s) => [s, ...s.scenes]);
}
function updateCounts() {
  if (!part) return;
  const count = F.words(part.text),
    chars = Array.from(part.text).length;
  const digits = String(count).padStart(4, "0");
  if ($("counter").dataset.n !== digits) {
    $("counter").innerHTML = [...digits].map((x) => "<span>" + x + "</span>").join("");
    $("counter").dataset.n = digits;
  }
  $("countAccessible").textContent = wordLabel(count);
  $("charStatus").textContent =
    chars.toLocaleString("ru-RU") + " " + F.plural(chars, "знак", "знака", "знаков");
}
function renderHeader() {
  const type = partType(),
    parent = book.sections.find((s) => s.scenes.some((sc) => sc.id === part.id));
  const siblings = parent ? parent.scenes : book.sections;
  const index = siblings.findIndex((s) => s.id === part.id) + 1;
  $("sectionKind").textContent =
    type === "Текст" ? "Рукопись" : type + " " + String(index).padStart(2, "0");
  $("sectionTitle").textContent = book.kind === "single" ? book.title : part.title;
  $("currentBook").textContent = book.title;
  $("sampleTag").hidden = !book.demo;
  $("outlineStatus").textContent =
    type === "Текст" ? "Один текст" : type + " " + index + " из " + siblings.length;
  $("counterLabel").textContent =
    type === "Текст" ? "Слов в тексте" : type === "Сцена" ? "Слов в сцене" : "Слов в главе";
  document.title = book.title + " — Каретка";
  updateCounts();
  badge();
}
function selectBook(b, id, place) {
  book = b;
  part = allParts(b).find((s) => s.id === id) || b.sections[0];
  if (!part) return;
  writer.value = part.text;
  const end = Number.isFinite(place) ? Math.min(place, writer.value.length) : writer.value.length;
  writer.setSelectionRange(end, end);
  writer.readOnly = false;
  lastLine = undefined;
  firstGeometry = true;
  S.writePref("selected", { book: b.id, part: part.id });
  renderHeader();
  scheduleLayout();
  window.dispatchEvent(new Event("karetka-part"));
}
function updateSettings() {
  S.writePref("settings", prefs);
  document.body.dataset.paper = prefs.paper;
  document.body.classList.toggle("no-lamp", !prefs.lamp);
  document.documentElement.style.setProperty("--font-ink", prefs.size + "px");
  $("soundButton").setAttribute("aria-pressed", String(prefs.sound));
  $("soundButton").querySelector(".sound-icon").innerHTML = icon(
    prefs.sound ? "speaker" : "speakerOff"
  );
  writer.spellcheck = mode === "edit";
  writer.setAttribute("autocorrect", locked() ? "off" : "on");
  scheduleLayout();
}
function locked() {
  return mode === "machine" && prefs.correction === "draft";
}
function setMode(next, focus = true) {
  mode = next;
  stage.classList.toggle("editing", mode === "edit");
  $("machineMode").setAttribute("aria-pressed", String(mode === "machine"));
  $("editMode").setAttribute("aria-pressed", String(mode === "edit"));
  writer.style.paddingTop = "0px";
  writer.style.paddingBottom = "0px";
  writer.style.top = "0px";
  if (locked()) writer.setSelectionRange(writer.value.length, writer.value.length);
  if (focus) writer.focus({ preventScroll: true });
  lastLine = undefined;
  updateSettings();
  scheduleLayout();
}
function scheduleLayout() {
  if (!layoutTicket)
    layoutTicket = requestAnimationFrame(() => {
      layoutTicket = 0;
      layout();
    });
}
let strikeSound = "";
function layout() {
  if (!part || !sheet.clientWidth) return;
  const head = sheet.querySelector(".paper-head"),
    isCompact = getComputedStyle(head).display === "none";
  let bodyTop = isCompact
    ? 8
    : Math.ceil(head.offsetTop + head.offsetHeight + Math.min(30, sheet.clientHeight * 0.055));
  if (sheet.clientHeight - bodyTop < 72) {
    bodyTop = isCompact ? 8 : Math.min(bodyTop, Math.max(18, sheet.clientHeight - 76));
  }
  area.style.setProperty("--body-top", bodyTop + "px");
  if (mode === "edit") return;
  const value = writer.value,
    caret = writer.selectionDirection === "backward" ? writer.selectionStart : writer.selectionEnd;
  const start = caret > 0 ? value.lastIndexOf("\n", caret - 1) + 1 : 0;
  const after = value.indexOf("\n", caret);
  const mark = document.createElement("span");
  const paraEnd = after < 0 ? value.length : after;
  // Keep the whole word around the marker so native line wrapping matches the textarea.
  mark.textContent = value.slice(caret, paraEnd) || "\u200b";
  mirror.replaceChildren(document.createTextNode(value.slice(start, caret)), mark);
  const range = document.createRange();
  range.setStart(mark.firstChild, 0);
  range.collapse(true);
  const rc = range.getClientRects()[0] || mark.getClientRects()[0];
  if (!rc) return;
  const sr = stage.getBoundingClientRect(),
    ar = area.getBoundingClientRect(),
    mr = mirror.getBoundingClientRect(),
    pr = sheet.getBoundingClientRect();
  const x = Math.min(ar.right, Math.max(ar.left, ar.left + rc.left - mr.left));
  const lh = parseFloat(getComputedStyle(writer).lineHeight);
  const oldScroll = writer.scrollTop;
  // Native scrolling preserves selection, IME, copy and ordinary keyboard shortcuts.
  const currentParagraphRows = Math.floor((rc.top - mr.top) / lh + 0.25);
  let beforeRows = 0;
  if (start > 0) {
    const prefix = value.slice(0, start - 1);
    if (
      layout.prefix !== prefix ||
      layout.width !== area.clientWidth ||
      layout.size !== prefs.size
    ) {
      const probe = layout.probe || (layout.probe = document.createElement("div"));
      if (!probe.isConnected) {
        probe.className = "ink mirror";
        area.append(probe);
      }
      probe.textContent = prefix + "\u200b";
      layout.prefix = prefix;
      layout.width = area.clientWidth;
      layout.size = prefs.size;
      layout.rows = Math.max(1, Math.round(probe.getBoundingClientRect().height / lh));
    }
    beforeRows = layout.rows;
  }
  const row = beforeRows + currentParagraphRows;
  const padding = Math.max(0, area.clientHeight - lh);
  writer.style.paddingTop = padding + "px";
  writer.style.paddingBottom = padding + "px";
  if (!writer.matches(":active") || writer.selectionStart === writer.selectionEnd) {
    writer.scrollTop = Math.round(row * lh);
  }
  if (!Number.isFinite(writer.scrollTop)) writer.scrollTop = oldScroll;
  const isReturn = lastLine !== undefined && row > lastLine;
  $("carriage").classList.toggle("return", isReturn);
  $("carriage").classList.toggle("jump", firstGeometry);
  stage.style.setProperty("--car-x", x - sr.left - stage.clientLeft + "px");
  $("lamp").style.left = x - pr.left + "px";
  if (strikeSound) clickSound(isReturn || strikeSound === "return" ? "return" : strikeSound);
  strikeSound = "";
  firstGeometry = false;
  lastLine = row;
  lastColumn = x;
}
function focusMode(on) {
  $("app").classList.toggle("focus", on);
  $("exitFocus").hidden = !on;
  writer.focus({ preventScroll: true });
  scheduleLayout();
}
function blockEdit() {
  if (!blockEdit.last || Date.now() - blockEdit.last > 1800) {
    toast("Для исправлений откройте «Правка».");
    blockEdit.last = Date.now();
  }
}
writer.addEventListener("keydown", (e) => {
  audioReady();
  if (!locked() || e.isComposing) return;
  const key = e.key.toLowerCase();
  if (
    ["backspace", "delete"].includes(key) ||
    ((e.metaKey || e.ctrlKey) && ["z", "y", "x"].includes(key))
  ) {
    e.preventDefault();
    blockEdit();
  }
});
writer.addEventListener("beforeinput", (e) => {
  audioReady();
  if (!locked() || e.isComposing) return;
  if (
    /^(delete|history|format)/.test(e.inputType) ||
    ["insertFromDrop", "insertReplacementText"].includes(e.inputType)
  ) {
    e.preventDefault();
    blockEdit();
    return;
  }
  if (writer.selectionStart !== writer.value.length || writer.selectionEnd !== writer.value.length)
    writer.setSelectionRange(writer.value.length, writer.value.length);
});
writer.addEventListener("compositionstart", () => {
  if (locked()) writer.setSelectionRange(writer.value.length, writer.value.length);
});
writer.addEventListener("cut", (e) => {
  if (locked()) {
    e.preventDefault();
    blockEdit();
  }
});
writer.addEventListener("drop", (e) => {
  if (locked()) {
    e.preventDefault();
    blockEdit();
  }
});
writer.addEventListener("input", (e) => {
  if (!part) return;
  if (locked() && !e.isComposing && !writer.value.startsWith(part.text)) {
    writer.value = part.text;
    writer.setSelectionRange(writer.value.length, writer.value.length);
    blockEdit();
    scheduleLayout();
    return;
  }
  if (e.isComposing) {
    scheduleLayout();
    return;
  }
  if (part.text !== writer.value) {
    part.text = writer.value;
    touch();
  }
  strikeSound =
    mode === "machine"
      ? e.inputType === "insertLineBreak"
        ? "return"
        : e.data === " "
          ? "space"
          : "key"
      : "";
  scheduleLayout();
  clearTimeout(countTimer);
  countTimer = setTimeout(updateCounts, 90);
});
writer.addEventListener("compositionend", () => {
  if (part && part.text !== writer.value) {
    if (locked() && !writer.value.startsWith(part.text)) writer.value = part.text;
    else {
      part.text = writer.value;
      touch();
    }
    updateCounts();
    scheduleLayout();
  }
});
["keyup", "click", "select", "focus"].forEach((name) =>
  writer.addEventListener(name, scheduleLayout)
);
document.addEventListener("selectionchange", () => {
  if (document.activeElement === writer) scheduleLayout();
});
sheet.addEventListener("click", (e) => {
  if (e.target !== writer) writer.focus({ preventScroll: true });
  audioReady();
  scheduleLayout();
});
new ResizeObserver(scheduleLayout).observe(stage);
function viewport() {
  const vv = window.visualViewport;
  if (vv) {
    document.documentElement.style.setProperty("--view-height", Math.round(vv.height) + "px");
    $("app").classList.toggle(
      "keyboard",
      innerHeight - vv.height > 125 && document.activeElement === writer
    );
  }
  scheduleLayout();
}
window.visualViewport?.addEventListener("resize", viewport);
window.addEventListener("resize", viewport);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    journal();
    void flush();
  } else cloud?.schedule(100);
});
window.addEventListener("pagehide", journal);
function panel(view, title, sub = "", layout = "") {
  panelView = view;
  dialog.className = layout;
  $("panelTitle").textContent = title;
  $("panelSub").textContent = sub;
  $("panelSub").hidden = !sub;
  $("panelBody").replaceChildren();
  if (!dialog.open) dialog.showModal();
}
function closePanel() {
  if (dialog.open) dialog.close();
}
dialog.addEventListener("close", () => {
  panelView = "";
  scheduleLayout();
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
      closePanel();
  }
});
function btn(text, name = "none", style = "btn") {
  return (
    '<button type="button" class="' + style + '" data-act="' + name + '">' + text + "</button>"
  );
}
function action(name, fn, root = $("panelBody")) {
  const el = root.querySelector('[data-act="' + name + '"]');
  if (el) el.onclick = fn;
}
function viewLibrary() {
  panel("library", "Рукописи", "Книги, рассказы и отдельные тексты.", "drawer left");
  const list = [...books.values()].sort(
    (a, b) => Number(a.demo || false) - Number(b.demo || false) || b.updated - a.updated
  );
  const rows = list
    .map(
      (b) =>
        '<div class="library-row ' +
        (b.id === book.id ? "selected" : "") +
        '"><button class="list-open" data-book="' +
        esc(b.id) +
        '">' +
        icon("book") +
        '<span class="row-text"><strong>' +
        esc(b.title) +
        "</strong><small>" +
        (b.demo ? "Образец · " : "") +
        labels[b.kind] +
        " · " +
        wordLabel(F.ordered(b).reduce((n, s) => n + F.words(s.text), 0)) +
        '</small></span></button><div class="list-controls"><button title="Переименовать рукопись" aria-label="Переименовать ' +
        esc(b.title) +
        '" data-rename="' +
        esc(b.id) +
        '">' +
        icon("edit") +
        "</button></div></div>"
    )
    .join("");
  $("panelBody").innerHTML =
    '<div class="group">' +
    btn(icon("plus") + "Новая рукопись", "new", "btn main wide") +
    '</div><div class="group">' +
    rows +
    '</div><hr><div class="group">' +
    btn(icon("upload") + "Открыть из файла", "import", "btn") +
    btn(icon("cloud") + "Синхронизация устройств", "sync", "btn") +
    "</div>";
  action("new", () => bookForm());
  action("import", () => $("fileInput").click());
  action("sync", viewCloud);
  $("panelBody")
    .querySelectorAll("[data-book]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          selectBook(books.get(el.dataset.book));
          closePanel();
        })
    );
  $("panelBody")
    .querySelectorAll("[data-rename]")
    .forEach((el) => (el.onclick = () => bookForm(books.get(el.dataset.rename))));
}
function bookForm(existing) {
  const initKind = existing?.kind || "single";
  let kind = initKind;
  panel("bookForm", existing ? "Название рукописи" : "Новая рукопись");
  $("panelBody").innerHTML =
    '<form id="bookForm"><div class="form-field"><label for="bookTitle">Название</label><input id="bookTitle" type="text" maxlength="180" required placeholder="Название рукописи" value="' +
    esc(existing?.title || "") +
    '"></div>' +
    (!existing
      ? '<div class="group"><h3>Структура</h3>' +
        [
          ["single", "Один текст", "Рассказ, эссе или запись."],
          ["chapters", "Главы", "Внутри главы можно добавить сцены."],
          ["scenes", "Сцены", "Соберите историю из отдельных эпизодов."]
        ]
          .map(
            ([k, label, h]) =>
              '<button type="button" class="option ' +
              (k === kind ? "selected" : "") +
              '" data-kind="' +
              k +
              '" aria-pressed="' +
              (k === kind) +
              '"><span class="choice"></span><span class="row-text"><strong>' +
              label +
              "</strong><small>" +
              h +
              "</small></span></button>"
          )
          .join("") +
        "</div>"
      : "") +
    '<div class="button-row end">' +
    btn("Назад", "back") +
    '<button type="submit" class="btn main">' +
    (existing ? "Сохранить" : "Создать") +
    "</button></div></form>";
  $("panelBody")
    .querySelectorAll("[data-kind]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          kind = el.dataset.kind;
          for (const x of $("panelBody").querySelectorAll("[data-kind]")) {
            x.classList.toggle("selected", x === el);
            x.setAttribute("aria-pressed", String(x === el));
          }
        })
    );
  action("back", viewLibrary);
  $("bookForm").onsubmit = (e) => {
    e.preventDefault();
    const t = $("bookTitle").value.trim();
    if (!t) return;
    if (existing) {
      existing.title = t;
      if (existing.kind === "single") existing.sections[0].title = t;
      touch(existing);
      if (existing.id === book.id) renderHeader();
      viewLibrary();
    } else {
      const b = newBook(t, kind);
      books.set(b.id, b);
      selectBook(b);
      touch(b);
      closePanel();
      writer.focus({ preventScroll: true });
    }
  };
  $("bookTitle").focus();
}
function outline() {
  panel("outline", "Оглавление", book.title, "drawer left");
  const all = F.ordered(book);
  const rows = all
    .map((s) => {
      const arr = s.parent ? s.parent.scenes : book.sections,
        idx = arr.findIndex((x) => x.id === s.id);
      const controls =
        book.kind === "single"
          ? ""
          : '<div class="list-controls"><button aria-label="Поднять ' +
            esc(s.title) +
            '" title="Поднять" ' +
            (idx <= 0 ? "disabled" : "") +
            ' data-move="-1" data-id="' +
            esc(s.id) +
            '">' +
            icon("up") +
            '</button><button aria-label="Опустить ' +
            esc(s.title) +
            '" title="Опустить" ' +
            (idx >= arr.length - 1 ? "disabled" : "") +
            ' data-move="1" data-id="' +
            esc(s.id) +
            '">' +
            icon("down") +
            '</button><button aria-label="Изменить ' +
            esc(s.title) +
            '" title="Свойства раздела" data-unit="' +
            esc(s.id) +
            '">' +
            icon("more") +
            "</button></div>";
      return (
        '<div class="outline-row ' +
        (s.depth === 2 ? "scene-row " : "") +
        (s.id === part.id ? "selected" : "") +
        '"><button class="list-open" data-section="' +
        esc(s.id) +
        '">' +
        icon(s.depth === 2 ? "page" : "outline") +
        '<span class="row-text"><strong>' +
        esc(s.title) +
        "</strong><small>" +
        (s.depth === 2 ? "Сцена · " : "") +
        wordLabel(F.words(s.text)) +
        "</small></span></button>" +
        controls +
        "</div>"
      );
    })
    .join("");
  $("panelBody").innerHTML =
    '<div class="group">' +
    rows +
    '</div><div class="group">' +
    (book.kind === "single"
      ? btn("Разделить на главы", "convert", "btn")
      : btn(
          icon("plus") + (book.kind === "chapters" ? "Добавить главу" : "Добавить сцену"),
          "add",
          "btn"
        )) +
    (book.kind === "chapters" ? btn(icon("plus") + "Сцена внутри главы", "scene", "btn") : "") +
    "</div>" +
    btn(icon("library") + "Все рукописи", "library", "subtle-btn");
  action("library", viewLibrary);
  action("add", () => unitForm());
  action("scene", () =>
    unitForm(
      null,
      book.sections.find((s) => s.id === part.id || s.scenes.some((x) => x.id === part.id))
    )
  );
  action("convert", () => {
    book.kind = "chapters";
    book.sections[0].title = "Первая глава";
    touch();
    renderHeader();
    outline();
  });
  $("panelBody")
    .querySelectorAll("[data-section]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          selectBook(book, el.dataset.section);
          closePanel();
          writer.focus({ preventScroll: true });
        })
    );
  $("panelBody")
    .querySelectorAll("[data-unit]")
    .forEach((el) => (el.onclick = () => unitForm(all.find((s) => s.id === el.dataset.unit))));
  $("panelBody")
    .querySelectorAll("[data-move]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          const s = all.find((x) => x.id === el.dataset.id),
            arr = s.parent ? s.parent.scenes : book.sections;
          const i = arr.findIndex((x) => x.id === s.id),
            j = i + Number(el.dataset.move);
          if (j < 0 || j >= arr.length) return;
          [arr[i], arr[j]] = [arr[j], arr[i]];
          touch();
          renderHeader();
          outline();
        })
    );
}
function unitForm(item, parent = null) {
  const isScene = parent || item?.depth === 2 || book.kind === "scenes",
    noun = isScene ? "сцены" : "главы";
  panel(
    "unitForm",
    item ? "Свойства " + noun : isScene ? "Новая сцена" : "Новая глава",
    parent ? parent.title : book.title
  );
  const canRemove = item && (item.parent || book.sections.length > 1);
  $("panelBody").innerHTML =
    '<form id="unitForm"><div class="form-field"><label for="unitTitle">Название ' +
    noun +
    '</label><input id="unitTitle" type="text" required maxlength="180" value="' +
    esc(item?.title || "") +
    '"></div><div class="button-row end">' +
    btn("Назад", "back") +
    '<button type="submit" class="btn main">' +
    (item ? "Сохранить" : "Добавить") +
    "</button></div></form>" +
    (canRemove ? "<hr>" + btn("Удалить раздел", "remove", "subtle-btn") : "");
  action("back", outline);
  $("unitForm").onsubmit = (e) => {
    e.preventDefault();
    const v = $("unitTitle").value.trim();
    if (!v) return;
    if (item) {
      item.unit.title = v;
      touch();
      renderHeader();
      outline();
    } else {
      const s = newUnit(v);
      (parent ? parent.scenes : book.sections).push(s);
      touch();
      selectBook(book, s.id);
      closePanel();
      writer.focus({ preventScroll: true });
    }
  };
  action("remove", () => {
    panel("remove", "Удалить раздел?", item.title);
    $("panelBody").innerHTML =
      '<p class="notice">Раздел будет удалён вместе с текстом и вложенными сценами.</p><div class="button-row end">' +
      btn("Отмена", "cancel") +
      btn("Удалить", "yes", "btn main") +
      "</div>";
    action("cancel", outline);
    action("yes", () => {
      const arr = item.parent ? item.parent.scenes : book.sections;
      arr.splice(
        arr.findIndex((s) => s.id === item.id),
        1
      );
      touch();
      selectBook(book, part.id);
      outline();
    });
  });
  $("unitTitle").focus();
}
function settings() {
  panel("settings", "Настройки");
  const opt = (val, title, sub) =>
    '<button class="option ' +
    (prefs.correction === val ? "selected" : "") +
    '" data-correct="' +
    val +
    '" aria-pressed="' +
    (prefs.correction === val) +
    '"><span class="choice"></span><span class="row-text"><strong>' +
    title +
    "</strong><small>" +
    sub +
    "</small></span></button>";
  const pills = (key, vals) =>
    vals
      .map(
        ([v, t, color]) =>
          '<button class="pill ' +
          (String(prefs[key]) === String(v) ? "selected" : "") +
          '" aria-pressed="' +
          (String(prefs[key]) === String(v)) +
          '" data-pref="' +
          key +
          '" data-val="' +
          v +
          '">' +
          (color ? '<span class="swatch" style="background:' + color + '"></span>' : "") +
          t +
          "</button>"
      )
      .join("");
  $("panelBody").innerHTML =
    '<div class="group"><h3>Исправления в машинке</h3>' +
    opt("free", "Свободные правки", "Можно двигать курсор и исправлять написанное сразу.") +
    opt(
      "draft",
      "Сначала черновик",
      "Машинка дописывает в конец. Для изменений откройте «Правка»."
    ) +
    '</div><div class="group"><h3>Шрифт рукописи</h3><div class="opt-grid">' +
    pills("size", [
      [16, "16 px"],
      [18, "18 px"],
      [21, "21 px"],
      [24, "24 px"]
    ]) +
    '</div></div><div class="group"><h3>Бумага</h3><div class="opt-grid">' +
    pills("paper", [
      ["cream", "Кремовая", "#f7efd9"],
      ["white", "Белая", "#fff"],
      ["gray", "Шалфей", "#e1e5d9"]
    ]) +
    '</div></div><div class="group"><label class="checkline">Подсветка у каретки<input type="checkbox" id="lampCheck" ' +
    (prefs.lamp ? "checked" : "") +
    '></label><label class="checkline">Звук клавиш и звонок<input type="checkbox" id="soundCheck" ' +
    (prefs.sound ? "checked" : "") +
    '></label></div><hr><div class="group">' +
    btn(icon("cloud") + "Синхронизация устройств", "cloud", "btn") +
    '<p class="file-hint" id="offlineInfo"></p></div>';
  $("offlineInfo").textContent = offlineReady
    ? "Офлайн-режим готов на этом устройстве."
    : "Офлайн-режим подготовится после загрузки приложения по HTTPS.";
  $("panelBody")
    .querySelectorAll("[data-correct]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          prefs.correction = el.dataset.correct;
          if (locked()) writer.setSelectionRange(writer.value.length, writer.value.length);
          updateSettings();
          settings();
        })
    );
  $("panelBody")
    .querySelectorAll("[data-pref]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          prefs[el.dataset.pref] =
            el.dataset.pref === "size" ? Number(el.dataset.val) : el.dataset.val;
          updateSettings();
          settings();
        })
    );
  $("lampCheck").onchange = (e) => {
    prefs.lamp = e.target.checked;
    updateSettings();
  };
  $("soundCheck").onchange = (e) => {
    prefs.sound = e.target.checked;
    audioReady();
    updateSettings();
    if (prefs.sound) clickSound("key");
  };
  action("cloud", viewCloud);
}
function viewExport() {
  panel("export", "Экспорт рукописи", book.title);
  let format = "docx";
  const opts = [
    ["docx", "Документ Word", ".docx · Весь текст с заголовками"],
    ["txt", "Обычный текст", ".txt · Для любого редактора"],
    ["json", "Копия рукописи", ".json · Структура, текст, картотека и планы"]
  ];
  $("panelBody").innerHTML =
    '<div class="group">' +
    opts
      .map(
        ([f, t, h]) =>
          '<button class="export-row ' +
          (f === format ? "selected" : "") +
          '" data-format="' +
          f +
          '" aria-pressed="' +
          (f === format) +
          '"><span class="choice"></span><span class="row-text"><strong>' +
          t +
          "</strong><small>" +
          h +
          "</small></span></button>"
      )
      .join("") +
    "</div>" +
    btn(icon("download") + "Скачать", "download", "btn main wide");
  $("panelBody")
    .querySelectorAll("[data-format]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          format = el.dataset.format;
          for (const x of $("panelBody").querySelectorAll("[data-format]")) {
            x.classList.toggle("selected", x === el);
            x.setAttribute("aria-pressed", String(x === el));
          }
        })
    );
  action("download", () => {
    const blob =
      format === "docx"
        ? F.toDocx(book)
        : new Blob(format === "txt" ? ["\ufeff", F.manuscript(book)] : [F.backup(book)], {
            type: format === "txt" ? "text/plain;charset=utf-8" : "application/json"
          });
    F.download(blob, book.title, format === "json" ? "karetka.json" : format);
    closePanel();
  });
}
$("fileInput").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const raw = await file.text();
    let b;
    if (/\.json$/i.test(file.name)) {
      const v = F.parseBackup(raw);
      b = newBook(v.title, v.kind);
      b.cards = (v.cards || []).map((c) => ({ ...c, id: uid() }));
      const unit = (s) => Object.assign(newUnit(s.title), { text: s.text, plan: s.plan || {} });
      b.sections = v.sections.map((s) => ({ ...unit(s), scenes: s.scenes.map(unit) }));
    } else if (/\.txt$/i.test(file.name)) {
      b = newBook(file.name.replace(/\.txt$/i, "") || "Рукопись", "single");
      b.sections[0].text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    } else throw new Error("Выберите TXT или копию рукописи JSON.");
    books.set(b.id, b);
    selectBook(b);
    touch(b);
    closePanel();
    toast("Рукопись открыта.");
  } catch (err) {
    panel("error", "Не удалось открыть файл");
    $("panelBody").innerHTML =
      '<p class="form-error">' +
      esc(err instanceof SyntaxError ? "Проверьте формат файла JSON." : err.message) +
      "</p>" +
      btn("К рукописям", "back");
    action("back", viewLibrary);
  }
};
function viewCloud() {
  panel("cloud", "Синхронизация", "Общие рукописи на компьютере, планшете и телефоне.");
  const online = !!cloud?.connected;
  $("panelBody").innerHTML = online
    ? '<div class="group"><p class="notice" id="cloudInfo"></p>' +
      btn("Синхронизировать сейчас", "sync", "btn main") +
      btn("Код для другого устройства", "reveal") +
      '</div><div id="revealArea"></div>'
    : '<div class="group"><p class="hint">На первом устройстве создайте хранилище. На остальных введите тот же код. Код открывает ваши рукописи, поэтому храните его в надёжном месте.</p>' +
      btn("Создать хранилище", "create", "btn main") +
      '</div><hr><form id="joinForm"><div class="form-field"><label for="vaultKey">Код с другого устройства</label><input id="vaultKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required></div><button type="submit" class="btn">Подключить устройство</button></form>';
  const body = $("panelBody");
  const error = document.createElement("p");
  error.className = "form-error";
  error.setAttribute("role", "status");
  body.append(error);
  const run = async (fn) => {
    body.querySelectorAll("button").forEach((b) => (b.disabled = true));
    error.textContent = "Подключаемся…";
    try {
      await fn();
      if (panelView === "cloud") viewCloud();
    } catch (e) {
      error.textContent = e.message || "Связь с хранилищем недоступна.";
    } finally {
      body.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  };
  if (online) {
    $("cloudInfo").textContent = cloud.info();
    action("sync", () => run(() => cloud.now()));
    action("reveal", showCode);
  } else {
    action("create", () =>
      run(async () => {
        await cloud.connect(null);
        if (panelView === "cloud") {
          viewCloud();
          showCode();
        }
      }).then(() => {
        if (panelView === "cloud" && cloud.connected) showCode();
      })
    );
    $("joinForm").onsubmit = (e) => {
      e.preventDefault();
      const code = $("vaultKey").value;
      void run(() => cloud.connect(code));
    };
  }
}
function showCode() {
  const out = $("revealArea");
  if (!out) return;
  out.innerHTML =
    '<p class="hint">На другом устройстве откройте «Настройки» → «Синхронизация устройств» и введите этот код.</p><code class="pair-key"></code>' +
    btn("Скопировать код", "copy", "subtle-btn");
  out.querySelector("code").textContent = cloud.code();
  action(
    "copy",
    async () => {
      try {
        await navigator.clipboard.writeText(cloud.code());
        out.querySelector("button").textContent = "Скопировано";
      } catch {
        out.querySelector("button").textContent = "Выделите и скопируйте код выше";
      }
    },
    out
  );
}
$("focusButton").onclick = () => focusMode(true);
$("exitFocus").onclick = () => focusMode(false);
$("closePanel").onclick = closePanel;
$("libraryNav").onclick = viewLibrary;
$("outlineButton").onclick = $("bookButton").onclick = outline;
$("exportButton").onclick = viewExport;
$("settingsButton").onclick = settings;
$("home").onclick = (e) => {
  e.preventDefault();
  closePanel();
  writer.focus({ preventScroll: true });
};
$("deskNav").onclick = () => {
  closePanel();
  writer.focus({ preventScroll: true });
};
$("machineMode").onclick = () => setMode("machine");
$("editMode").onclick = () => setMode("edit");
$("soundButton").onclick = () => {
  prefs.sound = !prefs.sound;
  audioReady();
  updateSettings();
  if (prefs.sound) clickSound("key");
  writer.focus({ preventScroll: true });
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !dialog.open && $("app").classList.contains("focus")) {
    e.preventDefault();
    focusMode(false);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void flush();
    cloud?.schedule(100);
  }
});
function buildScale() {
  const n = Math.max(20, Math.floor(stage.clientWidth / 9));
  const fragment = document.createDocumentFragment();
  for (let i = 0; i <= n; i++) {
    const e = document.createElement("span");
    e.className = "tick" + (i % 10 === 0 ? " major" : i % 5 === 0 ? " mid" : "");
    if (i > 0 && i < n && i % 10 === 0) {
      const b = document.createElement("b");
      b.textContent = String(i);
      e.append(b);
    }
    fragment.append(e);
  }
  $("scale").replaceChildren(fragment);
}
new ResizeObserver(buildScale).observe(stage);
function refreshSynced(b, previousVersion, copy) {
  if (book?.id !== b.id) return;
  if (previousVersion !== b.version) {
    const old = part.id,
      pos = writer.selectionEnd;
    selectBook(copy || b, old, pos);
  } else badge();
}
(async () => {
  try {
    const rows = await S.open();
    storageReady = true;
    rows.forEach((b) => {
      books.set(b.id, b);
      persisted.set(b.id, b.rev);
      diskVersions.set(b.id, b.version);
    });
    repairJournal();
  } catch {
    storageReady = false;
  }
  if (!books.size) {
    const b = sampleBook();
    books.set(b.id, b);
    touch(b, false);
  }
  const selected = S.readPref("selected", {});
  selectBook(books.get(selected.book) || books.values().next().value, selected.part);
  cloud = KaretkaSync({
    books,
    store: S,
    uid,
    touch,
    flush,
    storageReady: () => storageReady,
    hasError: (id) => errors.has(id),
    refresh: refreshSynced,
    notify: toast,
    status: () => {
      badge();
      if (panelView === "cloud" && $("cloudInfo")) $("cloudInfo").textContent = cloud.info();
    }
  });
  ready = true;
  updateSettings();
  viewport();
  badge();
  cloud.schedule(500);
  if (matchMedia("(pointer:fine)").matches) writer.focus({ preventScroll: true });
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker
      .register("./sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        offlineReady = true;
        if ($("offlineInfo"))
          $("offlineInfo").textContent = "Офлайн-режим готов на этом устройстве.";
      })
      .catch(() => {});
  }
})();
