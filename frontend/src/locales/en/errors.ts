import { serviceErrors } from './serviceErrors';

export const errors = {
  fallback: 'Something went wrong. Please try again.', network: 'The network connection failed. Check your connection and try again.', unauthorized: 'Your session has expired. Sign in again.', forbidden: 'You do not have permission to perform this action.', notFound: 'The requested content was not found.', conflict: 'The content changed. Refresh and try again.', validation: 'The submitted information is invalid. Check it and try again.', rateLimited: 'Too many requests. Try again later.', server: 'The server is temporarily unavailable. Try again later.', uploadTooLarge: 'The file exceeds the allowed upload size.', storageUnavailable: 'The storage service is temporarily unavailable.', telegramUnavailable: 'The Telegram service is temporarily unavailable.', timeout: 'The request timed out. Try again.', diagnostic: 'Diagnostic details: {{detail}}', requestId: 'Request ID: {{requestId}}', retryAfter: 'Try again in {{duration}}.',
  services: serviceErrors,
} as const;
