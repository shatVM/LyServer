const app = require("./src/app");
const config = require("./src/config");

app.listen(config.port, config.host, () => {
  console.log("Навчальний портал запущено");
  console.log("На ПК: http://localhost:" + config.port);
  console.log("Каталог матеріалів: " + config.dataDir);
  // Не друкуємо сам PIN у консоль (див. Issue #1) — лише джерело значення
  if (process.env.PORTAL_PIN) {
    console.log("PIN викладача: задано через змінну PORTAL_PIN");
  } else {
    console.log("PIN викладача: значення за замовчуванням (рекомендовано задати PORTAL_PIN)");
  }
});
