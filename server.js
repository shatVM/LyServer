const os = require("node:os");
const app = require("./src/app");
const config = require("./src/config");
// Issue #63 (Етап 5): усі попередні входи (сесії викладача й учнів) стають
// недійсними при кожному перезапуску — сховище сесій живе в пам'яті процесу,
// тому скидання робиться явно на старті, до прийому запитів.
const sessionService = require("./src/services/sessionService");

sessionService.reset();

/** Локальні IPv4-адреси для відображення адреси порталу в мережі */
function lanAddresses() {
  const out = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const i of interfaces || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

app.listen(config.port, config.host, () => {
  console.log("Навчальний портал запущено");
  console.log("На ПК: http://localhost:" + config.port);
  const addrs = lanAddresses();
  console.log(
    "У локальній мережі: " +
      (addrs.length
        ? addrs.map((ip) => `http://${ip}:${config.port}`).join("  |  ")
        : "(немає підключених мережевих адаптерів)")
  );
  console.log("Каталог матеріалів: " + config.dataDir);
  // Issue #85: адмін-PIN — змінна PORTAL_PIN або стандартне значення.
  // Саме значення не друкується (див. Issue #1).
  console.log("PIN викладача: задано через змінну PORTAL_PIN");
});
