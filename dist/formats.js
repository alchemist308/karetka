"use strict";

const KaretkaFormats = (() => {
  const encoder = new TextEncoder();
  const russian = new Intl.PluralRules("ru");
  const wordsPattern = /[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu;
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function words(value) {
    return (value.match(wordsPattern) || []).length;
  }
  function plural(n, one, few, many) {
    return { one, few, many }[russian.select(n)] || many;
  }
  function ordered(book) {
    return book.sections.flatMap((s) => [
      { id: s.id, title: s.title, text: s.text, depth: 1, unit: s, parent: null },
      ...s.scenes.map((scene) => ({
        id: scene.id,
        title: scene.title,
        text: scene.text,
        depth: 2,
        unit: scene,
        parent: s
      }))
    ]);
  }
  function manuscript(book) {
    const sections = ordered(book);
    return (
      [
        book.title,
        ...sections.flatMap((s) => [
          ...(book.kind === "single" ? [] : [s.title]),
          ...(s.text ? [s.text] : [])
        ])
      ]
        .join("\n\n")
        .trimEnd() + "\n"
    );
  }
  function backup(book) {
    const section = (s) => ({ title: s.title, text: s.text, plan: s.plan || {} });
    return JSON.stringify(
      {
        format: "karetka-manuscript",
        version: 1,
        title: book.title,
        kind: book.kind,
        cards: book.cards || [],
        sections: book.sections.map((s) => ({ ...section(s), scenes: s.scenes.map(section) }))
      },
      null,
      2
    );
  }
  function parseBackup(raw) {
    const b = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const validText = (s) =>
      s &&
      typeof s.title === "string" &&
      s.title.trim().length > 0 &&
      s.title.length <= 220 &&
      typeof s.text === "string";
    if (
      !b ||
      b.format !== "karetka-manuscript" ||
      b.version !== 1 ||
      typeof b.title !== "string" ||
      !b.title.trim() ||
      b.title.length > 220 ||
      !["single", "chapters", "scenes"].includes(b.kind) ||
      !Array.isArray(b.sections) ||
      !b.sections.length ||
      (b.kind === "single" && b.sections.length !== 1) ||
      !b.sections.every(
        (s) =>
          validText(s) &&
          Array.isArray(s.scenes) &&
          (b.kind === "chapters" || s.scenes.length === 0) &&
          s.scenes.every(validText)
      )
    ) {
      throw new Error("Этот файл не содержит рукопись «Каретки» первой версии.");
    }
    if (
      b.cards !== undefined &&
      (!Array.isArray(b.cards) ||
        !b.cards.every(
          (c) =>
            c &&
            ["person", "place", "detail"].includes(c.category) &&
            typeof c.title === "string" &&
            typeof c.notes === "string"
        ))
    )
      throw new Error("В файле повреждена картотека.");
    for (const u of b.sections.flatMap((s) => [s, ...s.scenes])) {
      if (
        u.plan !== undefined &&
        (u.plan === null ||
          typeof u.plan !== "object" ||
          Array.isArray(u.plan) ||
          ["goal", "obstacle", "turn"].some(
            (k) => u.plan[k] !== undefined && typeof u.plan[k] !== "string"
          ))
      )
        throw new Error("В файле повреждён план сцены.");
    }
    return b;
  }
  function zip(entries) {
    const local = [],
      directory = [];
    let offset = 0,
      centralSize = 0;
    const header = (size) => {
      const bytes = new Uint8Array(size);
      const view = new DataView(bytes.buffer);
      return {
        bytes,
        u16: (i, v) => view.setUint16(i, v, true),
        u32: (i, v) => view.setUint32(i, v, true)
      };
    };
    const now = new Date();
    const date =
      ((Math.max(1980, now.getFullYear()) - 1980) << 9) |
      ((now.getMonth() + 1) << 5) |
      now.getDate();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    for (const [filename, xml] of entries) {
      const name = encoder.encode(filename),
        data = encoder.encode(xml);
      let crc = -1;
      for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      crc = (crc ^ -1) >>> 0;
      const lh = header(30);
      lh.u32(0, 0x04034b50);
      lh.u16(4, 20);
      lh.u16(6, 0x0800);
      lh.u16(10, time);
      lh.u16(12, date);
      lh.u32(14, crc);
      lh.u32(18, data.length);
      lh.u32(22, data.length);
      lh.u16(26, name.length);
      local.push(lh.bytes, name, data);
      const ch = header(46);
      ch.u32(0, 0x02014b50);
      ch.u16(4, 20);
      ch.u16(6, 20);
      ch.u16(8, 0x0800);
      ch.u16(12, time);
      ch.u16(14, date);
      ch.u32(16, crc);
      ch.u32(20, data.length);
      ch.u32(24, data.length);
      ch.u16(28, name.length);
      ch.u32(42, offset);
      directory.push(ch.bytes, name);
      centralSize += 46 + name.length;
      offset += 30 + name.length + data.length;
    }
    const end = header(22);
    end.u32(0, 0x06054b50);
    end.u16(8, entries.length);
    end.u16(10, entries.length);
    end.u32(12, centralSize);
    end.u32(16, offset);
    return new Blob([...local, ...directory, end.bytes], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
  }
  function toDocx(book) {
    const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const rel = "http://schemas.openxmlformats.org/package/2006/relationships";
    const od = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const xmlStart = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const escape = (value) =>
      value
        .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const para = (value, style = "") => {
      const runs = value
        .split("\t")
        .map((part) => '<w:t xml:space="preserve">' + escape(part) + "</w:t>")
        .join("<w:tab/>");
      return (
        "<w:p>" +
        (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : "") +
        "<w:r>" +
        runs +
        "</w:r></w:p>"
      );
    };
    let body = para(book.title, "Title");
    for (const s of ordered(book)) {
      if (book.kind !== "single") body += para(s.title, s.depth === 1 ? "Heading1" : "Heading2");
      if (s.text.length)
        body += s.text
          .replace(/\r\n?/g, "\n")
          .split("\n")
          .map((line) => para(line))
          .join("");
    }
    const style = (id, name, level, size) =>
      '<w:style w:type="paragraph" w:styleId="' +
      id +
      '"><w:name w:val="' +
      name +
      '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="160"/>' +
      (level === null ? "" : '<w:outlineLvl w:val="' + level + '"/>') +
      '</w:pPr><w:rPr><w:b/><w:sz w:val="' +
      size +
      '"/></w:rPr></w:style>';
    const styles =
      xmlStart +
      '<w:styles xmlns:w="' +
      w +
      '"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="100" w:line="300" w:lineRule="auto"/></w:pPr></w:style>' +
      style("Title", "Title", null, 44) +
      style("Heading1", "heading 1", 0, 34) +
      style("Heading2", "heading 2", 1, 28) +
      "</w:styles>";
    return zip([
      [
        "[Content_Types].xml",
        xmlStart +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'
      ],
      [
        "_rels/.rels",
        xmlStart +
          '<Relationships xmlns="' +
          rel +
          '"><Relationship Id="rId1" Type="' +
          od +
          '/officeDocument" Target="word/document.xml"/></Relationships>'
      ],
      [
        "word/document.xml",
        xmlStart +
          '<w:document xmlns:w="' +
          w +
          '"><w:body>' +
          body +
          '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1417"/></w:sectPr></w:body></w:document>'
      ],
      ["word/styles.xml", styles],
      [
        "word/_rels/document.xml.rels",
        xmlStart +
          '<Relationships xmlns="' +
          rel +
          '"><Relationship Id="rId1" Type="' +
          od +
          '/styles" Target="styles.xml"/></Relationships>'
      ]
    ]);
  }
  function download(blob, title, extension) {
    const a = document.createElement("a");
    a.download =
      (title
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .trim()
        .replace(/[. ]+$/, "")
        .slice(0, 140) || "Рукопись") +
      "." +
      extension;
    const url = URL.createObjectURL(blob);
    a.href = url;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return { words, plural, ordered, manuscript, backup, parseBackup, toDocx, download };
})();
if (typeof module !== "undefined" && module.exports) module.exports = KaretkaFormats;
