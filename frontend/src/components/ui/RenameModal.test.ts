import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zh from '../../locales/zh-CN/index';
import en from '../../locales/en/index';

const modal = fs.readFileSync(new URL('./RenameModal.tsx', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

test('rename modal awaits confirmation and keeps the form open when it fails', () => {
    assert.match(modal, /onConfirm: \(newName: string\) => void \| Promise<void>/);
    assert.match(modal, /await onConfirm\(newName\)/);
    assert.match(modal, /catch \(confirmError/);
    assert.match(modal, /setError\(confirmError instanceof Error/);
});

test('rename modal preserves the edited value and focus after a failed confirmation', () => {
    const failureFlow = modal.match(/catch \(confirmError\) \{([\s\S]*?)\n {8}\}/)?.[1] || '';
    assert.doesNotMatch(failureFlow, /setBaseName\(/);
    assert.match(modal, /finally \{[\s\S]*requestAnimationFrame\(\(\) => inputRef\.current\?\.focus\(\)\)/);
});

test('rename modal disables all form exits and duplicate submissions while confirmation is pending', () => {
    assert.match(modal, /const \[isSubmitting, setIsSubmitting\] = useState\(false\)/);
    assert.match(modal, /if \(isSubmitting\) return/);
    assert.match(modal, /onClick=\{isSubmitting \? undefined : onClose\}/);
    assert.match(modal, /onClick=\{\(\) => void handleConfirm\(\)\}[\s\S]*disabled=\{isSubmitting\}/);
    assert.match(modal, /disabled=\{isSubmitting\}[\s\S]*t\('files\.ui\.rename\.renaming'\)[\s\S]*t\('files\.ui\.rename\.confirm'\)/);
    assert.equal(zh.files.ui.rename.confirm, '确认');
    assert.equal(en.files.ui.rename.confirm, 'Rename');
});

test('rename handlers surface failures in the modal instead of swallowing them', () => {
    assert.match(app, /handleFileRename[\s\S]*setNotification\([\s\S]*throw error;/);
    assert.match(app, /handleFolderRename[\s\S]*setNotification\([\s\S]*throw error;/);
});

test('rename modal uses the shared accessible dialog shell', () => {
    assert.match(modal, /<Dialog/);
    assert.match(modal, /labelledBy="rename-modal-title"/);
    assert.doesNotMatch(modal, /fixed inset-0 z-\[9999\]/);
});
