export interface StorageProbeFailureSummary {
    reason: string;
    code?: string;
}

function safeErrorCode(value: unknown): string | undefined {
    const code = String(value ?? '').trim();
    return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(code) ? code : undefined;
}

export function summarizeStorageProbeFailure(error: unknown): StorageProbeFailureSummary {
    const source = error as any;
    const status = Number(source?.response?.status || source?.$metadata?.httpStatusCode || source?.statusCode || source?.status || 0);
    const code = safeErrorCode(source?.code || source?.name || source?.Code || source?.response?.data?.error?.code);
    // Raw provider text is used only for classification. It is never returned or persisted because
    // SDK errors can echo credentials, signed URLs, authorization headers, or private endpoints.
    const raw = String(source?.response?.data?.error?.message || source?.response?.data?.error_description || source?.message || '');
    const diagnostic = `${code || ''} ${raw}`;

    let reason: string;
    if (/PermanentRedirect|AuthorizationHeaderMalformed|region/i.test(diagnostic)) reason = '区域配置与存储桶不匹配';
    else if (status === 401 || /InvalidAccessKey|InvalidToken|invalid_grant|unauthorized|authentication/i.test(diagnostic)) reason = '凭据无效或已过期';
    else if (status === 403 || /AccessDenied|Forbidden|insufficient.*permission|EACCES|EPERM/i.test(diagnostic)) reason = '没有读取存储根目录或存储桶的权限';
    else if (status === 404 || /NoSuchBucket|not found|ENOENT/i.test(diagnostic)) reason = '存储桶或根目录不存在';
    else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|socket/i.test(diagnostic)) reason = '端点无法连接或 DNS 解析失败';
    else if (/timeout|timed out|AbortError/i.test(diagnostic)) reason = '连接测试超时';
    else if (status >= 500) reason = `远端存储服务暂时不可用（HTTP ${status}）`;
    else if (status > 0) reason = `连接测试返回 HTTP ${status}`;
    else if (code) reason = `连接测试返回错误 ${code}`;
    else reason = '连接测试失败，未收到可识别的错误原因';

    return { reason, code };
}
