import type { BatchDeleteResult } from './batchDeleteContract';

export interface FileData {
    id: string;
    name: string;
    stored_name: string;
    type: 'image' | 'video' | 'audio' | 'document' | 'other';
    mime_type: string;
    size: string;
    date: string;
    thumbnailUrl?: string;
    previewUrl: string;
    width?: number;
    height?: number;
    source?: string;
    folder?: string;
    created_at: string;
    is_favorite?: boolean;
}

export interface MediaStatus {
    available: boolean;
    source?: string;
    code?: 'MEDIA_SOURCE_MISSING' | 'MEDIA_QUOTA_EXCEEDED' | 'MEDIA_RATE_LIMITED' | 'MEDIA_UPSTREAM_UNAVAILABLE' | 'FILE_NOT_FOUND';
    error?: string;
    reason?: 'not_found' | 'trashed';
}

export interface StorageCapabilities {
    share: boolean;
    sharePassword: boolean;
    shareExpiration: boolean;
    quota: boolean;
    userDelete: boolean;
}

export interface StorageStats {
    provider: string;
    accountId: string | null;
    capabilities: StorageCapabilities;
    temporary: { totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number };
    indexed: { usedBytes: number; fileCount: number };
    remoteQuota: { totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number } | null;
    health: { probeStatus: 'available' | 'failed' | null; lastProbedAt: string | null; cooldownUntil: string | null; cooldownReason: string | null };
    server: {
        total: string;
        totalBytes: number;
        used: string;
        usedBytes: number;
        free: string;
        freeBytes: number;
        usedPercent: number;
    };
    tgvault: {
        used: string;
        usedBytes: number;
        fileCount: number;
        usedPercent?: number;
    };
}

export interface UploadProgress {
    loaded: number;
    total: number;
    percent: number;
}

export interface UploadCapabilities {
    acceptsAnyFile: boolean;
    simpleUploadThresholdBytes: number;
    simpleUploadMaxBytes: number;
    chunkBytes: number;
    maxChunkUploadBytes: number;
    globalSessionBudgetBytes: number;
    maxChunks: number;
    sessionTtlMs: number;
}

export interface UploadTargetSnapshot {
    provider: string;
    accountId: string | null;
    accountName?: string | null;
    folder?: string | null;
}

export interface ChunkUploadSession {
    uploadId: string;
    filename: string;
    mimeType: string;
    folder: string | null;
    status: 'open' | 'completing' | 'failed';
    totalChunks: number;
    uploadedChunks: number[];
    uploadedChunkHashes: Record<number, string>;
    receivedBytes: number;
    totalSize: number;
    progress: number;
    maxChunkBytes: number;
    targetProvider: string;
    targetAccountId: string | null;
    targetAccountName?: string | null;
    expiresAt: string;
    error?: string | null;
}

export type ChunkUploadCancelStatus = 'cancelled' | 'busy' | 'terminal' | 'not_found';

export type UnifiedTaskSource = 'telegram_bot' | 'telegram_channel' | 'ytdlp' | 'web_upload' | 'subscription' | 'telegram_target';

export interface UnifiedTask {
    id: string;
    sourceType: UnifiedTaskSource;
    kind: string;
    title: string;
    status: string;
    stage: string;
    progress: number;
    ownerUserId: number | null;
    chatId: string | null;
    source: string | null;
    target: {
        provider: string | null;
        accountId: string | null;
        accountName: string | null;
        folder: string | null;
    };
    counts: { total: number; completed: number; failed: number };
    bytes: { total: number; transferred: number };
    detail: Record<string, unknown>;
    error: string | null;
    retryable: boolean;
    cancellable: boolean;
    dismissible: boolean;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
}

export interface UnifiedTaskList {
    tasks: UnifiedTask[];
    total: number;
    returned: number;
    generatedAt: string;
}

export type TelegramAdFilterMode = 'off' | 'conservative' | 'aggressive';
export type TelegramAdRuleKind = 'keyword' | 'domain' | 'username' | 'template' | 'media';
export type TelegramAdRuleAction = 'allow' | 'block';

export interface TelegramSubscription {
    id: string;
    source: string;
    source_original: string | null;
    source_type: string;
    title: string | null;
    last_message_id: number;
    folder_override: string | null;
    enabled: boolean;
    disabled_reason: string | null;
    last_scan_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    next_scan_at: string | null;
    ad_filter_mode: TelegramAdFilterMode;
    ad_stats: { blocked_count: number; review_count: number; reviewed_count: number };
    created_at: string;
    updated_at: string;
}

export interface TelegramSubscriptionList {
    subscriptions: TelegramSubscription[];
    total: number;
    limit: number;
    offset: number;
    summary: { enabled: number; protected: number; blocked: number; review: number };
}

export interface TelegramAdRule {
    id: string;
    subscription_id: string;
    kind: TelegramAdRuleKind;
    action: TelegramAdRuleAction;
    pattern: string;
    label: string | null;
    enabled: boolean;
    created_at: string;
    updated_at: string;
}

export interface TelegramAdReason {
    code: string;
    label: string;
    score: number;
    ruleId?: string;
}

export interface TelegramAdDecision {
    id: string;
    subscription_id: string;
    subscription_title: string | null;
    subscription_source: string;
    source_peer: string;
    message_id: number;
    message_ids: number[];
    grouped_id: string | null;
    decision: 'allow' | 'review' | 'blocked';
    score: number;
    reasons: TelegramAdReason[];
    text_excerpt: string | null;
    domains: string[];
    usernames: string[];
    manual_label: 'ad' | 'normal' | null;
    manually_reviewed_at: string | null;
    created_at: string;
}

export interface TelegramAdDecisionList {
    decisions: TelegramAdDecision[];
    total: number;
    limit: number;
    offset: number;
}

export interface CreateYtDlpTaskResult {
    success: true;
    task: UnifiedTask;
}

export interface TaskFilters {
    source?: string;
    status?: string;
    accountId?: string;
    limit?: number;
}

export interface TaskDismissalInput {
    tasks?: Array<{ sourceType: UnifiedTaskSource; id: string }>;
    source?: string;
    status?: string;
    accountId?: string;
}

export interface TaskDismissalPreview {
    confirmationToken: string;
    snapshotId: string;
    context: string;
    expiresAt: number;
    impact: {
        count: number;
        bySource: Record<string, number>;
        byStatus: Record<string, number>;
        filesDeleted: false;
        cloudObjectsDeleted: false;
        subscriptionsDeleted: false;
    };
}

export interface TaskDismissalResult {
    status: 'complete' | 'partial';
    dismissed: Array<{ sourceType: UnifiedTaskSource; id: string }>;
    failed: Array<{ sourceType: UnifiedTaskSource; id: string; reason: string }>;
    filesDeleted: false;
    cloudObjectsDeleted: false;
}

export interface StorageAccount {
    id: string;
    name: string;
    type: string;
    is_active: boolean;
    capabilities: StorageCapabilities;
    last_probe_status: 'available' | 'failed' | null;
    last_probe_error: string | null;
    last_probed_at: string | null;
}

export interface TelegramBotPublicConfig {
    configured: boolean;
    enabled: boolean;
    required: boolean;
    pinConfigured: boolean;
    source: 'web' | 'environment' | 'none';
    status: string;
    bot: { username: string | null; displayName: string | null } | null;
    lastConnectedAt: string | null;
    lastError: string | null;
    action: string | null;
}

export interface UpdateStatus {
    enabled: boolean;
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    releaseName: string | null;
    releaseUrl: string | null;
    publishedAt: string | null;
    checkedAt: string | null;
    stale: boolean;
    error: string | null;
}

export interface TelegramUserAccountStatus {
    configured: boolean;
    enabled: boolean;
    connected: boolean;
    account: { userId: string; username: string | null; displayName: string | null } | null;
}

export interface TelegramUserLoginComplete {
    step: 'complete';
    account: NonNullable<TelegramUserAccountStatus['account']>;
}

export type TelegramUserAccountHealth = 'ready' | 'connecting' | 'disabled' | 'cooldown' | 'expired' | 'permission_denied' | 'error';
export type TelegramSourcePermissionState = 'allowed' | 'denied' | 'unknown';

export interface TelegramPermissionSummary {
    allowed: number;
    denied: number;
    unknown: number;
    total: number;
    lastCheckedAt: string | null;
}

export interface TelegramSourcePermission {
    sourceId: string;
    sourceName: string | null;
    status: TelegramSourcePermissionState;
    checkedAt: string | null;
    reason: string | null;
}

export interface TelegramUserAccount {
    id: string;
    userId: string;
    username: string | null;
    displayName: string | null;
    enabled: boolean;
    connected: boolean;
    health: TelegramUserAccountHealth;
    checkedAt: string | null;
    lastError: string | null;
    cooldownUntil: string | null;
    permissionSummary: TelegramPermissionSummary;
    permissions?: TelegramSourcePermission[];
    scheduling: {
        weight: number;
        activeDownloads: number;
        lastSelectedAt: string | null;
    };
}

export interface TelegramUserAccountsOverview {
    accounts: TelegramUserAccount[];
    summary: {
        total: number;
        enabled: number;
        ready: number;
        coolingDown: number;
        permissions: TelegramPermissionSummary;
    };
    scheduling: {
        strategy: 'weighted_least_connections';
        description: string;
    };
    accessSweep?: TelegramAccessSweepSummary;
}

export type TelegramUserLoginState = 'pending' | 'waiting_for_scan' | 'code_required' | 'password_required' | 'complete' | 'expired' | 'cancelled' | 'error';

export interface TelegramUserLoginAccount {
    userId: string;
    username: string | null;
    displayName: string | null;
}

export interface TelegramUserLoginStatus {
    flowId: string;
    status: TelegramUserLoginState;
    qrCode?: string;
    qrExpiresAt?: string;
    expiresAt?: string;
    account?: TelegramUserLoginAccount;
    message?: string;
}

export interface TelegramUserQrLoginStarted extends TelegramUserLoginStatus {
    status: 'waiting_for_scan';
    qrCode: string;
    qrExpiresAt: string;
}

export interface TelegramUserPhoneLoginStarted extends TelegramUserLoginStatus {
    status: 'code_required';
    delivery: 'app' | 'sms';
}

export interface TelegramAccessSweepSummary {
    runId: string | null;
    status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
    startedAt: string | null;
    completedAt: string | null;
    counts: { accounts: number; sources: number; probes: number; allowed: number; denied: number; error: number };
    lastError: string | null;
}

export interface TelegramPermissionCheckResult {
    success: boolean;
    summary: TelegramAccessSweepSummary;
}

export interface StorageConfig {
    provider: string;
    activeAccountId: string | null;
    activeAccountName?: string;
    capabilities: StorageCapabilities;
    accounts: StorageAccount[];
    redirectUri: string;
    googleDriveRedirectUri: string;
    telegramUserDownloadEnabled?: boolean;
    telegramUserSessionReady?: boolean;
    telegramUserClientStatus?: { status: string; userId: string | null; username: string | null; checkedAt: string | null; lastError: string | null; action: string | null };
    telegramAllowedUserIds?: number[];
    telegramAllowedUserIdsFromEnv?: boolean;
    allowUnsafeWebdavEndpoints: boolean;
}

export interface FolderMovePreview {
    sourcePath: string;
    destinationParent: string | null;
    finalPath: string;
    fileCount: number;
    folderCount: number;
    totalSizeBytes: number;
    conflict: boolean;
    conflictReason?: string;
    noChange: boolean;
}

export interface FilesPage {
    files: FileData[];
    nextCursor: string | null;
    hasMore: boolean;
}

export interface FileQueryOptions {
    cursor?: string | null;
    limit?: number;
    q?: string;
    type?: 'image' | 'video' | 'audio' | 'document' | 'other' | 'media';
    folder?: string | null;
    favorite?: boolean;
    sort?: 'name' | 'date';
    direction?: 'asc' | 'desc';
    signal?: AbortSignal;
}

export interface FolderAggregation {
    name: string;
    fileCount: number;
    totalSizeBytes: number;
    latestDate: string;
    isFavorite: boolean;
    coverFile: FileData | null;
}

export interface BatchDeletePreview {
    confirmationToken: string;
    fileCount: number;
    dataFileCount: number;
    placeholderCount: number;
    folderCount: number;
    totalSizeBytes: number;
    expiresAt: string;
}

export type { BatchDeleteResult };

export interface AdvancedTaskSettings {
    telegramDownloadWorkers: number;
    telegramFileConcurrency: number;
    duplicateMode: 'copy' | 'skip';
    autoCleanupOrphans: boolean;
    skipTelegramPhotosInBatch: boolean;
    telegramDownloadHistoryPolicy: 'errors_only' | 'all';
    highRisk: { telegramDownloadWorkers: boolean; telegramFileConcurrency: boolean };
}

export interface StorageDeleteImpact {
    accountId: string;
    accountName: string;
    provider: string;
    fileCount: number;
    totalSizeBytes: number;
    folderCount: number;
    activeLeaseCount: number;
    activeTaskCount: number;
    activeUploadCount: number;
    remoteObjectsDeleted: false;
}

export interface OAuthStartResult {
    authUrl: string;
    flowNonce: string;
    frontendOrigin: string;
    expiresAt: string;
}
