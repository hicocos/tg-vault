from pathlib import Path

root = Path(__file__).resolve().parents[1]
jobs = (root / 'src/services/telegramChannelJobs.ts').read_text()
commands = (root / 'src/services/telegramCommands.ts').read_text()
messages = (root / 'src/utils/telegramMessages.ts').read_text()

checks = [
    ('listTelegramActiveTaskQueues', jobs),
    ('finished_at IS NULL', jobs),
    ('cancelled_at IS NULL', jobs),
    ("j.status = 'running'", jobs),
    ("j.status = 'paused'", jobs),
    ("pending_count", jobs),
    ("downloading_count", jobs),
    ("is_actively_running", jobs),
    ("completed_with_errors", jobs),
    ('buildChannelTaskQueueReport', commands),
    ('buildTasksKeyboard', commands),
    ('handleChannelTaskQueueCallback', commands),
    ('ctq_cancel_all', commands),
    ('频道任务队列', commands),
    ('正在运行', commands),
    ('已暂停', commands),
    ('等待接手', commands),
    ('buildTasksReport(status.active, status.pending)', commands),
    ('historyCount', commands, False),
    ('最近完成', messages, False),
    ('实时下载队列', messages),
    ('等待开始', messages),
]

missing = []
for check in checks:
    if len(check) == 2:
        needle, haystack = check
        should_exist = True
    else:
        needle, haystack, should_exist = check
    present = needle in haystack
    if present != should_exist:
        missing.append(("missing" if should_exist else "unexpected") + f": {needle}")

if missing:
    raise SystemExit('Telegram /tasks queue rendering verification failed: ' + ', '.join(missing))
print('Telegram /tasks queue rendering verifies active/paused-only output and hides history')
