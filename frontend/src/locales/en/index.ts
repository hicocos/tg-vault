import base from '../en.json';
import { common } from './common';
import { auth } from './auth';
import { files } from './files';
import { errors } from './errors';
import { appCopy } from './app';
import { serviceErrors } from './serviceErrors';
import { management } from './management';
import { remainingPages } from './remainingPages';
import { redesign } from './redesign';
import { uiAudit } from './uiAudit';
import { botConnection } from './botConnection';
import { mergeCatalogs } from '../../i18n/mergeCatalogs';
import { storageAccount } from './storageAccount';
import { qbittorrent } from './qbittorrent';
import { storageSettings } from './storageSettings';

export default mergeCatalogs(base, { common, auth, files, errors: { ...errors, services: serviceErrors }, appCopy, management, storageAccount, storageSettings, qbittorrent }, remainingPages, redesign, uiAudit, botConnection);
