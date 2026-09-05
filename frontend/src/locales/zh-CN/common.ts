export const common = {
  language: { label: '语言', select: '选择语言' },
  status: { loading: '正在加载…', saving: '正在保存…', success: '成功', failed: '失败', cancelled: '已取消' },
  actions: { cancel: '取消', confirm: '确认', close: '关闭', save: '保存', delete: '删除', retry: '重试', refresh: '刷新', loadMore: '加载更多' },
  navigation: { previous: '上一页', next: '下一页', root: '根目录' },
  units: { byte: '字节', item_one: '{{count}} 项', item_other: '{{count}} 项' },
} as const;
