import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectPrimaryOutputFile } from './ytDlpDownload.js';

function makeTaskDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vault-ytdlp-select-'));
}

function writeFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function testSelectsRealOutputFromNestedDirectories() {
    const dir = makeTaskDir();
    writeFile(path.join(dir, 'video.info.json'), '{"metadata":true}');
    writeFile(path.join(dir, 'tmp.part'), 'partial');
    writeFile(path.join(dir, 'nested', 'small-thumb.jpg'), 'x');
    writeFile(path.join(dir, 'nested', 'video.mp4'), 'real-media-output');

    const selected = selectPrimaryOutputFile(dir);

    assert.equal(selected?.fileName, 'video.mp4');
    assert.equal(selected?.filePath, path.join(dir, 'nested', 'video.mp4'));
    assert.equal(selected?.size, Buffer.byteLength('real-media-output'));
}

function testDoesNotDiscardJsonWhenItIsTheOnlyRealOutput() {
    const dir = makeTaskDir();
    writeFile(path.join(dir, 'result.json'), '{"download":"payload"}');

    const selected = selectPrimaryOutputFile(dir);

    assert.equal(selected?.fileName, 'result.json');
    assert.equal(selected?.filePath, path.join(dir, 'result.json'));
}

function testReturnsNullWhenOnlyTemporarySidecarsExist() {
    const dir = makeTaskDir();
    writeFile(path.join(dir, 'video.part'), 'partial');
    writeFile(path.join(dir, 'video.ytdl'), 'state');
    writeFile(path.join(dir, 'video.info.json'), '{"metadata":true}');
    writeFile(path.join(dir, 'video.tmp'), 'tmp');

    assert.equal(selectPrimaryOutputFile(dir), null);
}

testSelectsRealOutputFromNestedDirectories();
testDoesNotDiscardJsonWhenItIsTheOnlyRealOutput();
testReturnsNullWhenOnlyTemporarySidecarsExist();
console.log('yt-dlp output selection ok');
