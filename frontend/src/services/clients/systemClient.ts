import type { UpdateStatus } from '../apiTypes';
import { apiRequest } from '../httpClient';
import { tr } from '../../i18n/runtime';
import { getApiHeaders } from './clientHeaders';

export class SystemClient {
    async getUpdateStatus(): Promise<UpdateStatus> {
        const response = await apiRequest('/api/system/update-status', {
            credentials: 'include',
            cache: 'no-store',
            headers: getApiHeaders(),
        });
        if (!response.ok) throw new Error(tr('errors.services.system.getVersionFailed'));
        return response.json();
    }

    async checkForUpdates(): Promise<UpdateStatus> {
        const response = await apiRequest('/api/system/update-check', {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: getApiHeaders(),
        });
        if (response.status === 429) throw new Error(tr('errors.services.system.updateCheckRateLimited'));
        if (!response.ok) throw new Error(tr('errors.services.system.checkVersionFailed'));
        return response.json();
    }

    async healthCheck(): Promise<{ status: string; timestamp: string }> {
        const response = await apiRequest('/health');
        if (!response.ok) throw new Error(tr('errors.services.system.healthCheckFailed'));
        return response.json();
    }
}

export const systemClient = new SystemClient();
