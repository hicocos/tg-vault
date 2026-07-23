export type MaintenanceActionCode = 'DELETE_TASK_HISTORY' | 'AUTO_DELETE_UNINDEXED_TEMP_FILES' | 'DELETE_LOCAL_PHYSICAL_FILES';
export type AffectedObjectType = 'task_history' | 'file_index' | 'local_physical_file' | 'cloud_physical_file';

export interface MaintenanceActionContract {
    actionCode: MaintenanceActionCode;
    label: string;
    affectedObjectTypes: AffectedObjectType[];
    impact: Record<AffectedObjectType, boolean>;
}

function contract(actionCode: MaintenanceActionCode, label: string, affected: AffectedObjectType[]): MaintenanceActionContract {
    return {
        actionCode,
        label,
        affectedObjectTypes: affected,
        impact: {
            task_history: affected.includes('task_history'),
            file_index: affected.includes('file_index'),
            local_physical_file: affected.includes('local_physical_file'),
            cloud_physical_file: affected.includes('cloud_physical_file'),
        },
    };
}

export const MAINTENANCE_ACTIONS: Record<MaintenanceActionCode, MaintenanceActionContract> = {
    DELETE_TASK_HISTORY: contract('DELETE_TASK_HISTORY', '删除任务历史', ['task_history']),
    AUTO_DELETE_UNINDEXED_TEMP_FILES: contract('AUTO_DELETE_UNINDEXED_TEMP_FILES', '自动清理未索引临时文件', ['local_physical_file']),
    DELETE_LOCAL_PHYSICAL_FILES: contract('DELETE_LOCAL_PHYSICAL_FILES', '删除本地实体文件', ['file_index', 'local_physical_file']),
};

export function maintenanceImpact(actionCode: MaintenanceActionCode, dryRunCount: number) {
    return { ...MAINTENANCE_ACTIONS[actionCode], dryRunCount };
}
