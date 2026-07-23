import fs from 'fs';
import path from 'path';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { recordTelegramUserClientFailure, recordTelegramUserClientReady } from './telegramUserClientStatus.js';

let userClient: TelegramClient | null = null;
let userSessionFilePath = '';

function getUserApiId(): number {
  return parseInt(process.env.TELEGRAM_API_ID || '0');
}

function getUserApiHash(): string {
  return process.env.TELEGRAM_API_HASH || '';
}

function getSessionFilePath(): string {
  return process.env.TELEGRAM_USER_SESSION_FILE || './data/telegram_user_session.txt';
}

export async function initTelegramUserClient(): Promise<void> {
  const apiId = getUserApiId();
  const apiHash = getUserApiHash();
  if (!apiId || !apiHash) {
    recordTelegramUserClientFailure('not_configured', '未配置 Telegram API');
    console.log('⚠️ 未配置 Telegram 用户账号下载器，跳过 user client 初始化');
    return;
  }

  userSessionFilePath = getSessionFilePath();
  const sessionDir = path.dirname(userSessionFilePath);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  }

  const sessionString = fs.existsSync(userSessionFilePath)
    ? fs.readFileSync(userSessionFilePath, 'utf-8').trim()
    : '';

  if (!sessionString) {
    recordTelegramUserClientFailure('missing_session', 'Telegram 用户 session 文件为空或不存在');
    console.log('⚠️ Telegram 用户 session 为空，先运行登录脚本生成 session 后再启用 user client');
    return;
  }

  userClient = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 15,
    retryDelay: 2000,
    useWSS: false,
    deviceModel: 'TG Vault User Downloader',
    systemVersion: '1.0.0',
    appVersion: '1.0.0',
    floodSleepThreshold: 120,
  });

  await userClient.connect();
  if (!(await userClient.checkAuthorization())) {
    recordTelegramUserClientFailure('expired', 'Telegram 用户 session 无效或已过期');
    console.log('⚠️ Telegram 用户 session 无效或已过期，user client 未启用');
    userClient = null;
    return;
  }

  fs.writeFileSync(userSessionFilePath, userClient.session.save() as unknown as string, { mode: 0o600 });
  fs.chmodSync(userSessionFilePath, 0o600);
  const me = await userClient.getMe();
  recordTelegramUserClientReady({
    userId: String((me as any)?.id || ''),
    username: (me as any)?.username || null,
  });
  console.log('🤖 Telegram 用户账号下载器已连接');
}

export function getTelegramUserClient(): TelegramClient | null {
  return userClient;
}

export function isTelegramUserClientReady(): boolean {
  return Boolean(userClient?.connected);
}

export function getTelegramUserSessionFilePath(): string {
  return userSessionFilePath || getSessionFilePath();
}