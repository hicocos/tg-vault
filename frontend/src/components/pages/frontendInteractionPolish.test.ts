import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const tasks = fs.readFileSync(new URL('./TasksPage.tsx', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const layout = fs.readFileSync(new URL('../layout/AppLayout.tsx', import.meta.url), 'utf8');
const actionNotice = settings.slice(settings.indexOf('const ActionNotice'), settings.indexOf('const ActionDialog'));

test('task success feedback auto-dismisses while retaining a manual close control', () => {
    assert.match(tasks, /interface TaskNotice \{ message: string; sequence: number; \}/);
    assert.match(tasks, /const showNotice = \(message: string\) => setNotice\(previous => \(\{ message, sequence: \(previous\?\.sequence \?\? 0\) \+ 1 \}\)\);/);
    assert.match(tasks, /useEffect\(\(\) => \{\s*if \(!notice\) return;[\s\S]*setTimeout\(\(\) => setNotice\(null\), 4_000\)/);
    assert.match(tasks, /\}, \[notice\?\.sequence\]\);/);
    assert.match(tasks, /aria-live="polite"/);
    assert.match(tasks, /aria-label=\{t\('tasks\.actions\.closeNotice'\)\}/);
});

test('the global header owns the theme switch on every page', () => {
    assert.match(layout, /data-testid="header-theme-switch"/);
    assert.match(layout, /useTheme\(\)/);
    assert.match(layout, /value: "light" as const/);
    assert.match(layout, /value: "dark" as const/);
    assert.match(layout, /value: "system" as const/);
    assert.match(layout, /setTheme\(option\.value\)/);
    assert.doesNotMatch(settings, /label=\{t\("settings\.general\.theme"\)\}/);
});

test('storage connection test feedback stays beside the account that triggered it', () => {
    assert.match(settings, /interface ProbeFeedbackState \{ accountId: string; tone: 'success' \| 'error'; message: string; sequence: number; \}/);
    assert.match(settings, /probeFeedback\?\.accountId === account\.id \? probeFeedback : null/);
    assert.match(settings, /role="status" aria-live="polite"/);
    assert.match(settings, /setProbeFeedback\(previous => \(\{ accountId: account\.id, tone: 'success', message: t\('settings\.remaining\.copy\.177'\), sequence: \(previous\?\.sequence \?\? 0\) \+ 1 \}\)\)/);
    assert.match(settings, /tone: 'error'/);
    assert.doesNotMatch(settings, /showNotice\([^)]*settings\.remaining\.copy\.177/);
});

test('settings uses non-modal transient feedback for notices but keeps confirmations and prompts modal', () => {
    assert.match(settings, /interface ActionNoticeState/);
    assert.match(settings, /role="status"/);
    assert.match(settings, /aria-live="polite"/);
    assert.match(settings, /window\.setTimeout\(\(\) => closeActionNotice\(\), 4_000\)/);
    assert.match(settings, /setActionNotice\(\{ title, message, tone:[^\n]*\}\);/);
    assert.match(actionNotice, /return createPortal\(/);
    assert.match(actionNotice, /document\.body/);
    assert.match(settings, /return Promise\.resolve\(\);/);
    assert.doesNotMatch(settings, /window\.location\.reload\(\)/);
    assert.doesNotMatch(settings, /interface ActionNoticeState\s*\{[^}]*resolve\?:/);
    assert.doesNotMatch(settings, /mode:\s*'notice'\s*\|\s*'confirm'\s*\|\s*'prompt'/);
    assert.doesNotMatch(settings, /state\.mode === 'notice' \? '知道了'/);
});
