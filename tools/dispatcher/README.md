# LyServer Dispatcher — Stage 1 (перевірки + попередній перегляд)

Усі файли запуску лежать у `tools\dispatcher\`. Потрібен Windows PowerShell 5.1,
налаштовані `git`, `gh` (авторизований) та `opencode`.

## 1. Налаштування `config.psd1` (один раз)

`config.psd1` містить локальні налаштування і **не комітиться** (у `.gitignore`).

```powershell
cd C:\Users\Admin\Documents\LyServer\tools\dispatcher
Copy-Item config.example.psd1 config.psd1
notepad config.psd1
```

Перевірте значення: `RepoPath`, `GitHubRepo`, `ExpectedRemote`, `Model`,
`LogDir` (журнали мають бути **поза** репозиторієм), `RunRootDir`, `LockDir`.
Секретів у конфігурації немає і бути не повинно.

## 2. Тести

```bat
tools\dispatcher\Test-Dispatcher.bat
```

Код завершення `0` — усі тести пройдено; ненульовий — є помилка (код друкується
в кінці). Перед запуском робоче дерево репозиторію має бути чистим (T0).

## 3. Запуск Dispatcher (Stage 1 — лише попередній перегляд)

```bat
tools\dispatcher\Start-Dispatcher.bat
```

Обидва BAT можна запускати з будь-якого поточного каталогу (шляхи обчислюються
від `%~dp0`).

Звичайний запуск виконує лише: перевірки середовища → ping моделі → пошук
Issue з міткою `ready-for-opencode` → повідомлення про кандидатів. Він **не
виконує інструкції з Issue, не змінює Issues/мітки і не створює гілок чи PR**.

## 4. Журнал першого запуску

Каталог із конфігурації (`LogDir`), за замовчуванням:

```
C:\Users\Admin\Documents\LyServerDispatcherLogs\dispatcher-<РРРРММДД-ГГММСС>.log
```

Перевірка успішного запуску:

- останній рядок `=== Dispatcher finished (stage 1) ===`;
- `Preview completed. No claims, branches, sessions, or GitHub changes were made.`;
- відсутні рядки `[ERROR]`.

## 5. Обмеження Stage 1

- Push, створення PR і зміни в GitHub заборонені без окремого дозволу.
- Stage 2 (реальне виконання задач) не вмикається без окремого дозволу.
- Автозлиття PR заборонене завжди.
