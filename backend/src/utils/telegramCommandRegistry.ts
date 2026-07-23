export type BotCommandCategory = 'main' | 'files' | 'channels' | 'settings' | 'security';

export interface BotCommandDefinition {
    command: string;
    description: string;
    helpDescription: string;
    category: BotCommandCategory;
    aliases?: string[];
    usage?: string;
    menu?: boolean;
    help?: boolean;
}

export const BOT_COMMANDS: BotCommandDefinition[] = [
    { command: 'start', description: '开始使用 / 验证身份', helpDescription: '身份认证 / 开始使用', category: 'main', menu: true, help: true },
    { command: 'tasks', description: '查看实时任务', helpDescription: '查看实时传输任务队列', category: 'main', aliases: ['task'], menu: true, help: true },
    { command: 'storage', description: '存储状态 / 删除本地实体文件', helpDescription: '查看存储状态；可确认删除本地实体文件', category: 'main', menu: true, help: true },
    { command: 'path_rules', description: '保存位置 / 自定义目录', helpDescription: '打开保存位置与自定义目录面板', category: 'main', aliases: ['path', 'save_rules'], menu: true, help: true },
    { command: 'tg_download', description: '按日期 / 标签下载频道文件', helpDescription: '打开按日期或标签下载向导', category: 'main', aliases: ['tg_dl'], menu: true, help: true },
    { command: 'list', description: '查看最近文件', helpDescription: '查看最近文件和可复制的文件 ID', category: 'files', usage: '[数量] [页码]', menu: true, help: true },
    { command: 'tg_sub', description: '管理频道自动同步', helpDescription: '打开频道订阅管理向导', category: 'channels', aliases: ['tg_subscribe'], menu: true, help: true },
    { command: 'storage_switch', description: '切换系统默认存储', helpDescription: '切换所有新任务使用的系统默认存储', category: 'settings', aliases: ['switch_storage', 'storage_source'], menu: true, help: true },
    { command: 'ytdlp', description: '下载视频链接', helpDescription: '解析并下载一个视频链接', category: 'files', usage: '<url>', menu: true, help: true },
    { command: 'help', description: '查看完整帮助', helpDescription: '显示此帮助', category: 'main', menu: true, help: true },
    { command: 'setup_2fa', description: '配置双重验证', helpDescription: '配置双重验证 (TOTP)', category: 'security', aliases: ['setup-2fa'], menu: false, help: true },
    { command: 'p', description: '设置下一次保存目录', helpDescription: '下一次下载保存到指定目录', category: 'files', usage: '<目录>', help: true },
    { command: 'ps', description: '设置本会话保存目录', helpDescription: '本会话持续保存到指定目录', category: 'files', usage: '<目录>', help: true },
    { command: 'pc', description: '清除自定义保存目录', helpDescription: '清除下一次和本会话自定义目录', category: 'files', help: true },
    { command: 'delete', description: '删除指定文件', helpDescription: '按至少 8 位文件 ID 前缀删除文件', category: 'files', usage: '<文件 ID 前缀>', help: true },
    { command: 'task_pause', description: '暂停任务', helpDescription: '暂停当前聊天任务或指定任务', category: 'settings', usage: '[任务 ID]', help: true },
    { command: 'task_resume', description: '继续任务', helpDescription: '继续当前聊天任务或指定任务', category: 'settings', usage: '[任务 ID]', help: true },
    { command: 'task_cancel', description: '取消任务', helpDescription: '预览并取消指定任务或当前聊天全部任务', category: 'settings', usage: '<任务 ID|all>', help: true },
    { command: 'tg_retry', description: '重试失败任务', helpDescription: '重试最近失败的 Telegram 下载任务', category: 'channels', usage: '[数量] [任务 ID]', help: true },
    { command: 'stop_tasks', description: '停止当前聊天任务', helpDescription: '兼容入口：预览并停止当前聊天下载任务', category: 'settings', aliases: ['stop', 'cancel_tasks'], help: true },
    { command: 'download_workers', description: '单文件分片并发', helpDescription: '设置单文件分片下载并发', category: 'settings', aliases: ['workers'], help: true },
    { command: 'file_concurrency', description: '同时下载文件数', helpDescription: '设置同时下载文件数', category: 'settings', aliases: ['file_workers', 'download_files'], help: true },
    { command: 'duplicate_mode', description: '重复文件处理', helpDescription: '设置重复文件处理策略', category: 'settings', aliases: ['duplicate', 'dup'], help: true },
    { command: 'cleanup_settings', description: '自动清理未索引临时文件', helpDescription: '设置自动清理未登记临时文件的开关', category: 'settings', aliases: ['cleanup'], help: true },
    { command: 'tg_subs', description: '查看频道订阅', helpDescription: '查看频道订阅列表', category: 'channels', aliases: ['tg_subscriptions'], help: true },
    { command: 'tg_unsub', description: '取消频道订阅', helpDescription: '按频道或订阅 ID 请求取消订阅', category: 'channels', aliases: ['tg_unsubscribe'], usage: '<频道|订阅 ID>', help: true },
];

const lookup = new Map<string, BotCommandDefinition>();
for (const definition of BOT_COMMANDS) {
    lookup.set(definition.command, definition);
    definition.aliases?.forEach(alias => lookup.set(alias, definition));
}

export function buildBotCommandMenu(): Array<{ command: string; description: string }> {
    return BOT_COMMANDS.filter(command => command.menu).map(({ command, description }) => ({ command, description }));
}

export function findBotCommand(input: string): BotCommandDefinition | undefined {
    const token = input.trim().split(/\s+/, 1)[0].replace(/^\//, '').replace(/@\w+$/, '').toLowerCase();
    return lookup.get(token);
}

export function normalizeBotCommandText(input: string): string {
    const match = input.match(/^(\s*)\/([^\s@]+)(?:@\w+)?([\s\S]*)$/);
    if (!match) return input;
    const definition = lookup.get(match[2].toLowerCase());
    return definition ? `${match[1]}/${definition.command}${match[3]}` : input;
}

export function buildBotHelpSections(): Array<{ title: string; commands: BotCommandDefinition[] }> {
    const labels: Array<[BotCommandCategory, string]> = [
        ['main', '常用入口'], ['files', '文件与保存位置'], ['channels', '频道与订阅'], ['settings', '任务与系统设置'], ['security', '安全'],
    ];
    return labels.map(([category, title]) => ({
        title,
        commands: BOT_COMMANDS.filter(command => command.help && command.category === category),
    })).filter(section => section.commands.length > 0);
}
