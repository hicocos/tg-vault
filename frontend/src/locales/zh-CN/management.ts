export const management = {
  upload: {
    title: '上传中心', subtitle: "选择目录并添加文件。大文件自动分片，上传时可继续浏览。", manageQueue: '管理上传队列', root: '根目录', destination: '上传到', destinationHint: '上传开始后，目标存储与目录不会随设置变更。', currentStorage: '当前存储', storageLoading: '正在读取存储配置', queue: '上传队列', activeCount: '{{count}} 项进行中', idle: '当前空闲', recoverableCount: '{{count}} 项可恢复', transferPolicy: '传输策略', chunkThreshold: '超过 {{size}} MiB 自动分片', limitsLoading: '正在读取上传限制', currentBatch: '本次上传', batchSummary: '{{completed}} 项完成 · {{failed}} 项失败或取消', viewAll: '查看全部', empty: '选择文件后，进度会显示在这里。',
    status: { pending: '等待上传', uploading: '正在上传', processing: '服务器处理中', completed: '已完成', error: '上传失败', cancelled: '已取消' },
    reliable: { title: "上传说明", resumable: '可续传', resumableDetail: '中断的大文件上传可重新选择原文件继续。', concurrency: "并发上传", concurrencyDetail: "队列最多同时处理 3 个文件。", locked: '目标锁定', lockedDetail: "上传任务的存储账户和目录在创建后保持不变。" },
  },
  telegramAccounts: {
    title: 'Telegram 用户账号', count: '{{count}} 个', description: "用于读取频道、群组媒体。停用账号会保留登录信息。", add: '添加账号', botRequired: '请先配置 Telegram Bot 的 API ID 与 API Hash，再添加用户账号。', retry: '重试', loading: '正在加载账号…', fallbackName: 'Telegram 账号 {{id}}', privacy: "登录凭证加密保存在服务端，登录二维码在浏览器内生成。",
    status: { disabled: '已停用', ready: '可用', cooldown: '暂时受限', permissionDenied: '权限受限', connecting: '连接中', expired: '登录已失效', error: '异常' },
    summary: { enabled: '已启用账号', ready: '可用账号', cooldown: '暂时受限' },
    scheduling: { title: "账号调度", description: '逐文件选账号：已确认来源权限优先，按权重与负载分配，同负载轮换。合适账号都忙或请求受限时，新请求自动等待，不可用账号跳过。' },
    empty: { title: '尚未绑定 Telegram 用户账号', description: "添加账号后，可通过二维码或手机号登录。" },
    reauth: {
      action: '重新登录',
      expiredHint: '登录已失效，请使用原 Telegram 账号重新登录以更新凭证。',
      title: '重新登录：{{name}}',
      description: '正在为 {{name}}（Telegram ID：{{id}}）更新登录凭证。请使用同一个 Telegram 账号扫码或通过手机号登录。原有配置与启用／停用状态会保留。',
      closeAria: '关闭账号重新登录',
      completeTitle: '登录凭证已更新',
      completeDescription: '原账号及配置保持不变，实际连接状态请查看账号列表。已停用的账号仍保持停用，需手动启用后才会参与调度。',
      notice: '登录凭证已更新，实际状态请查看账号列表；已停用的账号仍保持停用。',
    },
    account: { dc: '所属 DC：{{value}}', dcUnknown: '未知', dcHint: '从 Telegram 登录会话读取的主数据中心，不代表文件所在 DC 或当前位置。', activeDownloads: '下载中：{{count}}', weight: '调度权重：{{value}}', cooldownUntil: '预计恢复新请求：{{time}}', rateLimitHint: 'Telegram 限流等待时间较长，此账号暂时无法接收新请求，系统会自动重试。', pendingUpdate: "等待更新", lastError: '最近错误', disabledHint: "已停用，不再分配新任务；登录信息保留。", disable: '停用', enable: '重新启用', delete: '删除账号' },
    login: { title: '添加 Telegram 用户账号', description: '支持二维码或手机号登录；手机号登录需要验证码，必要时再输入两步验证密码。登录凭证只在服务端加密保存。', closeAria: '关闭添加账号', chooseTitle: '选择登录方式', chooseDescription: "使用二维码或手机号登录。", qr: '二维码登录', qrDescription: '打开 Telegram 扫描二维码，无需输入手机号。', phone: '手机号登录', phoneDescription: '输入手机号和 Telegram 验证码，必要时再输入两步验证密码。', next: '下一步', qrInstructions: '打开 Telegram，进入“设置 → 设备 → 连接桌面设备”并扫码。', qrAria: 'Telegram 登录二维码', generatingQr: '正在生成二维码', refreshQr: '刷新二维码', usePhone: '改用手机号', back: '返回选择登录方式', phoneLabel: '手机号', phoneHint: '请包含国家或地区区号。输入内容不会在账号列表中显示。', phonePlaceholder: '例如 +86…', sendCode: '发送验证码', backQr: '返回二维码登录', codeLabel: '验证码', codeSent: '验证码已发送到 Telegram', codePlaceholder: '输入验证码', verify: '验证', passwordLabel: '两步验证密码', passwordHint: '此账号已开启 Telegram 两步验证，请输入云密码完成绑定。', passwordPlaceholder: '输入两步验证密码', signIn: '登录', completeTitle: '账号已绑定并自动启用', completeDescription: "下载任务会按账号权限、连接状态和负载分配。", done: '完成' },
    errors: { qrCreate: '二维码生成失败，请改用手机号登录', qrExpired: '二维码已过期，请刷新后重新扫码', login: '登录失败，请重试', status: '登录状态查询失败，请重试', codeSend: '验证码发送失败', codeVerify: '验证码校验失败', password: '两步验证失败', load: '账号列表加载失败', operation: '账号操作失败', operationTitle: '操作失败' },
    unlink: { message: '删除“{{name}}”后，将永久删除该账号已加密保存的登录信息，并立即停止它参与下载调度。\n\n其他 Telegram 账号和已下载文件不会受影响。', title: '删除 Telegram 账号', danger: '将永久删除此账号的登录信息，无法撤销', cancel: '保留账号', confirm: '确认删除' },
    notices: { enabled: '账号已重新启用，将在状态就绪后参与调度。', disabled: '账号已停用；已加密保存的登录信息会保留。', unlinked: '账号已删除，登录信息已删除。', bound: '账号已绑定并自动启用' },
  },
} as const;
