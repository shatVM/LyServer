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
}
