"use strict";

(() => {
  const api = window.KaretkaAccount;
  const space = () => window.KaretkaWorkspace;
  const rubles = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 });
  const dates = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  const periodDays = { month: 30, year: 365 };
  const orderStates = {
    created: "Создан", creating: "Создаём платёж", pending: "Ожидает оплаты", waiting_for_capture: "Обрабатывается",
    succeeded: "Оплачен", paid: "Оплачен", canceled: "Отменён", refunded: "Возвращён", expired: "Истёк",
    partially_refunded: "Частичный возврат", failed: "Не проведён"
  };
  const paymentId = new URL(location.href).searchParams.get("payment");
  const returning = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(paymentId || "");
  let session, pendingAccess, paymentHandled = false, attempt;
  let period = "month";

  function element(tag, css, text) {
    const node = document.createElement(tag);
    if (css) node.className = css;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function active(view) { return view.isConnected && $("panel").open; }
  function page(title, description, wide = false) {
    panel("account", title, description, wide ? "account-panel account-wide" : "account-panel");
    const view = element("div", "account-view");
    const error = element("p", "account-error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    view.append(error);
    $("panelBody").append(view);
    $("panelTitle").tabIndex = -1;
    $("panelTitle").focus({ preventScroll: true });
    $("panel").scrollTop = 0;
    return view;
  }
  function warn(view, text) {
    if (!active(view)) return;
    const note = view.querySelector(".account-error");
    note.textContent = text || "";
    note.hidden = !text;
    if (text) note.scrollIntoView({ block: "nearest" });
  }
  function note(view, text) {
    const n = element("p", "account-note", text);
    n.setAttribute("role", "status");
    view.append(n);
    return n;
  }
  function textButton(text, handler, css = "btn") {
    const b = element("button", css, text);
    b.type = "button";
    b.addEventListener("click", handler);
    return b;
  }
  function links(...buttons) {
    const row = element("div", "account-links");
    row.append(...buttons);
    return row;
  }
  function back(view, label = "К кабинету", handler = openAccount) {
    view.append(textButton(label, handler, "back-btn"));
  }
  function field(form, labelText, name, type, settings = {}, hint) {
    const wrap = element("div", "form-field");
    const label = element("label", "", labelText);
    const input = document.createElement("input");
    input.id = "cab-" + name;
    input.type = type;
    input.name = name;
    input.required = true;
    Object.assign(input, settings);
    label.htmlFor = input.id;
    wrap.append(label, input);
    if (hint) {
      const small = element("small", "", hint);
      small.id = input.id + "-hint";
      input.setAttribute("aria-describedby", small.id);
      wrap.append(small);
    }
    form.append(wrap);
    return input;
  }
  function confirmChoice(form, text) {
    const label = element("label", "account-confirm");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.required = true;
    label.append(input, element("span", "", text));
    form.append(label);
    return input;
  }
  async function run(view, button, work) {
    if (button.disabled) return;
    warn(view, "");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try { await work(); }
    catch (e) { warn(view, e?.message || "Не удалось выполнить действие. Попробуйте ещё раз."); }
    finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
  function submit(form, view, title, work) {
    const b = element("button", "btn main", title);
    b.type = "submit";
    form.append(b);
    form.addEventListener("submit", e => {
      e.preventDefault();
      void run(view, b, work);
    });
    return b;
  }
  function groupButtons(label, values, current, onChange) {
    const group = element("div", "account-tabs");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    for (const [value, title] of values) {
      const b = textButton(title, () => onChange(value), "");
      b.setAttribute("aria-pressed", String(current === value));
      group.append(b);
    }
    return group;
  }
  function row(title, sub, extra) {
    const line = element("div", "account-line");
    const info = element("div");
    info.append(element("strong", "", title));
    if (sub) info.append(element("small", "", sub));
    line.append(info);
    if (extra) line.append(extra);
    return line;
  }
  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : dates.format(date);
  }
  function planName(id) {
    return session?.plans?.find(p => p.id === id)?.title || ({ free: "Черновик", author: "Автор", studio: "Мастерская" }[id]) || id;
  }
  function countBooks(n) {
    return n + " " + F.plural(n, "рукопись", "рукописи", "рукописей");
  }
  function checkReturn() {
    return returning && !paymentHandled;
  }
  function dismissReturn() {
    paymentHandled = true;
    const u = new URL(location.href);
    u.searchParams.delete("payment");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  }
  async function openAccount() {
    const loading = page("Личный кабинет", "");
    note(loading, "Открываем кабинет…");
    try {
      session = await api.session();
      if (!active(loading)) return;
      const user = session.user;
      if (pendingAccess && (pendingAccess.user.id !== user?.id || pendingAccess.sessionTag !== session.sessionTag))
        pendingAccess = null;
      if (pendingAccess?.recovery) return showBackup();
      if (!user) return authForm("login");
      if (space()?.profile()?.id !== user.id) return authForm("unlock", user.login);
      if (checkReturn()) return purchaseHistory(true);
      dashboard();
    } catch (e) {
      if (!active(loading)) return;
      const profile = space()?.profile();
      const view = page("Личный кабинет", profile?.login || "");
      note(view, !navigator.onLine ? "Сейчас вы офлайн. Можно продолжать писать на этом устройстве." :
        e.message || "Сейчас нет связи с кабинетом.");
      const again = textButton("Повторить", openAccount);
      view.append(links(again, textButton("Вернуться к рукописи", closePanel)),
        textButton("Мой защищённый файл", () => window.KaretkaFiles.open()));
      if (profile) {
        const signOut = textButton("Выйти на этом устройстве", () => void run(view, signOut, () => space().leave()));
        view.append(signOut);
      }
    }
  }
  function authForm(kind, defaultLogin = "") {
    const registering = kind === "register", owner = kind === "owner", recovery = kind === "recover";
    const unlocking = kind === "unlock", signing = kind === "login" || unlocking;
    const titles = { login: "Личный кабинет", register: "Регистрация", recover: "Восстановление доступа",
      owner: "Активация владельца", unlock: "Открыть личную библиотеку" };
    const descriptions = {
      login: "Войдите, чтобы продолжить рукопись на другом устройстве.",
      register: "Создайте аккаунт и подключите личную облачную библиотеку.",
      recover: "Введите резервный код и выберите новый пароль.",
      owner: "Код активации выдаётся при настройке хостинга.",
      unlock: "Подтвердите пароль, чтобы открыть книги этого аккаунта на устройстве."
    };
    const view = page(titles[kind], descriptions[kind]);
    if (checkReturn()) note(view, "После входа здесь появится результат оплаты.");
    if (kind === "login" || registering)
      view.append(groupButtons("Действие с аккаунтом", [["login", "Вход"], ["register", "Регистрация"]], kind, authForm));
    else if (!unlocking) back(view, "Ко входу", () => authForm("login"));
    const form = element("form", "account-form");
    view.append(form);
    const login = field(form, "Логин", "login", "text", {
      autocapitalize: "none", autocomplete: "username", spellcheck: false,
      readOnly: owner || unlocking, minLength: 3, maxLength: 32,
      value: owner ? session.ownerLogin : defaultLogin
    }, registering ? "От 3 до 32 знаков. Используйте латинские буквы и цифры." : "");
    let code;
    if (owner || recovery) code = field(form, owner ? "Одноразовый код владельца" : "Резервный код",
      "secret", "password", { autocomplete: "off", autocapitalize: "none", spellcheck: false });
    const pwd = field(form, signing ? "Пароль" : "Новый пароль", "password", "password", {
      autocomplete: signing ? "current-password" : "new-password", minLength: signing ? 1 : 12
    }, signing ? "" : "Минимум 12 символов.");
    submit(form, view, signing ? "Войти" : owner ? "Активировать кабинет" : recovery ? "Восстановить доступ" : "Создать аккаунт",
      async () => {
        const name = login.value.trim();
        let result;
        if (signing) result = await api.login(name, pwd.value);
        else if (recovery) result = await api.recover(name, code.value.trim(), pwd.value);
        else result = await api.register(name, pwd.value, owner ? code.value.trim() : undefined);
        pwd.value = "";
        if (code) code.value = "";
        if (result.recovery) {
          pendingAccess = result;
          if (active(view)) showBackup();
          return;
        }
        if (active(view)) await enterWorkspace(result);
      });
    const tools = [];
    if (signing) tools.push(textButton("Забыли пароль?", () => authForm("recover", login.value.trim()), ""));
    if (kind === "login" || registering)
      tools.push(textButton("Посмотреть тарифы", () => showPlans(), ""),
        textButton("Мой защищённый файл", () => window.KaretkaFiles.open(), ""), storageGuideLink());
    if (unlocking) {
      const exit = textButton("Выйти", () => void run(view, exit, () => space().leave()), "");
      tools.push(exit);
    }
    if (tools.length) view.append(links(...tools));
    if (kind === "login" && session.ownerLogin) {
      const details = element("details", "account-owner-entry");
      details.append(element("summary", "", "Для владельца сайта"), links(textButton("Первый вход владельца", () => authForm("owner"), "")));
      view.append(details);
    }
  }
  async function enterWorkspace(result) {
    const verified = await api.session();
    if (verified.user?.id !== result.user.id || verified.sessionTag !== result.sessionTag)
      throw new Error("В другой вкладке изменился вход в аккаунт. Откройте кабинет и войдите снова.");
    await space().switchTo({ id: result.user.id, login: result.user.login, sessionTag: result.sessionTag }, result.vaultKey);
  }
  function showBackup() {
    const access = pendingAccess;
    if (!access) return void openAccount();
    const view = page("Сохраните резервный код", "Он понадобится, если вы забудете пароль. Храните код отдельно от устройства.");
    const code = element("code", "account-code", access.recovery);
    code.tabIndex = 0;
    code.setAttribute("aria-label", "Ваш резервный код");
    view.append(code);
    const copy = textButton("Скопировать код", () => void run(view, copy, async () => {
      if (!navigator.clipboard?.writeText) throw new Error("Выделите код и скопируйте его вручную.");
      await navigator.clipboard.writeText(access.recovery);
      copy.textContent = "Скопировано";
    }));
    view.append(copy);
    const form = element("form", "account-form");
    view.append(form);
    confirmChoice(form, "Я сохранил резервный код");
    submit(form, view, "Открыть библиотеку", async () => {
      await enterWorkspace(access);
      pendingAccess = null;
    });
  }
  function dashboard() {
    const user = session.user;
    const view = page("Личный кабинет", user.login);
    const card = element("section", "account-profile");
    card.append(element("strong", "", user.role === "owner" ? "Владелец сервиса" : "Тариф «" + planName(user.plan) + "»"));
    if (user.role === "owner") card.append(element("p", "account-text", "Все функции и облачная библиотека без лимита рукописей."));
    else {
      const n = Number(user.used) || 0;
      card.append(element("p", "account-text", "Мест в облачной библиотеке занято " + n + " из " + user.bookLimit + "."));
      const meter = element("progress");
      meter.max = Math.max(1, user.bookLimit);
      meter.value = Math.min(n, meter.max);
      meter.setAttribute("aria-label", "Заполнение личной библиотеки");
      card.append(meter);
      if (user.until) card.append(element("small", "", "Доступ по тарифу до " + formatDate(user.until) + "."));
      if (user.trialUntil > Date.now() && user.plan === "author") card.append(element("small", "", "Пробный период до " + formatDate(user.trialUntil) + "."));
    }
    view.append(card);
    if (user.trialAvailable) offerTrial(view);
    storageOptions(view);
    const main = element("div", "account-list account-actions");
    main.append(textButton("Мои рукописи", () => viewLibrary(), "btn main"),
      textButton("Перенести рукопись с этого устройства", importBooks),
      textButton("Контрольные версии открытой рукописи", () => window.KaretkaFiles.versions()),
      textButton("Тарифы", () => showPlans()), textButton("История платежей", () => purchaseHistory()));
    if (user.role === "owner") main.append(textButton("Управление сервисом", admin));
    view.append(main);
    const exit = textButton("Выйти из аккаунта", () => void run(view, exit, () => space().leave()), "");
    view.append(links(exit));
  }
  function offerTrial(view) {
    const b = textButton("Попробовать «Автор» на 14 дней", () => void run(view, b, async () => {
      const result = await api.call("account/trial", {});
      if (!active(view)) return;
      session.user = result.user;
      dashboard();
    }));
    const box = element("section", "account-profile");
    box.append(element("p", "account-text", "Пробный период включает облачную библиотеку тарифа «Автор» и контрольные версии. Карта не требуется."), b);
    view.append(box);
  }
  function storageGuideLink() {
    return textButton("Как хранить черновики", () => draftGuide(openAccount, "В кабинет"), "");
  }
  function storageOptions(view) {
    const ws = space();
    const box = element("section", "account-profile");
    const cloudOn = ws.cloudEnabled();
    box.append(element("h3", "", "Где хранить рукописи"),
      element("p", "account-text", cloudOn
        ? "Локальные изменения синхронизируются с зашифрованной личной библиотекой при появлении интернета."
        : "Сейчас рукописи остаются в браузере этого устройства. Для доступа с других устройств можно включить облако."));
    const toggle = textButton(cloudOn ? "Приостановить синхронизацию" : "Включить зашифрованное облако", () => void run(view, toggle, async () => {
      await ws.setCloudEnabled(!cloudOn);
      if (active(view)) await openAccount();
    }));
    box.append(toggle, links(textButton("Мой защищённый файл", () => window.KaretkaFiles.open(), ""), storageGuideLink()));
    view.append(box);
  }
  async function importBooks() {
    const view = page("Перенос рукописей", "Выберите гостевую рукопись. Её копия появится в личной библиотеке, а оригинал останется на устройстве.");
    back(view);
    const list = element("div", "account-list");
    view.append(list);
    try {
      const books = await space().guestBooks();
      if (!active(view)) return;
      if (!books.length) note(view, "На этом устройстве пока нет гостевых рукописей для переноса.");
      for (const book of books) {
        const b = textButton("Скопировать", () => void run(view, b, async () => {
          await space().importGuest(book.id);
          b.replaceWith(element("small", "", "Скопировано"));
        }));
        b.setAttribute("aria-label", "Скопировать «" + book.title + "»");
        list.append(row(book.title, "", b));
      }
    } catch (e) { warn(view, e.message); }
  }
  function showPlans() {
    const view = page("Тарифы", "На всех тарифах доступны офлайн-редактор без лимита локальных рукописей, шрифты, помощники, защищённые файлы и экспорт в DOCX и TXT.", true);
    back(view, session.user ? "К кабинету" : "Ко входу");
    view.append(groupButtons("Срок доступа", [["month", "30 дней"], ["year", "365 дней"]], period, next => {
      period = next;
      showPlans();
    }));
    const plans = element("div", "account-plans");
    view.append(plans);
    for (const p of session.plans) {
      const isCurrent = p.id === (session.user?.plan || "free");
      const card = element("section", "account-plan" + (isCurrent ? " current" : ""));
      const price = Number(p[period]);
      const versions = p.versions ?? ({ free: 0, author: 5, studio: 25 })[p.id];
      const facts = element("div", "plan-facts");
      facts.append(element("small", "", p.id === "free" ? "Без ограничения срока" : "За " + periodDays[period] + " дней"),
        element("p", "", countBooks(p.limit) + " в облаке"),
        element("p", "", versions ? versions + " " + F.plural(versions, "контрольная версия", "контрольные версии", "контрольных версий") + " каждой рукописи" : "Текущая редакция в облаке"));
      card.append(element("h3", "", p.title), element("span", "plan-price", rubles.format(Number.isFinite(price) ? price : 0)), facts);
      if (p.id !== "free" && session.user?.role !== "owner") {
        if (session.billing?.enabled) {
          card.append(textButton(!session.user ? "Войти для оплаты" : isCurrent ? "Продлить" : "Выбрать",
            () => session.user ? checkout(p) : authForm("login")));
        }
      }
      plans.append(card);
    }
    if (!session.billing?.enabled) note(view, "Продажи подписок пока закрыты. Бесплатная библиотека доступна после регистрации.");
    else if (session.billing.mode === "test") note(view, "Работает тестовый магазин. Тестовые платежи проходят без списания денег и выдачи платного доступа.");
    if (session.user?.trialAvailable) offerTrial(view);
    view.append(element("p", "account-text", "Подписка продлевается вручную. После окончания срока сохраняется доступ к чтению и экспорту рукописей."));
  }
  function externalLink(label, raw) {
    try {
      const target = new URL(raw);
      if (target.protocol !== "https:" || target.username || target.password) return null;
      const link = element("a", "", label);
      link.href = target.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    } catch { return null; }
  }
  function paymentTarget(raw, id) {
    try {
      const target = new URL(raw, location.origin);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id || "") || target.username || target.password) return null;
      if (target.origin === location.origin && target.pathname === "/" && target.searchParams.get("payment") === id &&
          [...target.searchParams.keys()].length === 1 && (!target.hash || target.hash === "#account"))
        return target;
      if (target.protocol === "https:" && !target.port && /(^|\.)(yoomoney\.ru|yookassa\.ru)$/.test(target.hostname)) return target;
    } catch {}
    return null;
  }
  function checkout(plan) {
    const amount = plan[period], days = periodDays[period], test = session.billing.mode === "test";
    const view = page("Подписка «" + plan.title + "»", rubles.format(amount) + " за " + days + " дней. Продление вручную.");
    back(view, "К тарифам", showPlans);
    if (test) note(view, "Тестовая оплата. Используйте тестовые данные ЮKassa. Баланс и срок доступа останутся прежними.");
    const form = element("form", "account-form");
    view.append(form);
    const email = field(form, "Электронная почта для чека", "email", "email",
      { autocomplete: "email", autocapitalize: "none", spellcheck: false, maxLength: 254 });
    const methods = element("fieldset", "account-methods");
    methods.append(element("legend", "", "Способ оплаты"));
    for (const [value, title] of [["auto", "Выбрать в ЮKassa"], ["yoo_money", "Кошелёк ЮMoney"]]) {
      const entry = element("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "paymentMethod";
      radio.value = value;
      radio.checked = value === "auto";
      entry.append(radio, document.createTextNode(title));
      methods.append(entry);
    }
    form.append(methods);
    const seller = session.seller || {};
    const terms = externalLink("Оферта", seller.offer);
    const privacy = externalLink("Конфиденциальность", seller.privacy);
    if (seller.name) form.append(element("p", "account-text", "Продавец — " + seller.name));
    const company = [terms, privacy].filter(Boolean);
    if (typeof seller.email === "string" && /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(seller.email)) {
      const mail = element("a", "", seller.email);
      mail.href = "mailto:" + seller.email;
      company.push(mail);
    }
    if (company.length) form.append(links(...company));
    const consent = confirmChoice(form, "Я принимаю условия оферты и ознакомился с политикой конфиденциальности.");
    submit(form, view, test ? "Перейти к тестовой оплате" : "Перейти к оплате", async () => {
      const address = email.value.trim();
      const method = form.elements.paymentMethod.value;
      const key = [session.user.id, plan.id, period, method, address.toLowerCase()].join("|");
      if (!attempt || attempt.key !== key) attempt = { key, id: crypto.randomUUID() };
      const order = await api.call("pay/checkout", { plan: plan.id, period, method, email: address, accepted: consent.checked, requestId: attempt.id });
      const target = paymentTarget(order.url, order.orderId);
      if (!target)
        throw new Error("Сервис не получил адрес платёжной страницы ЮKassa. Проверьте заказ в истории.");
      if (active(view)) location.assign(target.href);
    });
  }
  function orderRow(order, adminView = false) {
    const name = (order.test ? "Тест · " : "") + planName(order.plan) + " · " + rubles.format(Number(order.amount));
    const detail = [
      formatDate(order.createdAt), periodDays[order.period] && (periodDays[order.period] + " дней"),
      orderStates[order.status] || "Статус уточняется", order.until && ("до " + formatDate(order.until))
    ].filter(Boolean);
    const line = row(name, detail.join(" · "));
    if (adminView && (order.receiptEmail || order.providerId)) {
      const info = line.firstChild;
      if (order.receiptEmail) info.append(element("small", "", "Чек — " + order.receiptEmail));
      if (order.providerId) info.append(element("small", "", "Платёж ЮKassa " + order.providerId));
    }
    return line;
  }
  async function purchaseHistory(fromPayment = false) {
    const view = page("История платежей", session.user.login);
    back(view);
    const hint = note(view, fromPayment ? "Проверяем платёж в ЮKassa…" : "Загружаем заказы…");
    try {
      if (fromPayment) {
        await api.call("pay/order", { orderId: paymentId });
        if (!active(view)) return;
        dismissReturn();
      }
      const result = await api.call("pay/orders");
      if (!active(view)) return;
      hint.remove();
      if (!result.orders?.length) { note(view, "В этом аккаунте пока нет заказов."); return; }
      const list = element("div", "account-list");
      view.append(list);
      for (const order of result.orders) {
        const line = orderRow(order);
        if (["created", "creating", "pending", "waiting_for_capture"].includes(order.status)) {
          const url = order.url && paymentTarget(order.url, order.id);
          if (url) line.append(textButton("К оплате", () => location.assign(url.href)));
          const check = textButton("Проверить", () => void run(view, check, async () => {
            await api.call("pay/order", { orderId: order.id });
            if (active(view)) await purchaseHistory();
          }));
          line.append(check);
        }
        list.append(line);
      }
    } catch (e) {
      hint.remove();
      if (!active(view)) return;
      warn(view, e.message);
      view.append(textButton("Проверить ещё раз", () => purchaseHistory(fromPayment)));
      if (fromPayment) view.append(textButton("Мои заказы", () => { dismissReturn(); void purchaseHistory(); }));
    }
  }
  function admin() {
    if (session.user?.role !== "owner") return void openAccount();
    const view = page("Управление сервисом", "Кабинет владельца");
    back(view);
    const mode = session.billing?.enabled ? (session.billing.mode === "test" ? "Тестовый магазин" : "Открыт приём платежей") : "Продажи выключены";
    view.append(row("Оплата через ЮKassa", mode));
    const search = element("form", "account-inline");
    view.append(search);
    const name = field(search, "Найти пользователя по логину", "lookup", "text", {
      minLength: 3, maxLength: 32, autocapitalize: "none", autocomplete: "off", spellcheck: false
    });
    submit(search, view, "Найти", () => member(name.value.trim(), view));
    const content = element("section", "account-list");
    content.setAttribute("aria-label", "Зарегистрированные пользователи");
    content.append(element("h3", "", "Пользователи"));
    view.append(content);
    let cursor;
    const more = textButton("Показать ещё", () => void run(view, more, loadPage));
    async function loadPage() {
      const next = await api.call("admin/users" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
      if (!active(view)) return;
      for (const user of next.users || []) {
        const detail = user.role === "owner" ? "Владелец сервиса" : "Тариф «" + planName(user.plan) + "»";
        const show = textButton("Открыть", () => void run(view, show, () => member(user.login, view)));
        show.setAttribute("aria-label", "Открыть аккаунт " + user.login);
        content.append(row(user.login, detail, show));
      }
      cursor = next.next;
      more.hidden = !cursor;
    }
    more.hidden = true;
    view.append(more);
    void loadPage().catch(e => warn(view, e.message));
  }
  async function member(login, previous, message) {
    const data = await api.call("admin/user?login=" + encodeURIComponent(login));
    if (!active(previous)) return;
    const user = data.user;
    const view = page("Аккаунт " + user.login, "Управление доступом");
    back(view, "К управлению сервисом", admin);
    if (message) note(view, message);
    const label = user.role === "owner" ? "Владелец сервиса" : "Тариф «" + planName(user.plan) + "»";
    view.append(row(label, user.role === "owner" ? "Полный доступ" :
      "Рукописей в облаке " + (user.used ?? 0) + " из " + user.bookLimit + (user.until ? " · До " + formatDate(user.until) : "")));
    if (user.role !== "owner") {
      const form = element("form", "account-form");
      form.append(element("h3", "", "Доступ за счёт сервиса"));
      const current = user.grant?.plan && user.grant.until > Date.now();
      if (current)
        form.append(element("p", "account-text", "Выдан тариф «" + planName(user.grant.plan) + "» до " + formatDate(user.grant.until) + "."));
      const wrap = element("div", "form-field"), label = element("label", "", "Тариф"), sel = element("select");
      sel.id = "cab-grant-plan";
      label.htmlFor = sel.id;
      for (const p of session.plans.filter(p => p.id !== "free"))
        sel.add(new Option(p.title, p.id, false, p.id === user.grant?.plan));
      wrap.append(label, sel);
      form.append(wrap);
      const duration = field(form, "Количество дней с сегодняшней даты", "days", "number", { min: 1, max: 3650, step: 1, value: "30" });
      submit(form, view, "Выдать доступ", async () => {
        await api.call("admin/grant", { login: user.login, plan: sel.value, days: duration.valueAsNumber });
        await member(user.login, view, "Доступ обновлён.");
      });
      if (current) {
        const revoke = textButton("Отменить выданный доступ", () => {
          const confirm = page("Отменить выданный доступ?", user.login);
          confirm.append(element("p", "account-text", "Оплаченные покупки сохраняют свой срок. Рукописи останутся доступны для чтения и экспорта."));
          const yes = textButton("Отменить доступ за счёт сервиса", () => void run(confirm, yes, async () => {
            await api.call("admin/grant", { login: user.login, plan: "free", days: 0 });
            await member(user.login, confirm, "Доступ за счёт сервиса отменён.");
          }), "btn main");
          const cancel = textButton("Вернуться", () => void run(confirm, cancel, () => member(user.login, confirm)));
          confirm.append(yes, cancel);
        });
        form.append(revoke);
      }
      view.append(form);
    }
    if (Array.isArray(data.orders)) {
      const list = element("section", "account-list");
      list.append(element("h3", "", "Платежи аккаунта"));
      if (!data.orders.length) list.append(element("p", "account-text", "Пока нет заказов."));
      for (const item of data.orders) list.append(orderRow(item, true));
      view.append(list);
    }
  }
  window.KaretkaOpenAccount = openAccount;
  $("accountButton").addEventListener("click", openAccount);
  if (returning) window.addEventListener("load", openAccount, { once: true });
})();
