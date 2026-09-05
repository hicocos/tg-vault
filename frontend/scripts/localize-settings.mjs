import fs from 'node:fs';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const settingsPath = new URL('src/components/pages/SettingsPage.tsx', root);
const zhPath = new URL('src/locales/zh-CN/remainingPages.ts', root);
const enPath = new URL('src/locales/en/remainingPages.ts', root);
const source = fs.readFileSync(settingsPath, 'utf8');
const file = ts.createSourceFile('SettingsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function readCopy(path) {
  const text = fs.readFileSync(path, 'utf8');
  const body = text.match(/"copy": \{([\s\S]*?)\n      \}/)?.[1];
  if (!body) throw new Error(`copy catalog not found: ${path}`);
  const values = {};
  for (const match of body.matchAll(/"(\d{3})":\s*("(?:[^"\\]|\\.)*")/g)) values[match[1]] = JSON.parse(match[2]);
  return values;
}

const zh = readCopy(zhPath);
const en = readCopy(enPath);
const normalized = value => value.replace(/\\n/g, '\n').replace(/\r?\n/g, '\n');
const jsxKeys = new Map();
const expressionKeys = new Map();
for (const [key, value] of Object.entries(zh)) {
  const target = Number(key) <= 123 ? jsxKeys : expressionKeys;
  if (!target.has(normalized(value))) target.set(normalized(value), key);
}

const english = {
  '129': 'This feature is usually unnecessary. Use it only when a channel posts both a regular photo and an original image file and you only want the original file.\n\nWhen enabled, subscription, date-range, and tag downloads skip every regular channel photo and download only images sent as files and other files. Channels that post only regular photos will be missed. Enable it?',
  '130': 'This concurrency level may trigger Telegram rate limits, interrupted transfers, or account restrictions. Continue?',
  '131': 'Confirm skipping regular channel photos', '132': 'Confirm high concurrency',
  '133': 'Changed to keep errors only; removed {{value1}} completed successful or skipped details.', '134': 'Changed to keep all details. Full download history will be recorded from now on.',
  '135': 'Delete completed Telegram download task history older than {{value1}} days?\n\nThis deletes only task audit details, not file indexes or cloud files.', '136': 'Delete task history', '137': 'Deleted {{value1}} completed download task history entries.', '138': 'Could not delete download task history',
  '140': 'Enter {{value1}}', '142': 'The new Telegram Bot PIN must be exactly four digits', '144': 'The new PIN entries do not match', '146': 'Telegram Bot PIN changed', '147': 'Could not change the Telegram Bot PIN',
  '150': 'Telegram Bot credential test failed', '152': 'The Telegram Bot PIN must be exactly four digits', '154': 'Telegram Bot credentials saved securely and enabled', '155': 'Could not save the Telegram Bot configuration',
  '157': 'Create an exact four-digit Telegram Bot PIN before migrating', '158': 'PIN required', '159': 'Read the Telegram Bot credentials from backend environment variables, encrypt and save them in the database, and switch to Web management? The browser will not receive the original credentials.', '160': 'Migrate Telegram Bot configuration', '161': 'Migrated to encrypted Web management. After confirming it works, you can remove the old credentials from .env.', '162': 'Migration failed', '163': 'Migration failed',
  '164': 'Deleting the configuration stops the Bot immediately and permanently deletes the saved Bot Token, API ID, API Hash, and Bot session.\n\nThe Telegram allowlist is retained. To use the Bot again, you must enter all credentials and establish a new connection. This cannot be undone.', '165': 'Confirm deleting the Telegram Bot configuration', '166': 'Credentials and the Bot session will be permanently deleted', '167': 'Cancel deletion', '168': 'Delete permanently', '169': 'Telegram Bot configuration deleted',
  '172': 'Telegram user allowlist saved', '173': 'Could not update the Telegram user allowlist', '175': 'Could not check for updates', '177': 'Connection test succeeded', '178': 'Connection test failed. Try again later.',
  '179': 'Local storage', '180': 'Alibaba Cloud OSS', '181': 'S3-compatible storage', '182': 'WebDAV storage', '183': 'Native OpenList storage',
  '184': 'Switch the system default storage to {{value1}}{{value2}}?\n\nThis affects new tasks submitted by all users. Existing upload, Telegram, tasks keep their original destination. A read-only connection test runs before switching.', '185': 'Switch system default storage', '186': 'Switched to {{value1}}', '187': 'Switched to {{value1}}, but storage statistics could not be refreshed. Refresh them manually later.', '189': 'Switch completed',
  '202': 'Enter the Client ID and Client Secret', '204': 'The browser blocked the authorization window. Allow pop-ups and try again.', '205': 'The authorization callback did not include the new account ID', '206': 'Google Drive authorization was cancelled. Your form entries were retained.', '207': 'Authorization cancelled', '208': 'Google Drive authorization failed: {{value1}}', '210': 'Google Drive authorized and enabled', '211': 'Google Drive was authorized and enabled, but storage statistics could not be refreshed. Refresh them manually later.', '213': 'Authorization completed', '214': 'Could not start authorization: ',
  '216': 'Account: {{value1}}', '217': 'TG Vault indexes to delete: {{value1}}', '218': 'Indexed size: {{value1}} MiB', '219': 'Folders affected: {{value1}}', '220': 'Active leases/tasks/uploads: {{value1}}/{{value2}}/{{value3}}', '221': 'Original cloud files will not be deleted. The server rechecks active leases and tasks when the operation runs.', '222': 'Active references exist, so the server will block this operation. End the related tasks first.', '223': 'Cancel the corresponding task in Task Center. Fixed targets such as channel subscriptions show their account references there.', '224': 'Account is still in use', '225': 'Delete storage account', '226': '{{value1}}; however, storage statistics could not be refreshed. Refresh them manually later.', '228': 'Deletion completed',
  '230': 'Enter the Client ID', '232': 'The browser blocked the authorization window. Allow pop-ups and try again.', '233': 'The authorization callback did not include the new account ID', '234': 'OneDrive authorization was cancelled. Your form entries were retained.', '235': 'Authorization cancelled', '236': 'OneDrive authorization failed: {{value1}}', '238': 'OneDrive authorized and enabled', '239': 'OneDrive was authorized and enabled, but storage statistics could not be refreshed. Refresh them manually later.', '241': 'Authorization completed', '242': 'Could not start authorization: ',
  '244': 'Complete all required fields', '246': 'Alibaba Cloud OSS account added', '247': 'Could not add the Alibaba Cloud OSS account: ', '248': 'Could not add account', '249': 'Complete all required fields', '251': 'S3-compatible storage account added', '252': 'Could not add the S3-compatible storage account: ', '253': 'Could not add account', '254': 'Enter an account name and URL', '256': 'WebDAV storage account added', '257': 'Could not add the WebDAV storage account: ', '258': 'Could not add account',
  '319': 'Connected', '320': 'Configured', '321': 'Not configured', '322': 'Cancel PIN change', '323': 'Cancel PIN setup', '324': 'Change Bot PIN', '325': 'Set Bot PIN', '326': 'Cancel replacement', '327': 'Replace credentials', '328': 'Cancel PIN change', '329': 'Cancel PIN setup', '330': 'Change Bot PIN', '331': 'Set Bot PIN',
  '333': 'Get from @BotFather', '334': 'Get from my.telegram.org', '335': '32-character API Hash', '337': 'Working...', '338': 'Save and enable', '339': 'Change Telegram Bot PIN', '340': 'Set Telegram Bot PIN', '341': 'Verify with the current PIN or the Web administrator password. After the change, every authenticated Telegram user must verify again with the new PIN.', '342': 'When no PIN is configured, verify with the Web administrator password. After setup, Telegram users can use this four-digit PIN for initial verification.', '345': 'Four digits', '346': 'Enter the four digits again', '347': 'Working...', '348': 'Confirm PIN change', '349': 'Confirm PIN setup', '350': 'For example: 123456789, 987654321', '351': ' TELEGRAM_ALLOWED_USER_IDS is set on the backend. Edit .env and restart the backend.', '352': 'Saving...', '353': 'Save allowlist', '354': 'Could not update Telegram download settings', '356': 'Disable account-based downloads', '357': 'Enable account-based downloads',
  '358': 'Local storage', '359': 'Files are stored on the server’s local disk. This is the fastest option and suits typical use.', '360': 'In use', '361': 'Cancel adding', '362': 'Add account', '363': 'Unnamed account', '364': 'For example: My Google Drive', '365': 'For example: 0Axxxxxxxxxxxxxxxxx', '366': 'Starting...', '367': 'Save and authorize', '368': 'Cancel adding', '369': 'Add account', '370': 'Unnamed account', '371': 'Defaults to common', '372': 'Custom display name, for example: Personal Drive', '373': 'Optional in public-client mode', '374': 'Starting...', '375': 'Save and authorize', '376': 'Cancel adding', '377': 'Add account', '378': 'Unnamed account', '379': 'For example: Backup OSS', '380': 'Saving...', '381': 'Save account', '382': 'Cancel adding', '383': 'Add account', '384': 'Unnamed account', '385': 'For example: My MinIO storage', '386': 'Saving...', '387': 'Save account', '388': 'Cancel adding', '389': 'Add account', '390': 'Unnamed account', '391': 'For example: My WebDAV', '392': 'WebDAV username', '393': 'WebDAV password', '394': 'Saving...', '395': 'Save account',
  '021': 'Bot credentials and connection', '022': 'Environment variable compatibility', '023': 'Encrypted Web management', '024': 'Only the status is shown after setup. Bot Token, API ID, and API Hash are never displayed.', '025': 'Credentials saved securely', '026': 'Migrate to Web management', '027': 'Delete configuration', '028': 'Telegram Bot PIN is not set. Set a four-digit PIN for initial Telegram user verification.', '029': 'Telegram Bot PIN (four digits)', '030': 'Create an exact four-digit PIN before migrating environment-variable credentials.', '031': 'Telegram Bot PIN is set and will not change when credentials are replaced.', '032': 'Telegram Bot PIN (four digits)', '033': 'The PIN is created only during initial setup and must be exactly four digits.', '035': 'Safe test', '036': 'The safe test validates the Token only through the Telegram HTTPS Bot API. It does not create another MTProto login or connect the account-based downloader.', '037': 'Verification method', '038': 'Current PIN', '039': 'Web administrator password', '040': 'New PIN', '041': 'Confirm new PIN', '043': 'Telegram users allowed to use the Bot', '044': 'Managed by environment variable', '045': 'Not configured', '046': 'Account-based downloader', '047': 'Disabled', '048': 'Enabled', '049': 'Session not ready', '050': 'When enabled, downloads are assigned among enabled Telegram user accounts based on permissions, health, and load.',
  '051': 'Google Drive accounts', '052': 'Manage and switch between Google Drive accounts', '054': 'No Google Drive account configured', '055': 'Google Drive API credentials', '056': 'create', '057': 'OAuth 2.0 client ID', '058': 'Web application', '059': ', then add the following ', '060': 'authorized redirect URI', '061': 'Account name (display name)', '062': 'Client ID', '063': 'Client Secret', '064': 'Shared Drive ID (optional)', '065': 'Start authorization', '066': 'Open Google to complete authorization.',
  '068': 'Microsoft OneDrive accounts', '069': 'Manage and switch between OneDrive accounts', '071': 'No OneDrive account configured', '072': 'Entra ID (Azure) application details', '073': 'Microsoft Entra ID portal', '074': 'redirect URI', '075': 'select ', '076': 'Value', '077': '; do not copy “Secret ID.” Copying the wrong field causes Microsoft to return ', '078': 'Application (client) ID', '079': 'Tenant ID', '080': 'Account name (optional)', '081': 'Client Secret (optional)', '082': 'Authorize a new account', '083': 'Open Microsoft to complete authorization. The system detects and adds the account automatically.',
  '085': 'Alibaba Cloud OSS accounts', '086': 'Manage and switch between Alibaba Cloud OSS storage sources', '088': 'No Alibaba Cloud OSS account configured', '089': 'Alibaba Cloud OSS credentials', '090': 'Account display name', '091': 'Region', '092': 'Bucket', '093': 'Save configuration', '094': 'The system tests the OSS account connection after saving.', '096': 'S3-compatible storage accounts', '097': 'Manage and switch between S3-compatible sources such as MinIO, Cloudflare R2, and AWS S3', '099': 'No S3-compatible storage account configured', '100': 'S3-compatible storage credentials', '101': 'Account display name', '102': 'Endpoint', '103': 'Region', '104': 'Bucket', '105': 'Save configuration', '106': 'The system tests the S3 account connection after saving.', '108': 'WebDAV storage accounts', '109': 'Manage and switch between WebDAV sources such as Nutstore, InfiniCLOUD, and Synology', '111': 'No WebDAV account configured', '112': 'WebDAV credentials', '113': 'Account display name', '114': 'Server URL', '115': 'Username (optional)', '116': 'Password / app password (optional)', '117': 'Save configuration', '118': 'The system tests the WebDAV account connection after saving.', '120': 'Server storage', '121': 'Available space', '122': 'TG Vault storage',
};

for (const [key, value] of Object.entries(english)) en[key] = value;

const extra = new Map([
  ['连接成功{{value1}}', ['connectionSuccess', 'Connection successful{{value1}}']],
  ['关闭提示', ['closeNotice', 'Close notification']], ['此操作不可撤销，请谨慎确认', ['irreversible', 'This action cannot be undone. Confirm carefully.']], ['关闭确认弹窗', ['closeDialog', 'Close confirmation dialog']], ['（指定账户）', ['specifiedAccount', ' (selected account)']], ['未知错误', ['unknownError', 'Unknown error']], ['最近连接：', ['lastConnected', 'Last connected: ']], ['最近错误：', ['lastError', 'Last error: ']], ['迁移前创建 PIN', ['createPinBeforeMigration', 'Create a PIN before migration']], ['用于 Bot 首次身份验证', ['pinInitialVerification', 'For initial Bot verification']], ['输入当前 4 位 PIN', ['enterCurrentPin', 'Enter the current four-digit PIN']], ['输入网页管理员密码', ['enterWebPassword', 'Enter the Web administrator password']], ['个', ['countSuffix', '']], ['输入允许通过 Telegram Bot PIN 登录的 user id，多个用英文逗号、空格或换行分隔。空列表会拒绝所有用户；首次无人认证时，首个正确输入 PIN 的用户会自动加入。', ['allowlistDescription', 'Enter the user IDs allowed to sign in with the Telegram Bot PIN, separated by commas, spaces, or line breaks. An empty list rejects everyone. If nobody has authenticated yet, the first user to enter the correct PIN is added automatically.']], ['获取 user id：让用户在 Telegram 私聊', ['getUserIdPrefix', 'To get a user ID, ask the user to message ']], ['查看 Id。', ['getUserIdSuffix', ' on Telegram.']], ['首次配置？请参阅', ['guidePrefix', 'First time configuring storage? Read the ']], ['存储源配置指南', ['guideLink', 'storage source setup guide']], ['查看详细教程。', ['guideSuffix', ' for detailed instructions.']], ['切换使用', ['switchUse', 'Use this storage']], ['切换到此账户', ['switchAccount', 'Switch to this account']], ['立即添加', ['addNow', 'Add now']], ['前往', ['goTo', 'Go to ']], ['。 应用类型选择', ['googleAppTypePrefix', '. Select ']], ['留空则使用“我的云端硬盘”。如需上传到共享云端硬盘，请填写 URL 中', ['sharedDriveHintPrefix', 'Leave blank to use “My Drive.” To upload to a Shared Drive, enter the Shared Drive ID after ']], ['后面的共享盘 ID；授权账号必须已加入该共享盘并具备创建文件权限。', ['sharedDriveHintSuffix', ' in its URL. The authorized account must be a member with permission to create files.']], ['并登录。授权账号可与最终存储账号不同。 注册应用时，', ['entraGuideMiddle', ' and sign in. The authorizing account can differ from the storage account. When registering the app, set the ']], ['，并填写：', ['andEnter', ' and enter:']], ['如果填写客户端密码，请复制 Azure「证书和密码」里新建密码后的', ['azureSecretPrefix', 'If you use a client secret, copy the ']], ['请提供您的阿里云 OSS 访问凭证。建议使用具有最小权限的 RAM 用户。', ['ossCredentialsHint', 'Enter your Alibaba Cloud OSS credentials. Use a RAM user with the minimum required permissions.']], ['支持 MinIO, Cloudflare R2, AWS S3 等。请确保已开启跨域访问 (CORS)。', ['s3CredentialsHint', 'Supports MinIO, Cloudflare R2, AWS S3, and compatible services. Make sure cross-origin access (CORS) is enabled.']], ['强制路径风格 (Force Path Style) - MinIO 或私有化部署建议勾选', ['forcePathStyle', 'Force path style (recommended for MinIO and self-hosted services)']], ['请提供您的 WebDAV 服务器地址及登录凭证。', ['webdavCredentialsHint', 'Enter the WebDAV server address and login credentials.']], ['本地存储 (Local)', ['localTitle', 'Local storage']], ['文件存储在服务器本地磁盘。适合常规使用，速度最快。', ['localDescription', 'Files are stored on the server’s local disk. This is the fastest option and suits typical use.']], ['正在使用', ['inUse', 'In use']], ['未命名账户', ['unnamedAccount', 'Unnamed account']], ['取消添加', ['cancelAdd', 'Cancel adding']], ['添加新账户', ['addAccount', 'Add account']], ['关闭', ['close', 'Close']], ['账户显示名称', ['accountDisplayName', 'Account display name']], ['区域 (Region)', ['region', 'Region']], ['存储空间 (Bucket)', ['bucket', 'Bucket']], ['保存配置', ['saveConfiguration', 'Save configuration']], ['正在保存...', ['saving', 'Saving...']], ['保存账户', ['saveAccount', 'Save account']]
]);

function exactKey(text, jsx = false) {
  const value = normalized(text);
  const preferred = jsx ? jsxKeys : expressionKeys;
  const fallback = jsx ? expressionKeys : jsxKeys;
  return preferred.get(value) || fallback.get(value);
}

const edits = [];
const used = new Map();
function keyFor(text, jsx = false) {
  const found = exactKey(text, jsx);
  if (found) { used.set(found, { zh: zh[found], en: en[found] }); return `settings.remaining.copy.${found}`; }
  const item = extra.get(normalized(text));
  if (!item) throw new Error(`No translation for ${JSON.stringify(text)}`);
  used.set(`shared.${item[0]}`, { zh: text, en: item[1] });
  return `settings.remaining.shared.${item[0]}`;
}
function templateTranslation(node) {
  let text = node.head.text;
  const values = [];
  node.templateSpans.forEach((span, index) => {
    values.push(span.expression.getText(file));
    text += `{{value${index + 1}}}${span.literal.text}`;
  });
  const key = keyFor(text);
  const options = values.map((value, index) => `value${index + 1}: ${value}`).join(', ');
  return `t('${key}', { ${options} })`;
}
function eligibleString(node) {
  if (!ts.isStringLiteral(node) || !/[\u3400-\u9fff]/u.test(node.text)) return false;
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isPropertyAccessExpression(parent)) return false;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return false;
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText(file);
    if (callee === 't' || /^console\.(?:log|info|debug|warn|error)$/.test(callee)) return false;
  }
  return true;
}
function visit(node) {
  if (ts.isJsxText(node) && /[\u3400-\u9fff]/u.test(node.text.trim())) {
    const text = node.text.trim().replace(/\s+/g, ' ');
    const key = keyFor(text, true);
    edits.push({ start: node.getStart(file), end: node.getEnd(), text: `{t('${key}')}` });
    return;
  }
  if (ts.isTemplateExpression(node) && /[\u3400-\u9fff]/u.test(node.head.text + node.templateSpans.map(span => span.literal.text).join(''))) {
    edits.push({ start: node.getStart(file), end: node.getEnd(), text: templateTranslation(node) });
    return;
  }
  if (eligibleString(node)) {
    const key = keyFor(node.text);
    const replacement = `t('${key}')`;
    edits.push({ start: node.getStart(file), end: node.getEnd(), text: ts.isJsxAttribute(node.parent) ? `{${replacement}}` : replacement });
    return;
  }
  ts.forEachChild(node, visit);
}
visit(file);
let output = source;
for (const edit of edits.sort((a,b) => b.start-a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
fs.writeFileSync(settingsPath, output);

function addCatalog(path, language) {
  let text = fs.readFileSync(path, 'utf8');
  const copyLines = [...used.entries()].filter(([k]) => /^\d{3}$/.test(k)).sort().map(([k,v]) => `      "${k}": ${JSON.stringify(v[language])},`).join('\n');
  const sharedLines = [...used.entries()].filter(([k]) => k.startsWith('shared.')).sort().map(([k,v]) => `        ${JSON.stringify(k.slice(7))}: ${JSON.stringify(v[language])},`).join('\n');
  const block = `    "remaining": {\n      "copy": {\n${copyLines}\n      },\n      "shared": {\n${sharedLines}\n      }\n    },`;
  text = text.replace(/    "remaining": \{[\s\S]*?\n    \},\n    "navigation":/, block + '\n    "navigation":');
  fs.writeFileSync(path, text);
}
console.log(`Replaced ${edits.length} literals; wrote ${used.size} translations.`);
