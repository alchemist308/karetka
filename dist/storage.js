"use strict";

const KaretkaStore = (() => {
  const prefix = "karetka.v1.";
  let database, backend;
  const listPrefix = prefix + "book.";
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("karetka-writing-v1", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("books", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("Хранилище занято другой вкладкой."));
    });
  }
  function readAll() {
    if (backend === "local") {
      const result = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(listPrefix)) result.push(JSON.parse(localStorage.getItem(key)));
      }
      return Promise.resolve(result);
    }
    return new Promise((resolve, reject) => {
      const req = database.transaction("books").objectStore("books").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function open() {
    let preferred;
    try {
      preferred = localStorage.getItem(prefix + "backend");
    } catch {}
    if (preferred !== "local") {
      try {
        database = await openDatabase();
        backend = "db";
      } catch (e) {
        if (preferred === "db") throw e;
      }
    }
    if (!backend) {
      localStorage.setItem(prefix + "probe", "1");
      localStorage.removeItem(prefix + "probe");
      backend = "local";
    }
    try {
      localStorage.setItem(prefix + "backend", backend);
    } catch {}
    return readAll();
  }
  function save(book, expected) {
    if (backend === "local") {
      const key = listPrefix + book.id,
        old = localStorage.getItem(key);
      if (old && JSON.parse(old).rev !== expected) return Promise.resolve(false);
      localStorage.setItem(key, JSON.stringify(book));
      return Promise.resolve(true);
    }
    return new Promise((resolve, reject) => {
      const tx = database.transaction("books", "readwrite"),
        store = tx.objectStore("books");
      let matches = true;
      const req = store.get(book.id);
      req.onsuccess = () => {
        const old = req.result;
        if (old && old.rev !== expected) {
          matches = false;
          return;
        }
        store.put(book);
      };
      tx.oncomplete = () => resolve(matches);
      tx.onabort = tx.onerror = () =>
        reject(tx.error || new Error("Не удалось сохранить рукопись."));
    });
  }
  function readPref(key, fallback) {
    try {
      const value = localStorage.getItem(prefix + key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  function writePref(key, value) {
    try {
      localStorage.setItem(prefix + key, JSON.stringify(value));
    } catch {}
  }
  return { open, readAll, save, readPref, writePref };
})();
