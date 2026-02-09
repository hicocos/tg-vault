import { sanitizeFilename } from './backend/src/utils/telegramUtils.js';

const testCases = [
    { name: 'Simple English', input: 'Hello World' },
    { name: 'Chinese Characters', input: '你好世界' },
    { name: 'Long Chinese String', input: '这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的中文字符串' },
    { name: 'Emoji String', input: '😊🚀🔥🌟🌈🍦🍔🍕🎸🎮' },
    { name: 'Multi-line Caption', input: 'First Line\nSecond Line\nThird Line' },
    { name: 'Invalid Characters', input: 'File: <name> / "quoted" | ? *' },
    { name: 'Trailing Dots and Spaces', input: 'Space at end   ' },
    { name: 'More Trailing Dots', input: 'Dots at end...' },
    { name: 'Mixed Long String', input: 'Mixed string with English and Chinese 包含很多中文字符以测试字节限制是否生效，这是一个非常长的测试用例。'.repeat(10) },
];

console.log('--- Sanitization Test ---');
for (const tc of testCases) {
    const output = sanitizeFilename(tc.input);
    const byteLength = Buffer.byteLength(output, 'utf8');
    console.log(`[${tc.name}]`);
    console.log(`  Input:  ${tc.input.length > 50 ? tc.input.substring(0, 50) + '...' : tc.input}`);
    console.log(`  Output: ${output}`);
    console.log(`  Chars:  ${output.length}`);
    console.log(`  Bytes:  ${byteLength}`);
    if (byteLength > 150) {
        console.error('  ❌ FAILED: Byte length exceeds 150');
    } else if (output.length > 50) {
        console.error('  ❌ FAILED: Character length exceeds 50');
    } else {
        console.log('  ✅ PASSED');
    }
}
