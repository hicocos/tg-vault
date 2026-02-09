// Standalone sanitization logic for testing
function sanitizeFilename(name) {
    if (!name) return 'unknown';

    // Take ONLY the first line if it's a multi-line caption
    const firstLine = name.split('\n')[0].trim();

    let sanitized = firstLine
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Remove invalid chars
        .replace(/\s+/g, ' ')                   // Collapse whitespace
        .trim();

    // Remove trailing dots and spaces (problematic on Windows/some filesystems)
    sanitized = sanitized.replace(/[.\s]+$/, '');

    if (!sanitized) return 'unknown';

    // Limit character length first
    let result = sanitized.substring(0, 50);

    // Further limit by byte length (UTF-8) to ensure it stays well under the 255-byte limit
    const MAX_BYTES = 150;
    while (Buffer.byteLength(result, 'utf8') > MAX_BYTES && result.length > 0) {
        result = result.substring(0, result.length - 1);
    }

    return result || 'unknown';
}

const testCases = [
    { name: 'Simple English', input: 'Hello World' },
    { name: 'Chinese Characters', input: '你好世界' },
    { name: 'Long Chinese String', input: '这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的中文字串' },
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
