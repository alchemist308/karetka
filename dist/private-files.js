"use strict";
const KaretkaFiles = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const magic = enc.encode("KARETKA-FILE-1\n");
  const maximum = 64 * 1024 * 1024;
  const passwordOptions = { name: "PBKDF2", hash: "SHA-256", iterations: 600000 };
  const W = () => window.KaretkaWorkspace;
  const A = () => window.KaretkaAccount;
  async function fileKey(password, salt) {
    if (!globalThis.crypto?.subtle) throw new Error("Шифрование доступно при открытии приложения по HTTPS.");
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ ...passwordOptions, salt }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt","decrypt"]);
  }
  async function seal(text, password) {
    if (password.length < 12) throw new Error("Для файла нужен пароль длиной от 12 символов.");
    const raw = enc.encode(text);
    if (raw.length > maximum) throw new Error("Для защищённого файла разделите рукопись на тома до 64 МБ.");
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: magic }, await fileKey(password, salt), raw);
    return new Blob([magic, salt, iv, data], { type: "application/octet-stream" });
  }
  async function unseal(blob, password) {
    if (blob.size > maximum + magic.length + 44) throw new Error("Размер файла превышает 64 МБ.");
    const bytes = new Uint8Array(await blob.arrayBuffer()), start = magic.length;
    if (bytes.length < start + 44 || !magic.every((v,i) => v === bytes[i])) throw new Error("Выберите защищённый файл «Каретки» с расширением .karetka.");
    const key = await fileKey(password, bytes.slice(start, start + 16));
    try {
      const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(start + 16, start + 28), additionalData: magic }, key, bytes.slice(start + 28));
      return dec.decode(raw);
    } catch { throw new Error("Пароль не подошёл или файл повреждён. Рукописи на устройстве сохранены."); }
  }

  function button(label, fn, main = false) {
    const b = document.createElement("button"); b.type = "button"; b.className = main ? "btn main" : "btn"; b.textContent = label;
    b.onclick = () => work(b, fn); return b;
  }
  async function work(control, fn) {
    const hint = document.getElementById("privateFileStatus");
    if (hint) hint.textContent = "";
    control.disabled = true;
    try { await fn(); } catch (e) { if (hint && e.name !== "AbortError") hint.textContent = e.message || "Действие не завершено."; }
    finally { control.disabled = false; }
  }
  function render(mode = "save") {
    panel("privateFile", "Мой защищённый файл");
    const box = $("panelBody");
    box.innerHTML = '<div class="button-row"><button class="btn" id="pfSaveMode">Создать копию</button><button class="btn" id="pfOpenMode">Открыть копию</button></div>';
    $("pfSaveMode").setAttribute("aria-pressed", String(mode === "save"));
    $("pfOpenMode").setAttribute("aria-pressed", String(mode !== "save"));
    $("pfSaveMode").onclick = () => render("save"); $("pfOpenMode").onclick = () => render("open");
    const form = document.createElement("form"); form.className = "group"; box.append(form);
    const saving = mode === "save";
    form.innerHTML = (saving ? '<p class="file-hint">Текст, главы и карточки шифруются на устройстве. Файл можно положить на свой диск, в iCloud Drive или Google Диск. Для открытия понадобится выбранный здесь пароль.</p>'
      : '<label class="form-field">Защищённый файл<input type="file" id="pfInput" accept=".karetka,application/octet-stream" required></label>') +
      '<label class="form-field">Пароль файла<input type="password" id="pfPass" maxlength="256" required></label>' +
      (saving ? '<label class="form-field">Повторите пароль<input type="password" autocomplete="new-password" id="pfRepeat" required></label>' : '') +
      '<button type="submit" class="btn main" id="pfSubmit"></button>';
    $("pfPass").autocomplete = saving ? "new-password" : "current-password";
    $("pfSubmit").textContent = saving ? "Подготовить защищённый файл" : "Открыть как новую рукопись";
    if (saving) $("pfPass").minLength = 12;
    const out = document.createElement("div"); out.className = "group"; box.append(out);
    const hint = document.createElement("p"); hint.id = "privateFileStatus"; hint.className = "file-hint"; hint.setAttribute("role","status"); box.append(hint);
    form.onsubmit = (e) => {
      e.preventDefault(); void work($("pfSubmit"), async () => {
        const password = $("pfPass").value;
        if (!saving) {
          const file = $("pfInput").files[0]; if (!file) throw new Error("Выберите файл рукописи.");
          const data = KaretkaFormats.parseBackup(await unseal(file, password));
          await W().importCopy(data); closePanel(); toast("Защищённая копия открыта как новая рукопись."); return;
        }
        if (password !== $("pfRepeat").value) throw new Error("Пароли не совпали.");
        const current = W().currentBook();
        const blob = await seal(KaretkaFormats.backup(current), password);
        if (!form.isConnected) return;
        form.reset(); form.hidden = true;
        const name = "Рукопись-" + new Date().toISOString().slice(0,10) + ".karetka";
        hint.textContent = "Копия готова. Выберите, куда сохранить файл.";
        out.append(button("Сохранить файл", async () => {
          if (!window.showSaveFilePicker) { KaretkaFormats.download(blob, name.replace(/\.karetka$/, ""), "karetka"); return; }
          const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "Защищённая рукопись", accept: { "application/octet-stream": [".karetka"] } }] });
          const writer = await handle.createWritable();
          try { await writer.write(blob); await writer.close(); } catch (err) { await writer.abort().catch(() => {}); throw err; }
          hint.textContent = "Защищённый файл сохранён.";
        }, true));
        const file = new File([blob], name, { type: blob.type });
        if (navigator.canShare?.({ files:[file] })) out.append(button("Отправить в «Файлы» или на личный диск", () => navigator.share({ files:[file] })));
      });
    };
    if (saving) {
      const note = document.createElement("p"); note.className="file-hint";
      note.textContent = "Для редактирования в Google Документах можно отдельно скачать обычный DOCX. Он содержит читаемый текст.";
      box.append(note, button("Скачать DOCX для Google Документов", () => {
        const current = W().currentBook(); KaretkaFormats.download(KaretkaFormats.toDocx(current), current.title, "docx");
      }));
    }
  }
  const un64 = (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
  async function readSnapshot(secret, bookId, head, ciphertext) {
    const raw = Uint8Array.from(secret.match(/../g), q => parseInt(q,16));
    const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name:"HKDF",hash:"SHA-256",salt:enc.encode("karetka-vault-v1"),info:enc.encode("manuscripts") }, base, { name:"AES-GCM",length:256 },false,["decrypt"]);
    const data = await crypto.subtle.decrypt({ name:"AES-GCM",iv:un64(head.iv),additionalData:enc.encode("karetka/v1/" + bookId + "/" + head.version) },key,un64(ciphertext));
    const json = head.codec === "gzip" ? await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).text() : dec.decode(data);
    const restored = JSON.parse(json);
    if (restored.id !== bookId || restored.version !== head.version) throw new Error("Версия не прошла проверку целостности.");
    return KaretkaFormats.parseBackup(KaretkaFormats.backup(restored));
  }
  async function versions() {
    panel("versions","Контрольные версии");
    const box = $("panelBody"), main = document.createElement("div"); main.className="group";
    const hint=document.createElement("p"); hint.id="privateFileStatus"; hint.setAttribute("role","status"); hint.className="file-hint"; box.append(main,hint);
    try {
      const ws = W(), profile = ws.profile(), current = ws.currentBook();
      if (!profile || !current || current.demo) throw new Error("Откройте свою рукопись в личном кабинете.");
      const query = "?book=" + encodeURIComponent(current.id);
      const result = await A().call("versions/list" + query);
      if (!main.isConnected) return;
      const caption = document.createElement("p"); caption.className="file-hint";
      caption.textContent = current.title + " · " + result.versions.length + (result.limit === null ? " сохранено" : " из " + result.limit + " версий");
      main.append(caption);
      if (result.limit !== 0) main.append(button("Сохранить текущую версию",async () => {
        if (!ws.cloudEnabled()) throw new Error("Сначала включите зашифрованное облако в кабинете.");
        await ws.syncNow(); const b=ws.currentBook();
        if (b.id !== current.id) throw new Error("Рукопись изменилась. Откройте версии снова.");
        await A().call("versions/save",{bookId:b.id,version:b.version}); await versions();
      },true));
      const help=document.createElement("p"); help.className="file-hint";
      help.textContent = result.limit === 0 ? "Новые версии доступны на тарифах «Автор» и «Мастерская». Ранее сохранённые можно открыть." : "При заполнении архива новая версия заменяет самую старую. Восстановление создаёт отдельную рукопись.";
      main.append(help);
      for (const row of result.versions) main.append(button("Открыть копию от " + new Date(row.at).toLocaleString("ru-RU"),async () => {
        const partQuery = query + "&id=" + encodeURIComponent(row.id), head=await A().call("versions/get" + partQuery);
        let cipher=head.data;
        if (!cipher) {
          const pieces=[]; for(let i=0;i<head.parts;i++) pieces.push((await A().call("versions/part"+partQuery+"&n="+i)).data);
          cipher=pieces.join("");
        }
        const original=await readSnapshot(ws.vaultCode(), current.id, head, cipher);
        await ws.importCopy(original);closePanel();toast("Открыта отдельная копия контрольной версии.");
      }));
    } catch (e) { hint.textContent = e.message; }
    main.append(button("В кабинет", () => window.KaretkaOpenAccount()));
  }
  return { open: render, versions, seal, unseal, readSnapshot };
})();
if (typeof window !== "undefined") window.KaretkaFiles = KaretkaFiles;
if (typeof module !== "undefined" && module.exports) module.exports = KaretkaFiles;
