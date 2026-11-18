"use strict";
(() => {
  const box = $("assist"),
    body = $("assistBody");
  let tab = "cards",
    editCard = null,
    proofVersion = "";
  const categories = { person: "Персонаж", place: "Место", detail: "Деталь мира" };
  const ignored = new Set(
    "этот эта этих этой этого этот тогда когда если чтобы который которая которые только очень ведь даже словно будто более менее иногда меня тебя себя было были была быть есть этом пока тоже также чего него него нему теми была меня свою своих этот него надо свои была один одно another about that this with from where they have then there their were".split(
      " "
    )
  );
  function proof(text) {
    const found = [],
      last = new Map(),
      token = /[\p{L}]+(?:[-’'][\p{L}]+)*/gu;
    let m,
      index = 0;
    while ((m = token.exec(text)) !== null) {
      const word = m[0].toLocaleLowerCase("ru").replace(/ё/g, "е");
      if (word.length >= 4 && !ignored.has(word)) {
        const prev = last.get(word);
        if (prev && index - prev.index <= 18) {
          found.push({
            at: m.index,
            end: m.index + m[0].length,
            label: "Близкий повтор",
            excerpt:
              "«" +
              m[0] +
              "» · " +
              (index - prev.index) +
              " " +
              F.plural(index - prev.index, "слово", "слова", "слов") +
              " между позициями"
          });
        }
        last.set(word, { index });
      }
      index++;
    }
    const sentences =
      typeof Intl.Segmenter === "function"
        ? [...new Intl.Segmenter("ru", { granularity: "sentence" }).segment(text)].map((s) => ({
            text: s.segment,
            at: s.index
          }))
        : Array.from(text.matchAll(/[^.!?…\n]+(?:[.!?…]+|$)/gu), (s) => ({
            text: s[0],
            at: s.index
          }));
    for (const s of sentences) {
      if (F.words(s.text) > 30) {
        const cut = s.text.trim(),
          at = s.at + s.text.indexOf(cut);
        found.push({
          at,
          end: at + cut.length,
          label: "Длинное предложение",
          excerpt: wordLabel(F.words(cut)) + " · " + cut.slice(0, 72) + (cut.length > 72 ? "…" : "")
        });
      }
    }
    return found.sort((a, b) => a.at - b.at);
  }
  function tabs() {
    body.innerHTML =
      '<div class="assist-tabs" role="group" aria-label="Инструменты">' +
      [
        ["cards", "Картотека"],
        ["plan", "План сцены"],
        ["proof", "Вычитка"]
      ]
        .map(
          ([k, t]) =>
            '<button class="pill ' +
            (k === tab ? "selected" : "") +
            '" aria-pressed="' +
            (k === tab) +
            '" data-tab="' +
            k +
            '">' +
            t +
            "</button>"
        )
        .join("") +
      '</div><div id="assistantContent"></div>';
    body.querySelectorAll("[data-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.tab;
          editCard = null;
          render();
        })
    );
    return $("assistantContent");
  }
  function cards(out) {
    const cards = book.cards || [];
    if (editCard !== null) {
      const card = cards.find((c) => c.id === editCard) || {
        title: "",
        notes: "",
        category: "person"
      };
      out.innerHTML =
        '<form id="cardForm" class="group"><label>Тип карточки<select id="cardType">' +
        Object.entries(categories)
          .map(
            ([k, t]) =>
              '<option value="' +
              k +
              '" ' +
              (k === card.category ? "selected" : "") +
              ">" +
              t +
              "</option>"
          )
          .join("") +
        '</select></label><label>Название<input id="cardName" type="text" required maxlength="180" value="' +
        esc(card.title) +
        '" placeholder="Имя или название"></label><label>Заметки<textarea id="cardNotes" rows="5" placeholder="Что важно помнить?">' +
        esc(card.notes) +
        '</textarea></label><div class="button-row"><button class="btn main" type="submit">Сохранить</button>' +
        btn("Отмена", "cancel") +
        "</div></form>";
      action(
        "cancel",
        () => {
          editCard = null;
          render();
        },
        out
      );
      $("cardForm").onsubmit = (e) => {
        e.preventDefault();
        const title = $("cardName").value.trim();
        if (!title) return;
        const v = {
          id: card.id || uid(),
          title,
          category: $("cardType").value,
          notes: $("cardNotes").value
        };
        book.cards ??= [];
        const idx = book.cards.findIndex((c) => c.id === v.id);
        if (idx < 0) book.cards.push(v);
        else book.cards[idx] = v;
        touch();
        editCard = null;
        render();
      };
      return;
    }
    out.innerHTML =
      '<div class="group">' +
      btn(icon("plus") + "Карточка", "new", "btn main") +
      "</div>" +
      (cards.length
        ? '<div class="group">' +
          cards
            .map(
              (c) =>
                '<button class="option" data-card="' +
                esc(c.id) +
                '"><span class="row-text"><small>' +
                esc(categories[c.category] || "Деталь") +
                "</small><strong>" +
                esc(c.title) +
                "</strong>" +
                (c.notes ? "<small>" + esc(c.notes.slice(0, 135)) + "</small>" : "") +
                "</span></button>"
            )
            .join("") +
          "</div>"
        : '<p class="hint">Сохраните имя персонажа, приметы места или детали мира. Карточки доступны из любой главы этой рукописи.</p>');
    action(
      "new",
      () => {
        editCard = "new";
        render();
        $("cardName").focus();
      },
      out
    );
    out.querySelectorAll("[data-card]").forEach(
      (el) =>
        (el.onclick = () => {
          editCard = el.dataset.card;
          render();
        })
    );
  }
  function plan(out) {
    const fields = [
      ["goal", "Чего хочет герой?"],
      ["obstacle", "Что ему мешает?"],
      ["turn", "Что изменится к концу?"]
    ];
    out.innerHTML =
      '<p class="hint">План для раздела «' +
      esc(book.kind === "single" ? book.title : part.title) +
      '».</p><div class="group">' +
      fields
        .map(
          ([k, t]) =>
            "<label>" +
            t +
            '<textarea rows="2" data-plan="' +
            k +
            '">' +
            esc(part.plan?.[k] || "") +
            "</textarea></label>"
        )
        .join("") +
      "</div>";
    out.querySelectorAll("[data-plan]").forEach(
      (field) =>
        (field.oninput = () => {
          part.plan ??= {};
          part.plan[field.dataset.plan] = field.value;
          touch();
        })
    );
  }
  function proofread(out) {
    const source = part.text,
      entries = proof(source);
    proofVersion = source;
    out.innerHTML =
      '<p class="hint">Повторы в пределах 18 слов и предложения длиннее 30 слов. Нажмите на находку, чтобы выделить её в тексте.</p><div class="group">' +
      btn("Проверить снова", "check", "btn") +
      (entries.length
        ? entries
            .slice(0, 80)
            .map(
              (r, i) =>
                '<button class="option" data-find="' +
                i +
                '"><span class="row-text"><strong>' +
                r.label +
                "</strong><small>" +
                esc(r.excerpt) +
                "</small></span></button>"
            )
            .join("")
        : '<p class="notice">' +
          (source.trim()
            ? "Близких повторов и длинных предложений не найдено."
            : "Начните писать, чтобы проверить текст.") +
          "</p>") +
      (entries.length > 80 ? '<small class="hint">Показаны первые 80 находок.</small>' : "") +
      "</div>";
    action("check", render, out);
    out.querySelectorAll("[data-find]").forEach(
      (el) =>
        (el.onclick = () => {
          if (part.text !== proofVersion) {
            render();
            toast("Список обновлён с учётом новых правок.");
            return;
          }
          const r = entries[Number(el.dataset.find)];
          if (innerWidth <= 900) toggle(false);
          setMode("edit");
          writer.setSelectionRange(r.at, r.end);
          writer.focus({ preventScroll: true });
          // Locate the selected sentence in the same font and width as the editing surface.
          mirror.style.width =
            Math.max(
              1,
              writer.clientWidth - parseFloat(getComputedStyle(writer).paddingRight || 0)
            ) + "px";
          mirror.textContent = writer.value.slice(0, r.at) + "\u200b";
          writer.scrollTop = Math.max(0, mirror.offsetHeight - writer.clientHeight / 3);
          mirror.style.width = "";
        })
    );
  }
  function render() {
    if (box.hidden || !part) return;
    const out = tabs();
    if (tab === "cards") cards(out);
    else if (tab === "plan") plan(out);
    else proofread(out);
  }
  function toggle(on) {
    box.hidden = !on;
    $("assistantButton").setAttribute("aria-expanded", String(on));
    if (on) render();
    scheduleLayout();
  }
  $("assistantButton").onclick = () => toggle(box.hidden);
  $("closeAssist").onclick = () => toggle(false);
  window.addEventListener("karetka-part", () => {
    editCard = null;
    render();
  });
})();
