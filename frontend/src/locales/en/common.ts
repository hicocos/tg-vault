export const common = {
  language: { label: 'Language', select: 'Select language' },
  status: { loading: 'Loading…', saving: 'Saving…', success: 'Success', failed: 'Failed', cancelled: 'Cancelled' },
  actions: { cancel: 'Cancel', confirm: 'Confirm', close: 'Close', save: 'Save', delete: 'Delete', retry: 'Retry', refresh: 'Refresh', loadMore: 'Load more' },
  navigation: { previous: 'Previous', next: 'Next', root: 'Root directory' },
  units: { byte: 'byte', item_one: '{{count}} item', item_other: '{{count}} items' },
} as const;
