import assert from 'node:assert/strict';
import test from 'node:test';
import { MAINTENANCE_ACTIONS, maintenanceImpact } from './maintenanceActions.js';

test('maintenance actions name distinct affected objects and never imply cloud deletion', () => {
    assert.deepEqual(MAINTENANCE_ACTIONS.DELETE_TASK_HISTORY.affectedObjectTypes, ['task_history']);
    assert.deepEqual(MAINTENANCE_ACTIONS.AUTO_DELETE_UNINDEXED_TEMP_FILES.affectedObjectTypes, ['local_physical_file']);
    assert.deepEqual(MAINTENANCE_ACTIONS.DELETE_LOCAL_PHYSICAL_FILES.affectedObjectTypes, ['file_index', 'local_physical_file']);
    for (const action of Object.values(MAINTENANCE_ACTIONS)) assert.equal(action.impact.cloud_physical_file, false);
    assert.equal(maintenanceImpact('DELETE_TASK_HISTORY', 7).dryRunCount, 7);
});
