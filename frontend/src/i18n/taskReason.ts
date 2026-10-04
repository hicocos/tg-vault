import type { TFunction } from 'i18next';

// Historical API records contain these fixed server messages rather than codes.
// Translate exact known messages only; never replace arbitrary diagnostic text.
const taskReasonKeys: ReadonlyMap<string, string> = new Map([
  ['用户手动暂停订阅', 'uiAudit.taskReasons.subscriptionPausedByUser'],
  ['Web 管理员取消任务', 'uiAudit.taskReasons.cancelledByWebAdmin'],
]);

export const localizeTaskReason = (reason: string, t: TFunction): string => {
  const key = taskReasonKeys.get(reason);
  return key ? t(key) : reason;
};
