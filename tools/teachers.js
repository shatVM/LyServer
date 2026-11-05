#!/usr/bin/env node
/**
 * tools/teachers.js — локальна безпечна процедура роботи з персональними
 * PIN викладачів (Issue #85).
 *
 * Навіщо: створення першого облікового запису та заміна PIN мають бути
 * можливі БЕЗ введення PIN у браузері/мережі — із терміналу самого сервера.
 * Той самий запис потрапляє у materials/.teachers.json (поза Git), тому
 * ні PIN, ні хеш у репозиторій не потрапляють у жодному разі.
 *
 * Команди:
 *   node tools/teachers.js list
 *   node tools/teachers.js create [--name "ПІБ"] [--permissions demo,materials]
 *   node tools/teachers.js set-pin --id <id>
 *
 * PIN читається зі змінної середовища TEACHER_PIN (зручно для разового
 * виклику) або вводиться в терміналі без еха (рядок НЕ друкується).
 * Ні PIN, ні хеш ніколи не виводяться в stdout/stderr.
 *
 * Приклад (PowerShell):
 *   $env:TEACHER_PIN = "1234"; node tools/teachers.js create --name "Шатківський Віталій Миколайович"
 */

const readline = require("node:readline");
const config = require("../src/config");
const teacherService = require("../src/services/teacherService");
const { isValidPin } = require("../src/utils/pinHash");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}

/**
 * Читання PIN: спочатку змінна середовища TEACHER_PIN, далі — ввід у
 * терміналі БЕЗ еха (raw mode: символи не друкуються, підтвердження — Enter,
 * виправлення — Backspace). Незалежно від шляху рядок PIN нікуди не логується.
 */
function readPin(question) {
  const fromEnv = process.env.TEACHER_PIN;
  if (fromEnv && String(fromEnv).trim()) return Promise.resolve(String(fromEnv).trim());

  // Не-TTY (пайп): читаємо один рядок мовчки (там немає й еха)
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolve(value.trim().split(/\r?\n/)[0] || ""));
      process.stdin.on("error", reject);
    });
  }

  process.stdout.write(question + " (ввід не відображатиметься): ");
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") { finish(); resolve(value); return; }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); } // Ctrl+C
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        if (ch >= " " && ch <= "~") value += ch; // 4 цифри ASCII
      }
    };
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

function fail(message) {
  process.stderr.write("ПОМИЛКА: " + message + "\n");
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === "help" || args.help) {
    process.stdout.write(
      "Керування обліковими записами викладачів (Issue #85)\n\n" +
      "  node tools/teachers.js list\n" +
      "  node tools/teachers.js create [--name \"ПІБ\"] [--permissions demo,materials]\n" +
      "  node tools/teachers.js set-pin --id <id>\n\n" +
      "PIN читається з TEACHER_PIN або вводиться без еха. " +
      "PIN/хеші у відповіді не виводяться.\n"
    );
    return;
  }

  try {
    if (command === "list") {
      const list = teacherService.list();
      if (!list.length) {
        process.stdout.write("Облікових записів ще немає.\n");
        return;
      }
      for (const t of list) {
        const state = t.archived ? "архівований" : (t.active ? "активний" : "деактивований");
        process.stdout.write(
          `${t.id}  ${t.fullName}  [${state}]  права: ${(t.permissions || []).join(",") || "—"}  ` +
          `сесій: ${t.activeSessions}\n`
        );
      }
      process.stdout.write(`\nВсього: ${list.length}. Файл: ${config.teachersFile}\n`);
      return;
    }

    if (command === "create") {
      let fullName = typeof args.name === "string" ? args.name.trim() : "";
      if (!fullName) {
        if (!process.stdin.isTTY) fail('не вказано --name "ПІБ"');
        fullName = await new Promise((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question("ПІБ викладача: ", (answer) => { rl.close(); resolve(String(answer).trim()); });
        });
      }
      const pin = await readPin("Персональний PIN (4 цифри): ");
      if (!isValidPin(pin, config.teacherPinLength)) {
        fail(`PIN має містити рівно ${config.teacherPinLength} цифри`);
      }
      const permissions =
        typeof args.permissions === "string"
          ? args.permissions.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
      const teacher = teacherService.create({ fullName, pin, permissions });
      process.stdout.write(
        `Створено обліковий запис:\n  id: ${teacher.id}\n  ПІБ: ${teacher.fullName}\n` +
        `  права: ${teacher.permissions.join(", ") || "—"}\n` +
        "  PIN збережено лише як хеш (materials/.teachers.json, поза Git).\n"
      );
      return;
    }

    if (command === "set-pin") {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) fail("не вказано --id (подивіться його в `list` або в панелі «Викладачі»)");
      const pin = await readPin("Новий персональний PIN (4 цифри): ");
      if (!isValidPin(pin, config.teacherPinLength)) {
        fail(`PIN має містити рівно ${config.teacherPinLength} цифри`);
      }
      const teacher = teacherService.setPin(id, pin);
      process.stdout.write(
        `PIN замінено для «${teacher.fullName}». Чинні сесії викладача відкликано.\n`
      );
      return;
    }

    fail(`невідома команда «${command}» (див. help)`);
  } catch (error) {
    fail(error.message);
  }
}

main();
