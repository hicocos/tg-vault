import { query } from '../db/index.js';

// Authenticated user storage (Cache)
export const authenticatedUsers = new Map<number, { authenticatedAt: Date }>();

// Password input state
export const passwordInputState = new Map<number, { password: string }>();

// Initialize authenticated users from database
export async function loadAuthenticatedUsers(): Promise<void> {
    try {
        const result = await query('SELECT user_id, authenticated_at FROM telegram_auth');
        result.rows.forEach(row => {
            // Telegram IDs are stored as BIGINT in DB, but we use number in Map
            authenticatedUsers.set(Number(row.user_id), { authenticatedAt: new Date(row.authenticated_at) });
        });
        console.log(`🤖 已从数据库载入 ${authenticatedUsers.size} 个授权用户`);
    } catch (error) {
        console.error('🤖 载入已验证用户失败:', error);
    }
}

// Persist authenticated user to database
export async function persistAuthenticatedUser(userId: number): Promise<void> {
    try {
        await query('INSERT INTO telegram_auth (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
        authenticatedUsers.set(userId, { authenticatedAt: new Date() });
        console.log(`🤖 用户 ${userId} 已持久化到数据库`);
    } catch (error) {
        console.error('🤖 持久化用户失败:', error);
    }
}

// Check if user is authenticated
export function isAuthenticated(userId: number): boolean {
    const ACCESS_PASSWORD_HASH = process.env.ACCESS_PASSWORD_HASH || '';
    if (!ACCESS_PASSWORD_HASH) {
        return true;
    }
    return authenticatedUsers.has(userId);
}
