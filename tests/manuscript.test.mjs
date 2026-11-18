import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import formats from "../dist/formats.js";
const story = {
  title: "Север & море",
  kind: "chapters",
  cards: [{ id: "a", category: "person", title: "Смотритель", notes: "Любит море." }],
  sections: [
    {
      id: "b",
      title: "Глава 1",
      text: "Встреча",
      plan: { goal: "Найти ключ" },
      scenes: [{ id: "c", title: "Причал", text: "— Привет.\n\nВетер стих." }]
    }
  ]
};
test("chapters, nested scenes, notes and blank lines survive backup and export", async () => {
  const copy = formats.parseBackup(formats.backup(story));
  assert.equal(copy.cards[0].title, "Смотритель");
  assert.equal(copy.sections[0].plan.goal, "Найти ключ");
  assert.equal(copy.sections[0].scenes[0].text, story.sections[0].scenes[0].text);
  assert.equal(
    formats.manuscript(story),
    "Север & море\n\nГлава 1\n\nВстреча\n\nПричал\n\n— Привет.\n\nВетер стих.\n"
  );
  const bytes = Buffer.from(await formats.toDocx(story).arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.match(bytes.toString(), /Север &amp; море/);
  assert.match(bytes.toString(), /Heading2/);
});
test("counts Russian and hyphenated words", () => {
  assert.equal(formats.words("«Кто-нибудь», — спросил он. 2026"), 4);
  assert.equal(formats.plural(22, "слово", "слова", "слов"), "слова");
});
test("every offline shell file is shipped", async () => {
  const sw = await readFile(new URL("../dist/sw.js", import.meta.url), "utf8");
  const list = sw.match(/const\s+SHELL\s*=\s*(\[[^;]+\]);/)[1];
  const files = Array.from(list.matchAll(/"([^"]+)"/g), (m) => m[1]);
  for (const path of files) {
    if (path !== "./")
      assert.ok((await readFile(new URL("../dist/" + path, import.meta.url))).length);
  }
});
