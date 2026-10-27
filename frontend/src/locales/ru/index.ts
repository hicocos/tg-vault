import ru from '../ru.json';
import { redesign } from './redesign';
import { uiAudit } from './uiAudit';
import { botConnection } from './botConnection';
import { mergeCatalogs } from '../../i18n/mergeCatalogs';
import { storageAccount } from './storageAccount';
import { qbittorrent } from './qbittorrent';
import { storageSettings } from './storageSettings';
export default mergeCatalogs(ru, redesign, uiAudit, botConnection, { storageAccount, storageSettings, qbittorrent });
