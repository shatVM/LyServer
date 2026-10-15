@{
    # Шлях до локального клону репозиторію LyServer
    RepoPath       = 'C:\Users\Admin\Documents\LyServer'

    # GitHub repo у форматі owner/name
    GitHubRepo     = 'shatVM/LyServer'

    # Очікуваний origin remote (суворий захист від роботи не в тому репозиторії)
    ExpectedRemote = 'https://github.com/shatVM/LyServer.git'

    # Модель OpenCode для виконання задач
    Model          = 'opencode/mimo-v2.6-flash-free'

    # Тайм-аути (секунди)
    ModelPingTimeoutSec = 120
    TaskTimeoutSec      = 1800

    # Мітки GitHub
    LabelReady      = 'ready-for-opencode'
    LabelInProgress = 'in-progress'
    LabelReview     = 'opencode-review'

    # Каталог журналів (поза репозиторієм!)
    LogDir         = 'C:\Users\Admin\Documents\LyServerDispatcherLogs'

    # Каталог журналів виконання задач (діагностика, робочі копії)
    RunRootDir     = 'C:\Users\Admin\Documents\LyServerDispatcherRuns'

    # Захист від паралельного запуску: каталог lock-файлів
    LockDir        = 'C:\Users\Admin\Documents\LyServerDispatcherLogs\locks'

    # ---- Stage 2 (контрольоване виконання; вмикається лише ключем -Stage2) ----
    # Джерело завдань: 'GitHub' (через gh, потрібна автентифікація) або
    # 'Local' (тестовий режим: JSON-файл, жодного звернення до GitHub).
    TaskSource     = 'GitHub'

    # Команда-агент (ім'я з PATH). Реальний запуск: opencode.
    # У тестовому режимі - підроблений агент.
    AgentCommand   = 'opencode'

    # TaskSource='Local': шлях до JSON-файлу з завданням(и)
    # [{ "number": 901, "title": "...", "state": "open",
    #    "labels": ["ready-for-opencode"], "body": "..." }]
    LocalTaskFile  = ''

    # TaskSource='Local': базова гілка, з якої створюється worktree
    BaseBranch     = ''

    # Безпечна обробка застарілого lock-файлу (секунди): старший за цей
    # вік lock вважається застарілим, архівується і береться заново.
    LockStaleSec   = 900

    # ---- Issue report publishing (Issue #9) ----
    # Увімкнути публікацію звіту у GitHub Issue (COMMENT ONLY).
    # За замовчуванням ВИМКНЕНО: публікація — це мутація, вона потребує явного opt-in.
    PublishReport  = $false

    # TaskSource='GitHub': перевіряти, що Issue існує, відкрите і має
    # LabelReady перед публікацією (безпечна перевірка TOCTOU).
    VerifyIssueBeforePublish = $true
}
