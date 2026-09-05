import { serviceErrors } from './serviceErrors';

export const errors = {
  fallback: '操作失败，请稍后重试。', network: '网络连接失败，请检查网络后重试。', unauthorized: '登录会话已失效，请重新登录。', forbidden: '你没有执行此操作的权限。', notFound: '请求的内容不存在。', conflict: '内容已发生变化，请刷新后重试。', validation: '提交的信息无效，请检查后重试。', rateLimited: '请求过于频繁，请稍后重试。', server: '服务器暂时不可用，请稍后重试。', uploadTooLarge: '文件超过允许的上传大小。', storageUnavailable: '存储服务暂时不可用。', telegramUnavailable: 'Telegram 服务暂时不可用。', timeout: '请求超时，请稍后重试。', diagnostic: '诊断信息：{{detail}}', requestId: '请求编号：{{requestId}}', retryAfter: '{{duration}}后可重试。',
  services: serviceErrors,
} as const;
