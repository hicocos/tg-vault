import base from '../zh.json';
import { common } from './common';
import { auth } from './auth';
import { files } from './files';
import { errors } from './errors';
import { appCopy } from './app';
import { serviceErrors } from './serviceErrors';
import { management } from './management';
import { remainingPages } from './remainingPages';
import { mergeCatalogs } from '../../i18n/mergeCatalogs';

export default mergeCatalogs(base, { common, auth, files, errors: { ...errors, services: serviceErrors }, appCopy, management }, remainingPages);
