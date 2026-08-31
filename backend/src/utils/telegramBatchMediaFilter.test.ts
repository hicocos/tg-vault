import assert from 'node:assert/strict';
import test from 'node:test';
import { filterTelegramBatchMessages } from './telegramBatchMediaFilter.js';

function photo(id: number) {
    return { id, photo: { className: 'Photo', sizes: [{}] }, media: { className: 'MessageMediaPhoto' } } as any;
}

function document(id: number, mimeType = 'image/jpeg') {
    return {
        id,
        document: {
            className: 'Document',
            mimeType,
            size: 1024,
            attributes: [{ className: 'DocumentAttributeFilename', fileName: `original_${id}.jpg` }],
        },
        media: { className: 'MessageMediaDocument' },
    } as any;
}

test('batch photo filter keeps Telegram photos when the switch is off', () => {
    const messages = [photo(1), document(2)];
    assert.deepEqual(filterTelegramBatchMessages(messages, false), messages);
});

test('batch photo filter removes only Telegram photos when the switch is on', () => {
    const original = document(2);
    const pdf = document(3, 'application/pdf');
    assert.deepEqual(filterTelegramBatchMessages([photo(1), original, pdf], true), [original, pdf]);
});
