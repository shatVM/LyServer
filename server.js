const app = require("./src/app");
const config = require("./src/config");

app.listen(config.port, config.host, () => {
  console.log("Навчальний портал запущено");
  console.log("На ПК: http://localhost:" + config.port);
  console.log("У локальній мережі: http://192.168.1.141:" + config.port);
  console.log("Каталог матеріалів: " + config.dataDir);
  console.log("PIN викладача: " + config.portalPin);
});
