#!/usr/bin/env node
/**
 * 密码哈希生成器
 * 用法: node generate-password-hash.js <密码>
 */

import crypto from 'crypto';

const password = process.argv[2];

if (!password) {
    console.log('用法: node generate-password-hash.js <密码>');
    console.log('');
    console.log('示例:');
    console.log('  node generate-password-hash.js mySecretPassword');
    console.log('');
    console.log('然后将生成的哈希值添加到 .env 文件中的 ACCESS_PASSWORD_HASH');
    process.exit(1);
}

const hash = crypto.createHash('sha256').update(password).digest('hex');

console.log('');
console.log('密码:', password);
console.log('');
console.log('SHA-256 哈希值:');
console.log(hash);
console.log('');
console.log('请将以下内容添加到 .env 文件:');
console.log(`ACCESS_PASSWORD_HASH=${hash}`);
console.log('');
