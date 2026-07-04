var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/db/index.ts
import pg from "pg";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
async function ensureFavoritesColumn() {
  try {
    await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT false`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_is_favorite ON files(is_favorite)`);
  } catch (err) {
    if (err?.code === "42P01") {
      return;
    }
    console.error("\u274C \u6570\u636E\u5E93\u8FC1\u79FB\u5931\u8D25 (\u6536\u85CF\u5B57\u6BB5):", err);
    throw err;
  }
}
async function ensureFilesPerformanceIndexes() {
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_account_created ON files(storage_account_id, created_at DESC, id DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_source_created ON files(source, created_at DESC, id DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_account_fav_created ON files(storage_account_id, is_favorite, created_at DESC, id DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_source_fav_created ON files(source, is_favorite, created_at DESC, id DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_account_folder_created ON files(storage_account_id, folder, created_at DESC, id DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_source_folder_created ON files(source, folder, created_at DESC, id DESC)`);
  } catch (err) {
    if (err?.code === "42P01") {
      return;
    }
    console.error("\u274C \u6570\u636E\u5E93\u8FC1\u79FB\u5931\u8D25 (\u6587\u4EF6\u5217\u8868\u6027\u80FD\u7D22\u5F15):", err);
    throw err;
  }
}
async function initializeDatabase() {
  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    const schemaSql = await fs.readFile(schemaPath, "utf-8");
    const statements = [];
    let current = "";
    let inDollarQuote = false;
    for (let i = 0; i < schemaSql.length; i++) {
      const char = schemaSql[i];
      current += char;
      if (char === "$" && schemaSql[i + 1] === "$") {
        inDollarQuote = !inDollarQuote;
        current += "$";
        i++;
      } else if (char === ";" && !inDollarQuote) {
        const stmt = current.trim();
        if (stmt.length > 1) {
          const withoutLeadingLineComments = stmt.replace(/^\s*(--[^\n]*\n\s*)+/g, "").trim();
          if (withoutLeadingLineComments.length > 0) {
            statements.push(withoutLeadingLineComments.slice(0, -1));
          }
        }
        current = "";
      }
    }
    const lastStmt = current.trim();
    if (lastStmt.length > 0) {
      const withoutLeadingLineComments = lastStmt.replace(/^\s*(--[^\n]*\n\s*)+/g, "").trim();
      if (withoutLeadingLineComments.length > 0) {
        statements.push(withoutLeadingLineComments);
      }
    }
    for (const statement of statements) {
      try {
        await pool.query(statement);
      } catch (err) {
        if (err.message?.includes("already exists")) {
          continue;
        }
        throw err;
      }
    }
    await ensureFavoritesColumn();
    await ensureFilesPerformanceIndexes();
    await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_path VARCHAR(500)`);
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash VARCHAR(64)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash) WHERE key_hash IS NOT NULL`);
    console.log("\u2705 \u6570\u636E\u5E93\u8868\u7ED3\u6784\u521D\u59CB\u5316\u5B8C\u6210");
  } catch (err) {
    console.error("\u274C \u6570\u636E\u5E93\u521D\u59CB\u5316\u5931\u8D25:", err);
    throw err;
  }
}
var __filename, __dirname, Pool, pool, initializationPromise, query;
var init_db = __esm({
  "src/db/index.ts"() {
    "use strict";
    __filename = fileURLToPath(import.meta.url);
    __dirname = path.dirname(__filename);
    dotenv.config();
    ({ Pool } = pg);
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || "postgresql://tgvault:password@localhost:5432/tgvault"
    });
    initializationPromise = null;
    pool.on("connect", async () => {
      console.log("\u{1F4E6} \u5DF2\u8FDE\u63A5\u5230 PostgreSQL \u6570\u636E\u5E93");
      if (!initializationPromise) {
        initializationPromise = initializeDatabase();
      }
      await initializationPromise;
    });
    pool.on("error", (err) => {
      console.error("\u274C \u6570\u636E\u5E93\u8FDE\u63A5\u9519\u8BEF:", err);
    });
    query = async (text, params) => {
      const start = Date.now();
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      console.log("\u{1F50D} \u6267\u884C\u67E5\u8BE2", { text: text.substring(0, 50), duration, rows: res.rowCount });
      return res;
    };
  }
});

// src/utils/secretStore.ts
import crypto from "crypto";
import fs2 from "fs";
import path2 from "path";
function getCandidateSecretDirs() {
  const dirs = [];
  if (process.env.TG_VAULT_SECRET_DIR?.trim()) {
    dirs.push(process.env.TG_VAULT_SECRET_DIR.trim());
  }
  const uploadDir = process.env.UPLOAD_DIR || "./data/uploads";
  dirs.push(path2.join(path2.dirname(path2.resolve(uploadDir)), "secrets"));
  dirs.push(path2.join(process.cwd(), "data", "secrets"));
  return [...new Set(dirs.map((dir) => path2.resolve(dir)))];
}
function readSecretFile(filePath) {
  try {
    if (!fs2.existsSync(filePath)) return "";
    return fs2.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    console.warn(`[SecretStore] Failed to read ${filePath}:`, error);
    return "";
  }
}
function tryWriteSecretFile(filePath, value) {
  try {
    fs2.mkdirSync(path2.dirname(filePath), { recursive: true, mode: 448 });
    fs2.writeFileSync(filePath, `${value}
`, { mode: 384 });
    try {
      fs2.chmodSync(filePath, 384);
    } catch {
    }
    return true;
  } catch (error) {
    console.warn(`[SecretStore] Failed to write ${filePath}:`, error);
    return false;
  }
}
function getExistingPersistentSecret(fileName) {
  for (const dir of getCandidateSecretDirs()) {
    const value = readSecretFile(path2.join(dir, fileName));
    if (value) return value;
  }
  return "";
}
function persistSecretWithFallback(envName, fileName, value) {
  for (const dir of getCandidateSecretDirs()) {
    const filePath = path2.join(dir, fileName);
    if (tryWriteSecretFile(filePath, value)) {
      console.log(`[SecretStore] Persisted ${envName} to ${filePath}`);
      return filePath;
    }
  }
  throw new Error(`Unable to persist ${envName}. Please make /data/secrets writable or set ${envName} manually.`);
}
function getOrCreatePersistentSecret(envName, fileName) {
  const fromEnv = process.env[envName]?.trim() || "";
  const fromFile = getExistingPersistentSecret(fileName);
  if (fromEnv) {
    if (!fromFile) {
      persistSecretWithFallback(envName, fileName, fromEnv);
    } else if (fromFile !== fromEnv) {
      console.warn(`[SecretStore] ${envName} is set and differs from the persisted secret; using environment value for this process.`);
    }
    return fromEnv;
  }
  if (fromFile) {
    return fromFile;
  }
  const generated = crypto.randomBytes(32).toString("hex");
  persistSecretWithFallback(envName, fileName, generated);
  return generated;
}
var init_secretStore = __esm({
  "src/utils/secretStore.ts"() {
    "use strict";
  }
});

// src/utils/credentialCrypto.ts
import crypto2 from "crypto";
function getCredentialSecret() {
  const secret = getOrCreatePersistentSecret("STORAGE_CREDENTIALS_SECRET", "storage_credentials_secret");
  if (secret.length < 32) {
    throw new Error("STORAGE_CREDENTIALS_SECRET must be at least 32 characters long. Remove the generated secret file or set STORAGE_CREDENTIALS_SECRET to a value from: openssl rand -hex 32");
  }
  const sessionSecret = process.env.SESSION_SECRET || getExistingPersistentSecret("session_secret");
  if (sessionSecret && secret === sessionSecret) {
    throw new Error("STORAGE_CREDENTIALS_SECRET must be independent from SESSION_SECRET. Remove the generated secret file or set a separate value.");
  }
  process.env.STORAGE_CREDENTIALS_SECRET = secret;
  return secret;
}
function getKey() {
  return crypto2.createHash("sha256").update(getCredentialSecret()).digest();
}
function isEncryptedCredential(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTION_PREFIX);
}
function encryptCredential(value) {
  if (!value || isEncryptedCredential(value)) return value;
  const iv = crypto2.randomBytes(12);
  const cipher = crypto2.createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTION_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}
function decryptCredential(value) {
  if (!isEncryptedCredential(value)) return value;
  const [, , ivText, tagText, cipherText] = value.split(":");
  if (!ivText || !tagText || !cipherText) {
    throw new Error("Invalid encrypted credential format");
  }
  const decipher = crypto2.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
function isSensitiveSettingKey(key) {
  return SENSITIVE_SETTING_KEYS.has(key);
}
function encryptSettingValue(key, value) {
  return isSensitiveSettingKey(key) ? encryptCredential(value) : value;
}
function decryptSettingValue(key, value) {
  return isSensitiveSettingKey(key) ? decryptCredential(value) : value;
}
function encryptStorageConfig(config) {
  const encrypted = { ...config };
  for (const key of Object.keys(encrypted)) {
    if (SENSITIVE_CONFIG_KEYS.has(key) && typeof encrypted[key] === "string" && encrypted[key]) {
      encrypted[key] = encryptCredential(encrypted[key]);
    }
  }
  return encrypted;
}
function decryptStorageConfig(config) {
  const decrypted = { ...config };
  for (const key of Object.keys(decrypted)) {
    if (SENSITIVE_CONFIG_KEYS.has(key) && typeof decrypted[key] === "string" && decrypted[key]) {
      decrypted[key] = decryptCredential(decrypted[key]);
    }
  }
  return decrypted;
}
function storageConfigNeedsEncryption(config) {
  return Object.entries(config).some(([key, value]) => SENSITIVE_CONFIG_KEYS.has(key) && typeof value === "string" && value.length > 0 && !isEncryptedCredential(value));
}
var ENCRYPTION_PREFIX, SENSITIVE_CONFIG_KEYS, SENSITIVE_SETTING_KEYS;
var init_credentialCrypto = __esm({
  "src/utils/credentialCrypto.ts"() {
    "use strict";
    init_secretStore();
    ENCRYPTION_PREFIX = "enc:v1:";
    SENSITIVE_CONFIG_KEYS = /* @__PURE__ */ new Set([
      "clientSecret",
      "refreshToken",
      "accessKeySecret",
      "password"
    ]);
    SENSITIVE_SETTING_KEYS = /* @__PURE__ */ new Set([
      "onedrive_client_secret",
      "onedrive_refresh_token",
      "google_drive_client_secret",
      "google_drive_refresh_token",
      "admin_password_hash",
      "telegram_pin_hash"
    ]);
  }
});

// src/utils/localPath.ts
import fs3 from "fs";
import path3 from "path";
function isPathInside(baseDir, targetPath) {
  const resolvedBase = path3.resolve(baseDir);
  const resolvedTarget = path3.resolve(targetPath);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path3.sep);
}
function safeJoin(baseDir, ...segments) {
  const resolvedBase = path3.resolve(baseDir);
  const resolvedTarget = path3.resolve(resolvedBase, ...segments);
  if (!isPathInside(resolvedBase, resolvedTarget)) {
    throw new Error("Unsafe path outside storage directory");
  }
  return resolvedTarget;
}
function getRelativeStoragePath(baseDir, targetPath) {
  const resolvedBase = path3.resolve(baseDir);
  const resolvedTarget = path3.resolve(targetPath);
  if (!isPathInside(resolvedBase, resolvedTarget)) return null;
  return path3.relative(resolvedBase, resolvedTarget).split(path3.sep).join("/");
}
async function safeUnlink(filePath, baseDir) {
  if (!filePath) return false;
  if (!isPathInside(baseDir, filePath)) {
    console.warn(`Refusing to delete path outside storage directory: ${filePath}`);
    return false;
  }
  if (!fs3.existsSync(filePath)) return false;
  await fs3.promises.unlink(filePath);
  return true;
}
var init_localPath = __esm({
  "src/utils/localPath.ts"() {
    "use strict";
  }
});

// src/services/storage.ts
var storage_exports = {};
__export(storage_exports, {
  AliyunOSSStorageProvider: () => AliyunOSSStorageProvider,
  GoogleDriveStorageProvider: () => GoogleDriveStorageProvider,
  LocalStorageProvider: () => LocalStorageProvider,
  OneDriveStorageProvider: () => OneDriveStorageProvider,
  S3StorageProvider: () => S3StorageProvider,
  StorageManager: () => StorageManager,
  WebDAVStorageProvider: () => WebDAVStorageProvider,
  storageManager: () => storageManager
});
import fs4 from "fs";
import path4 from "path";
import axios from "axios";
import OSS from "ali-oss";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "webdav";
import { google } from "googleapis";
var LocalStorageProvider, AliyunOSSStorageProvider, S3StorageProvider, WebDAVStorageProvider, OneDriveStorageProvider, GoogleDriveStorageProvider, StorageManager, storageManager;
var init_storage = __esm({
  "src/services/storage.ts"() {
    "use strict";
    init_db();
    init_localPath();
    init_credentialCrypto();
    LocalStorageProvider = class {
      name = "local";
      uploadDir;
      constructor(uploadDir = process.env.UPLOAD_DIR || "./data/uploads") {
        this.uploadDir = path4.resolve(uploadDir);
        if (!fs4.existsSync(this.uploadDir)) {
          fs4.mkdirSync(this.uploadDir, { recursive: true });
        }
      }
      async saveFile(tempPath, fileName, _mimeType, folder) {
        const destDir = folder ? safeJoin(this.uploadDir, folder) : this.uploadDir;
        if (!fs4.existsSync(destDir)) {
          fs4.mkdirSync(destDir, { recursive: true });
        }
        const destPath = safeJoin(destDir, fileName);
        try {
          await fs4.promises.rename(tempPath, destPath);
        } catch (error) {
          if (error.code === "EXDEV") {
            await fs4.promises.copyFile(tempPath, destPath);
            await fs4.promises.unlink(tempPath);
          } else {
            throw error;
          }
        }
        return destPath;
      }
      async getFileStream(storedPath) {
        const safePath = safeJoin(this.uploadDir, path4.relative(this.uploadDir, storedPath));
        if (safePath !== path4.resolve(storedPath)) {
          throw new Error("Unsafe local file path");
        }
        if (!fs4.existsSync(safePath)) {
          throw new Error(`File not found: ${safePath}`);
        }
        return fs4.createReadStream(safePath);
      }
      async getPreviewUrl(storedPath) {
        return "";
      }
      async deleteFile(storedPath) {
        const safePath = safeJoin(this.uploadDir, path4.relative(this.uploadDir, storedPath));
        if (safePath !== path4.resolve(storedPath)) {
          throw new Error("Unsafe local file path");
        }
        if (fs4.existsSync(safePath)) {
          await fs4.promises.unlink(safePath);
        }
      }
      async createShareLink(storedPath, password, expiration) {
        return { link: "", error: "\u672C\u5730\u5B58\u50A8\u6682\u4E0D\u652F\u6301\u751F\u6210\u5206\u4EAB\u94FE\u63A5\uFF0C\u8BF7\u4F7F\u7528 OneDrive \u5B58\u50A8\u3002" };
      }
    };
    AliyunOSSStorageProvider = class {
      constructor(id, region, accessKeyId, accessKeySecret, bucket) {
        this.id = id;
        const sanitizedRegion = this.sanitizeRegion(region);
        this.client = new OSS({
          region: sanitizedRegion,
          accessKeyId,
          accessKeySecret,
          bucket,
          secure: true
        });
      }
      id;
      name = "aliyun_oss";
      client;
      sanitizeRegion(region) {
        let r = region.trim().toLowerCase();
        r = r.replace(/^https?:\/\//, "");
        if (r.includes(".aliyuncs.com")) {
          r = r.split(".")[0];
        }
        return r;
      }
      async saveFile(tempPath, fileName, _mimeType, folder) {
        try {
          const objectKey = folder ? `${folder}/${fileName}` : fileName;
          const result = await this.client.put(objectKey, tempPath);
          console.log("[AliyunOSS] Upload successful:", result.name);
          return result.name;
        } catch (error) {
          console.error("[AliyunOSS] Upload failed:", error.message);
          throw new Error(`Aliyun OSS upload failed: ${error.message}`);
        }
      }
      async getFileStream(storedPath) {
        try {
          const result = await this.client.getStream(storedPath);
          return result.stream;
        } catch (error) {
          console.error("[AliyunOSS] Get stream failed:", error.message);
          throw new Error(`Aliyun OSS get stream failed: ${error.message}`);
        }
      }
      async getPreviewUrl(storedPath) {
        try {
          const url = this.client.signatureUrl(storedPath, { expires: 3600 });
          return url;
        } catch (error) {
          console.error("[AliyunOSS] Get preview URL failed:", error.message);
          return "";
        }
      }
      async deleteFile(storedPath) {
        try {
          await this.client.delete(storedPath);
          console.log("[AliyunOSS] Delete successful:", storedPath);
        } catch (error) {
          console.error("[AliyunOSS] Delete failed:", error.message);
          throw new Error(`Aliyun OSS delete failed: ${error.message}`);
        }
      }
      async getFileSize(storedPath) {
        try {
          const result = await this.client.head(storedPath);
          return parseInt(result.meta["content-length"] || result.res.headers["content-length"] || "0");
        } catch (error) {
          console.error("[AliyunOSS] Get file size failed:", error.message);
          return 0;
        }
      }
    };
    S3StorageProvider = class {
      constructor(id, endpoint, region, accessKeyId, secretAccessKey, bucket, forcePathStyle = false) {
        this.id = id;
        this.endpoint = endpoint;
        this.region = region;
        this.accessKeyId = accessKeyId;
        this.secretAccessKey = secretAccessKey;
        this.bucket = bucket;
        this.forcePathStyle = forcePathStyle;
        this.client = new S3Client({
          endpoint,
          region,
          credentials: {
            accessKeyId,
            secretAccessKey
          },
          forcePathStyle
        });
      }
      id;
      endpoint;
      region;
      accessKeyId;
      secretAccessKey;
      bucket;
      forcePathStyle;
      name = "s3";
      client;
      async saveFile(tempPath, fileName, mimeType, folder) {
        try {
          const objectKey = folder ? `${folder}/${fileName}` : fileName;
          const stats = await fs4.promises.stat(tempPath);
          const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: objectKey,
            Body: fs4.createReadStream(tempPath),
            ContentType: mimeType,
            ContentLength: stats.size
          });
          await this.client.send(command);
          return objectKey;
        } catch (error) {
          console.error("[S3] Upload failed:", error.message);
          throw new Error(`S3 upload failed: ${error.message}`);
        }
      }
      async getFileStream(storedPath) {
        try {
          const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: storedPath
          });
          const response = await this.client.send(command);
          return response.Body;
        } catch (error) {
          console.error("[S3] Get stream failed:", error.message);
          throw new Error(`S3 get stream failed: ${error.message}`);
        }
      }
      async getPreviewUrl(storedPath) {
        try {
          const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: storedPath
          });
          return await getS3SignedUrl(this.client, command, { expiresIn: 3600 });
        } catch (error) {
          console.error("[S3] Get preview URL failed:", error.message);
          return "";
        }
      }
      async deleteFile(storedPath) {
        try {
          const command = new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: storedPath
          });
          await this.client.send(command);
        } catch (error) {
          console.error("[S3] Delete failed:", error.message);
          throw new Error(`S3 delete failed: ${error.message}`);
        }
      }
      async getFileSize(storedPath) {
        try {
          const command = new HeadObjectCommand({
            Bucket: this.bucket,
            Key: storedPath
          });
          const response = await this.client.send(command);
          return response.ContentLength || 0;
        } catch (error) {
          console.error("[S3] Get file size failed:", error.message);
          return 0;
        }
      }
    };
    WebDAVStorageProvider = class {
      constructor(id, url, username, password) {
        this.id = id;
        this.url = url;
        this.username = username;
        this.password = password;
        this.client = createClient(url, {
          username,
          password
        });
      }
      id;
      url;
      username;
      password;
      name = "webdav";
      client;
      async saveFile(tempPath, fileName, _mimeType, folder) {
        try {
          const remotePath = folder ? `${folder}/${fileName}` : fileName;
          if (folder) {
            await this.client.createDirectory(`/${folder}`, { recursive: true });
          }
          await this.client.putFileContents(`/${remotePath}`, fs4.createReadStream(tempPath));
          console.log("[WebDAV] Upload successful:", remotePath);
          return remotePath;
        } catch (error) {
          console.error("[WebDAV] Upload failed:", error.message);
          throw new Error(`WebDAV upload failed: ${error.message}`);
        }
      }
      async getFileStream(storedPath) {
        try {
          return this.client.createReadStream(`/${storedPath}`);
        } catch (error) {
          console.error("[WebDAV] Get stream failed:", error.message);
          throw new Error(`WebDAV get stream failed: ${error.message}`);
        }
      }
      async getPreviewUrl(storedPath) {
        return "";
      }
      async deleteFile(storedPath) {
        try {
          await this.client.deleteFile(`/${storedPath}`);
          console.log("[WebDAV] Delete successful:", storedPath);
        } catch (error) {
          console.error("[WebDAV] Delete failed:", error.message);
          throw new Error(`WebDAV delete failed: ${error.message}`);
        }
      }
      async getFileSize(storedPath) {
        try {
          const stat = await this.client.stat(`/${storedPath}`);
          return stat.size || 0;
        } catch (error) {
          console.error("[WebDAV] Get file size failed:", error.message);
          return 0;
        }
      }
    };
    OneDriveStorageProvider = class {
      // 使用第三方存储根目录，不再额外套 TG Vault 目录
      constructor(id, clientId, clientSecret, refreshToken, tenantId = "common") {
        this.id = id;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.refreshToken = refreshToken;
        this.tenantId = tenantId;
        console.log(`[OneDrive] Provider ${id} initialized with clientId:`, clientId.substring(0, 8) + "...", "Tenant:", tenantId);
      }
      id;
      clientId;
      clientSecret;
      refreshToken;
      tenantId;
      name = "onedrive";
      accessToken = null;
      tokenExpiresAt = 0;
      ONEDRIVE_FOLDER = "";
      /**
       * 生成 OAuth 授权 URL
       */
      static generateAuthUrl(clientId, tenantId = "common", redirectUri, state) {
        const scope = encodeURIComponent("Files.ReadWrite.All offline_access");
        const encodedRedirect = encodeURIComponent(redirectUri);
        const stateParam = state ? `&state=${encodeURIComponent(state)}` : "";
        return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?client_id=${clientId}&scope=${scope}&response_type=code&redirect_uri=${encodedRedirect}&response_mode=query${stateParam}`;
      }
      /**
       * 使用授权码交换令牌
       */
      static async exchangeCodeForToken(clientId, clientSecret, tenantId = "common", redirectUri, code) {
        const params = new URLSearchParams();
        params.append("client_id", clientId);
        if (clientSecret) params.append("client_secret", clientSecret);
        params.append("code", code);
        params.append("grant_type", "authorization_code");
        params.append("redirect_uri", redirectUri);
        const endpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
        const response = await axios.post(endpoint, params.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 3e4
        });
        return response.data;
      }
      /**
       * 获取有效的访问令牌，自动刷新过期令牌
       */
      async getAccessToken() {
        if (this.accessToken && Date.now() < this.tokenExpiresAt - 3e5) {
          return this.accessToken;
        }
        console.log("[OneDrive] Refreshing access token...");
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const params = new URLSearchParams();
            params.append("client_id", this.clientId.trim());
            if (this.clientSecret && this.clientSecret.trim()) {
              params.append("client_secret", this.clientSecret.trim());
            }
            params.append("refresh_token", this.refreshToken.trim());
            params.append("grant_type", "refresh_token");
            const endpoint = `https://login.microsoftonline.com/${this.tenantId.trim()}/oauth2/v2.0/token`;
            console.log(`[OneDrive] Refreshing token. ClientID: ${this.clientId}, HasSecret: ${!!this.clientSecret}, Scope: ${params.get("scope")}`);
            const response = await axios.post(
              endpoint,
              params.toString(),
              {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                timeout: 3e4
              }
            );
            this.accessToken = response.data.access_token;
            this.tokenExpiresAt = Date.now() + response.data.expires_in * 1e3;
            console.log("[OneDrive] Token refreshed successfully, expires in:", response.data.expires_in, "seconds");
            if (response.data.refresh_token && response.data.refresh_token !== this.refreshToken) {
              console.log(`[OneDrive] New refresh token received for account ${this.id}, updating database...`);
              this.refreshToken = response.data.refresh_token;
              await StorageManager.updateAccountToken(this.id, this.refreshToken);
            }
            return this.accessToken;
          } catch (error) {
            lastError = error;
            const errorData = error.response?.data;
            console.error(`[OneDrive] Token refresh attempt ${attempt}/3 failed:`, {
              status: error.response?.status,
              error: errorData?.error,
              description: errorData?.error_description
            });
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 1e3 * attempt));
            }
          }
        }
        throw new Error(`Failed to refresh OneDrive token after 3 attempts: ${lastError?.response?.data?.error_description || lastError?.message}`);
      }
      encodeOneDrivePath(rawPath) {
        return rawPath.split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
      }
      /**
       * 确保存储文件夹存在
       */
      async ensureFolderExists(token, folder) {
        const fullFolderPath = [this.ONEDRIVE_FOLDER, folder].filter(Boolean).join("/");
        if (!fullFolderPath) return "";
        try {
          const endpoint = `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(fullFolderPath)}:`;
          await axios.get(endpoint, {
            headers: { "Authorization": `Bearer ${token}` },
            timeout: 3e4
          });
          return fullFolderPath;
        } catch (error) {
          if (error.response?.status === 404) {
            const segments = fullFolderPath.split("/").filter(Boolean);
            let currentPath = "";
            for (const segment of segments) {
              const parentPath = currentPath;
              currentPath = currentPath ? `${currentPath}/${segment}` : segment;
              try {
                await axios.get(`https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(currentPath)}:`, {
                  headers: { "Authorization": `Bearer ${token}` },
                  timeout: 3e4
                });
              } catch (getError) {
                if (getError.response?.status !== 404) throw getError;
                const parentEndpoint = parentPath ? `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(parentPath)}:/children` : "https://graph.microsoft.com/v1.0/me/drive/root/children";
                await axios.post(
                  parentEndpoint,
                  { name: segment, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
                  {
                    headers: {
                      "Authorization": `Bearer ${token}`,
                      "Content-Type": "application/json"
                    },
                    timeout: 3e4
                  }
                );
              }
            }
            console.log("[OneDrive] Storage folder created successfully:", fullFolderPath);
            return fullFolderPath;
          } else {
            const errorDetails = error.response?.data?.error || error.message;
            console.error("[OneDrive] Check folder failed:", errorDetails);
            throw new Error(`OneDrive folder check failed (Status ${error.response?.status}): ${JSON.stringify(errorDetails)}`);
          }
        }
      }
      /**
       * 保存文件到 OneDrive
       */
      async saveFile(tempPath, fileName, mimeType, folder) {
        const token = await this.getAccessToken();
        const stats = await fs4.promises.stat(tempPath);
        const fileSize = stats.size;
        console.log(`[OneDrive] Uploading file: ${fileName}, size: ${fileSize} bytes, type: ${mimeType}`);
        const uploadFolder = await this.ensureFolderExists(token, folder);
        const targetPath = uploadFolder ? `${uploadFolder}/${fileName}` : fileName;
        try {
          if (fileSize < 4 * 1024 * 1024) {
            console.log("[OneDrive] Using simple upload for small file");
            const fileBuffer = await fs4.promises.readFile(tempPath);
            const response = await axios.put(
              `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(targetPath)}:/content`,
              fileBuffer,
              {
                headers: {
                  "Authorization": `Bearer ${token}`,
                  "Content-Type": mimeType || "application/octet-stream",
                  "Content-Length": fileSize.toString()
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                timeout: 6e4
              }
            );
            console.log("[OneDrive] Simple upload successful, file ID:", response.data.id);
            return response.data.id;
          } else {
            console.log("[OneDrive] Using chunked upload session for large file");
            const sessionRes = await axios.post(
              `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(targetPath)}:/createUploadSession`,
              {
                item: {
                  "@microsoft.graph.conflictBehavior": "rename",
                  name: fileName
                }
              },
              {
                headers: {
                  "Authorization": `Bearer ${token}`,
                  "Content-Type": "application/json"
                },
                timeout: 3e4
              }
            );
            const uploadUrl = sessionRes.data.uploadUrl;
            console.log("[OneDrive] Upload session created");
            const CHUNK_SIZE = 320 * 1024 * 10;
            let uploadedBytes = 0;
            let lastResponse = null;
            const fd = await fs4.promises.open(tempPath, "r");
            try {
              while (uploadedBytes < fileSize) {
                const chunkSize = Math.min(CHUNK_SIZE, fileSize - uploadedBytes);
                const buffer = Buffer.alloc(chunkSize);
                await fd.read(buffer, 0, chunkSize, uploadedBytes);
                const rangeEnd = uploadedBytes + chunkSize - 1;
                const contentRange = `bytes ${uploadedBytes}-${rangeEnd}/${fileSize}`;
                console.log(`[OneDrive] Uploading chunk: ${contentRange}`);
                lastResponse = await axios.put(uploadUrl, buffer, {
                  headers: {
                    "Content-Length": chunkSize.toString(),
                    "Content-Range": contentRange
                  },
                  maxBodyLength: Infinity,
                  maxContentLength: Infinity,
                  timeout: 12e4
                });
                uploadedBytes += chunkSize;
                const progress = Math.round(uploadedBytes / fileSize * 100);
                console.log(`[OneDrive] Upload progress: ${progress}%`);
              }
            } catch (chunkError) {
              await fd.close();
              console.error("[OneDrive] Chunk upload failed, cancelling session...");
              await this.cancelUploadSession(uploadUrl);
              throw chunkError;
            } finally {
              try {
                await fd.close();
              } catch {
              }
            }
            if (lastResponse?.data?.id) {
              console.log("[OneDrive] Chunked upload successful, file ID:", lastResponse.data.id);
              return lastResponse.data.id;
            }
            const itemRes = await axios.get(
              `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(targetPath)}`,
              {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 3e4
              }
            );
            console.log("[OneDrive] File ID retrieved:", itemRes.data.id);
            return itemRes.data.id;
          }
        } catch (error) {
          console.error("[OneDrive] Upload failed:", {
            status: error.response?.status,
            error: error.response?.data?.error,
            message: error.message
          });
          throw new Error(`OneDrive upload failed: ${error.response?.data?.error?.message || error.message}`);
        }
      }
      /**
       * 取消上传会话（清理服务器上的未完成上传）
       */
      async cancelUploadSession(uploadUrl) {
        try {
          await axios.delete(uploadUrl, { timeout: 1e4 });
          console.log("[OneDrive] Upload session cancelled successfully");
        } catch (error) {
          console.warn("[OneDrive] Failed to cancel upload session (may already be expired):", error.message);
        }
      }
      /**
       * 获取文件流用于下载
       */
      async getFileStream(storedPath) {
        const token = await this.getAccessToken();
        try {
          const response = await axios.get(
            `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}/content`,
            {
              headers: { "Authorization": `Bearer ${token}` },
              responseType: "stream",
              timeout: 6e4
            }
          );
          return response.data;
        } catch (error) {
          console.error("[OneDrive] Get file stream failed:", {
            fileId: storedPath,
            status: error.response?.status,
            error: error.response?.data?.error
          });
          throw new Error(`OneDrive download failed: ${error.response?.data?.error?.message || error.message}`);
        }
      }
      /**
       * 获取文件预览URL（临时下载链接，有效期约1小时）
       */
      async getPreviewUrl(storedPath) {
        const token = await this.getAccessToken();
        try {
          const response = await axios.get(
            `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}`,
            {
              headers: { "Authorization": `Bearer ${token}` },
              timeout: 3e4
            }
          );
          const downloadUrl = response.data["@microsoft.graph.downloadUrl"];
          if (!downloadUrl) {
            console.error("[OneDrive] Download URL missing from response:", {
              fileId: storedPath,
              responseKeys: Object.keys(response.data)
            });
            throw new Error("Download URL not available");
          }
          return downloadUrl;
        } catch (error) {
          console.error("[OneDrive] Get preview URL failed:", {
            fileId: storedPath,
            status: error.response?.status,
            error: error.response?.data?.error
          });
          throw new Error(`OneDrive preview URL failed: ${error.response?.data?.error?.message || error.message}`);
        }
      }
      /**
       * 删除文件
       */
      async deleteFile(storedPath) {
        const token = await this.getAccessToken();
        try {
          await axios.delete(
            `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}`,
            {
              headers: { "Authorization": `Bearer ${token}` },
              timeout: 3e4
            }
          );
          console.log("[OneDrive] File deleted:", storedPath);
        } catch (error) {
          if (error.response?.status === 404) {
            console.log("[OneDrive] File already deleted or not found:", storedPath);
            return;
          }
          console.error("[OneDrive] Delete file failed:", {
            fileId: storedPath,
            status: error.response?.status,
            error: error.response?.data?.error
          });
          throw new Error(`OneDrive delete failed: ${error.response?.data?.error?.message || error.message}`);
        }
      }
      /**
       * 获取文件大小
       */
      async getFileSize(storedPath) {
        const token = await this.getAccessToken();
        try {
          const response = await axios.get(
            `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}?$select=size`,
            {
              headers: { "Authorization": `Bearer ${token}` },
              timeout: 3e4
            }
          );
          return response.data.size || 0;
        } catch (error) {
          console.error("[OneDrive] Get file size failed:", error.message);
          return 0;
        }
      }
      /**
       * 创建分享链接
       */
      async createShareLink(storedPath, password, expiration) {
        const token = await this.getAccessToken();
        try {
          const body = {
            type: "view",
            scope: "anonymous"
            // 任何人（可能需要根据组织策略调整）
          };
          if (password) {
            body.password = password;
          }
          if (expiration) {
            body.expirationDateTime = expiration;
          }
          console.log(`[OneDrive] Creating share link for ${storedPath} with params:`, { ...body, password: body.password ? "***" : void 0 });
          const response = await axios.post(
            `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}/createLink`,
            body,
            {
              headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
              },
              timeout: 3e4
            }
          );
          if (response.data && response.data.link && response.data.link.webUrl) {
            console.log("[OneDrive] Share link created successfully");
            return { link: response.data.link.webUrl };
          } else {
            return { link: "", error: "OneDrive \u672A\u8FD4\u56DE\u6709\u6548\u7684\u5206\u4EAB\u94FE\u63A5" };
          }
        } catch (error) {
          console.error("[OneDrive] Create share link failed:", {
            status: error.response?.status,
            error: error.response?.data?.error
          });
          const errorData = error.response?.data?.error;
          if (errorData?.code === "notSupported" || errorData?.code === "invalidRequest") {
            if (password || expiration) {
              return { link: "", error: "\u60A8\u7684 OneDrive \u8D26\u6237\u53EF\u80FD\u4E0D\u652F\u6301\u8BBE\u7F6E\u5BC6\u7801\u6216\u8FC7\u671F\u65F6\u95F4\uFF0C\u8BF7\u5C1D\u8BD5\u4E0D\u5E26\u8FD9\u4E9B\u9009\u9879\u91CD\u8BD5\uFF0C\u6216\u68C0\u67E5 OneDrive \u8D26\u6237\u7C7B\u578B\uFF08\u90E8\u5206\u4E2A\u4EBA\u7248/\u5546\u4E1A\u7248\u9650\u5236\uFF09\u3002" };
            }
          }
          return { link: "", error: `\u521B\u5EFA\u5206\u4EAB\u94FE\u63A5\u5931\u8D25: ${errorData?.message || error.message}` };
        }
      }
    };
    GoogleDriveStorageProvider = class {
      constructor(id, clientId, clientSecret, refreshToken, redirectUri, sharedDriveId) {
        this.id = id;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.refreshToken = refreshToken;
        this.redirectUri = redirectUri;
        const normalizedSharedDriveId = sharedDriveId?.trim();
        this.sharedDriveId = normalizedSharedDriveId || void 0;
        this.oauth2Client = new google.auth.OAuth2(
          this.clientId,
          this.clientSecret,
          this.redirectUri
        );
        this.oauth2Client.setCredentials({
          refresh_token: this.refreshToken
        });
        this.drive = google.drive({ version: "v3", auth: this.oauth2Client });
      }
      id;
      clientId;
      clientSecret;
      refreshToken;
      redirectUri;
      name = "google_drive";
      oauth2Client;
      drive;
      tokenExpiresAt = 0;
      GOOGLE_DRIVE_FOLDER = "TG Vault";
      sharedDriveId;
      folderIdCache = /* @__PURE__ */ new Map();
      folderEnsureLocks = /* @__PURE__ */ new Map();
      static generateAuthUrl(clientId, clientSecret, redirectUri, state) {
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        return oauth2Client.generateAuthUrl({
          access_type: "offline",
          scope: ["https://www.googleapis.com/auth/drive.file"],
          prompt: "consent",
          state
        });
      }
      static async exchangeCodeForToken(clientId, clientSecret, redirectUri, code) {
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        const { tokens } = await oauth2Client.getToken(code);
        return tokens;
      }
      async ensureAuthenticated() {
        const credentials = await this.oauth2Client.getAccessToken();
        if (credentials.token) {
          this.tokenExpiresAt = credentials.res?.data?.expiry_date || 0;
        }
      }
      escapeDriveQuery(value) {
        return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      }
      getRootParentId() {
        return this.sharedDriveId || "root";
      }
      withSharedDriveSupport(params, includeListScope = false) {
        const next = {
          ...params,
          supportsAllDrives: true
        };
        if (includeListScope) {
          next.includeItemsFromAllDrives = true;
          if (this.sharedDriveId) {
            next.corpora = "drive";
            next.driveId = this.sharedDriveId;
          }
        }
        return next;
      }
      async findFolderId(segment, parentId) {
        const parentClause = `'${parentId || this.getRootParentId()}' in parents`;
        const response = await this.drive.files.list(this.withSharedDriveSupport({
          q: `name = '${this.escapeDriveQuery(segment)}' and mimeType = 'application/vnd.google-apps.folder' and ${parentClause} and trashed = false`,
          fields: "files(id, name, createdTime)",
          orderBy: "createdTime",
          spaces: "drive",
          pageSize: 10
        }, true));
        return response.data.files?.[0]?.id || null;
      }
      async ensureChildFolder(segment, parentId) {
        const cacheKey = `${parentId || "root"}/${segment}`;
        const cachedId = this.folderIdCache.get(cacheKey);
        if (cachedId) return cachedId;
        const existingLock = this.folderEnsureLocks.get(cacheKey);
        if (existingLock) return existingLock;
        const lock = (async () => {
          const existingFolderId = await this.findFolderId(segment, parentId);
          if (existingFolderId) {
            this.folderIdCache.set(cacheKey, existingFolderId);
            return existingFolderId;
          }
          const folderMetadata = {
            name: segment,
            mimeType: "application/vnd.google-apps.folder"
          };
          folderMetadata.parents = [parentId || this.getRootParentId()];
          const createdFolder = await this.drive.files.create(this.withSharedDriveSupport({
            resource: folderMetadata,
            fields: "id"
          }));
          const createdId = createdFolder.data.id;
          this.folderIdCache.set(cacheKey, createdId);
          return createdId;
        })();
        this.folderEnsureLocks.set(cacheKey, lock);
        try {
          return await lock;
        } finally {
          this.folderEnsureLocks.delete(cacheKey);
        }
      }
      async ensureFolderExists(folder) {
        await this.ensureAuthenticated();
        const segments = [this.GOOGLE_DRIVE_FOLDER, ...folder ? folder.split("/").filter(Boolean) : []];
        let parentId = null;
        for (const segment of segments) {
          parentId = await this.ensureChildFolder(segment, parentId);
        }
        return parentId;
      }
      async saveFile(tempPath, fileName, mimeType, folder) {
        await this.ensureAuthenticated();
        const folderId = await this.ensureFolderExists(folder);
        const fileMetadata = {
          name: fileName,
          parents: [folderId]
        };
        const media = {
          mimeType,
          body: fs4.createReadStream(tempPath)
        };
        try {
          const file = await this.drive.files.create(this.withSharedDriveSupport({
            resource: fileMetadata,
            media,
            fields: "id"
          }));
          console.log("[GoogleDrive] Upload successful, file ID:", file.data.id);
          return file.data.id;
        } catch (error) {
          console.error("[GoogleDrive] Upload failed:", error.message);
          throw new Error(`Google Drive upload failed: ${error.message}`);
        }
      }
      async getFileStream(storedPath) {
        await this.ensureAuthenticated();
        try {
          const response = await this.drive.files.get(
            this.withSharedDriveSupport({ fileId: storedPath, alt: "media" }),
            { responseType: "stream" }
          );
          return response.data;
        } catch (error) {
          console.error("[GoogleDrive] Get stream failed:", error.message);
          throw new Error(`Google Drive get stream failed: ${error.message}`);
        }
      }
      async getPreviewUrl(storedPath) {
        return "";
      }
      async deleteFile(storedPath) {
        await this.ensureAuthenticated();
        try {
          await this.drive.files.delete(this.withSharedDriveSupport({ fileId: storedPath }));
          console.log("[GoogleDrive] Delete successful:", storedPath);
        } catch (error) {
          if (error.code === 404) {
            console.log("[GoogleDrive] File not found, skipping delete:", storedPath);
            return;
          }
          console.error("[GoogleDrive] Delete failed:", error.message);
          throw new Error(`Google Drive delete failed: ${error.message}`);
        }
      }
      async getFileSize(storedPath) {
        await this.ensureAuthenticated();
        try {
          const response = await this.drive.files.get(this.withSharedDriveSupport({
            fileId: storedPath,
            fields: "size"
          }));
          return parseInt(response.data.size || "0");
        } catch (error) {
          console.error("[GoogleDrive] Get file size failed:", error.message);
          return 0;
        }
      }
      /**
       * 创建分享链接
       */
      async createShareLink(storedPath, password, expiration) {
        await this.ensureAuthenticated();
        try {
          await this.drive.permissions.create(this.withSharedDriveSupport({
            fileId: storedPath,
            requestBody: {
              role: "reader",
              type: "anyone"
            }
          }));
          const response = await this.drive.files.get(this.withSharedDriveSupport({
            fileId: storedPath,
            fields: "webViewLink"
          }));
          const link = response.data.webViewLink;
          if (!link) {
            return { link: "", error: "Google Drive \u672A\u8FD4\u56DE\u6709\u6548\u7684\u5206\u4EAB\u94FE\u63A5" };
          }
          console.log("[GoogleDrive] Share link created successfully:", link);
          let errorMsg = void 0;
          if (password || expiration) {
            errorMsg = "Google Drive \u666E\u901A\u8D26\u6237\u6682\u4E0D\u652F\u6301\u901A\u8FC7 API \u8BBE\u7F6E\u5206\u4EAB\u5BC6\u7801\u6216\u8FC7\u671F\u65F6\u95F4\uFF0C\u5DF2\u4E3A\u60A8\u751F\u6210\u516C\u5F00\u5206\u4EAB\u94FE\u63A5\u3002";
          }
          return { link, error: errorMsg };
        } catch (error) {
          console.error("[GoogleDrive] Create share link failed:", error.message);
          return { link: "", error: `\u521B\u5EFA\u5206\u4EAB\u94FE\u63A5\u5931\u8D25: ${error.message}` };
        }
      }
    };
    StorageManager = class _StorageManager {
      static instance;
      activeProvider;
      providers = /* @__PURE__ */ new Map();
      activeAccountId = null;
      constructor() {
        const local = new LocalStorageProvider();
        this.providers.set(local.name, local);
        this.activeProvider = local;
      }
      static getInstance() {
        if (!_StorageManager.instance) {
          _StorageManager.instance = new _StorageManager();
        }
        return _StorageManager.instance;
      }
      // 初始化：从数据库加载配置
      async init() {
        try {
          await query(`
                CREATE TABLE IF NOT EXISTS system_settings (
                    key VARCHAR(255) PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE TABLE IF NOT EXISTS storage_accounts (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    type VARCHAR(50) NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    config JSONB NOT NULL,
                    is_active BOOLEAN DEFAULT false,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );

                -- \u786E\u4FDD files \u8868\u6709 storage_account_id \u5B57\u6BB5
                DO $$ 
                BEGIN 
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='files' AND column_name='storage_account_id') THEN
                        ALTER TABLE files ADD COLUMN storage_account_id UUID;
                    END IF;
                END $$;
            `);
          await this.migrateLegacyConfig();
          let providerRes = await query("SELECT value FROM system_settings WHERE key = $1", ["active_storage_provider"]);
          let providerName = providerRes.rows[0]?.value || null;
          if (!providerName) {
            const legacyRes = await query("SELECT value FROM system_settings WHERE key = $1", ["storage_provider"]);
            providerName = legacyRes.rows[0]?.value || "local";
            if (legacyRes.rows[0]) {
              console.log(`[StorageManager] Migrating legacy key 'storage_provider' -> 'active_storage_provider' = ${providerName}`);
              await _StorageManager.updateSetting("active_storage_provider", providerName);
            }
          }
          console.log(`[StorageManager] Active provider from settings: ${providerName}`);
          const accountsRes = await query("SELECT * FROM storage_accounts");
          const globalSecretRes = await query("SELECT value FROM system_settings WHERE key = 'onedrive_client_secret'");
          const globalSecretRaw = globalSecretRes.rows[0]?.value || "";
          const globalSecret = globalSecretRaw ? decryptSettingValue("onedrive_client_secret", globalSecretRaw) : "";
          if (globalSecretRaw && !isEncryptedCredential(globalSecretRaw)) {
            await _StorageManager.updateSetting("onedrive_client_secret", globalSecretRaw);
          }
          await this.encryptLegacySensitiveSettings();
          for (const row of accountsRes.rows) {
            const rawConfig = row.config || {};
            const config = decryptStorageConfig(rawConfig);
            if (storageConfigNeedsEncryption(rawConfig)) {
              await query("UPDATE storage_accounts SET config = $1, updated_at = NOW() WHERE id = $2", [JSON.stringify(encryptStorageConfig(rawConfig)), row.id]);
              console.log(`[StorageManager] Encrypted stored credentials for account ${row.id}`);
            }
            let provider = null;
            if (row.type === "onedrive") {
              provider = new OneDriveStorageProvider(
                row.id,
                config.clientId,
                config.clientSecret || globalSecret || "",
                config.refreshToken,
                config.tenantId || "common"
              );
              this.providers.set(`onedrive:${row.id}`, provider);
            } else if (row.type === "aliyun_oss") {
              provider = new AliyunOSSStorageProvider(
                row.id,
                config.region,
                config.accessKeyId,
                config.accessKeySecret,
                config.bucket
              );
              this.providers.set(`aliyun_oss:${row.id}`, provider);
            } else if (row.type === "s3") {
              provider = new S3StorageProvider(
                row.id,
                config.endpoint,
                config.region,
                config.accessKeyId,
                config.accessKeySecret,
                config.bucket,
                config.forcePathStyle || false
              );
              this.providers.set(`s3:${row.id}`, provider);
            } else if (row.type === "webdav") {
              provider = new WebDAVStorageProvider(
                row.id,
                config.url,
                config.username,
                config.password
              );
              this.providers.set(`webdav:${row.id}`, provider);
            } else if (row.type === "google_drive") {
              provider = new GoogleDriveStorageProvider(
                row.id,
                config.clientId,
                config.clientSecret,
                config.refreshToken,
                config.redirectUri,
                config.sharedDriveId
              );
              this.providers.set(`google_drive:${row.id}`, provider);
            }
            if (provider && row.is_active) {
              this.activeProvider = provider;
              this.activeAccountId = row.id;
              console.log(`Storage Provider initialized: ${row.type} Account (${row.name})`);
            }
          }
          if (providerName === "local" || !this.activeAccountId) {
            this.activeProvider = this.providers.get("local");
            this.activeAccountId = null;
            console.log("Storage Provider initialized: Local");
          }
        } catch (error) {
          console.error("Failed to init storage manager:", error);
          this.activeProvider = this.providers.get("local");
        }
      }
      async migrateLegacyConfig() {
        const clientId = await this.getSetting("onedrive_client_id");
        const refreshToken = await this.getSetting("onedrive_refresh_token");
        if (clientId && refreshToken) {
          console.log("[StorageManager] Migrating legacy OneDrive config...");
          const clientSecret = await this.getSetting("onedrive_client_secret") || "";
          const tenantId = await this.getSetting("onedrive_tenant_id") || "common";
          const existingAccounts = await query("SELECT id, config FROM storage_accounts WHERE type = $1", ["onedrive"]);
          const existing = existingAccounts.rows.find((row) => decryptStorageConfig(row.config || {}).clientId === clientId);
          let accountId;
          if (!existing) {
            const encryptedConfig = encryptStorageConfig({ clientId, clientSecret, refreshToken, tenantId });
            const insertRes = await query(
              `INSERT INTO storage_accounts (type, name, config, is_active) 
                     VALUES ($1, $2, $3, $4) RETURNING id`,
              ["onedrive", "Default Account", JSON.stringify(encryptedConfig), true]
            );
            accountId = insertRes.rows[0].id;
            console.log("[StorageManager] Legacy config migrated successfully.");
          } else {
            accountId = existing.id;
            console.log("[StorageManager] Legacy config already migrated, account ID:", accountId);
          }
          console.log("[StorageManager] Cleaning up legacy settings...");
          await query("DELETE FROM system_settings WHERE key IN ('onedrive_client_id', 'onedrive_client_secret', 'onedrive_refresh_token', 'onedrive_tenant_id')");
          const updateRes = await query(
            "UPDATE files SET storage_account_id = $1 WHERE source = $2 AND storage_account_id IS NULL",
            [accountId, "onedrive"]
          );
          if (updateRes.rowCount > 0) {
            console.log(`[StorageManager] Associated ${updateRes.rowCount} legacy OneDrive files with account ${accountId}`);
          }
        }
      }
      async encryptLegacySensitiveSettings() {
        const res = await query("SELECT key, value FROM system_settings");
        for (const row of res.rows) {
          if (isSensitiveSettingKey(row.key) && row.value && !isEncryptedCredential(row.value)) {
            await _StorageManager.updateSetting(row.key, row.value);
            console.log(`[StorageManager] Encrypted sensitive setting ${row.key}`);
          }
        }
      }
      async getSetting(key) {
        const res = await query("SELECT value FROM system_settings WHERE key = $1", [key]);
        const value = res.rows[0]?.value || null;
        return value ? decryptSettingValue(key, value) : null;
      }
      static async updateSetting(key, value) {
        const storedValue = encryptSettingValue(key, value);
        await query(
          `INSERT INTO system_settings (key, value, updated_at) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, storedValue]
        );
      }
      static async updateAccountToken(accountId, refreshToken) {
        await query(
          `UPDATE storage_accounts 
             SET config = config || jsonb_build_object('refreshToken', $2::text), updated_at = NOW()
             WHERE id = $1`,
          [accountId, encryptCredential(refreshToken)]
        );
      }
      getProvider(name) {
        if (name) {
          const provider = this.providers.get(name);
          if (!provider) {
            throw new Error(`Storage provider not found: ${name}`);
          }
          return provider;
        }
        return this.activeProvider;
      }
      getActiveAccountId() {
        return this.activeAccountId;
      }
      async getAccounts() {
        const res = await query("SELECT id, name, type, is_active FROM storage_accounts ORDER BY created_at ASC");
        return res.rows;
      }
      // 从内存中移除 Provider
      removeProvider(key) {
        this.providers.delete(key);
      }
      // 添加新的 OneDrive 账户 (如果 Client ID 已存在则更新现有记录)
      async addOneDriveAccount(name, clientId, clientSecret, refreshToken, tenantId = "common") {
        const config = JSON.stringify(encryptStorageConfig({ clientId, clientSecret, refreshToken, tenantId }));
        const existingAccounts = await query("SELECT id, config FROM storage_accounts WHERE type = $1", ["onedrive"]);
        const existing = existingAccounts.rows.find((row) => decryptStorageConfig(row.config || {}).clientId === clientId);
        let targetId;
        if (existing) {
          targetId = existing.id;
          console.log(`[StorageManager] Updating existing OneDrive account: ${targetId} (ClientID: ${clientId.substring(0, 8)}...)`);
          await query(
            "UPDATE storage_accounts SET name = $1, config = $2, updated_at = NOW() WHERE id = $3",
            [name, config, targetId]
          );
        } else {
          const res = await query(
            `INSERT INTO storage_accounts (type, name, config, is_active) 
                 VALUES ($1, $2, $3, $4) RETURNING id`,
            ["onedrive", name, config, false]
          );
          targetId = res.rows[0].id;
          console.log(`[StorageManager] Added new OneDrive account: ${targetId}`);
        }
        const oneDrive = new OneDriveStorageProvider(targetId, clientId, clientSecret, refreshToken, tenantId);
        this.providers.set(`onedrive:${targetId}`, oneDrive);
        return targetId;
      }
      // 切换激活账户
      async switchAccount(accountId) {
        if (accountId === "local") {
          await _StorageManager.updateSetting("active_storage_provider", "local");
          await query("UPDATE storage_accounts SET is_active = false");
        } else {
          const accRes = await query("SELECT type FROM storage_accounts WHERE id = $1", [accountId]);
          const type = accRes.rows[0]?.type || "local";
          await _StorageManager.updateSetting("active_storage_provider", type);
          await query("UPDATE storage_accounts SET is_active = (id = $1)", [accountId]);
        }
        await this.init();
      }
      async addAliyunOSSAccount(name, region, accessKeyId, accessKeySecret, bucket) {
        const config = JSON.stringify(encryptStorageConfig({ region, accessKeyId, accessKeySecret, bucket }));
        const res = await query(
          `INSERT INTO storage_accounts (type, name, config, is_active) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
          ["aliyun_oss", name, config, false]
        );
        const targetId = res.rows[0].id;
        console.log(`[StorageManager] Added new Aliyun OSS account: ${targetId}`);
        const oss = new AliyunOSSStorageProvider(targetId, region, accessKeyId, accessKeySecret, bucket);
        this.providers.set(`aliyun_oss:${targetId}`, oss);
        return targetId;
      }
      async addS3Account(name, endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle = false) {
        const config = JSON.stringify(encryptStorageConfig({ endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle }));
        const res = await query(
          `INSERT INTO storage_accounts (type, name, config, is_active) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
          ["s3", name, config, false]
        );
        const targetId = res.rows[0].id;
        console.log(`[StorageManager] Added new S3 account: ${targetId}`);
        const s3 = new S3StorageProvider(targetId, endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle);
        this.providers.set(`s3:${targetId}`, s3);
        return targetId;
      }
      async addWebDAVAccount(name, url, username, password) {
        const config = JSON.stringify(encryptStorageConfig({ url, username, password }));
        const res = await query(
          `INSERT INTO storage_accounts (type, name, config, is_active) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
          ["webdav", name, config, false]
        );
        const targetId = res.rows[0].id;
        console.log(`[StorageManager] Added new WebDAV account: ${targetId}`);
        const webdav = new WebDAVStorageProvider(targetId, url, username, password);
        this.providers.set(`webdav:${targetId}`, webdav);
        return targetId;
      }
      async addGoogleDriveAccount(name, clientId, clientSecret, refreshToken, redirectUri, sharedDriveId) {
        const normalizedSharedDriveId = sharedDriveId?.trim() || void 0;
        const config = JSON.stringify(encryptStorageConfig({ clientId, clientSecret, refreshToken, redirectUri, sharedDriveId: normalizedSharedDriveId }));
        const res = await query(
          `INSERT INTO storage_accounts (type, name, config, is_active) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
          ["google_drive", name, config, false]
        );
        const targetId = res.rows[0].id;
        console.log(`[StorageManager] Added new Google Drive account: ${targetId}`);
        const gd = new GoogleDriveStorageProvider(targetId, clientId, clientSecret, refreshToken, redirectUri, normalizedSharedDriveId);
        this.providers.set(`google_drive:${targetId}`, gd);
        return targetId;
      }
      async updateOneDriveConfig(clientId, clientSecret, refreshToken, tenantId = "common", name) {
        await _StorageManager.updateSetting("onedrive_client_id", clientId);
        await _StorageManager.updateSetting("onedrive_client_secret", clientSecret);
        await _StorageManager.updateSetting("onedrive_tenant_id", tenantId);
        if (refreshToken !== "pending") {
          await _StorageManager.updateSetting("onedrive_refresh_token", refreshToken);
        }
        if (name) {
          await _StorageManager.updateSetting("onedrive_pending_name", name);
        }
        if (refreshToken !== "pending") {
          const pendingName = await this.getSetting("onedrive_pending_name");
          const finalName = name || pendingName || "OneDrive Account";
          await this.addOneDriveAccount(finalName, clientId, clientSecret, refreshToken, tenantId);
          console.log("[StorageManager] Cleaning up temporary settings after successful account add/update...");
          await query("DELETE FROM system_settings WHERE key IN ('onedrive_client_id', 'onedrive_client_secret', 'onedrive_refresh_token', 'onedrive_tenant_id', 'onedrive_pending_name')");
          const res = await query("SELECT id FROM storage_accounts WHERE type = $1 ORDER BY created_at DESC LIMIT 1", ["onedrive"]);
          if (res.rows[0]) {
            await this.switchAccount(res.rows[0].id);
          }
        }
      }
      // 切换回本地
      async switchToLocal() {
        await this.switchAccount("local");
      }
    };
    storageManager = StorageManager.getInstance();
  }
});

// src/index.ts
import express from "express";
import cors from "cors";
import dotenv3 from "dotenv";
import path21 from "path";
import fs16 from "fs";

// src/routes/files.ts
init_db();
import { Router as Router2 } from "express";
import fs12 from "fs";
import path16 from "path";

// src/middleware/signedUrl.ts
import crypto8 from "crypto";

// src/utils/config.ts
init_secretStore();
import dotenv2 from "dotenv";
dotenv2.config();
function loadSessionSecret() {
  const secret = getOrCreatePersistentSecret("SESSION_SECRET", "session_secret");
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters long. Remove the generated secret file or set SESSION_SECRET to a value from: openssl rand -hex 32");
  }
  process.env.SESSION_SECRET = secret;
  return secret;
}
var SESSION_SECRET = loadSessionSecret();
var TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1e3;
var TELEGRAM_API_ID = process.env.TELEGRAM_API_ID || "";
var TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || "";
var TELEGRAM_USER_SESSION_FILE = process.env.TELEGRAM_USER_SESSION_FILE || "./data/telegram_user_session.txt";
var TELEGRAM_DOWNLOAD_WORKERS = Math.max(1, Math.min(16, parseInt(process.env.TELEGRAM_DOWNLOAD_WORKERS || "4", 10) || 4));

// src/routes/auth.ts
import { Router } from "express";
import crypto7 from "crypto";
import { rateLimit } from "express-rate-limit";

// src/utils/security.ts
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from "otplib";
import QRCode from "qrcode";
import crypto3 from "crypto";

// src/utils/settings.ts
init_db();
init_credentialCrypto();
async function getSetting(key, defaultValue) {
  try {
    const res = await query("SELECT value FROM system_settings WHERE key = $1", [key]);
    if (res.rowCount === 0) {
      return defaultValue ?? null;
    }
    return decryptSettingValue(key, res.rows[0].value);
  } catch (e) {
    console.error(`\u83B7\u53D6\u8BBE\u7F6E ${key} \u5931\u8D25:`, e);
    return defaultValue ?? null;
  }
}
async function setSetting(key, value) {
  try {
    await query(
      "INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
      [key, encryptSettingValue(key, value)]
    );
  } catch (e) {
    console.error(`\u4FDD\u5B58\u8BBE\u7F6E ${key} \u5931\u8D25:`, e);
    throw e;
  }
}

// src/utils/security.ts
function totpEncryptionKey() {
  return crypto3.createHash("sha256").update(SESSION_SECRET).digest();
}
function encryptSecret(plain) {
  const iv = crypto3.randomBytes(12);
  const cipher = crypto3.createCipheriv("aes-256-gcm", totpEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}
function decryptSecret(value) {
  if (!value.startsWith("enc:v1:")) return value;
  const [, , ivText, tagText, cipherText] = value.split(":");
  const decipher = crypto3.createDecipheriv("aes-256-gcm", totpEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, "base64url")), decipher.final()]).toString("utf8");
}
async function setTOTPSecret(secret) {
  await setSetting("totp_secret", encryptSecret(secret));
}
var authenticator = new TOTP({
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin()
});
async function getTOTPSecret() {
  if (process.env.TOTP_SECRET) {
    return process.env.TOTP_SECRET;
  }
  const stored = await getSetting("totp_secret");
  if (!stored) return null;
  try {
    const secret = decryptSecret(stored);
    if (!stored.startsWith("enc:v1:")) {
      await setTOTPSecret(secret);
    }
    return secret;
  } catch (error) {
    console.error("TOTP \u5BC6\u94A5\u89E3\u5BC6\u5931\u8D25:", error);
    return null;
  }
}
async function is2FAEnabled() {
  const secret = await getTOTPSecret();
  const enabled = await getSetting("2fa_enabled", "false");
  return !!secret && enabled === "true";
}
async function activate2FA() {
  await setSetting("2fa_enabled", "true");
}
async function disable2FA() {
  await setSetting("2fa_enabled", "false");
}
async function verifyTOTP(token) {
  const secret = await getTOTPSecret();
  if (!secret) return true;
  try {
    const result = await authenticator.verify(token, {
      secret
    });
    return result.valid;
  } catch (e) {
    console.error("TOTP \u9A8C\u8BC1\u5931\u8D25:", e);
    return false;
  }
}
async function generateOTPAuthUrl(user = "Admin") {
  let secret = await getTOTPSecret();
  const isMalformed = secret && secret.length === 32 && /^[0-9A-F]+$/.test(secret);
  if (!secret || isMalformed) {
    secret = authenticator.generateSecret();
    await setTOTPSecret(secret);
    console.log("\u2705 \u5DF2\u4E3A\u7CFB\u7EDF\u81EA\u52A8\u751F\u6210\u6807\u51C6 Base32 2FA \u5BC6\u94A5\u5E76\u5B58\u5165\u6570\u636E\u5E93");
  }
  const otpauth = authenticator.toURI({
    label: user,
    issuer: "TG Vault",
    secret
  });
  return await QRCode.toDataURL(otpauth);
}
function getClientIP(req) {
  return req.ip || req.socket?.remoteAddress || "\u672A\u77E5";
}

// src/routes/auth.ts
import { UAParser } from "ua-parser-js";
import axios2 from "axios";

// src/services/telegramBot.ts
init_storage();
import { TelegramClient as TelegramClient4, Api as Api6 } from "telegram";
import { StringSession as StringSession2 } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Raw } from "telegram/events/index.js";
import fs11 from "fs";
import path15 from "path";

// src/services/telegramState.ts
init_db();

// src/utils/authSettings.ts
import crypto4 from "crypto";
var WEB_PASSWORD_KEY = "admin_password_hash";
var TELEGRAM_PIN_KEY = "telegram_pin_hash";
var TELEGRAM_ALLOWED_USERS_KEY = "telegram_allowed_user_ids";
var SCRYPT_PREFIX = "scrypt:v1";
function hashSecret(secret) {
  const salt = crypto4.randomBytes(16).toString("base64url");
  const derived = crypto4.scryptSync(secret, salt, 64).toString("base64url");
  return `${SCRYPT_PREFIX}:${salt}:${derived}`;
}
function safeEqualText(a, b) {
  try {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto4.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}
function verifySecret(secret, stored) {
  if (!stored) return false;
  if (stored.startsWith(`${SCRYPT_PREFIX}:`)) {
    const [, , salt, expected] = stored.split(":");
    if (!salt || !expected) return false;
    const actual = crypto4.scryptSync(secret, salt, 64).toString("base64url");
    return safeEqualText(actual, expected);
  }
  if (/^[a-f0-9]{64}$/i.test(stored)) {
    const actual = crypto4.createHash("sha256").update(secret).digest("hex");
    return safeEqualText(actual, stored.toLowerCase());
  }
  return false;
}
async function getStoredWebPasswordHash() {
  const stored = await getSetting(WEB_PASSWORD_KEY, "");
  return stored || "";
}
async function isInitialSetupRequired() {
  return !await getStoredWebPasswordHash();
}
async function verifyWebPassword(password) {
  return verifySecret(password, await getStoredWebPasswordHash());
}
async function verifyTelegramPin(pin) {
  const stored = await getSetting(TELEGRAM_PIN_KEY, "");
  if (stored) return verifySecret(pin, stored);
  return verifySecret(pin, await getStoredWebPasswordHash());
}
function validateWebPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "\u7F51\u9875\u7BA1\u7406\u5458\u5BC6\u7801\u81F3\u5C11\u9700\u8981 8 \u4F4D";
  }
  if (password.length > 256) {
    return "\u7F51\u9875\u7BA1\u7406\u5458\u5BC6\u7801\u8FC7\u957F";
  }
  return null;
}
function validateTelegramPin(pin) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    return "Telegram Bot \u5BC6\u7801\u5FC5\u987B\u662F 4 \u4F4D\u6570\u5B57";
  }
  return null;
}
async function createInitialAdminCredentials(webPassword, telegramPin) {
  if (!await isInitialSetupRequired()) {
    throw new Error("\u7BA1\u7406\u5458\u5BC6\u7801\u5DF2\u521B\u5EFA\uFF0C\u4E0D\u80FD\u91CD\u590D\u521D\u59CB\u5316");
  }
  const webError = validateWebPassword(webPassword);
  if (webError) throw new Error(webError);
  const pinError = validateTelegramPin(telegramPin);
  if (pinError) throw new Error(pinError);
  if (webPassword === telegramPin) {
    throw new Error("\u7F51\u9875\u5BC6\u7801\u4E0D\u80FD\u4E0E Telegram Bot 4 \u4F4D\u5BC6\u7801\u76F8\u540C");
  }
  await setSetting(WEB_PASSWORD_KEY, hashSecret(webPassword));
  await setSetting(TELEGRAM_PIN_KEY, hashSecret(telegramPin));
}
function parseUserIds(value) {
  if (!value) return [];
  return [...new Set(String(value).split(",").map((item) => Number(item.trim())).filter((item) => Number.isSafeInteger(item) && item > 0))];
}
async function getConfiguredTelegramAllowedUsers() {
  const envUsers = parseUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS || "");
  if (envUsers.length > 0) return envUsers;
  const stored = await getSetting(TELEGRAM_ALLOWED_USERS_KEY, "");
  return parseUserIds(stored || "");
}

// src/services/telegramState.ts
var userStates = /* @__PURE__ */ new Map();
var authenticatedUsers = /* @__PURE__ */ new Map();
var passwordInputState = /* @__PURE__ */ new Map();
async function revokeAuthenticatedUser(userId) {
  authenticatedUsers.delete(userId);
  try {
    await query("DELETE FROM telegram_auth WHERE user_id = $1", [userId]);
  } catch (error) {
    console.error("\u{1F916} \u64A4\u9500 Telegram \u6388\u6743\u7528\u6237\u5931\u8D25:", error);
  }
}
async function loadAuthenticatedUsers() {
  try {
    const allowedUsers = await getConfiguredTelegramAllowedUsers();
    const result = await query("SELECT user_id, authenticated_at FROM telegram_auth");
    for (const row of result.rows) {
      const userId = Number(row.user_id);
      if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
        await revokeAuthenticatedUser(userId);
        continue;
      }
      authenticatedUsers.set(userId, { authenticatedAt: new Date(row.authenticated_at) });
    }
    console.log(`\u{1F916} \u5DF2\u4ECE\u6570\u636E\u5E93\u8F7D\u5165 ${authenticatedUsers.size} \u4E2A\u6388\u6743\u7528\u6237`);
  } catch (error) {
    console.error("\u{1F916} \u8F7D\u5165\u5DF2\u9A8C\u8BC1\u7528\u6237\u5931\u8D25:", error);
  }
}
async function persistAuthenticatedUser(userId) {
  try {
    await query("INSERT INTO telegram_auth (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
    authenticatedUsers.set(userId, { authenticatedAt: /* @__PURE__ */ new Date() });
    console.log(`\u{1F916} \u7528\u6237 ${userId} \u5DF2\u6301\u4E45\u5316\u5230\u6570\u636E\u5E93`);
  } catch (error) {
    console.error("\u{1F916} \u6301\u4E45\u5316\u7528\u6237\u5931\u8D25:", error);
  }
}
async function isAuthenticatedAsync(userId) {
  const allowedUsers = await getConfiguredTelegramAllowedUsers();
  if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
    if (authenticatedUsers.has(userId)) await revokeAuthenticatedUser(userId);
    return false;
  }
  return authenticatedUsers.has(userId);
}

// src/services/telegramCommands.ts
init_db();
import { Api as Api5 } from "telegram";
import checkDiskSpaceModule from "check-disk-space";
import os from "os";
import fs9 from "fs";
import path13 from "path";

// src/utils/telegramUtils.ts
import path5 from "path";
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
function getTypeEmoji(mimeType) {
  if (!mimeType) return "\u{1F4C1}";
  if (mimeType.startsWith("image/")) return "\u{1F5BC}\uFE0F";
  if (mimeType.startsWith("video/")) return "\u{1F3AC}";
  if (mimeType.startsWith("audio/")) return "\u{1F3B5}";
  if (mimeType === "application/pdf") return "\u{1F4D5}";
  if (mimeType === "text/markdown" || mimeType.includes("markdown")) return "\u{1F4DD}";
  if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml") return "\u{1F4C4}";
  if (mimeType.includes("word") || mimeType.includes("officedocument.wordprocessingml")) return "\u{1F4DD}";
  if (mimeType.includes("excel") || mimeType.includes("spreadsheetml") || mimeType === "text/csv") return "\u{1F4CA}";
  if (mimeType.includes("powerpoint") || mimeType.includes("presentationml")) return "\u{1F4C9}";
  if (mimeType.includes("zip") || mimeType.includes("rar") || mimeType.includes("7z") || mimeType.includes("tar") || mimeType.includes("compressed")) return "\u{1F4E6}";
  if (mimeType.includes("epub") || mimeType.includes("mobi")) return "\u{1F4DA}";
  if (mimeType.includes("executable") || mimeType.includes("msdownload") || mimeType.includes("apk")) return "\u2699\uFE0F";
  if (mimeType.includes("sql") || mimeType.includes("database")) return "\u{1F5C4}\uFE0F";
  if (mimeType.includes("key") || mimeType.includes("pem") || mimeType.includes("certificate") || mimeType.includes("pkcs")) return "\u{1F511}";
  if (mimeType.includes("javascript") || mimeType.includes("typescript") || mimeType.includes("python") || mimeType.includes("php") || mimeType.includes("java") || mimeType.includes("cplusplus") || mimeType.includes("x-httpd-php")) return "\u{1F4BB}";
  if (mimeType.includes("pdf") || mimeType.includes("document")) return "\u{1F4C4}";
  return "\u{1F4C1}";
}
function getFileType(mimeType) {
  if (!mimeType) return "other";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("text") || mimeType.includes("word") || mimeType.includes("excel") || mimeType.includes("spreadsheet") || mimeType.includes("powerpoint") || mimeType.includes("presentation") || mimeType.includes("markdown") || mimeType.includes("json") || mimeType.includes("xml") || mimeType.includes("sql") || mimeType.includes("javascript") || mimeType.includes("typescript")) return "document";
  return "other";
}
function getMimeTypeFromFilename(filename) {
  const ext = path5.extname(filename).toLowerCase();
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".flv": "video/x-flv",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".ts": "application/typescript",
    ".json": "application/json",
    ".xml": "application/xml",
    ".py": "text/x-python",
    ".java": "text/x-java-source",
    ".sql": "application/sql",
    ".zip": "application/zip",
    ".rar": "application/x-rar-compressed",
    ".7z": "application/x-7z-compressed",
    ".tar": "application/x-tar",
    ".gz": "application/x-gzip",
    ".epub": "application/epub+zip",
    ".mobi": "application/x-mobipocket-ebook",
    ".exe": "application/x-msdownload",
    ".apk": "application/vnd.android.package-archive",
    ".iso": "application/x-iso9660-image",
    ".dmg": "application/x-apple-diskimage",
    ".crt": "application/x-x509-ca-cert",
    ".pem": "application/x-pem-file",
    ".key": "application/octet-stream"
  };
  return mimeTypes[ext] || "application/octet-stream";
}
function sanitizeFilename(name) {
  if (!name) return "unknown";
  const firstLine = name.split("\n")[0].trim();
  const originalExt = path5.extname(firstLine);
  const ext = originalExt && originalExt.length <= 15 ? originalExt : "";
  const withoutExt = ext ? firstLine.slice(0, -ext.length) : firstLine;
  let sanitized = withoutExt.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
  sanitized = sanitized.replace(/[.\s]+$/, "");
  if (!sanitized) return "unknown";
  const MAX_CHARS = 50;
  const baseMaxChars = Math.max(1, MAX_CHARS - ext.length);
  let base = sanitized.substring(0, baseMaxChars);
  let result = `${base}${ext}`;
  const MAX_BYTES = 150;
  while (Buffer.byteLength(result, "utf8") > MAX_BYTES && base.length > 0) {
    base = base.substring(0, base.length - 1);
    result = `${base}${ext}`;
  }
  return result || "unknown";
}

// src/utils/telegramMessages.ts
import { Api } from "telegram";
var PROVIDER_DISPLAY_MAP = {
  onedrive: "\u2601\uFE0F OneDrive",
  aliyun_oss: "\u2601\uFE0F \u963F\u91CC\u4E91 OSS",
  s3: "\u{1F4E6} S3 \u5B58\u50A8",
  webdav: "\u{1F310} WebDAV",
  google_drive: "\u2601\uFE0F Google Drive",
  local: "\u{1F4BE} \u672C\u5730\u5B58\u50A8"
};
function getProviderDisplayName(providerName) {
  return PROVIDER_DISPLAY_MAP[providerName] || `\u{1F4E6} ${providerName}`;
}
function buildTaskControlLines(taskId, queuePaused = false, pauseReason) {
  if (!taskId) return [`\u{1F4A1} \u53D1\u9001 /tasks \u67E5\u770B\u5B9E\u65F6\u4EFB\u52A1\u72B6\u6001`];
  if (queuePaused) {
    return [
      `\u23F8\uFE0F **\u5F53\u524D\u72B6\u6001\uFF1A\u5168\u5C40\u4E0B\u8F7D\u961F\u5217\u5DF2\u6682\u505C**`,
      pauseReason ? `\u{1F4CC} \u539F\u56E0\uFF1A${pauseReason}` : `\u{1F4CC} \u7B49\u5F85\u4E2D\u7684\u4E0B\u8F7D\u4EFB\u52A1\u4E0D\u4F1A\u7EE7\u7EED\u5F00\u59CB`,
      `\u25B6\uFE0F \u70B9\u51FB\u4E0B\u65B9\u201C\u7EE7\u7EED\u201D\u4F1A\u6062\u590D\u5168\u5C40\u4E0B\u8F7D\u961F\u5217`,
      `\u{1F6D1} \u70B9\u51FB\u201C\u53D6\u6D88\u201D\u53EA\u4F1A\u7ED3\u675F\u8FD9\u5F20\u540E\u53F0\u4EFB\u52A1\u5361\uFF1B\u4E0D\u4F1A\u518D\u8BEF\u6E05\u7A7A\u5176\u5B83\u4EFB\u52A1`
    ];
  }
  return [
    `\u{1F4A1} \u961F\u5217\u63A7\u5236\uFF1A\u6309\u94AE\u53EA\u5BF9\u5F53\u524D\u804A\u5929\u7684\u4EFB\u52A1\u5361\u6709\u6548`,
    `\u23F8 \u6682\u505C\uFF1A\u6682\u505C\u5168\u5C40\u4E0B\u8F7D\u961F\u5217\uFF0C\u5DF2\u5728\u5904\u7406\u7684\u6587\u4EF6\u4F1A\u5C3D\u5FEB\u505C\u4F4F`,
    `\u25B6\uFE0F \u7EE7\u7EED\uFF1A\u6062\u590D\u5168\u5C40\u4E0B\u8F7D\u961F\u5217`,
    `\u{1F6D1} \u53D6\u6D88\uFF1A\u7ED3\u675F\u5F53\u524D\u4EFB\u52A1\u5361\u5E76\u79FB\u9664\u6309\u94AE\uFF0C\u4E0D\u4F1A\u8BEF\u53D6\u6D88\u5176\u5B83\u804A\u5929\u4EFB\u52A1`
  ];
}
function buildTaskControlButtons(taskId) {
  if (!taskId) return void 0;
  return new Api.ReplyInlineMarkup({
    rows: [
      new Api.KeyboardButtonRow({
        buttons: [
          new Api.KeyboardButtonCallback({ text: "\u23F8 \u6682\u505C", data: Buffer.from(`tq_pause_${taskId}`) }),
          new Api.KeyboardButtonCallback({ text: "\u25B6\uFE0F \u7EE7\u7EED", data: Buffer.from(`tq_resume_${taskId}`) }),
          new Api.KeyboardButtonCallback({ text: "\u{1F6D1} \u53D6\u6D88", data: Buffer.from(`tq_cancel_${taskId}`) })
        ]
      })
    ]
  });
}
function collectCompletedFolders(singleFiles, batches) {
  const folders = /* @__PURE__ */ new Set();
  singleFiles.filter((file) => file.phase === "success" && file.folder).forEach((file) => folders.add(file.folder));
  batches.filter((batch) => batch.completed === batch.totalFiles).forEach((batch) => {
    const folder = batch.folderPath || batch.folderName;
    if (folder) folders.add(folder);
  });
  return Array.from(folders);
}
function formatFolderSummary(folders, maxItems = 4) {
  if (folders.length === 0) return [];
  const visible = folders.slice(0, maxItems);
  const lines = [`\u{1F4C1} \u4FDD\u5B58\u8DEF\u5F84\uFF1A${visible[0]}`];
  visible.slice(1).forEach((folder) => lines.push(`   \u2514 ${folder}`));
  if (folders.length > visible.length) {
    lines.push(`   \u2514 \u53E6\u6709 ${folders.length - visible.length} \u4E2A\u8DEF\u5F84\uFF0C\u53EF\u7528 /list \u67E5\u770B`);
  }
  return lines;
}
function generateProgressBar(completed, total, barLength = 20) {
  if (total <= 0) return "[" + "=".repeat(barLength - 1) + "-] 0%";
  const ratio = Math.min(completed / total, 1);
  const percentage = Math.round(ratio * 100);
  const filledLength = Math.round(ratio * (barLength - 1));
  const emptyLength = barLength - 1 - filledLength;
  return "[" + "=".repeat(filledLength) + ">" + "-".repeat(emptyLength) + "] " + percentage + "%";
}
function generateProgressBarWithSpeed(completed, total, startTime, barLength = 20) {
  const bar = generateProgressBar(completed, total, barLength);
  if (!startTime || completed <= 0) return bar;
  const elapsed = (Date.now() - startTime) / 1e3;
  if (elapsed < 1) return bar;
  const speed = completed / elapsed;
  return `${bar} \u26A1 ${formatBytes(speed)}/s`;
}
var LINE = "\u2501".repeat(22);
var THIN_LINE = "\u2500".repeat(22);
var MSG = {
  // 认证相关
  AUTH_REQUIRED: "\u{1F510} \u8BF7\u5148\u53D1\u9001 /start \u9A8C\u8BC1\u5BC6\u7801",
  AUTH_REQUIRED_UPLOAD: "\u{1F510} \u8BF7\u5148\u53D1\u9001 /start \u9A8C\u8BC1\u5BC6\u7801\u540E\u518D\u4E0A\u4F20\u6587\u4EF6",
  AUTH_INPUT_PROMPT: "\u{1F510} \u8BF7\u4F7F\u7528\u4E0B\u65B9\u952E\u76D8\u8F93\u5165\u5BC6\u7801\uFF1A",
  AUTH_CANCELLED: "\u{1F6AB} \u5DF2\u53D6\u6D88\u5BC6\u7801\u8F93\u5165\n\n\u53D1\u9001 /start \u91CD\u65B0\u5F00\u59CB",
  AUTH_WRONG: "\u274C \u5BC6\u7801\u9519\u8BEF\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165\uFF1A",
  AUTH_SUCCESS: "\u2705 \u5BC6\u7801\u9A8C\u8BC1\u6210\u529F!",
  AUTH_2FA_PROMPT: "\u{1F510} \u5BC6\u7801\u9A8C\u8BC1\u901A\u8FC7\uFF01\n\n\u8BF7\u8F93\u5165\u60A8\u7684 **2FA 6 \u4F4D\u9A8C\u8BC1\u7801** \u4EE5\u5B8C\u6210\u767B\u5F55\uFF1A",
  AUTH_2FA_TOAST: "\u8BF7\u8F93\u5165 2FA \u9A8C\u8BC1\u7801",
  AUTH_2FA_WRONG: "\u274C \u9A8C\u8BC1\u7801\u9519\u8BEF\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165 6 \u4F4D\u6570\u5B57\uFF1A",
  AUTH_2FA_ACTIVATED: "\u2705 **2FA \u5DF2\u6210\u529F\u6FC0\u6D3B\uFF01**\n\n\u{1F6E1}\uFE0F \u60A8\u7684\u8D26\u6237\u73B0\u5728\u53D7\u5230\u53CC\u91CD\u4FDD\u62A4\u3002",
  AUTH_2FA_LOGIN_OK: "\u2705 **2FA \u9A8C\u8BC1\u6210\u529F**\n\n\u6B22\u8FCE\u56DE\u6765\uFF01",
  AUTH_2FA_QR_FAIL: "\u274C \u751F\u6210\u4E8C\u7EF4\u7801\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u63A7\u5236\u53F0\u65E5\u5FD7\u3002",
  // 未知消息
  UNKNOWN_TEXT: "\u2753 \u672A\u8BC6\u522B\u7684\u6307\u4EE4\n\n\u53D1\u9001 /start \u5F00\u59CB\u4F7F\u7528\uFF0C\u6216 /help \u67E5\u770B\u5E2E\u52A9",
  UNSUPPORTED_MEDIA: "\u26A0\uFE0F \u6682\u4E0D\u652F\u6301\u6B64\u7C7B\u5A92\u4F53\u683C\u5F0F",
  // 空状态
  EMPTY_FILES: "\u{1F4EE} \u6682\u65E0\u4E0A\u4F20\u8BB0\u5F55",
  EMPTY_TASKS: "\u{1F4EE} \u5F53\u524D\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u4EFB\u52A1",
  // 错误
  ERR_STORAGE: "\u274C \u83B7\u53D6\u5B58\u50A8\u7EDF\u8BA1\u5931\u8D25",
  ERR_FILE_LIST: "\u274C \u83B7\u53D6\u6587\u4EF6\u5217\u8868\u5931\u8D25",
  ERR_DELETE: "\u274C \u5220\u9664\u6587\u4EF6\u5931\u8D25",
  ERR_TASKS: "\u274C \u83B7\u53D6\u4EFB\u52A1\u5217\u8868\u5931\u8D25",
  // 下载/上传
  DOWNLOAD_FAIL: "\u4E0B\u8F7D\u5931\u8D25",
  SAVING_FILE: "\u{1F4BE} \u6B63\u5728\u4FDD\u5B58\u5230\u5B58\u50A8...",
  RETRYING: "\u{1F504} \u4E0A\u4F20\u5931\u8D25\uFF0C\u6B63\u5728\u91CD\u8BD5..."
};
function buildWelcomeBack() {
  return [
    `\u{1F44B} **\u6B22\u8FCE\u56DE\u6765\uFF01**`,
    ``,
    `\u60A8\u5DF2\u901A\u8FC7\u9A8C\u8BC1\uFF0C\u53EF\u4EE5\u76F4\u63A5\u4F7F\u7528\uFF1A`,
    ``,
    `\u{1F4E4}  \u53D1\u9001/\u8F6C\u53D1\u6587\u4EF6\u5373\u53EF\u4E0A\u4F20 (\u6700\u5927 2GB\uFF0C\u8D26\u53F7\u7EA7\u4E0B\u8F7D\u5668\u4E0D\u53D7\u6B64\u9650\u5236)`,
    `\u{1F4C1}  /path_rules \u2014 \u4FDD\u5B58\u8DEF\u5F84/\u81EA\u5B9A\u4E49\u76EE\u5F55`,
    `\u{1F4E1}  /tg_sub \u2014 \u8BA2\u9605\u9891\u9053\u81EA\u52A8\u540C\u6B65`,
    `\u{1F4E6}  /tg_download \u2014 \u6309\u65E5\u671F/\u6807\u7B7E\u4E0B\u8F7D\u9891\u9053\u6587\u4EF6`,
    `\u2699\uFE0F  /download_workers \u2014 \u5355\u6587\u4EF6\u5206\u7247\u5E76\u53D1\u8BBE\u7F6E`,
    `\u{1F4E6}  /file_concurrency \u2014 \u540C\u65F6\u4E0B\u8F7D\u6587\u4EF6\u6570`,
    `\u{1F9EC}  /duplicate_mode \u2014 \u91CD\u590D\u6587\u4EF6\u5904\u7406`,
    `\u{1F9F9}  /cleanup_settings \u2014 \u81EA\u52A8\u6E05\u7406\u8BBE\u7F6E`,
    `\u{1F4CA}  /storage \u2014 \u5B58\u50A8\u7EDF\u8BA1/\u6E05\u7406\u672C\u5730\u6587\u4EF6`,
    `\u{1F527}  /tasks \u2014 \u5B9E\u65F6\u4EFB\u52A1\u961F\u5217`,
    `\u{1F510}  /setup_2fa \u2014 \u914D\u7F6E\u53CC\u91CD\u9A8C\u8BC1`,
    `\u{1F4E5}  /ytdlp \u2014 \u89E3\u6790\u5E76\u4E0B\u8F7D\u94FE\u63A5`,
    `\u2753  /help \u2014 \u5B8C\u6574\u5E2E\u52A9`
  ].join("\n");
}
function buildAuthSuccess() {
  return [
    `\u2705 **\u5BC6\u7801\u9A8C\u8BC1\u6210\u529F\uFF01**`,
    ``,
    `\u73B0\u5728\u60A8\u53EF\u4EE5\uFF1A`,
    `\u{1F4E4}  \u53D1\u9001/\u8F6C\u53D1\u4EFB\u610F\u6587\u4EF6\u4E0A\u4F20 (\u6700\u5927 2GB\uFF0C\u8D26\u53F7\u7EA7\u4E0B\u8F7D\u5668\u4E0D\u53D7\u6B64\u9650\u5236)`,
    `\u{1F4CA}  /storage \u2014 \u67E5\u770B\u5B58\u50A8\u7A7A\u95F4`
  ].join("\n");
}
function buildStartPrompt() {
  return `\u{1F44B} **\u6B22\u8FCE\u4F7F\u7528 TG Vault Bot\uFF01**

\u{1F510} \u8BF7\u4F7F\u7528\u4E0B\u65B9\u952E\u76D8\u8F93\u5165\u5BC6\u7801\uFF1A`;
}
function buildHelp() {
  return [
    `\u{1F4D6} **TG Vault Bot \u5E2E\u52A9**`,
    LINE,
    ``,
    `**\u{1F4E4} \u6587\u4EF6\u4E0A\u4F20**`,
    `  \u76F4\u63A5\u53D1\u9001\u6216\u8F6C\u53D1\u6587\u4EF6\u5373\u53EF\u81EA\u52A8\u4E0A\u4F20`,
    `  \u652F\u6301\u6240\u6709\u7C7B\u578B\uFF0C\u6700\u5927 2 GB\uFF0C\u8D26\u53F7\u7EA7\u4E0B\u8F7D\u5668\u4E0D\u53D7\u6B64\u9650\u5236`,
    `  \u591A\u6587\u4EF6\u540C\u65F6\u53D1\u9001\u4F1A\u81EA\u52A8\u5F52\u4E3A\u4E00\u7EC4`,
    ``,
    `**\u{1F6E0} \u53EF\u7528\u547D\u4EE4**`,
    `  /start \u2014 \u8EAB\u4EFD\u8BA4\u8BC1 / \u5F00\u59CB\u4F7F\u7528`,
    `  /setup\\_2fa \u2014 \u914D\u7F6E\u53CC\u91CD\u9A8C\u8BC1 (TOTP)`,
    `  /path_rules \u2014 \u4FDD\u5B58\u8DEF\u5F84/\u81EA\u5B9A\u4E49\u76EE\u5F55\u9762\u677F`,
    `  /p <\u76EE\u5F55> \u2014 \u4E0B\u4E00\u6B21\u4E0B\u8F7D\u4FDD\u5B58\u5230\u6307\u5B9A\u76EE\u5F55`,
    `  /ps <\u76EE\u5F55> \u2014 \u672C\u4F1A\u8BDD\u6301\u7EED\u4FDD\u5B58\u5230\u6307\u5B9A\u76EE\u5F55`,
    `  /pc \u2014 \u6E05\u9664\u81EA\u5B9A\u4E49\u76EE\u5F55`,
    `  /tg_sub <\u9891\u9053> \u2014 \u8BA2\u9605\u9891\u9053\u65B0\u6587\u4EF6\u81EA\u52A8\u540C\u6B65`,
    `  /tg_download \u2014 \u6309\u65E5\u671F/\u6807\u7B7E\u4E0B\u8F7D\u9891\u9053\u6587\u4EF6`,
    `  /tg_download date <\u9891\u9053> <\u5F00\u59CB\u65E5\u671F> <\u7ED3\u675F\u65E5\u671F> \u2014 \u6309\u65E5\u671F\u4E0B\u8F7D`,
    `  /tg_download tag <\u9891\u9053> <#\u6807\u7B7E> \u2014 \u6309\u6807\u7B7E\u4E0B\u8F7D`,
    `  /tg_download \u5411\u5BFC\u4E2D\u53EF\u9009\u62E9\u201C\u9891\u9053 + \u8BC4\u8BBA\u533A\u201D\uFF1B\u5F00\u542F\u540E\u53EA\u4E0B\u8F7D\u8BC4\u8BBA\u533A\u91CC\u7684\u6587\u4EF6/\u56FE\u7247/\u89C6\u9891/\u97F3\u9891\uFF0C\u6587\u5B57\u8BC4\u8BBA\u4F1A\u5FFD\u7565`,
    `  \u8BC4\u8BBA\u533A\u6BCF\u4E2A\u5E16\u5B50\u9ED8\u8BA4\u6700\u591A\u626B\u63CF ${process.env.TELEGRAM_COMMENTS_MAX_PER_POST || "200"} \u6761\u8BC4\u8BBA\uFF0C\u53EF\u7528 TELEGRAM_COMMENTS_MAX_PER_POST \u8C03\u6574`,
    `  /download_workers \u2014 \u8BBE\u7F6E\u5355\u6587\u4EF6\u5206\u7247\u5E76\u53D1`,
    `  /file_concurrency \u2014 \u8BBE\u7F6E\u540C\u65F6\u4E0B\u8F7D\u6587\u4EF6\u6570`,
    `  /duplicate_mode \u2014 \u8BBE\u7F6E\u91CD\u590D\u6587\u4EF6\u5904\u7406`,
    `  /cleanup_settings \u2014 \u8BBE\u7F6E\u81EA\u52A8\u6E05\u7406\u5F00\u5173`,
    `  /storage \u2014 \u5B58\u50A8\u7EDF\u8BA1/\u6E05\u7406\u672C\u5730\u6587\u4EF6`,
    `  /tasks \u2014 \u5B9E\u65F6\u4F20\u8F93\u4EFB\u52A1\u961F\u5217`,
    `  /ytdlp <url> \u2014 \u4E0B\u8F7D\u89C6\u9891\u94FE\u63A5\u5230\u5B58\u50A8`,
    `  /delete <ID\u6216\u5E8F\u53F7> \u2014 \u5220\u9664\u6307\u5B9A\u6587\u4EF6`,
    `  /help \u2014 \u663E\u793A\u6B64\u5E2E\u52A9`,
    ``,
    LINE,
    `\u{1F4A1} **\u63D0\u793A**\uFF1A\u8F6C\u53D1\u6587\u4EF6\u7ED9 Bot \u5373\u53EF\u5F00\u59CB\u4E0A\u4F20`
  ].join("\n");
}
function build2FASetupCaption() {
  return [
    `\u{1F510} **\u53CC\u91CD\u9A8C\u8BC1 (2FA) \u8BBE\u7F6E**`,
    ``,
    `1\uFE0F\u20E3 \u4F7F\u7528 Google Authenticator \u6216\u5176\u4ED6 2FA App \u626B\u63CF\u6B64\u4E8C\u7EF4\u7801`,
    `2\uFE0F\u20E3 \u626B\u63CF\u540E\u76F4\u63A5\u53D1\u9001 App \u751F\u6210\u7684 **6 \u4F4D\u9A8C\u8BC1\u7801**`,
    ``,
    `\u23F3 \u6FC0\u6D3B\u6210\u529F\u540E\u4E8C\u7EF4\u7801\u5C06\u81EA\u52A8\u5220\u9664`
  ].join("\n");
}
function buildStorageReport(data) {
  const usageBar = generateProgressBar(data.diskUsedPercent, 100, 12);
  return [
    `\u{1F4CA} **\u5B58\u50A8\u7A7A\u95F4\u7EDF\u8BA1**`,
    LINE,
    ``,
    `**\u{1F4BF} \u670D\u52A1\u5668\u78C1\u76D8**`,
    `  \u603B\u5BB9\u91CF\u3000${formatBytes(data.diskTotal)}`,
    `  \u5DF2\u4F7F\u7528\u3000${formatBytes(data.diskTotal - data.diskFree)} (${data.diskUsedPercent}%)`,
    `  \u53EF\u3000\u7528\u3000${formatBytes(data.diskFree)}`,
    `  ${usageBar}`,
    ``,
    `**\u{1F4C1} \u5B58\u50A8\u6E90\u6587\u4EF6**`,
    `  \u6587\u4EF6\u6570\u3000${data.fileCount} \u4E2A`,
    `  \u5360\u3000\u7528\u3000${formatBytes(data.totalFileSize)}`,
    ``,
    `**\u{1F5A5}\uFE0F \u672C\u5730\u670D\u52A1\u5668\u4E0B\u8F7D\u6587\u4EF6**`,
    `  \u6587\u4EF6\u6570\u3000${data.localFileCount} \u4E2A`,
    `  \u5360\u3000\u7528\u3000${formatBytes(data.localTotalSize)}`,
    `  \u4F4D\u7F6E\u3000uploads \u672C\u5730\u7F13\u5B58/\u4E0B\u8F7D\u76EE\u5F55`,
    ``,
    `**\u{1F4E1} \u4E0B\u8F7D\u961F\u5217**`,
    `  \u{1F504} \u5904\u7406\u4E2D ${data.queueActive}\u3000\u23F3 \u7B49\u5F85\u4E2D ${data.queuePending}`
  ].join("\n");
}
function buildTasksReport(active, pending, _history = []) {
  const lines = [
    `\u{1F4CB} **\u5B9E\u65F6\u4E0B\u8F7D\u961F\u5217**`,
    `\u{1F504} ${active.length} \u6B63\u5728\u4E0B\u8F7D\u3000\u23F3 ${pending.length} \u7B49\u5F85\u5F00\u59CB`,
    LINE
  ];
  if (active.length > 0) {
    lines.push("");
    lines.push(`**\u{1F504} \u6B63\u5728\u4E0B\u8F7D**`);
    active.forEach((task) => {
      lines.push(`  \u25B8 ${task.fileName}`);
      if (task.totalSize && task.downloadedSize) {
        const bar = generateProgressBar(task.downloadedSize, task.totalSize, 10);
        lines.push(`    ${bar}  (${formatBytes(task.downloadedSize)}/${formatBytes(task.totalSize)})`);
      } else {
        lines.push(`    \u4F20\u8F93\u4E2D\uFF0C\u8BF7\u7A0D\u5019...`);
      }
    });
  }
  if (pending.length > 0) {
    lines.push("");
    lines.push(`**\u23F3 \u7B49\u5F85\u5F00\u59CB** (\u524D 5 \u4E2A)`);
    pending.slice(0, 5).forEach((task, i) => {
      lines.push(`  ${i + 1}. ${task.fileName}`);
    });
    if (pending.length > 5) {
      lines.push(`  ... \u8FD8\u6709 ${pending.length - 5} \u4E2A\u7B49\u5F85\u4EFB\u52A1`);
    }
  }
  return lines.join("\n");
}
function buildUploadSuccess(fileName, size, fileType, providerName, folder) {
  const typeEmoji = getTypeEmoji(
    fileType === "image" ? "image/" : fileType === "video" ? "video/" : fileType === "audio" ? "audio/" : "other"
  );
  const bar = generateProgressBar(1, 1);
  return [
    `\u2705 **\u4E0A\u4F20\u6210\u529F\uFF01**`,
    `${bar}`,
    ``,
    `${typeEmoji} ${fileName}`,
    `\u{1F4E6} ${formatBytes(size)}`,
    `\u{1F4CD} ${getProviderDisplayName(providerName)}`,
    ...folder ? [`\u{1F4C1} ${folder}`] : []
  ].join("\n");
}
function buildUploadFail(fileName, error) {
  return [
    `\u274C **\u4E0A\u4F20\u5931\u8D25**`,
    ``,
    `\u{1F4C4} ${fileName}`,
    `\u539F\u56E0: ${error}`,
    ``,
    `\u{1F504} \u5927\u6587\u4EF6\u53EF\u80FD\u56E0\u7F51\u7EDC\u6CE2\u52A8\u3001Telegram \u9650\u6D41\u6216\u4E34\u65F6\u65AD\u6D41\u5931\u8D25\uFF1BBot \u5DF2\u81EA\u52A8\u91CD\u8BD5\u4E00\u6B21\u3002`,
    `\u{1F4A1} \u53EF\u91CD\u65B0\u53D1\u9001\u8BE5\u6587\u4EF6\uFF0C\u6216\u7528 /download_workers \u964D\u4F4E\u5E76\u53D1\u540E\u518D\u8BD5\u3002`
  ].join("\n");
}
function buildDuplicateSkipped(fileName, folder, existingId) {
  return [
    `\u23ED\uFE0F **\u5DF2\u8DF3\u8FC7\u91CD\u590D\u6587\u4EF6**`,
    ``,
    `\u{1F4C4} ${fileName}`,
    ...folder ? [`\u{1F4C1} ${folder}`] : [],
    ...existingId ? [`\u{1F194} \u5DF2\u5B58\u5728: ${existingId.substring(0, 8)}`] : [],
    ``,
    `\u5982\u9700\u4FDD\u7559\u526F\u672C\uFF0C\u8BF7\u53D1\u9001 /duplicate_mode \u5207\u6362\u4E3A\u201C\u751F\u6210\u526F\u672C\u201D\u3002`
  ].join("\n");
}
function buildDownloadProgress(fileName, downloaded, total, typeEmoji, startTime) {
  const bar = startTime ? generateProgressBarWithSpeed(downloaded, total, startTime) : generateProgressBar(downloaded, total);
  return [
    `\u23F3 **\u6B63\u5728\u4E0B\u8F7D**`,
    `${bar}`,
    ``,
    `${typeEmoji} ${fileName}`,
    `${formatBytes(downloaded)} / ${formatBytes(total)}`
  ].join("\n");
}
function buildSavingFile(fileName, typeEmoji) {
  const bar = generateProgressBar(1, 1);
  return [
    `\u{1F4BE} **\u6B63\u5728\u4FDD\u5B58...**`,
    `${bar}`,
    ``,
    `${typeEmoji} ${fileName}`
  ].join("\n");
}
function buildQueuedMessage(fileName, pendingCount) {
  return [
    `\u23F3 **\u5DF2\u52A0\u5165\u4E0B\u8F7D\u961F\u5217**`,
    ``,
    `\u{1F4C4} ${fileName}`,
    `\u{1F4CA} \u5F53\u524D\u6392\u961F: ${pendingCount} \u4E2A\u4EFB\u52A1`,
    `\u{1F4A1} Bot \u5C06\u6309\u987A\u5E8F\u5904\u7406\uFF0C\u8BF7\u8010\u5FC3\u7B49\u5F85`
  ].join("\n");
}
function buildRetryMessage(fileName, typeEmoji) {
  const bar = generateProgressBar(0, 1);
  return [
    `\u{1F504} **\u4E0A\u4F20\u5931\u8D25\uFF0C\u6B63\u5728\u91CD\u8BD5...**`,
    `${bar}`,
    ``,
    `${typeEmoji} ${fileName}`
  ].join("\n");
}
function buildDeleteSuccess(fileName, fileId) {
  return [
    `\u2705 **\u6587\u4EF6\u5DF2\u5220\u9664**`,
    ``,
    `\u{1F4C4} ${fileName}`,
    `\u{1F5D1}\uFE0F ID: ${fileId}`
  ].join("\n");
}
function buildSilentModeNotice(fileCount, taskId, queuePaused = false, pauseReason) {
  return [
    queuePaused ? `\u23F8\uFE0F **\u540E\u53F0\u4E0B\u8F7D\u5DF2\u6682\u505C**` : `\u{1F910} **\u5DF2\u5207\u6362\u5230\u9759\u9ED8\u6A21\u5F0F**`,
    ...taskId ? [`\u{1F194} \u4EFB\u52A1\uFF1A\`${taskId}\``] : [],
    ``,
    queuePaused ? `\u7B49\u5F85\u4EFB\u52A1\u5DF2\u6682\u505C\uFF0C\u4E0D\u4F1A\u7EE7\u7EED\u5F00\u59CB\u65B0\u7684\u4E0B\u8F7D\u3002` : `Bot \u5C06\u5728\u540E\u53F0\u7EE7\u7EED\u5904\u7406\u6240\u6709\u6587\u4EF6\uFF0C\u8BF7\u8010\u5FC3\u7B49\u5F85\u3002`,
    ``,
    ...buildTaskControlLines(taskId, queuePaused, pauseReason)
  ].join("\n");
}
function buildSilentProgress(sessionTotal, batches, singleFiles = [], sessionCompleted = 0, sessionFailed = 0, taskId, queuePaused = false, pauseReason) {
  const totalBatchFiles = batches.reduce((sum, batch) => sum + batch.totalFiles, 0);
  const completedBatchFiles = batches.reduce((sum, batch) => sum + batch.completed, 0);
  const successfulBatchFiles = batches.reduce((sum, batch) => sum + batch.successful, 0);
  const failedBatchFiles = batches.reduce((sum, batch) => sum + batch.failed, 0);
  const completedSingleFiles = singleFiles.filter((file) => file.phase === "success" || file.phase === "failed").length;
  const failedSingleFiles = singleFiles.filter((file) => file.phase === "failed").length;
  const totalFiles = Math.max(sessionTotal, totalBatchFiles + singleFiles.length, completedBatchFiles + completedSingleFiles, sessionCompleted);
  const completedFiles = Math.max(sessionCompleted, completedBatchFiles + completedSingleFiles);
  const failedFiles = Math.max(sessionFailed, failedBatchFiles + failedSingleFiles);
  const successfulFiles = Math.max(0, completedFiles - failedFiles);
  const remainingFiles = Math.max(0, totalFiles - completedFiles);
  const isComplete = totalFiles > 0 && remainingFiles === 0;
  const activeBatch = batches.find((batch) => batch.completed < batch.totalFiles);
  const activeSingle = singleFiles.find((file) => !["success", "failed"].includes(file.phase));
  const currentFile = activeBatch?.currentFileName || activeSingle?.fileName;
  const progress = generateProgressBar(completedFiles, Math.max(totalFiles, 1));
  if (isComplete) {
    return buildSilentAllTasksComplete(totalFiles, failedFiles, taskId, singleFiles, batches);
  }
  return [
    queuePaused ? `\u23F8\uFE0F **\u540E\u53F0\u4E0B\u8F7D\u5DF2\u6682\u505C**` : `\u{1F910} **\u540E\u53F0\u6279\u91CF\u5904\u7406\u4E2D**`,
    `${progress} (${completedFiles}/${totalFiles})`,
    ``,
    `\u2705 \u6210\u529F: ${successfulFiles}\u3000\u274C \u5931\u8D25: ${failedFiles}\u3000\u23F3 \u5269\u4F59: ${remainingFiles}`,
    ...currentFile ? [`\u{1F4C4} \u5F53\u524D: ${currentFile}`] : [],
    ...activeBatch ? [`\u{1F4C1} \u6279\u6B21: ${activeBatch.folderName}`] : [],
    ...activeBatch?.queuePending ? [`\u{1F552} \u961F\u5217\u7B49\u5F85: ${activeBatch.queuePending}`] : [],
    ``,
    ...buildTaskControlLines(taskId, queuePaused, pauseReason),
    ...taskId && failedFiles > 0 && remainingFiles === 0 ? [`\u{1F504} \u68C0\u6D4B\u5230\u5931\u8D25\u4EFB\u52A1\uFF0C\u53EF\u53D1\u9001 /tg_retry ${taskId} \u91CD\u8BD5\u6700\u8FD1\u5931\u8D25\u9879`] : []
  ].join("\n");
}
function buildSilentAllTasksComplete(totalCount, failedCount, taskId, singleFiles = [], batches = []) {
  const successCount = Math.max(0, totalCount - failedCount);
  const providers = /* @__PURE__ */ new Set();
  singleFiles.filter((f) => f.phase === "success" && f.providerName).forEach((f) => providers.add(f.providerName));
  batches.filter((b) => b.providerName).forEach((b) => providers.add(b.providerName));
  const folders = collectCompletedFolders(singleFiles, batches);
  const detailLines = [
    ...providers.size > 0 ? [`\u{1F4CD} \u5B58\u50A8: ${Array.from(providers).map((p) => getProviderDisplayName(p)).join(", ")}`] : [],
    ...formatFolderSummary(folders)
  ];
  if (failedCount > 0) {
    return [
      `\u26A0\uFE0F **\u540E\u53F0\u4EFB\u52A1\u90E8\u5206\u5B8C\u6210**`,
      ``,
      ...taskId ? [`\u{1F194} \u4EFB\u52A1\uFF1A\`${taskId}\``] : [],
      `\u2705 \u6210\u529F: ${successCount} \u4E2A\u6587\u4EF6`,
      `\u274C \u5931\u8D25: ${failedCount} \u4E2A\u6587\u4EF6`,
      `\u{1F4CA} \u603B\u8BA1: ${totalCount} \u4E2A\u6587\u4EF6`,
      ...detailLines,
      ``,
      ...taskId ? [`\u{1F504} \u68C0\u6D4B\u5230\u5931\u8D25\u4EFB\u52A1\uFF0C\u53D1\u9001 /tg_retry ${taskId} \u91CD\u8BD5\u6700\u8FD1\u5931\u8D25\u9879`] : []
    ].join("\n");
  }
  return [`\u2705 **\u540E\u53F0\u4EFB\u52A1\u5168\u90E8\u5B8C\u6210**`, ``, ...taskId ? [`\u{1F194} \u4EFB\u52A1\uFF1A\`${taskId}\``] : [], `\u{1F4CA} \u603B\u8BA1: ${totalCount} \u4E2A\u6587\u4EF6`, ...detailLines].join("\n");
}
async function buildConsolidatedStatus(singleFiles, batches) {
  const totalSingle = singleFiles.length;
  const totalBatches = batches.length;
  const totalTasks = totalSingle + totalBatches;
  const singleCompleted = singleFiles.filter((f) => f.phase === "success" || f.phase === "failed").length;
  const batchCompleted = batches.filter((b) => b.completed === b.totalFiles).length;
  const allCompleted = singleCompleted + batchCompleted === totalTasks;
  let statusIcon = "\u{1F4E6}";
  let statusText = `\u6B63\u5728\u5904\u7406 ${totalTasks} \u4E2A\u4EFB\u52A1...`;
  if (allCompleted && totalTasks > 0) {
    const successfulSingles = singleFiles.filter((f) => f.phase === "success").length;
    const failedSingles = singleFiles.filter((f) => f.phase === "failed").length;
    const successfulBatches = batches.reduce((sum, b) => sum + (b.successful || 0), 0);
    const failedBatches = batches.reduce((sum, b) => sum + (b.failed || 0), 0);
    const totalSuccessful = successfulSingles + successfulBatches;
    const totalFailed = failedSingles + failedBatches;
    const totalSize = [...singleFiles.filter((f) => f.phase === "success"), ...batches.flatMap((b) => [])].reduce((sum, f) => sum + (f.size || 0), 0);
    statusIcon = totalFailed === 0 ? "\u{1F389}" : "\u26A0\uFE0F";
    statusText = totalFailed === 0 ? "\u4EFB\u52A1\u5168\u90E8\u5B8C\u6210\uFF01" : `\u4EFB\u52A1\u5B8C\u6210 (${totalFailed} \u4E2A\u5931\u8D25)`;
  }
  const lines = [
    `${statusIcon} **${statusText}**`,
    ""
  ];
  if (allCompleted && totalTasks > 0) {
    const successfulSingles = singleFiles.filter((f) => f.phase === "success").length;
    const failedSingles = singleFiles.filter((f) => f.phase === "failed").length;
    const successfulBatches = batches.reduce((sum, b) => sum + (b.successful || 0), 0);
    const failedBatches = batches.reduce((sum, b) => sum + (b.failed || 0), 0);
    const totalSuccessful = successfulSingles + successfulBatches;
    const totalFailed = failedSingles + failedBatches;
    const totalSize = [...singleFiles.filter((f) => f.phase === "success"), ...batches.flatMap((b) => [])].reduce((sum, f) => sum + (f.size || 0), 0);
    lines.push("\u{1F4CA} **\u5B8C\u6210\u6458\u8981**");
    lines.push(LINE);
    lines.push(`\u2705 \u6210\u529F: ${totalSuccessful} \u4E2A\u6587\u4EF6`);
    if (totalFailed > 0) {
      lines.push(`\u274C \u5931\u8D25: ${totalFailed} \u4E2A\u6587\u4EF6`);
    }
    if (totalSize > 0) {
      lines.push(`\u{1F4E6} \u603B\u5927\u5C0F: ${formatBytes(totalSize)}`);
    }
    const providers = /* @__PURE__ */ new Set();
    singleFiles.filter((f) => f.phase === "success" && f.providerName).forEach((f) => providers.add(f.providerName));
    batches.filter((b) => b.providerName).forEach((b) => providers.add(b.providerName));
    if (providers.size > 0) {
      lines.push(`\u{1F4CD} \u5B58\u50A8: ${Array.from(providers).map((p) => getProviderDisplayName(p)).join(", ")}`);
    }
    const folders = collectCompletedFolders(singleFiles, batches);
    lines.push(...formatFolderSummary(folders));
    lines.push("");
    lines.push(`\u23F0 \u5B8C\u6210\u65F6\u95F4: ${(/* @__PURE__ */ new Date()).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    })}`);
    if (totalFailed > 0) {
      lines.push("");
      lines.push("\u{1F9F9} **\u81EA\u52A8\u6E05\u7406\u5DF2\u5173\u95ED**");
      lines.push("  \u5931\u8D25\u4EA7\u751F\u7684\u672C\u5730\u4E34\u65F6\u6587\u4EF6\u4E0D\u4F1A\u5728\u8FD9\u91CC\u81EA\u52A8\u5220\u9664\u3002");
      lines.push("  \u5982\u9700\u6E05\u7406\uFF0C\u8BF7\u5148\u786E\u8BA4\u6587\u4EF6\u72B6\u6001\u540E\u624B\u52A8\u5904\u7406\u3002");
    }
    lines.push("");
    if (totalFailed === 0) {
      lines.push("\u{1F38A} \u6240\u6709\u6587\u4EF6\u5DF2\u5B89\u5168\u4E0A\u4F20\u5230\u4E91\u7AEF\uFF01");
      lines.push("\u{1F4A1} \u60A8\u53EF\u4EE5\u968F\u65F6\u4F7F\u7528 /list \u67E5\u770B\u4E0A\u4F20\u8BB0\u5F55");
    } else {
      lines.push("\u{1F4A1} \u90E8\u5206\u6587\u4EF6\u4E0A\u4F20\u5931\u8D25\uFF0C\u672A\u81EA\u52A8\u6E05\u7406\u670D\u52A1\u5668\u7F13\u5B58");
      lines.push("\u{1F504} \u60A8\u53EF\u4EE5\u91CD\u65B0\u53D1\u9001\u5931\u8D25\u7684\u6587\u4EF6");
    }
    lines.push("");
  }
  const activeSingles = singleFiles.filter((f) => f.phase === "downloading" || f.phase === "saving" || f.phase === "retrying");
  const queuedSingles = singleFiles.filter((f) => f.phase === "queued");
  const doneSingles = singleFiles.filter((f) => f.phase === "success" || f.phase === "failed");
  const activeBatches = batches.filter((b) => b.completed < b.totalFiles);
  const doneBatches = batches.filter((b) => b.completed === b.totalFiles);
  if (activeSingles.length > 0) {
    activeSingles.forEach((file) => {
      let icon;
      let detail;
      switch (file.phase) {
        case "downloading":
          icon = "\u2B07\uFE0F";
          if (file.downloaded !== void 0 && file.total) {
            const pct = Math.round(file.downloaded / file.total * 100);
            const progressBar = generateProgressBar(file.downloaded, file.total);
            detail = `${progressBar} ${pct}%`;
          } else {
            detail = "\u4E0B\u8F7D\u4E2D...";
          }
          break;
        case "saving":
          icon = "\u{1F4BE}";
          detail = "\u4FDD\u5B58...";
          break;
        case "success":
          icon = "\u2705";
          const parts = [];
          if (file.size) parts.push(formatBytes(file.size));
          if (file.folder) parts.push(`\u{1F4C1} ${file.folder}`);
          detail = parts.join(" \xB7 ") || "\u5B8C\u6210";
          break;
        case "failed":
          icon = "\u274C";
          detail = file.error || "\u5931\u8D25";
          break;
        case "retrying":
          icon = "\u{1F504}";
          detail = "\u91CD\u8BD5...";
          break;
        case "queued":
        default:
          icon = "\u{1F552}";
          detail = "\u6392\u961F";
          break;
      }
      lines.push(`${icon} ${file.typeEmoji} ${file.fileName}`);
      lines.push(`    \u2514 ${detail}`);
    });
  }
  if ((activeBatches.length > 0 || doneBatches.length > 0) && !allCompleted) {
    if (activeSingles.length > 0) lines.push("");
    [...activeBatches, ...doneBatches].forEach((batch) => {
      const isDone = batch.completed === batch.totalFiles;
      const icon = isDone ? batch.failed === 0 ? "\u2705" : "\u26A0\uFE0F" : "\u{1F4C2}";
      lines.push(`${icon} \u{1F4C1} ${batch.folderName}`);
      if (!isDone) {
        const progress = generateProgressBar(batch.completed, batch.totalFiles);
        lines.push(`    ${progress} (${batch.completed}/${batch.totalFiles})`);
        if (batch.currentFileName) {
          lines.push(`    \u{1F4C4} \u5F53\u524D: ${batch.currentFileName}`);
        }
      } else {
        lines.push(`    \u2705 ${batch.successful}  \u274C ${batch.failed}`);
      }
      if (batch.queuePending && batch.queuePending > 0 && !isDone) {
        lines.push(`    \u23F3 \u961F\u5217: ${batch.queuePending}`);
      }
      if (batch.providerName && isDone) {
        lines.push(`    \u{1F4CD} ${getProviderDisplayName(batch.providerName)}`);
      }
      if (batch.folderPath && isDone) {
        lines.push(`    \u{1F4C1} ${batch.folderPath}`);
      }
    });
  }
  if (queuedSingles.length > 0) {
    if (activeSingles.length > 0 || totalBatches > 0) lines.push("");
    queuedSingles.forEach((file) => {
      lines.push(`\u{1F552} ${file.typeEmoji} ${file.fileName}`);
      lines.push(`    \u2514 \u6392\u961F`);
    });
  }
  if (doneSingles.length > 0 && !allCompleted) {
    if (activeSingles.length > 0 || totalBatches > 0 || queuedSingles.length > 0) lines.push("");
    doneSingles.forEach((file) => {
      let icon;
      let detail;
      switch (file.phase) {
        case "success":
          icon = "\u2705";
          const parts = [];
          if (file.size) parts.push(formatBytes(file.size));
          if (file.folder) parts.push(`\u{1F4C1} ${file.folder}`);
          detail = parts.join(" \xB7 ") || "\u5B8C\u6210";
          break;
        case "failed":
        default:
          icon = "\u274C";
          detail = file.error || "\u5931\u8D25";
          break;
      }
      lines.push(`${icon} ${file.typeEmoji} ${file.fileName}`);
      lines.push(`    \u2514 ${detail}`);
    });
  }
  return lines.join("\n");
}
function buildCleanupNotice(deletedCount, freedSpace) {
  return [
    `\u{1F9F9} **\u7CFB\u7EDF\u542F\u52A8\u6E05\u7406\u5B8C\u6210**`,
    ``,
    `\u{1F4CA} \u6E05\u7406\u7EDF\u8BA1\uFF1A`,
    `  \u5220\u9664\u5B64\u513F\u6587\u4EF6: ${deletedCount} \u4E2A`,
    `  \u91CA\u653E\u7A7A\u95F4: ${freedSpace}`,
    ``,
    `\u{1F4A1} \u8FD9\u4E9B\u662F\u4E4B\u524D\u4E0A\u4F20\u5931\u8D25\u6B8B\u7559\u7684\u6587\u4EF6`
  ].join("\n");
}

// src/services/telegramUpload.ts
init_db();
import { Api as Api4 } from "telegram";
import fs7 from "fs";
import path10 from "path";
import crypto6 from "crypto";
import bigInt from "big-integer";

// src/utils/thumbnail.ts
import path6 from "path";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import fs5 from "fs";
import crypto5 from "crypto";
var THUMBNAIL_DIR = path6.resolve(process.env.THUMBNAIL_DIR || "./data/thumbnails");
if (!fs5.existsSync(THUMBNAIL_DIR)) {
  fs5.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}
var PREVIEW_DIR = path6.resolve(process.env.PREVIEW_DIR || "./data/previews");
if (!fs5.existsSync(PREVIEW_DIR)) {
  fs5.mkdirSync(PREVIEW_DIR, { recursive: true });
}
function isMp4Like(mimeType, filePath) {
  const lower = filePath.toLowerCase();
  return mimeType === "video/mp4" || lower.endsWith(".mp4") || lower.endsWith(".m4v") || lower.endsWith(".mov");
}
function ffmpegRun(command, label) {
  return new Promise((resolve, reject) => {
    command.on("start", (cmd) => console.log(`[Preview] ${label} CMD: ${cmd}`)).on("end", () => resolve()).on("error", (err) => reject(err)).run();
  });
}
async function generateMediaPreview(filePath, storedName, mimeType) {
  const absFilePath = path6.resolve(filePath);
  if (!fs5.existsSync(absFilePath)) return null;
  try {
    if (mimeType.startsWith("image/") && mimeType !== "image/gif") {
      const previewName = `preview_${crypto5.randomUUID()}.webp`;
      const previewPath = path6.join(PREVIEW_DIR, previewName);
      await sharp(absFilePath).rotate().resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).webp({ quality: 86, effort: 4 }).toFile(previewPath);
      console.log(`[Preview] \u2705 Image preview created: ${previewName}`);
      return previewPath;
    }
    if (mimeType.startsWith("video/")) {
      const previewName = `preview_${crypto5.randomUUID()}.mp4`;
      const previewPath = path6.join(PREVIEW_DIR, previewName);
      const mp4Like = isMp4Like(mimeType, storedName || absFilePath);
      if (mp4Like) {
        try {
          await ffmpegRun(
            ffmpeg(absFilePath).outputOptions(["-c copy", "-movflags +faststart"]).output(previewPath),
            "Video faststart"
          );
          if (fs5.existsSync(previewPath) && fs5.statSync(previewPath).size > 0) {
            console.log(`[Preview] \u2705 Video faststart preview created: ${previewName}`);
            return previewPath;
          }
        } catch (copyError) {
          console.warn(`[Preview] \u26A0\uFE0F Faststart copy failed, fallback to transcode: ${copyError.message}`);
          try {
            if (fs5.existsSync(previewPath)) fs5.unlinkSync(previewPath);
          } catch {
          }
        }
      }
      await ffmpegRun(
        ffmpeg(absFilePath).videoCodec("libx264").audioCodec("aac").size("?x720").outputOptions([
          "-preset veryfast",
          "-crf 23",
          "-movflags +faststart",
          "-pix_fmt yuv420p",
          "-profile:v baseline",
          "-level 3.1",
          "-b:a 128k"
        ]).output(previewPath),
        "Video transcode"
      );
      if (fs5.existsSync(previewPath) && fs5.statSync(previewPath).size > 0) {
        console.log(`[Preview] \u2705 Video transcoded preview created: ${previewName}`);
        return previewPath;
      }
    }
  } catch (error) {
    console.error(`[Preview] \u274C Generate preview failed for ${storedName}:`, error.message);
  }
  return null;
}
async function generateThumbnail(filePath, storedName, mimeType) {
  const absFilePath = path6.resolve(filePath);
  const thumbName = `thumb_${crypto5.randomUUID()}.webp`;
  const thumbPath = path6.join(THUMBNAIL_DIR, thumbName);
  console.log(`[Thumbnail] \u{1F680} Starting generation for: ${storedName}`);
  console.log(`[Thumbnail] Source: ${absFilePath}`);
  console.log(`[Thumbnail] Target: ${thumbPath}`);
  console.log(`[Thumbnail] MIME: ${mimeType}`);
  if (!fs5.existsSync(absFilePath)) {
    console.error(`[Thumbnail] \u274C Source file does not exist: ${absFilePath}`);
    return null;
  }
  if (mimeType === "image/gif") {
    console.log(`[Thumbnail] \u23E9 Skipping GIF to preserve animation`);
    return null;
  }
  try {
    if (mimeType.startsWith("image/")) {
      console.log(`[Thumbnail] \u{1F5BC}\uFE0F  Processing image with Sharp...`);
      await sharp(absFilePath).resize(400, 300, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbPath);
      console.log(`[Thumbnail] \u2705 Image thumbnail created: ${thumbName}`);
      return thumbPath;
    } else if (mimeType.startsWith("video/")) {
      console.log(`[Thumbnail] \u{1F3AC} Processing video with Ffmpeg...`);
      const tryScreenshot = (timestamp) => {
        return new Promise((resolve) => {
          console.log(`[Thumbnail] \u{1F4F8} Attempting screenshot at ${timestamp}`);
          ffmpeg(absFilePath).screenshots({
            count: 1,
            folder: THUMBNAIL_DIR,
            filename: thumbName,
            size: "400x300",
            timestamps: [timestamp]
          }).on("start", (cmd) => console.log(`[Thumbnail] FFmpeg CMD: ${cmd}`)).on("end", () => {
            if (fs5.existsSync(thumbPath)) {
              console.log(`[Thumbnail] \u2705 Video thumbnail created at ${timestamp}`);
              resolve(true);
            } else {
              console.warn(`[Thumbnail] \u26A0\uFE0F  FFmpeg finished but file not found at ${timestamp}`);
              resolve(false);
            }
          }).on("error", (err) => {
            console.error(`[Thumbnail] \u274C FFmpeg error at ${timestamp}:`, err.message);
            resolve(false);
          });
        });
      };
      let success = await tryScreenshot("10%");
      if (!success) {
        console.log(`[Thumbnail] \u{1F504} Retrying at 1s mark...`);
        success = await tryScreenshot("00:00:01");
      }
      if (success) {
        return thumbPath;
      }
    }
  } catch (error) {
    console.error(`[Thumbnail] \u274C Unexpected error:`, error.message);
  }
  return null;
}
async function getImageDimensions(filePath, mimeType) {
  const absFilePath = path6.resolve(filePath);
  console.log(`[Dimensions] \u{1F4CF} Getting dimensions for: ${absFilePath} (${mimeType})`);
  try {
    if (mimeType.startsWith("image/")) {
      const metadata = await sharp(absFilePath).metadata();
      const result = { width: metadata.width || 0, height: metadata.height || 0 };
      console.log(`[Dimensions] \u2705 Image dimensions: ${result.width}x${result.height}`);
      return result;
    } else if (mimeType.startsWith("video/")) {
      return new Promise((resolve) => {
        ffmpeg.ffprobe(absFilePath, (err, metadata) => {
          if (err) {
            console.error(`[Dimensions] \u274C Probe failed:`, err.message);
            resolve({ width: 0, height: 0 });
          } else {
            const stream = metadata.streams.find((s) => s.width && s.height);
            const result = {
              width: stream?.width || 0,
              height: stream?.height || 0
            };
            console.log(`[Dimensions] \u2705 Video dimensions: ${result.width}x${result.height}`);
            resolve(result);
          }
        });
      });
    }
  } catch (error) {
    console.error("Get dimensions failed:", error);
  }
  return { width: 0, height: 0 };
}

// src/services/telegramUpload.ts
init_storage();

// src/services/telegramUserClient.ts
import fs6 from "fs";
import path7 from "path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
var userClient = null;
var userSessionFilePath = "";
function getUserApiId() {
  return parseInt(process.env.TELEGRAM_API_ID || "0");
}
function getUserApiHash() {
  return process.env.TELEGRAM_API_HASH || "";
}
function getSessionFilePath() {
  return process.env.TELEGRAM_USER_SESSION_FILE || "./data/telegram_user_session.txt";
}
async function initTelegramUserClient() {
  const apiId = getUserApiId();
  const apiHash = getUserApiHash();
  if (!apiId || !apiHash) {
    console.log("\u26A0\uFE0F \u672A\u914D\u7F6E Telegram \u7528\u6237\u8D26\u53F7\u4E0B\u8F7D\u5668\uFF0C\u8DF3\u8FC7 user client \u521D\u59CB\u5316");
    return;
  }
  userSessionFilePath = getSessionFilePath();
  const sessionDir = path7.dirname(userSessionFilePath);
  if (!fs6.existsSync(sessionDir)) {
    fs6.mkdirSync(sessionDir, { recursive: true, mode: 448 });
  }
  const sessionString = fs6.existsSync(userSessionFilePath) ? fs6.readFileSync(userSessionFilePath, "utf-8").trim() : "";
  if (!sessionString) {
    console.log("\u26A0\uFE0F Telegram \u7528\u6237 session \u4E3A\u7A7A\uFF0C\u5148\u8FD0\u884C\u767B\u5F55\u811A\u672C\u751F\u6210 session \u540E\u518D\u542F\u7528 user client");
    return;
  }
  userClient = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 15,
    retryDelay: 2e3,
    useWSS: false,
    deviceModel: "TG Vault User Downloader",
    systemVersion: "1.0.0",
    appVersion: "1.0.0",
    floodSleepThreshold: 120
  });
  await userClient.connect();
  if (!await userClient.checkAuthorization()) {
    console.log("\u26A0\uFE0F Telegram \u7528\u6237 session \u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF0Cuser client \u672A\u542F\u7528");
    userClient = null;
    return;
  }
  fs6.writeFileSync(userSessionFilePath, userClient.session.save(), { mode: 384 });
  fs6.chmodSync(userSessionFilePath, 384);
  console.log("\u{1F916} Telegram \u7528\u6237\u8D26\u53F7\u4E0B\u8F7D\u5668\u5DF2\u8FDE\u63A5");
}
function getTelegramUserClient() {
  return userClient;
}
function isTelegramUserClientReady() {
  return Boolean(userClient?.connected);
}
function getTelegramUserSessionFilePath() {
  return userSessionFilePath || getSessionFilePath();
}

// src/utils/telegramMedia.ts
import { Api as Api2 } from "telegram";
function getDownloadableMedia(message) {
  if (!message.media) return null;
  const media = message.media;
  if (message.sticker) return null;
  if (message.document || message.photo || message.video || message.audio || message.voice) {
    return message.media;
  }
  if (media.document || media.photo) {
    return media.document || media.photo;
  }
  if (media.webpage?.document || media.webpage?.photo) {
    return media.webpage.document || media.webpage.photo;
  }
  return null;
}
function isTelegramPhotoMedia(media) {
  const inner = media?.photo || media;
  return media?.className === "MessageMediaPhoto" || inner?.className === "Photo" || Boolean(inner?.sizes);
}
function getEstimatedFileSize(message) {
  const media = getDownloadableMedia(message);
  if (isTelegramPhotoMedia(media)) {
    return 0;
  }
  const document = media?.document || media;
  if (document?.size) {
    return Number(document.size) || 0;
  }
  return 0;
}
function getDocumentFilename(document, fallback) {
  const fileNameAttr = document.attributes?.find((a) => a.className === "DocumentAttributeFilename");
  return fileNameAttr?.fileName || fallback;
}
function extractFileInfo(message) {
  const downloadableMedia = getDownloadableMedia(message);
  if (!downloadableMedia) return null;
  let fileName = "unknown";
  let mimeType = "application/octet-stream";
  try {
    if (message.document) {
      const doc = message.document;
      const fileNameAttr = doc.attributes?.find((a) => a.className === "DocumentAttributeFilename");
      fileName = fileNameAttr?.fileName || `file_${message.id}`;
      mimeType = doc.mimeType || getMimeTypeFromFilename(fileName);
      if (fileName.startsWith("file_")) {
        const videoAttr = doc.attributes?.find((a) => a.className === "DocumentAttributeVideo");
        const audioAttr = doc.attributes?.find((a) => a.className === "DocumentAttributeAudio");
        if (videoAttr) fileName = `video_${message.id}.mp4`;
        else if (audioAttr) fileName = `audio_${message.id}.mp3`;
      }
    } else if (message.photo) {
      const date = new Date((message.date || Math.floor(Date.now() / 1e3)) * 1e3);
      const timestamp = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
      fileName = `Img_${timestamp}_${message.id}.jpg`;
      mimeType = "image/jpeg";
    } else if (message.video) {
      const video = message.video;
      const fileNameAttr = video.attributes?.find((a) => a.className === "DocumentAttributeFilename");
      fileName = fileNameAttr?.fileName || `video_${message.id}.mp4`;
      mimeType = video.mimeType || "video/mp4";
    } else if (message.audio) {
      const audio = message.audio;
      const fileNameAttr = audio.attributes?.find((a) => a.className === "DocumentAttributeFilename");
      fileName = fileNameAttr?.fileName || `audio_${message.id}.mp3`;
      mimeType = audio.mimeType || "audio/mpeg";
    } else if (message.voice) {
      fileName = `voice_${message.id}.ogg`;
      mimeType = "audio/ogg";
    } else {
      const media = message.media;
      if (media.document && media.document instanceof Api2.Document) {
        const doc = media.document;
        const fileNameAttr = doc.attributes?.find((a) => a.className === "DocumentAttributeFilename");
        fileName = fileNameAttr?.fileName || `file_${message.id}`;
        mimeType = doc.mimeType || getMimeTypeFromFilename(fileName);
      } else {
        const document = downloadableMedia.document || downloadableMedia;
        const photo = downloadableMedia.photo || downloadableMedia;
        if (document?.className === "Document" || document?.attributes) {
          fileName = getDocumentFilename(document, `file_${message.id}`);
          mimeType = document.mimeType || getMimeTypeFromFilename(fileName);
        } else if (photo?.className === "Photo" || photo?.sizes) {
          const date = new Date((message.date || Math.floor(Date.now() / 1e3)) * 1e3);
          const timestamp = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
          fileName = `Img_${timestamp}_${message.id}.jpg`;
          mimeType = "image/jpeg";
        } else {
          return null;
        }
      }
    }
  } catch (e) {
    console.error("\u{1F916} \u63D0\u53D6\u6587\u4EF6\u4FE1\u606F\u51FA\u9519:", e);
    return null;
  }
  return { fileName: sanitizeFilename(fileName), mimeType };
}

// src/utils/fileUtils.ts
init_db();
import path8 from "path";
async function getUniqueStoredName(originalName, folder = null, storageAccountId = null) {
  const sanitizedName = sanitizeFilename(originalName);
  const ext = path8.extname(sanitizedName);
  const baseName = ext ? sanitizedName.slice(0, -ext.length) : sanitizedName;
  let currentName = sanitizedName;
  let counter = 1;
  let exists = true;
  while (exists) {
    let checkQuery = "";
    let params = [];
    if (storageAccountId) {
      checkQuery = "SELECT COUNT(*)::int as cnt FROM files WHERE stored_name = $1 AND folder IS NOT DISTINCT FROM $2 AND storage_account_id = $3";
      params = [currentName, folder, storageAccountId];
    } else {
      checkQuery = "SELECT COUNT(*)::int as cnt FROM files WHERE stored_name = $1 AND folder IS NOT DISTINCT FROM $2 AND source = 'local'";
      params = [currentName, folder];
    }
    const result = await query(checkQuery, params);
    const count = result.rows[0]?.cnt || 0;
    if (count === 0) {
      exists = false;
    } else {
      currentName = `${baseName} (${counter})${ext}`;
      counter++;
    }
  }
  return currentName;
}

// src/utils/storagePath.ts
import path9 from "path";
function shouldClassifyStoragePath() {
  return true;
}
function getTypeFolder(mimeType) {
  const type = getFileType(mimeType || "");
  const map = {
    image: "images",
    video: "videos",
    audio: "audio",
    document: "documents"
  };
  return map[type] || null;
}
function hasAny(value, keywords) {
  return keywords.some((keyword) => value.includes(keyword));
}
function getDetailedTypeFolder(mimeType, fileName) {
  const lowerMime = (mimeType || "").toLowerCase();
  const ext = path9.extname(fileName || "").toLowerCase();
  const installerExts = /* @__PURE__ */ new Set([
    ".apk",
    ".apks",
    ".aab",
    ".ipa",
    ".exe",
    ".msi",
    ".msix",
    ".appx",
    ".appxbundle",
    ".dmg",
    ".pkg",
    ".deb",
    ".rpm",
    ".appimage",
    ".snap",
    ".run",
    ".bin",
    ".sh",
    ".bat",
    ".cmd",
    ".iso",
    ".img"
  ]);
  const imageExts = /* @__PURE__ */ new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif", ".tif", ".tiff", ".avif", ".ico"]);
  const rawImageExts = /* @__PURE__ */ new Set([".raw", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".orf", ".rw2"]);
  const videoExts = /* @__PURE__ */ new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".flv", ".wmv", ".mpeg", ".mpg", ".ts", ".m2ts", ".3gp"]);
  const audioExts = /* @__PURE__ */ new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma", ".aiff", ".alac"]);
  const archiveExts = /* @__PURE__ */ new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".zst", ".lz", ".lzma", ".cab"]);
  const codeExts = /* @__PURE__ */ new Set([".js", ".jsx", ".ts", ".tsx", ".py", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".env", ".sql", ".html", ".css", ".scss", ".sass", ".less", ".java", ".go", ".rs", ".php", ".rb", ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".cs", ".swift", ".kt", ".kts", ".dart", ".lua", ".pl", ".r", ".sh", ".bat", ".cmd", ".ps1", ".vue", ".svelte"]);
  const textExts = /* @__PURE__ */ new Set([".txt", ".md", ".markdown", ".rtf", ".log", ".nfo"]);
  const spreadsheetExts = /* @__PURE__ */ new Set([".xls", ".xlsx", ".xlsm", ".ods", ".csv", ".tsv", ".numbers"]);
  const presentationExts = /* @__PURE__ */ new Set([".ppt", ".pptx", ".pps", ".ppsx", ".odp", ".key"]);
  const wordExts = /* @__PURE__ */ new Set([".doc", ".docx", ".odt", ".pages"]);
  const ebookExts = /* @__PURE__ */ new Set([".epub", ".mobi", ".azw", ".azw3", ".fb2", ".cbz", ".cbr"]);
  const fontExts = /* @__PURE__ */ new Set([".ttf", ".otf", ".woff", ".woff2", ".eot"]);
  const designExts = /* @__PURE__ */ new Set([".psd", ".ai", ".sketch", ".fig", ".xd", ".indd", ".svg"]);
  const torrentExts = /* @__PURE__ */ new Set([".torrent", ".magnet"]);
  if (installerExts.has(ext) || lowerMime.includes("android.package-archive") || lowerMime.includes("apple.installer") || lowerMime.includes("x-msdownload") || lowerMime.includes("x-msi") || lowerMime.includes("x-apple-diskimage") || lowerMime.includes("x-debian-package") || lowerMime.includes("x-rpm") || lowerMime.includes("x-iso9660-image") || lowerMime.includes("executable")) return "apps";
  if (imageExts.has(ext) || lowerMime.startsWith("image/")) return "images";
  if (rawImageExts.has(ext)) return "raw-images";
  if (videoExts.has(ext) || lowerMime.startsWith("video/")) return "videos";
  if (audioExts.has(ext) || lowerMime.startsWith("audio/")) return "audio";
  if (fontExts.has(ext) || lowerMime.includes("font") || lowerMime.includes("opentype")) return "fonts";
  if (designExts.has(ext) || hasAny(lowerMime, ["photoshop", "illustrator", "figma", "sketch"])) return "design";
  if (torrentExts.has(ext) || lowerMime.includes("bittorrent")) return "torrents";
  if (lowerMime.includes("epub") || lowerMime.includes("mobi") || ebookExts.has(ext)) return "ebooks";
  if (lowerMime.includes("pdf") || ext === ".pdf") return "pdfs";
  if (lowerMime.includes("zip") || lowerMime.includes("rar") || lowerMime.includes("7z") || lowerMime.includes("tar") || lowerMime.includes("gzip") || lowerMime.includes("compressed") || archiveExts.has(ext)) return "archives";
  if (lowerMime.includes("spreadsheet") || lowerMime.includes("excel") || spreadsheetExts.has(ext)) return "spreadsheets";
  if (lowerMime.includes("presentation") || lowerMime.includes("powerpoint") || presentationExts.has(ext)) return "presentations";
  if (lowerMime.includes("word") || wordExts.has(ext)) return "word-docs";
  if (lowerMime.includes("javascript") || lowerMime.includes("typescript") || lowerMime.includes("python") || lowerMime.includes("json") || lowerMime.includes("xml") || lowerMime.includes("sql") || codeExts.has(ext)) return "code";
  if (lowerMime.startsWith("text/") || textExts.has(ext)) return "text";
  return getTypeFolder(mimeType);
}
async function getStoragePathRules() {
  return { bySource: true, byType: true };
}
function normalizeSegment(value, fallback) {
  const cleaned = sanitizeFilename((value || fallback).trim()).replace(/^\.+/, "_");
  return cleaned.replace(/^\.+$/, fallback) || fallback;
}
function getEntityDisplayName(entity) {
  if (!entity) return null;
  const personalName = [entity.firstName, entity.lastName].filter(Boolean).join(" ");
  return entity.title || personalName || entity.username || null;
}
function addUniqueSegment(segments, value, fallback) {
  const segment = normalizeSegment(value, fallback);
  if (segments[segments.length - 1] !== segment) {
    segments.push(segment);
  }
}
function getForwardedSourceName(fwdFrom) {
  return fwdFrom?.postAuthor || fwdFrom?.fromName || fwdFrom?.savedFromName || null;
}
function isOpaqueTelegramIdentifier(value) {
  if (!value) return false;
  const trimmed = value.trim();
  return /^\d{8,}$/.test(trimmed) || /^\d{8,}[-_]\d{8,}$/.test(trimmed);
}
function buildStorageFolderWithRules(options, rules) {
  if (!shouldClassifyStoragePath()) {
    return options.folder ? normalizeSegment(options.folder, "folder") : null;
  }
  const segments = [];
  if (rules.bySource) {
    addUniqueSegment(segments, options.source, "uploads");
    if (options.chatName) {
      addUniqueSegment(segments, options.chatName, "chat");
    }
  }
  if (options.folder) {
    addUniqueSegment(segments, options.folder, "folder");
  }
  if (rules.byType) {
    const typeFolder = getDetailedTypeFolder(options.mimeType, options.fileName);
    if (typeFolder) {
      segments.push(typeFolder);
    }
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}
async function getTelegramChatName(message) {
  const fwdFrom = message.fwdFrom;
  const forwardedPeer = fwdFrom?.savedFromPeer || fwdFrom?.fromId;
  if (forwardedPeer) {
    const sourceEntity = await message.client?.getEntity?.(forwardedPeer).catch(() => null);
    const sourceName = getEntityDisplayName(sourceEntity) || getForwardedSourceName(fwdFrom);
    if (sourceName) return normalizeSegment(sourceName, "telegram");
  }
  const forwardedName = getForwardedSourceName(fwdFrom);
  if (forwardedName) return normalizeSegment(forwardedName, "telegram");
  const chat = await message.getChat().catch(() => null);
  const title = getEntityDisplayName(chat);
  const chatId = message.chatId?.toString();
  return normalizeSegment(title || chatId || "telegram", "telegram");
}
async function getTelegramBatchFolderName(message, fallback) {
  const fwdFrom = message.fwdFrom;
  const forwardedPeer = fwdFrom?.savedFromPeer || fwdFrom?.fromId;
  if (forwardedPeer) {
    const sourceEntity = await message.client?.getEntity?.(forwardedPeer).catch(() => null);
    const sourceName = getEntityDisplayName(sourceEntity) || getForwardedSourceName(fwdFrom);
    if (sourceName) return normalizeSegment(sourceName, "telegram");
  }
  const forwardedName = getForwardedSourceName(fwdFrom);
  if (forwardedName) return normalizeSegment(forwardedName, "telegram");
  const chat = await message.getChat().catch(() => null);
  const title = getEntityDisplayName(chat);
  if (title) return normalizeSegment(title, "telegram");
  return normalizeSegment(fallback, "telegram-batch");
}

// src/utils/telegramPathSettings.ts
import { Api as Api3 } from "telegram";
var chatPathState = /* @__PURE__ */ new Map();
var pendingPathInputState = /* @__PURE__ */ new Map();
var recentPathState = /* @__PURE__ */ new Map();
var MAX_RECENT_PATHS = 6;
var RECENT_PATH_SETTING_PREFIX = "telegram_recent_paths:";
function pendingPathInputKey(chatId, userId) {
  return `${chatId}:${userId}`;
}
function recentPathSettingKey(chatId) {
  return `${RECENT_PATH_SETTING_PREFIX}${chatId}`;
}
function normalizePathSegment(segment) {
  return sanitizeFilename(segment.trim()).replace(/^\.+/, "_").replace(/^\.+$/, "_");
}
function parseRecentPaths(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, MAX_RECENT_PATHS);
  } catch {
    return [];
  }
}
async function loadRecentTelegramPaths(chatId) {
  const cached = recentPathState.get(chatId);
  if (cached) return [...cached];
  const raw = await getSetting(recentPathSettingKey(chatId), "[]");
  const loaded = parseRecentPaths(raw);
  recentPathState.set(chatId, loaded);
  return [...loaded];
}
async function persistRecentTelegramPaths(chatId, paths) {
  recentPathState.set(chatId, paths);
  await setSetting(recentPathSettingKey(chatId), JSON.stringify(paths));
}
function sanitizeCustomStoragePath(input) {
  const raw = input.trim().replace(/\\+/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!raw) throw new Error("\u8DEF\u5F84\u4E0D\u80FD\u4E3A\u7A7A");
  if (raw.startsWith("~") || raw.includes("\0")) throw new Error("\u8DEF\u5F84\u5305\u542B\u975E\u6CD5\u5B57\u7B26");
  const segments = raw.split("/").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error("\u8DEF\u5F84\u4E0D\u80FD\u4E3A\u7A7A");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes(".."))) {
    throw new Error("\u8DEF\u5F84\u4E0D\u80FD\u5305\u542B . \u6216 ..");
  }
  const normalized = segments.map((segment) => normalizePathSegment(segment)).filter(Boolean).join("/");
  if (!normalized) throw new Error("\u8DEF\u5F84\u65E0\u6548");
  if (normalized.length > 180) throw new Error("\u8DEF\u5F84\u8FC7\u957F\uFF0C\u8BF7\u63A7\u5236\u5728 180 \u4E2A\u5B57\u7B26\u5185");
  return normalized;
}
async function rememberRecentTelegramPathPersistent(chatId, folder) {
  const normalized = sanitizeCustomStoragePath(folder);
  const current = await loadRecentTelegramPaths(chatId);
  const next = [normalized, ...current.filter((item) => item !== normalized)].slice(0, MAX_RECENT_PATHS);
  await persistRecentTelegramPaths(chatId, next);
  return normalized;
}
async function getRecentTelegramPathsPersistent(chatId) {
  return loadRecentTelegramPaths(chatId);
}
function buildPathPreviewLine(folder) {
  return `\u4FDD\u5B58\u5230\uFF1A${folder}/\u6587\u4EF6\u540D\uFF08\u4E0D\u4F1A\u8FFD\u52A0\u9891\u9053\u540D\u6216\u6587\u4EF6\u7C7B\u578B\u76EE\u5F55\uFF09`;
}
function getTelegramPathState(chatId) {
  return { ...chatPathState.get(chatId) || {} };
}
async function setNextTelegramPathPersistent(chatId, folder) {
  const normalized = await rememberRecentTelegramPathPersistent(chatId, folder);
  const state = chatPathState.get(chatId) || {};
  state.nextFolder = normalized;
  chatPathState.set(chatId, state);
  return normalized;
}
async function setSessionTelegramPathPersistent(chatId, folder) {
  const normalized = await rememberRecentTelegramPathPersistent(chatId, folder);
  const state = chatPathState.get(chatId) || {};
  state.sessionFolder = normalized;
  chatPathState.set(chatId, state);
  return normalized;
}
function clearTelegramPathState(chatId) {
  chatPathState.delete(chatId);
}
function setPendingTelegramPathInput(chatId, userId, mode) {
  pendingPathInputState.set(pendingPathInputKey(chatId, userId), mode);
}
function getPendingTelegramPathInput(chatId, userId) {
  return pendingPathInputState.get(pendingPathInputKey(chatId, userId));
}
function clearPendingTelegramPathInput(chatId, userId) {
  pendingPathInputState.delete(pendingPathInputKey(chatId, userId));
}
async function applyPendingTelegramPathInputPersistent(chatId, userId, folder) {
  const mode = getPendingTelegramPathInput(chatId, userId);
  if (!mode) return null;
  const normalized = mode === "once" ? await setNextTelegramPathPersistent(chatId, folder) : await setSessionTelegramPathPersistent(chatId, folder);
  clearPendingTelegramPathInput(chatId, userId);
  return { mode, folder: normalized };
}
async function buildPendingPathPromptPersistent(mode, chatId) {
  const recent = chatId ? await getRecentTelegramPathsPersistent(chatId) : [];
  return [
    mode === "once" ? "\u{1F4CC} **\u8BBE\u7F6E\u4E0B\u4E00\u6B21\u4E0B\u8F7D\u76EE\u5F55**" : "\u{1F4CD} **\u8BBE\u7F6E\u4F1A\u8BDD\u4E0B\u8F7D\u76EE\u5F55**",
    "",
    "\u8BF7\u76F4\u63A5\u53D1\u9001\u76EE\u5F55\u540D\u79F0\uFF1A",
    mode === "once" ? "\u4F8B\u5982\uFF1A`PIXIV/\u6BCF\u65E5Top50`" : "\u4F8B\u5982\uFF1A`\u76F8\u518C/2026-07`",
    ...recent.length > 0 ? ["", "\u6700\u8FD1\u4F7F\u7528\u76EE\u5F55\uFF1A", ...recent.slice(0, 4).map((item) => `- ${item}`)] : [],
    "",
    mode === "once" ? "\u8BF4\u660E\uFF1A\u53EA\u5F71\u54CD\u4E0B\u4E00\u6B21\u8FDB\u5165\u4E0B\u8F7D\u6D41\u7A0B\u7684\u6587\u4EF6\u3002" : "\u8BF4\u660E\uFF1A\u4F1A\u5F71\u54CD\u5F53\u524D\u804A\u5929\u540E\u7EED\u4E0B\u8F7D\uFF0C\u76F4\u5230\u53D1\u9001 `/pc` \u6216\u70B9\u51FB\u6E05\u9664\u3002",
    "\u53D1\u9001\u201C\u53D6\u6D88\u201D\u53EF\u9000\u51FA\u672C\u6B21\u8BBE\u7F6E\u3002"
  ].join("\n");
}
function resolveTelegramStorageFolder(chatId, automaticFolder) {
  const state = chatPathState.get(chatId);
  if (!state) return automaticFolder || null;
  if (state.nextFolder) {
    const folder = state.nextFolder;
    delete state.nextFolder;
    if (!state.sessionFolder) chatPathState.delete(chatId);
    return folder;
  }
  return state.sessionFolder || automaticFolder || null;
}
function resolveTelegramBatchStorageFolder(chatId, automaticFolder) {
  return resolveTelegramStorageFolder(chatId, automaticFolder);
}
function resolveTelegramTaskStorageFolder(chatId, automaticFolder) {
  const state = chatPathState.get(chatId);
  if (!state) return { folder: automaticFolder || null, custom: false };
  if (state.nextFolder) {
    const folder = state.nextFolder;
    delete state.nextFolder;
    if (!state.sessionFolder) chatPathState.delete(chatId);
    return { folder, custom: true };
  }
  if (state.sessionFolder) return { folder: state.sessionFolder, custom: true };
  return { folder: automaticFolder || null, custom: false };
}
function buildTelegramPathStateLines(chatId) {
  const state = getTelegramPathState(chatId);
  const active = state.nextFolder || state.sessionFolder;
  return [
    `\u5F53\u524D\u4FDD\u5B58\uFF1A${active ? `\`${active}\`\uFF08\u81EA\u5B9A\u4E49\u76EE\u5F55\uFF09` : "\u9ED8\u8BA4\u81EA\u52A8\u5206\u7C7B"}`,
    active ? buildPathPreviewLine(active) : "\u9ED8\u8BA4\u793A\u4F8B\uFF1A`telegram/\u8D44\u6E90\u4E0B\u8F7D/images`",
    `\u{1F4CC} \u4E0B\u4E00\u6B21\u76EE\u5F55\uFF1A${state.nextFolder ? `\`${state.nextFolder}\`` : "\u672A\u8BBE\u7F6E"}`,
    `\u{1F4CD} \u672C\u4F1A\u8BDD\u76EE\u5F55\uFF1A${state.sessionFolder ? `\`${state.sessionFolder}\`` : "\u672A\u8BBE\u7F6E"}`
  ];
}
function buildPathSettingsKeyboard(_state) {
  return new Api3.ReplyInlineMarkup({
    rows: [
      new Api3.KeyboardButtonRow({
        buttons: [
          new Api3.KeyboardButtonCallback({ text: "\u{1F4CC} \u8BBE\u7F6E\u4E0B\u4E00\u6B21\u76EE\u5F55", data: Buffer.from("pr_help_once") }),
          new Api3.KeyboardButtonCallback({ text: "\u{1F4CD} \u8BBE\u7F6E\u4F1A\u8BDD\u76EE\u5F55", data: Buffer.from("pr_help_session") })
        ]
      }),
      new Api3.KeyboardButtonRow({
        buttons: [
          new Api3.KeyboardButtonCallback({ text: "\u{1F558} \u6700\u8FD1\u76EE\u5F55", data: Buffer.from("pr_recent") }),
          new Api3.KeyboardButtonCallback({ text: "\u{1F9F9} \u6E05\u9664\u81EA\u5B9A\u4E49\u76EE\u5F55", data: Buffer.from("pr_clear_custom") })
        ]
      })
    ]
  });
}
function buildPathSettingsText(_state, chatId) {
  return [
    "\u{1F4C1} **\u4FDD\u5B58\u4F4D\u7F6E**",
    "",
    "**\u9ED8\u8BA4\u4FDD\u5B58\u903B\u8F91**",
    "\u672A\u8BBE\u7F6E\u81EA\u5B9A\u4E49\u76EE\u5F55\u65F6\uFF1A\u81EA\u52A8\u6309\u6765\u6E90/\u9891\u9053 + \u6587\u4EF6\u7C7B\u578B\u4FDD\u5B58\u3002",
    "\u4F8B\u5982\uFF1A`telegram/\u8D44\u6E90\u4E0B\u8F7D/images`\u3001`telegram/\u8D44\u6E90\u4E0B\u8F7D/videos`\u3002",
    "\u8BBE\u7F6E\u81EA\u5B9A\u4E49\u76EE\u5F55\u540E\uFF1A\u6587\u4EF6\u4F1A\u76F4\u63A5\u4FDD\u5B58\u5230\u8BE5\u76EE\u5F55\u672C\u8EAB\uFF0C\u4E0D\u518D\u8FFD\u52A0\u9891\u9053\u540D\u6216\u6587\u4EF6\u7C7B\u578B\u76EE\u5F55\u3002",
    "",
    "**\u5F53\u524D\u8DEF\u5F84\u72B6\u6001**",
    ...buildTelegramPathStateLines(chatId),
    "",
    "**\u5FEB\u6377\u547D\u4EE4**",
    "`/p <\u76EE\u5F55>` \u2014 \u4EC5\u4E0B\u4E00\u6B21\u4E0B\u8F7D\u4F7F\u7528",
    "`/ps <\u76EE\u5F55>` \u2014 \u5F53\u524D\u4F1A\u8BDD\u6301\u7EED\u4F7F\u7528",
    "`/pc` \u2014 \u6E05\u9664\u4E0B\u4E00\u6B21/\u4F1A\u8BDD\u76EE\u5F55",
    "",
    "\u4F18\u5148\u7EA7\uFF1A\u4E0B\u4E00\u6B21\u76EE\u5F55 > \u672C\u4F1A\u8BDD\u76EE\u5F55 > \u9ED8\u8BA4\u81EA\u52A8\u5206\u7C7B\u76EE\u5F55\u3002",
    "\u8DEF\u5F84\u793A\u4F8B\uFF1A\u8BBE\u7F6E `/ps book` \u540E\uFF0C\u6587\u4EF6\u76F4\u63A5\u4FDD\u5B58\u5230 `book`\u3002"
  ].join("\n");
}

// src/utils/duplicatePolicy.ts
init_db();
function normalizeDuplicateMode(value) {
  return value === "skip" ? "skip" : "copy";
}
async function getDuplicateMode() {
  const value = await getSetting("duplicate_file_mode", process.env.DUPLICATE_FILE_MODE || "copy");
  return normalizeDuplicateMode(value);
}
async function findDuplicateFile(name, folder, size, storageAccountId) {
  const result = await query(
    `SELECT id, name, path, folder, size, created_at
         FROM files
         WHERE name = $1
           AND folder IS NOT DISTINCT FROM $2
           AND size = $3
           AND storage_account_id IS NOT DISTINCT FROM $4
         ORDER BY created_at DESC
         LIMIT 1`,
    [name, folder, size, storageAccountId]
  );
  return result.rows[0] || null;
}

// src/services/telegramUpload.ts
var UPLOAD_DIR = process.env.UPLOAD_DIR || "./data/uploads";
var DEFAULT_TELEGRAM_DOWNLOAD_WORKERS = Math.max(1, Math.min(16, parseInt(process.env.TELEGRAM_DOWNLOAD_WORKERS || "4", 10) || 4));
var TELEGRAM_DOWNLOAD_PART_SIZE = 512 * 1024;
var TG_BATCH_DEFAULT_LIMIT = 50;
var TG_LARGE_TASK_SEGMENT_SIZE = Math.max(10, parseInt(process.env.TG_LARGE_TASK_SEGMENT_SIZE || "50", 10) || 50);
var TG_MIN_FREE_DISK_BYTES = Math.max(1024 * 1024 * 1024, (parseInt(process.env.TG_MIN_FREE_DISK_GB || "8", 10) || 8) * 1024 * 1024 * 1024);
var TG_LARGE_TASK_REFRESH_INTERVAL_MS = Math.max(3e3, parseInt(process.env.TG_LARGE_TASK_REFRESH_INTERVAL_MS || "10000", 10) || 1e4);
var TG_DISK_WATERMARK_RECHECK_MS = Math.max(5e3, parseInt(process.env.TG_DISK_WATERMARK_RECHECK_MS || "30000", 10) || 3e4);
var TG_DISK_WATERMARK_MAX_WAIT_MS = Math.max(0, parseInt(process.env.TG_DISK_WATERMARK_MAX_WAIT_MS || "0", 10) || 0);
var TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE = Math.max(1, parseInt(process.env.TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE || "50", 10) || 50);
function normalizeFileDownloadConcurrency(value) {
  const parsed = parseInt(String(value ?? process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY ?? "2"), 10);
  return [1, 2, 3, 4].includes(parsed) ? parsed : 2;
}
var TG_DEBUG_LOG_PATH = process.env.TG_STATUS_DEBUG_LOG || path10.join(process.cwd(), "data", "logs", "tg_silent_debug.log");
var TG_DEBUG_LOG_MAX_BYTES = Math.max(1024 * 1024, parseInt(process.env.TG_DEBUG_LOG_MAX_MB || "5", 10) * 1024 * 1024);
function appendTelegramDebugLog(line) {
  if (process.env.TG_STATUS_DEBUG !== "1") return;
  try {
    fs7.mkdirSync(path10.dirname(TG_DEBUG_LOG_PATH), { recursive: true });
    if (fs7.existsSync(TG_DEBUG_LOG_PATH) && fs7.statSync(TG_DEBUG_LOG_PATH).size > TG_DEBUG_LOG_MAX_BYTES) {
      fs7.renameSync(TG_DEBUG_LOG_PATH, `${TG_DEBUG_LOG_PATH}.${Date.now()}.old`);
    }
    fs7.appendFileSync(TG_DEBUG_LOG_PATH, line);
  } catch {
  }
}
function clampDownloadWorkers(value) {
  const parsed = parseInt(String(value ?? DEFAULT_TELEGRAM_DOWNLOAD_WORKERS), 10);
  const normalized = [4, 8, 12, 16].includes(parsed) ? parsed : DEFAULT_TELEGRAM_DOWNLOAD_WORKERS;
  return Math.max(1, Math.min(16, normalized));
}
async function getTelegramDownloadWorkers() {
  const storedValue = await getSetting("telegram_download_workers", String(DEFAULT_TELEGRAM_DOWNLOAD_WORKERS));
  return clampDownloadWorkers(storedValue);
}
var floodWaitUntil = 0;
async function getFirstUserVisibleMediaMessage(userClient2, sourceEntity, sourceMessageId) {
  try {
    const [userVisibleMessage] = await userClient2.getMessages(sourceEntity, { ids: sourceMessageId });
    return userVisibleMessage?.media ? userVisibleMessage : void 0;
  } catch (error) {
    console.warn("\u{1F916} \u7528\u6237\u8D26\u53F7\u8BFB\u53D6 Telegram \u5A92\u4F53\u6D88\u606F\u5931\u8D25:", error);
    return void 0;
  }
}
async function resolveDownloadSource(botClient, message) {
  const activeUserClient = getTelegramUserClient();
  if (activeUserClient && botClient === activeUserClient) {
    return { client: botClient, message };
  }
  const userDownloadEnabled = await getSetting("telegram_user_download_enabled", "false") === "true";
  if (!userDownloadEnabled) {
    return { client: botClient, message };
  }
  const userClient2 = getTelegramUserClient();
  if (!userClient2 || !isTelegramUserClientReady()) {
    throw new Error("Telegram \u7528\u6237\u8D26\u53F7\u4E0B\u8F7D\u5DF2\u5F00\u542F\uFF0C\u4F46 user session \u672A\u5C31\u7EEA");
  }
  const fwdFrom = message.fwdFrom;
  const forwardedSourcePeer = fwdFrom?.savedFromPeer || fwdFrom?.fromId;
  const forwardedSourceMessageId = fwdFrom?.savedFromMsgId || fwdFrom?.channelPost;
  if (forwardedSourcePeer && forwardedSourceMessageId) {
    const forwardedSourceMessage = await getFirstUserVisibleMediaMessage(userClient2, forwardedSourcePeer, forwardedSourceMessageId);
    if (forwardedSourceMessage) {
      console.log(`\u{1F916} \u4F7F\u7528\u7528\u6237\u8D26\u53F7\u4ECE\u8F6C\u53D1\u6765\u6E90\u8BFB\u53D6\u5A92\u4F53: msg=${forwardedSourceMessageId}`);
      return { client: userClient2, message: forwardedSourceMessage };
    }
  }
  const botMe = await botClient.getMe();
  const botUsername = botMe?.username;
  const botEntity = botUsername ? `@${botUsername}` : botMe?.id;
  if (botEntity) {
    const botDialogMessage = await getFirstUserVisibleMediaMessage(userClient2, botEntity, message.id);
    if (botDialogMessage) {
      return { client: userClient2, message: botDialogMessage };
    }
  }
  console.warn("\u{1F916} \u7528\u6237\u8D26\u53F7\u65E0\u6CD5\u8BFB\u53D6\u8BE5\u5A92\u4F53\u6D88\u606F\uFF0C\u56DE\u9000\u5230 bot \u4F1A\u8BDD\u4E0B\u8F7D\uFF1B\u5927\u4E8E bot \u9650\u5236\u7684\u6587\u4EF6\u53EF\u80FD\u4ECD\u4F1A\u5931\u8D25\u3002");
  return { client: botClient, message };
}
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function getDiskWatermarkState(requiredBytes = 0) {
  const statfs = await fs7.promises.statfs(UPLOAD_DIR);
  const availableBytes = Number(statfs.bavail) * Number(statfs.bsize);
  return { availableBytes, ok: availableBytes - requiredBytes >= TG_MIN_FREE_DISK_BYTES };
}
async function waitForDiskWatermark(requiredBytes = 0) {
  const startedAt = Date.now();
  let announcedPause = false;
  while (true) {
    const { availableBytes, ok } = await getDiskWatermarkState(requiredBytes);
    if (ok) {
      if (announcedPause) {
        const stats = downloadQueue.resumeFromDiskPressure();
        console.log(`[Queue] \u{1F4A7} \u78C1\u76D8\u6C34\u4F4D\u6062\u590D\uFF0C\u7EE7\u7EED\u4E0B\u8F7D\u961F\u5217: active=${stats.active}, pending=${stats.pending}`);
      }
      return;
    }
    if (!announcedPause) {
      const stats = downloadQueue.pauseForDiskPressure(`\u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u5DF2\u6682\u505C\u4E0B\u8F7D\u961F\u5217\uFF1A\u53EF\u7528 ${formatBytes(availableBytes)}\uFF0C\u9884\u8BA1\u8FD8\u9700 ${formatBytes(requiredBytes)}\uFF0C\u9700\u4FDD\u7559 ${formatBytes(TG_MIN_FREE_DISK_BYTES)}`);
      console.warn(`[Queue] \u{1F4A7} \u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u5DF2\u6682\u505C\u4E0B\u8F7D\u961F\u5217: active=${stats.active}, pending=${stats.pending}, available=${formatBytes(availableBytes)}, required=${formatBytes(requiredBytes)}, reserve=${formatBytes(TG_MIN_FREE_DISK_BYTES)}`);
      announcedPause = true;
    }
    if (TG_DISK_WATERMARK_MAX_WAIT_MS > 0 && Date.now() - startedAt >= TG_DISK_WATERMARK_MAX_WAIT_MS) {
      throw new Error(`\u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u5DF2\u6682\u505C\u4E0B\u8F7D\u961F\u5217\u540E\u7B49\u5F85\u8D85\u65F6\uFF1A\u53EF\u7528 ${formatBytes(availableBytes)}\uFF0C\u9884\u8BA1\u8FD8\u9700 ${formatBytes(requiredBytes)}\uFF0C\u9700\u4FDD\u7559 ${formatBytes(TG_MIN_FREE_DISK_BYTES)}`);
    }
    await sleep(TG_DISK_WATERMARK_RECHECK_MS);
  }
}
function shouldRefreshLargeTaskStatus(lastStatusRefresh, completed, force = false) {
  return force || completed <= 3 || completed % 20 === 0 || Date.now() - lastStatusRefresh >= TG_LARGE_TASK_REFRESH_INTERVAL_MS;
}
async function safeEditMessage(client2, chatId, params) {
  if (Date.now() < floodWaitUntil) {
    console.warn(`[Telegram] \u23F3 \u8DF3\u8FC7\u7F16\u8F91\u6D88\u606F\uFF1A\u4ECD\u5728 FloodWait \u51B7\u5374\u4E2D chat=${chatId.toString()} msg=${params?.message}`);
    return null;
  }
  try {
    const result = await client2.editMessage(chatId, params);
    if (process.env.TG_STATUS_DEBUG === "1") {
      const chatIdStr = chatId.toString();
      const isSilent = silentSessionMap.has(chatIdStr);
      console.log(`[TG][status] edit chat=${chatIdStr} msg=${params?.message} silent=${isSilent}`);
    }
    return result;
  } catch (e) {
    if (e.errorMessage === "FLOOD" || e.errorMessage?.includes("FLOOD_WAIT")) {
      const seconds = e.seconds || 30;
      floodWaitUntil = Date.now() + seconds * 1e3;
      console.warn(`[Telegram] \u26A0\uFE0F \u89E6\u53D1 FloodWait\uFF0C\u51B7\u5374\u65F6\u95F4: ${seconds} \u79D2`);
    }
    if (e.errorMessage === "MESSAGE_NOT_MODIFIED" || e.message?.includes("MESSAGE_NOT_MODIFIED")) {
      if (process.env.TG_STATUS_DEBUG === "1") {
        console.log(`[TG][status] edit-noop chat=${chatId.toString()} msg=${params?.message}`);
      }
      return { notModified: true };
    }
    console.warn(`[Telegram] \u26A0\uFE0F \u7F16\u8F91\u6D88\u606F\u5931\u8D25 chat=${chatId.toString()} msg=${params?.message}:`, e?.errorMessage || e?.message || e);
    return null;
  }
}
var telegramStorageWriteLocks = /* @__PURE__ */ new Map();
async function withTelegramStorageWriteLock(key, fn) {
  const previous = telegramStorageWriteLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  telegramStorageWriteLocks.set(key, previous.then(() => current, () => current));
  await previous.catch(() => void 0);
  try {
    return await fn();
  } finally {
    release();
    if (telegramStorageWriteLocks.get(key) === current) {
      telegramStorageWriteLocks.delete(key);
    }
  }
}
var silentNoticePromiseMap = /* @__PURE__ */ new Map();
async function ensureSilentNotice(client2, chatId, fileCount, replyToMsg) {
  const chatIdStr = chatId.toString();
  const silentSessionActive = silentSessionMap.has(chatIdStr);
  if (!silentSessionActive) return;
  const silentMsgId = silentNoticeMessageIdMap.get(chatIdStr);
  if (silentMsgId) {
    if (!replyToMsg) return;
    try {
      await client2.deleteMessages(chatId, [silentMsgId], { revoke: true });
    } catch (e) {
    }
    silentNoticeMessageIdMap.delete(chatIdStr);
  }
  if (silentNoticePromiseMap.has(chatIdStr)) {
    try {
      await silentNoticePromiseMap.get(chatIdStr);
    } catch (e) {
    }
    if (silentNoticeMessageIdMap.get(chatIdStr)) return;
  }
  const queueStats = getDownloadQueueStats();
  const text = buildSilentModeNotice(fileCount, getSessionTaskId(chatIdStr), queueStats.paused, queueStats.pauseReason);
  const sendPromise = (async () => {
    let sMsg;
    if (replyToMsg) {
      sMsg = await safeReply(replyToMsg, { message: text, buttons: buildTaskControlButtons(getSessionTaskId(chatIdStr)) });
    }
    if (!sMsg) {
      try {
        sMsg = await client2.sendMessage(chatId, { message: text, buttons: buildTaskControlButtons(getSessionTaskId(chatIdStr)) });
      } catch (e) {
        console.error(`[TG][silent] notice-send-failed chat=${chatIdStr}:`, e);
      }
    }
    if (sMsg) {
      silentNoticeMessageIdMap.set(chatIdStr, sMsg.id);
      console.log(`[TG][silent] notice-sent chat=${chatIdStr} msg=${sMsg.id}`);
    }
    return sMsg;
  })();
  silentNoticePromiseMap.set(chatIdStr, sendPromise);
  try {
    await sendPromise;
  } finally {
    if (silentNoticePromiseMap.get(chatIdStr) === sendPromise) {
      silentNoticePromiseMap.delete(chatIdStr);
    }
  }
}
async function safeReply(message, params) {
  if (Date.now() < floodWaitUntil) return null;
  try {
    const result = await message.reply(params);
    if (process.env.TG_STATUS_DEBUG === "1") {
      const chatIdStr = message.chatId?.toString() || "unknown";
      const isSilent = silentSessionMap.has(chatIdStr);
      const msgId = result?.id;
      console.log(`[TG][status] reply chat=${chatIdStr} msg=${msgId} silent=${isSilent}`);
    }
    return result;
  } catch (e) {
    if (e.errorMessage === "FLOOD" || e.errorMessage?.includes("FLOOD_WAIT")) {
      const seconds = e.seconds || 30;
      floodWaitUntil = Date.now() + seconds * 1e3;
      console.warn(`[Telegram] \u26A0\uFE0F \u89E6\u53D1 FloodWait (Reply)\uFF0C\u51B7\u5374\u65F6\u95F4: ${seconds} \u79D2`);
    }
    return null;
  }
}
var BetterDownloadQueue = class {
  queue = [];
  active = [];
  history = [];
  maxHistory = 50;
  maxConcurrent = normalizeFileDownloadConcurrency(process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY);
  paused = false;
  diskPressurePaused = false;
  diskPressureReason;
  async add(fileName, execute, totalSize = 0) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      const abortController = new AbortController();
      const task = {
        id,
        fileName,
        status: "pending",
        abortController,
        totalSize,
        downloadedSize: 0,
        rawExecute: execute,
        settleCancelled: () => resolve(),
        // The actual execution logic
        execute: async () => {
          task.status = "active";
          task.startTime = Date.now();
          this.active.push(task);
          try {
            await execute(abortController.signal);
            task.status = abortController.signal.aborted ? "cancelled" : "success";
            resolve();
          } catch (error) {
            task.status = abortController.signal.aborted ? "cancelled" : "failed";
            task.error = error instanceof Error ? error.message : String(error);
            if (abortController.signal.aborted) {
              resolve();
            } else {
              reject(error);
            }
          } finally {
            task.endTime = Date.now();
            const idx = this.active.findIndex((t) => t.id === id);
            if (idx !== -1) this.active.splice(idx, 1);
            this.history.unshift(task);
            if (this.history.length > this.maxHistory) this.history.pop();
            this.processNext();
          }
        }
      };
      this.queue.push(task);
      console.log(`[Queue] \u{1F4E5} Task added: ${fileName}. Queue size: ${this.queue.length}`);
      this.processNext();
    });
  }
  processNext() {
    while (!this.paused && this.active.length < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        console.log(`[Queue] \u{1F680} Processing task: ${task.fileName}. Active: ${this.active.length + 1}, Pending: ${this.queue.length}`);
        task.execute();
      }
    }
  }
  getStats() {
    return {
      active: this.active.length,
      pending: this.queue.length,
      total: this.active.length + this.queue.length,
      maxConcurrent: this.maxConcurrent,
      paused: this.paused,
      diskPressurePaused: this.diskPressurePaused,
      diskPressureReason: this.diskPressureReason,
      pauseReason: this.diskPressureReason || (this.paused ? "\u7528\u6237\u5DF2\u6682\u505C\u4E0B\u8F7D\u961F\u5217" : void 0)
    };
  }
  getDetailedStatus() {
    return {
      active: [...this.active],
      pending: [...this.queue],
      history: [...this.history],
      maxConcurrent: this.maxConcurrent,
      paused: this.paused,
      diskPressurePaused: this.diskPressurePaused,
      diskPressureReason: this.diskPressureReason,
      pauseReason: this.diskPressureReason || (this.paused ? "\u7528\u6237\u5DF2\u6682\u505C\u4E0B\u8F7D\u961F\u5217" : void 0)
    };
  }
  // Update progress method
  updateProgress(taskId, downloaded) {
    const task = this.active.find((t) => t.id === taskId);
    if (task) {
      task.downloadedSize = downloaded;
    }
  }
  getMaxConcurrent() {
    return this.maxConcurrent;
  }
  setMaxConcurrent(value) {
    this.maxConcurrent = normalizeFileDownloadConcurrency(value);
    this.processNext();
    return this.maxConcurrent;
  }
  pause() {
    this.paused = true;
    return { active: this.active.length, pending: this.queue.length, total: this.active.length + this.queue.length };
  }
  pauseForDiskPressure(reason) {
    this.diskPressurePaused = true;
    this.diskPressureReason = reason;
    this.paused = true;
    return { active: this.active.length, pending: this.queue.length, total: this.active.length + this.queue.length };
  }
  resume() {
    this.diskPressurePaused = false;
    this.diskPressureReason = void 0;
    this.paused = false;
    this.processNext();
    return { active: this.active.length, pending: this.queue.length, total: this.active.length + this.queue.length };
  }
  resumeFromDiskPressure() {
    if (!this.diskPressurePaused) {
      return { active: this.active.length, pending: this.queue.length, total: this.active.length + this.queue.length };
    }
    this.diskPressurePaused = false;
    this.diskPressureReason = void 0;
    this.paused = false;
    this.processNext();
    return { active: this.active.length, pending: this.queue.length, total: this.active.length + this.queue.length };
  }
  cancel(selector, reason = "\u7528\u6237\u53D6\u6D88\u4EFB\u52A1") {
    const normalized = selector?.trim();
    if (!normalized || normalized === "all") return this.forceStopAll(reason);
    let cancelledPending = 0;
    const pendingIndex = this.queue.findIndex((task, index) => task.id.startsWith(normalized) || String(index + 1) === normalized || task.fileName.includes(normalized));
    if (pendingIndex >= 0) {
      const [task] = this.queue.splice(pendingIndex, 1);
      task.status = "cancelled";
      task.error = reason;
      task.endTime = Date.now();
      task.settleCancelled?.();
      this.history.unshift(task);
      cancelledPending = 1;
    }
    let cancelledActive = 0;
    for (const task of this.active) {
      if (task.id.startsWith(normalized) || task.fileName.includes(normalized)) {
        task.error = reason;
        task.abortController.abort(reason);
        cancelledActive += 1;
      }
    }
    if (this.history.length > this.maxHistory) this.history.splice(this.maxHistory);
    return { active: cancelledActive, pending: cancelledPending, total: cancelledActive + cancelledPending };
  }
  async retryFailed(limit = 10) {
    const failed = this.history.filter((task) => task.status === "failed").slice(0, Math.max(1, limit));
    let retried = 0;
    for (const task of failed) {
      this.add(task.fileName, task.rawExecute, task.totalSize || 0).catch((err) => console.error(`[Queue] retry failed: ${task.fileName}`, err));
      retried += 1;
    }
    return { retried };
  }
  forceStopAll(reason = "\u7528\u6237\u5F3A\u5236\u505C\u6B62") {
    const pending = this.queue.splice(0);
    for (const task of pending) {
      task.status = "cancelled";
      task.error = reason;
      task.endTime = Date.now();
      task.settleCancelled?.();
      this.history.unshift(task);
    }
    for (const task of this.active) {
      task.error = reason;
      task.abortController.abort(reason);
    }
    if (this.history.length > this.maxHistory) {
      this.history.splice(this.maxHistory);
    }
    return { active: this.active.length, pending: pending.length, total: this.active.length + pending.length };
  }
};
var downloadQueue = new BetterDownloadQueue();
var statusActionLocks = /* @__PURE__ */ new Map();
var lastSilentNotificationTimeMap = /* @__PURE__ */ new Map();
async function runStatusAction(chatId, action) {
  if (!chatId) return;
  const chatIdStr = chatId.toString();
  const currentLock = statusActionLocks.get(chatIdStr) || Promise.resolve();
  const nextLock = currentLock.then(async () => {
    try {
      await action();
    } catch (e) {
      console.error(`[Status] \u274C Action failed for chat ${chatIdStr}:`, e);
    }
  });
  statusActionLocks.set(chatIdStr, nextLock);
  return nextLock;
}
var lastStatusMessageIdMap = /* @__PURE__ */ new Map();
var silentNoticeMessageIdMap = /* @__PURE__ */ new Map();
var silentSessionMap = /* @__PURE__ */ new Map();
var taskIdToChatId = /* @__PURE__ */ new Map();
var taskIdControlScopes = /* @__PURE__ */ new Map();
function createSessionTaskId() {
  return `t${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
}
function getSessionTaskId(chatIdStr) {
  return silentSessionMap.get(chatIdStr)?.taskId;
}
function resolveTaskChatId(taskId) {
  if (!taskId) return void 0;
  return taskIdToChatId.get(taskId.trim());
}
function registerTaskControlScope(taskId, chatId, userId) {
  taskIdToChatId.set(taskId, chatId);
  taskIdControlScopes.set(taskId, { chatId, userId });
}
function removeTaskControlScope(taskId) {
  if (!taskId) return;
  taskIdToChatId.delete(taskId);
  taskIdControlScopes.delete(taskId);
}
function canControlTask(taskId, chatId, userId) {
  if (!taskId || !chatId) return false;
  const scope = taskIdControlScopes.get(taskId.trim());
  if (!scope) return false;
  if (scope.chatId !== chatId) return false;
  if (scope.userId !== void 0 && userId !== void 0 && scope.userId !== userId) return false;
  return true;
}
function getSilentSession(chatIdStr) {
  let s = silentSessionMap.get(chatIdStr);
  if (!s) {
    const taskId = createSessionTaskId();
    s = { total: 0, completed: 0, failed: 0, taskId, knownTaskKeys: /* @__PURE__ */ new Set(), knownTaskCounts: /* @__PURE__ */ new Map(), folders: /* @__PURE__ */ new Set(), providers: /* @__PURE__ */ new Set() };
    silentSessionMap.set(chatIdStr, s);
    registerTaskControlScope(taskId, chatIdStr);
  }
  return s;
}
function startSilentSession(chatIdStr, total) {
  const taskId = createSessionTaskId();
  const s = { total, completed: 0, failed: 0, taskId, knownTaskKeys: /* @__PURE__ */ new Set(), knownTaskCounts: /* @__PURE__ */ new Map(), folders: /* @__PURE__ */ new Set(), providers: /* @__PURE__ */ new Set() };
  silentSessionMap.set(chatIdStr, s);
  registerTaskControlScope(taskId, chatIdStr);
  return s;
}
async function finalizeSilentSessionIfDone(client2, chatId) {
  const chatIdStr = chatId.toString();
  if (!silentSessionMap.has(chatIdStr)) return;
  const outstanding = getOutstandingTaskCount(chatIdStr);
  if (outstanding > 0) return;
  const s = silentSessionMap.get(chatIdStr);
  const silentMsgId = silentNoticeMessageIdMap.get(chatIdStr);
  if (silentMsgId) {
    const text = buildSilentAllTasksComplete(
      s?.total || 0,
      s?.failed || 0,
      s?.taskId,
      getConsolidatedFiles(chatIdStr),
      [
        ...getConsolidatedBatches(chatIdStr),
        ...Array.from(s?.folders || []).map((folder, index) => ({
          id: `session-folder-${index}`,
          folderName: folder,
          folderPath: folder,
          totalFiles: 1,
          completed: 1,
          successful: 1,
          failed: 0,
          providerName: Array.from(s?.providers || [])[0]
        }))
      ]
    );
    const controls = s?.failed ? buildTaskControlButtons(s?.taskId) : void 0;
    const edited = await safeEditMessage(client2, chatId, { message: silentMsgId, text, buttons: controls });
    if (!edited) {
      try {
        await client2.sendMessage(chatId, { message: text, buttons: controls });
        console.warn(`[TG][silent] completion-edit-failed fallback-sent chat=${chatIdStr} oldMsg=${silentMsgId}`);
      } catch (e) {
        console.error(`[TG][silent] completion-fallback-send-failed chat=${chatIdStr}:`, e);
      }
    }
  }
  silentSessionMap.delete(chatIdStr);
  removeTaskControlScope(s?.taskId);
  silentNoticeMessageIdMap.delete(chatIdStr);
  lastSilentNotificationTimeMap.delete(chatIdStr);
  console.log(`[TG][silent] finalized chat=${chatIdStr} failed=${s?.failed || 0}`);
}
function getBackgroundFileCount(chatIdStr) {
  const files = getConsolidatedFiles(chatIdStr);
  const activeFilesCount = files.filter((f) => f.phase !== "success" && f.phase !== "failed").length;
  const batches = getConsolidatedBatches(chatIdStr);
  const activeBatchFiles = batches.filter((b) => b.completed < b.totalFiles).reduce((sum, b) => sum + (b.totalFiles - b.completed), 0);
  const count = activeFilesCount + activeBatchFiles;
  const logLine = `[TG][silent][${Date.now()}] fileCount chat=${chatIdStr}: activeFiles=${activeFilesCount} activeBatchFiles=${activeBatchFiles} => total=${count}
`;
  console.log(logLine.trim());
  appendTelegramDebugLog(logLine);
  return count;
}
async function trySilentMode(client2, chatId, message) {
  const chatIdStr = chatId.toString();
  const fileCount = getBackgroundFileCount(chatIdStr);
  const isSilent = silentSessionMap.has(chatIdStr);
  const logLine = `[TG][silent][${Date.now()}] tryCheck chat=${chatIdStr} fileCount=${fileCount} isSilent=${isSilent}
`;
  console.log(logLine.trim());
  appendTelegramDebugLog(logLine);
  if (fileCount > 3 || isSilent) {
    if (!isSilent) {
      await deleteLastStatusMessage(client2, chatId);
      const transferSession = syncChatTransferSession(chatIdStr);
      const silentSession = startSilentSession(chatIdStr, transferSession.total);
      silentSession.knownTaskKeys = new Set(transferSession.knownTaskKeys);
      silentSession.knownTaskCounts = new Map(transferSession.knownTaskCounts);
      console.log(`[TG][silent] ACTIVATED chat=${chatIdStr} files=${fileCount}`);
    } else {
      syncSilentSessionTotals(chatIdStr);
    }
    await ensureSilentNotice(client2, chatId, fileCount, message);
    await refreshSilentProgress(client2, chatId);
    return true;
  }
  return false;
}
async function deleteLastStatusMessage(client2, chatId) {
  if (!chatId) return;
  const chatIdStr = chatId.toString();
  const lastMsgId = lastStatusMessageIdMap.get(chatIdStr);
  if (lastMsgId) {
    if (process.env.TG_STATUS_DEBUG === "1") {
      const isSilent = silentSessionMap.has(chatIdStr);
      console.log(`[TG][status] delete chat=${chatIdStr} msg=${lastMsgId} silentSession=${isSilent}`);
    }
    try {
      await client2.deleteMessages(chatId, [lastMsgId], { revoke: true });
    } catch (e) {
    }
    lastStatusMessageIdMap.delete(chatIdStr);
  }
}
function updateLastStatusMessageId(chatId, msgId, isSilent = false) {
  if (!chatId || !msgId) return;
  const chatIdStr = chatId.toString();
  lastStatusMessageIdMap.set(chatIdStr, msgId);
  if (process.env.TG_STATUS_DEBUG === "1") {
    const sess = silentSessionMap.has(chatIdStr);
    console.log(`[TG][status] last chat=${chatIdStr} msg=${msgId} sess=${sess}`);
  }
}
var chatTransferSessions = /* @__PURE__ */ new Map();
function getChatTransferSession(chatId) {
  let session = chatTransferSessions.get(chatId);
  if (!session) {
    session = { total: 0, completed: 0, failed: 0, knownTaskKeys: /* @__PURE__ */ new Set(), knownTaskCounts: /* @__PURE__ */ new Map(), folders: /* @__PURE__ */ new Set(), providers: /* @__PURE__ */ new Set() };
    chatTransferSessions.set(chatId, session);
  }
  return session;
}
function rememberTransferDestination(chatId, folder, providerName) {
  const session = getChatTransferSession(chatId);
  if (folder) session.folders.add(folder);
  if (providerName) session.providers.add(providerName);
  const silentSession = silentSessionMap.get(chatId);
  if (silentSession) {
    if (folder) silentSession.folders.add(folder);
    if (providerName) silentSession.providers.add(providerName);
  }
}
function updateTaskCount(totalTracker, key, count) {
  const previousCount = totalTracker.knownTaskCounts.get(key) || 0;
  if (count > previousCount) {
    totalTracker.total += count - previousCount;
    totalTracker.knownTaskCounts.set(key, count);
  }
  totalTracker.knownTaskKeys.add(key);
}
function syncChatTransferSession(chatId) {
  const session = getChatTransferSession(chatId);
  const batches = getConsolidatedBatches(chatId);
  for (const batch of batches) {
    const key = `batch:${batch.id}`;
    updateTaskCount(session, key, batch.totalFiles);
  }
  const files = getConsolidatedFiles(chatId);
  for (const file of files) {
    const key = `file:${file.id || file.fileName}`;
    updateTaskCount(session, key, 1);
  }
  const completedBatches = batches.reduce((sum, batch) => sum + batch.completed, 0);
  const failedBatches = batches.reduce((sum, batch) => sum + batch.failed, 0);
  const completedFiles = files.filter((file) => file.phase === "success" || file.phase === "failed").length;
  const failedFiles = files.filter((file) => file.phase === "failed").length;
  for (const batch of batches) {
    if (batch.folderPath) session.folders.add(batch.folderPath);
    if (batch.providerName) session.providers.add(batch.providerName);
  }
  for (const file of files) {
    if (file.folder) session.folders.add(file.folder);
    if (file.providerName) session.providers.add(file.providerName);
  }
  session.completed = Math.max(session.completed, completedBatches + completedFiles);
  session.failed = Math.max(session.failed, failedBatches + failedFiles);
  return session;
}
function resetChatTransferSession(chatId) {
  chatTransferSessions.delete(chatId);
}
var chatActiveUploads = /* @__PURE__ */ new Map();
function registerUpload(chatId, uploadId, entry) {
  if (!chatActiveUploads.has(chatId)) {
    chatActiveUploads.set(chatId, /* @__PURE__ */ new Map());
  }
  chatActiveUploads.get(chatId).set(uploadId, { ...entry, id: uploadId });
  syncChatTransferSession(chatId);
}
function updateUploadPhase(chatId, uploadId, updates) {
  const map = chatActiveUploads.get(chatId);
  if (!map) return;
  const entry = map.get(uploadId);
  if (entry) {
    Object.assign(entry, updates);
    syncChatTransferSession(chatId);
  }
}
function removeUpload(chatId, uploadId) {
  const map = chatActiveUploads.get(chatId);
  if (map) {
    map.delete(uploadId);
    if (map.size === 0) chatActiveUploads.delete(chatId);
  }
}
function getActiveUploadCount(chatId) {
  return chatActiveUploads.get(chatId)?.size || 0;
}
function getConsolidatedFiles(chatId) {
  const map = chatActiveUploads.get(chatId);
  if (!map) return [];
  return Array.from(map.values());
}
var chatActiveBatches = /* @__PURE__ */ new Map();
function registerBatch(chatId, batchId, entry) {
  if (!chatActiveBatches.has(chatId)) {
    chatActiveBatches.set(chatId, /* @__PURE__ */ new Map());
  }
  chatActiveBatches.get(chatId).set(batchId, entry);
  syncChatTransferSession(chatId);
}
function updateBatch(chatId, batchId, updates) {
  const map = chatActiveBatches.get(chatId);
  if (!map) return;
  const entry = map.get(batchId);
  if (entry) {
    Object.assign(entry, updates);
    syncChatTransferSession(chatId);
  }
}
function removeBatch(chatId, batchId) {
  const map = chatActiveBatches.get(chatId);
  if (map) {
    map.delete(batchId);
    if (map.size === 0) chatActiveBatches.delete(chatId);
  }
}
function getActiveBatchCount(chatId) {
  return chatActiveBatches.get(chatId)?.size || 0;
}
function getConsolidatedBatches(chatId) {
  const map = chatActiveBatches.get(chatId);
  if (!map) return [];
  return Array.from(map.values());
}
function clearConsolidatedState(chatId) {
  chatActiveUploads.delete(chatId);
  chatActiveBatches.delete(chatId);
}
function isAllConsolidatedTasksDone(chatId) {
  const files = getConsolidatedFiles(chatId);
  const batches = getConsolidatedBatches(chatId);
  if (files.length === 0 && batches.length === 0) return true;
  const filesDone = files.every((f) => f.phase === "success" || f.phase === "failed");
  const batchesDone = batches.every((b) => b.completed === b.totalFiles);
  return filesDone && batchesDone;
}
function getOutstandingTaskCount(chatIdStr) {
  const files = getConsolidatedFiles(chatIdStr);
  const batches = getConsolidatedBatches(chatIdStr);
  const outstandingFiles = files.filter((f) => f.phase !== "success" && f.phase !== "failed").length;
  const outstandingBatches = batches.filter((b) => b.completed < b.totalFiles).length;
  return outstandingFiles + outstandingBatches;
}
function syncSilentSessionTotals(chatIdStr) {
  const session = silentSessionMap.get(chatIdStr);
  if (!session) return null;
  const transferSession = syncChatTransferSession(chatIdStr);
  for (const key of transferSession.knownTaskKeys) {
    session.knownTaskKeys.add(key);
  }
  for (const [key, count] of transferSession.knownTaskCounts) {
    updateTaskCount(session, key, count);
  }
  for (const folder of transferSession.folders) {
    session.folders.add(folder);
  }
  for (const provider of transferSession.providers) {
    session.providers.add(provider);
  }
  session.total = Math.max(session.total, transferSession.total);
  session.completed = Math.max(session.completed, transferSession.completed);
  session.failed = Math.max(session.failed, transferSession.failed);
  return session;
}
async function refreshSilentProgress(client2, chatId) {
  const chatIdStr = chatId.toString();
  if (!silentSessionMap.has(chatIdStr)) return;
  const silentMsgId = silentNoticeMessageIdMap.get(chatIdStr);
  if (!silentMsgId) return;
  const session = syncSilentSessionTotals(chatIdStr) || getSilentSession(chatIdStr);
  const batches = getConsolidatedBatches(chatIdStr);
  const files = getConsolidatedFiles(chatIdStr);
  const totalBatchFiles = batches.reduce((sum, batch) => sum + batch.totalFiles, 0);
  const completedBatchFiles = batches.reduce((sum, batch) => sum + batch.completed, 0);
  const completedSingleFiles = files.filter((file) => file.phase === "success" || file.phase === "failed").length;
  const totalFiles = Math.max(session.total, totalBatchFiles + files.length, completedBatchFiles + completedSingleFiles, session.completed);
  const completedFiles = Math.max(session.completed, completedBatchFiles + completedSingleFiles);
  const isComplete = totalFiles > 0 && completedFiles >= totalFiles;
  const queueStats = getDownloadQueueStats();
  const text = buildSilentProgress(
    session.total,
    batches,
    files,
    session.completed,
    session.failed,
    session.taskId,
    queueStats.paused,
    queueStats.pauseReason
  );
  const buttons = isComplete && session.failed === 0 ? void 0 : buildTaskControlButtons(session.taskId);
  await safeEditMessage(client2, chatId, { message: silentMsgId, text, buttons });
}
async function checkAndResetSession(client2, chatId) {
  const chatIdStr = chatId.toString();
  const outstanding = getOutstandingTaskCount(chatIdStr);
  if (outstanding === 0 && silentSessionMap.has(chatIdStr)) {
    const zombieTaskId = getSessionTaskId(chatIdStr);
    silentSessionMap.delete(chatIdStr);
    removeTaskControlScope(zombieTaskId);
    silentNoticeMessageIdMap.delete(chatIdStr);
    lastSilentNotificationTimeMap.delete(chatIdStr);
    console.log(`[TG][silent] Auto-cleared zombie session for ${chatIdStr}`);
    return;
  }
  if (silentSessionMap.has(chatIdStr)) {
    if (process.env.TG_STATUS_DEBUG === "1") {
      console.log(`[TG][status] reset-skip chat=${chatIdStr} reason=silentSession`);
    }
    return;
  }
  const hasAnyTask = getActiveBatchCount(chatIdStr) > 0 || getActiveUploadCount(chatIdStr) > 0;
  if (!hasAnyTask || isAllConsolidatedTasksDone(chatIdStr)) {
    await deleteLastStatusMessage(client2, chatId);
    clearConsolidatedState(chatIdStr);
    resetChatTransferSession(chatIdStr);
  }
}
async function refreshConsolidatedMessage(client2, chatId, replyTo) {
  const chatIdStr = chatId.toString();
  const alreadySilent = silentSessionMap.has(chatIdStr);
  const fileCount = getBackgroundFileCount(chatIdStr);
  const logLine = `[TG][consolidated][${Date.now()}] check chat=${chatIdStr} silent=${alreadySilent} fileCount=${fileCount} replyTo=${!!replyTo}
`;
  appendTelegramDebugLog(logLine);
  if (alreadySilent || fileCount > 3) {
    await trySilentMode(client2, chatId, replyTo);
    return;
  }
  const files = getConsolidatedFiles(chatIdStr);
  const batches = getConsolidatedBatches(chatIdStr);
  if (files.length === 0 && batches.length === 0) return;
  const text = await buildConsolidatedStatus(files, batches);
  const existingMsgId = lastStatusMessageIdMap.get(chatIdStr);
  if (replyTo) {
    await deleteLastStatusMessage(client2, chatId);
    const msg = await safeReply(replyTo, { message: text });
    if (msg) {
      updateLastStatusMessageId(chatId, msg.id, false);
    }
    return;
  }
  if (existingMsgId) {
    await safeEditMessage(client2, chatId, { message: existingMsgId, text });
  }
}
function getDownloadQueueStats() {
  return downloadQueue.getStats();
}
function getFileDownloadConcurrency() {
  return downloadQueue.getMaxConcurrent();
}
function setFileDownloadConcurrency(value) {
  const normalized = downloadQueue.setMaxConcurrent(value);
  process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY = String(normalized);
  return normalized;
}
async function loadFileDownloadConcurrencySetting() {
  const value = await getSetting("telegram_file_download_concurrency", process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY || "2");
  return setFileDownloadConcurrency(normalizeFileDownloadConcurrency(value));
}
function getTaskStatus() {
  return downloadQueue.getDetailedStatus();
}
function resolveTaskChatIdForControl(taskId) {
  return resolveTaskChatId(taskId);
}
function forceStopDownloadTasks(reason) {
  return downloadQueue.forceStopAll(reason);
}
function pauseDownloadTasks(taskId) {
  if (taskId && !resolveTaskChatId(taskId)) return { active: 0, pending: 0, total: 0 };
  return downloadQueue.pause();
}
function resumeDownloadTasks(taskId) {
  if (taskId && !resolveTaskChatId(taskId)) return { active: 0, pending: 0, total: 0 };
  return downloadQueue.resume();
}
function cancelDownloadTask(selector) {
  const normalized = selector?.trim();
  if (normalized && resolveTaskChatId(normalized)) {
    return downloadQueue.cancel("no-such-task-selector", `\u7528\u6237\u901A\u8FC7 /task_cancel ${normalized} \u53D6\u6D88\u4EFB\u52A1`);
  }
  return downloadQueue.cancel(normalized, "\u7528\u6237\u901A\u8FC7 /task_cancel \u53D6\u6D88\u4EFB\u52A1");
}
async function cancelSilentTask(client2, chatId, taskId, fallbackMessageId, userId) {
  const mappedChatId = resolveTaskChatId(taskId);
  const chatIdStr = mappedChatId || chatId.toString();
  const editChatId = mappedChatId || chatId;
  if (!canControlTask(taskId, chatIdStr, userId)) {
    throw new Error("\u4EFB\u52A1\u4E0D\u5C5E\u4E8E\u5F53\u524D\u804A\u5929\u6216\u5DF2\u5931\u6548");
  }
  const session = silentSessionMap.get(chatIdStr);
  const silentMsgId = silentNoticeMessageIdMap.get(chatIdStr) || fallbackMessageId;
  const result = cancelDownloadTask(taskId);
  const total = Math.max(session?.total || 0, result.total);
  const completed = session?.completed || 0;
  const failed = session?.failed || 0;
  const pendingOrActive = Math.max(0, total - completed);
  if (silentMsgId) {
    const text = [
      `\u{1F6D1} **\u540E\u53F0\u4EFB\u52A1\u5DF2\u53D6\u6D88**`,
      ``,
      `\u{1F194} \u4EFB\u52A1\uFF1A\`${taskId}\``,
      `\u2705 \u5DF2\u5B8C\u6210: ${completed} \u4E2A\u6587\u4EF6`,
      ...failed > 0 ? [`\u274C \u5931\u8D25: ${failed} \u4E2A\u6587\u4EF6`] : [],
      `\u{1F6AB} \u5DF2\u505C\u6B62/\u6E05\u7A7A: ${pendingOrActive} \u4E2A\u7B49\u5F85\u6216\u8FDB\u884C\u4E2D\u7684\u4EFB\u52A1`,
      ``,
      `\u5DF2\u79FB\u9664\u6682\u505C / \u7EE7\u7EED / \u53D6\u6D88\u6309\u94AE\uFF0C\u6B64\u4EFB\u52A1\u4E0D\u4F1A\u518D\u54CD\u5E94\u65E7\u6309\u94AE\u64CD\u4F5C\u3002`
    ].join("\n");
    await safeEditMessage(client2, editChatId, { message: silentMsgId, text, buttons: new Api4.ReplyInlineMarkup({ rows: [] }) });
  }
  silentSessionMap.delete(chatIdStr);
  removeTaskControlScope(session?.taskId);
  removeTaskControlScope(taskId);
  silentNoticeMessageIdMap.delete(chatIdStr);
  lastSilentNotificationTimeMap.delete(chatIdStr);
  clearConsolidatedState(chatIdStr);
  resetChatTransferSession(chatIdStr);
  return result;
}
function retryFailedDownloadTasks(limit = 10, _taskId) {
  return downloadQueue.retryFailed(limit);
}
var mediaGroupQueues = /* @__PURE__ */ new Map();
var MEDIA_GROUP_DELAY = 1500;
async function downloadAndSaveFile(client2, message, originalFileName, targetDir, onProgress, signal) {
  const ext = path10.extname(originalFileName) || "";
  const tempStoredName = `${crypto6.randomUUID()}${ext}`;
  let saveDir = targetDir || UPLOAD_DIR;
  if (!fs7.existsSync(saveDir)) {
    try {
      fs7.mkdirSync(saveDir, { recursive: true });
    } catch (err) {
      console.error(`\u{1F916} \u521B\u5EFA\u4E0B\u8F7D\u76EE\u5F55\u5931\u8D25: ${saveDir}`, err);
      if (saveDir === UPLOAD_DIR) throw err;
      saveDir = UPLOAD_DIR;
    }
  }
  const filePath = path10.join(saveDir, tempStoredName);
  const totalSize = getEstimatedFileSize(message);
  let downloadedSize = 0;
  try {
    if (signal?.aborted) throw new Error("\u4E0B\u8F7D\u4EFB\u52A1\u5DF2\u505C\u6B62");
    await waitForDiskWatermark(totalSize || 0);
    const configuredWorkers = await getTelegramDownloadWorkers();
    const media = getDownloadableMedia(message);
    if (!media) {
      throw new Error("\u8BE5\u56FE\u6587\u6D88\u606F\u672A\u5305\u542B\u53EF\u4E0B\u8F7D\u5A92\u4F53");
    }
    const isPhotoMedia = isTelegramPhotoMedia(media);
    const workers = !isPhotoMedia && totalSize > TELEGRAM_DOWNLOAD_PART_SIZE ? Math.min(configuredWorkers, Math.ceil(totalSize / TELEGRAM_DOWNLOAD_PART_SIZE)) : 1;
    console.log(`\u{1F916} Telegram \u4E0B\u8F7D\u53C2\u6570: workers=${workers}, part=${TELEGRAM_DOWNLOAD_PART_SIZE} bytes, size=${totalSize || "unknown"}, photo=${isPhotoMedia}`);
    if (isPhotoMedia) {
      const downloaded = await client2.downloadMedia(message, {
        outputFile: filePath,
        progressCallback: onProgress ? ((downloaded2, total) => onProgress(Number(downloaded2), Number(total))) : void 0
      });
      if (!downloaded || !fs7.existsSync(filePath)) {
        throw new Error("Telegram \u56FE\u7247\u4E0B\u8F7D\u672A\u751F\u6210\u6587\u4EF6");
      }
    } else if (workers > 1 && totalSize > 0) {
      const fileHandle = await fs7.promises.open(filePath, "w");
      try {
        await fileHandle.truncate(totalSize);
        await Promise.all(Array.from({ length: workers }, async (_, workerIndex) => {
          let writeOffset = workerIndex * TELEGRAM_DOWNLOAD_PART_SIZE;
          for await (const chunk of client2.iterDownload({
            file: media,
            offset: bigInt(writeOffset),
            stride: TELEGRAM_DOWNLOAD_PART_SIZE * workers,
            chunkSize: TELEGRAM_DOWNLOAD_PART_SIZE,
            requestSize: TELEGRAM_DOWNLOAD_PART_SIZE,
            fileSize: bigInt(totalSize)
          })) {
            if (signal?.aborted) throw new Error("\u4E0B\u8F7D\u4EFB\u52A1\u5DF2\u505C\u6B62");
            if (writeOffset >= totalSize) break;
            const bytesToWrite = Math.min(chunk.length, totalSize - writeOffset);
            if (bytesToWrite > 0) {
              await fileHandle.write(chunk.subarray(0, bytesToWrite), 0, bytesToWrite, writeOffset);
              downloadedSize += bytesToWrite;
              if (onProgress) {
                onProgress(Math.min(downloadedSize, totalSize), totalSize);
              }
            }
            writeOffset += TELEGRAM_DOWNLOAD_PART_SIZE * workers;
          }
        }));
      } finally {
        await fileHandle.close();
      }
    } else {
      const writeStream = fs7.createWriteStream(filePath);
      for await (const chunk of client2.iterDownload({
        file: media,
        requestSize: TELEGRAM_DOWNLOAD_PART_SIZE
      })) {
        if (signal?.aborted) throw new Error("\u4E0B\u8F7D\u4EFB\u52A1\u5DF2\u505C\u6B62");
        writeStream.write(chunk);
        downloadedSize += chunk.length;
        if (onProgress && totalSize > 0) {
          onProgress(downloadedSize, totalSize);
        }
      }
      writeStream.end();
      await new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
    }
    const stats = fs7.statSync(filePath);
    if (totalSize > 0 && stats.size !== totalSize) {
      throw new Error(`\u4E0B\u8F7D\u6587\u4EF6\u5927\u5C0F\u4E0D\u4E00\u81F4: expected=${totalSize}, actual=${stats.size}`);
    }
    return { filePath, actualSize: stats.size, tempStoredName };
  } catch (error) {
    console.error("\u{1F916} \u4E0B\u8F7D\u6587\u4EF6\u5931\u8D25:", error);
    if (fs7.existsSync(filePath)) {
      fs7.unlinkSync(filePath);
    }
    return null;
  }
}
async function processFileUpload(client2, file, queue) {
  file.status = "queued";
  const attemptUpload = async (signal) => {
    let localFilePath;
    let storedName;
    try {
      const activeAccountId = storageManager.getActiveAccountId();
      const chatName = await getTelegramChatName(file.message);
      const batchFolder = null;
      const storageRules = await getStoragePathRules();
      const automaticFolder = buildStorageFolderWithRules({
        source: "telegram",
        chatName,
        folder: batchFolder,
        mimeType: file.mimeType,
        fileName: file.fileName
      }, storageRules);
      const chatIdForPath = queue?.chatId?.toString() || file.message.chatId?.toString() || "unknown";
      const storageFolder = file.folderOverride !== void 0 ? file.folderOverride : queue?.storageFolder !== void 0 ? queue.storageFolder : resolveTelegramStorageFolder(chatIdForPath, automaticFolder);
      const downloadSource = await resolveDownloadSource(client2, file.message);
      const result = await downloadAndSaveFile(downloadSource.client, downloadSource.message, file.fileName, file.targetDir, void 0, signal);
      if (!result) {
        file.error = "\u4E0B\u8F7D\u5931\u8D25";
        return false;
      }
      localFilePath = result.filePath;
      const actualSize = result.actualSize;
      const fileType = getFileType(file.mimeType);
      const duplicateMode = await getDuplicateMode();
      if (duplicateMode === "skip") {
        const duplicate = await findDuplicateFile(file.fileName, storageFolder, actualSize, activeAccountId);
        if (duplicate) {
          file.status = "success";
          file.size = actualSize;
          file.fileType = fileType;
          if (queue?.chatId) {
            const chatIdStr = queue.chatId.toString();
            const batchId = file.message.groupedId?.toString();
            if (batchId) updateBatch(chatIdStr, batchId, { folderPath: storageFolder || void 0, providerName: storageManager.getProvider().name });
            rememberTransferDestination(chatIdStr, storageFolder, storageManager.getProvider().name);
          }
          if (localFilePath && fs7.existsSync(localFilePath)) fs7.unlinkSync(localFilePath);
          return true;
        }
      }
      const provider = storageManager.getProvider();
      const storageLockKey = `${provider.name}:${activeAccountId || "local"}:${storageFolder || ""}`;
      return await withTelegramStorageWriteLock(storageLockKey, async () => {
        storedName = await getUniqueStoredName(file.fileName, storageFolder, activeAccountId);
        let thumbnailPath = null;
        let dimensions = {};
        if (provider.name === "local" && (file.mimeType.startsWith("image/") || file.mimeType.startsWith("video/"))) {
          try {
            thumbnailPath = await generateThumbnail(localFilePath, storedName, file.mimeType);
            dimensions = await getImageDimensions(localFilePath, file.mimeType);
          } catch (thumbErr) {
            console.warn("\u{1F916} \u751F\u6210\u7F29\u7565\u56FE/\u83B7\u53D6\u5C3A\u5BF8\u5931\u8D25\uFF0C\u7EE7\u7EED\u4E0A\u4F20:", thumbErr);
          }
        }
        let finalPath = localFilePath;
        let sourceRef = provider.name;
        try {
          finalPath = await provider.saveFile(localFilePath, storedName, file.mimeType, storageFolder);
          if (fs7.existsSync(localFilePath)) {
            fs7.unlinkSync(localFilePath);
          }
          localFilePath = void 0;
        } catch (err) {
          console.error("\u4FDD\u5B58\u6587\u4EF6\u5230\u5B58\u50A8\u63D0\u4F9B\u5546\u5931\u8D25:", err);
          throw err;
        }
        await query(`
                    INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                `, [file.fileName, storedName, fileType, file.mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, storageFolder, activeAccountId]);
        file.status = "success";
        file.size = actualSize;
        file.fileType = fileType;
        if (queue?.chatId) {
          const chatIdStr = queue.chatId.toString();
          const batchId = file.message.groupedId?.toString();
          if (batchId) updateBatch(chatIdStr, batchId, { folderPath: storageFolder || void 0, providerName: provider.name });
          rememberTransferDestination(chatIdStr, storageFolder, provider.name);
        }
        return true;
      });
    } catch (error) {
      console.error("\u{1F916} \u6587\u4EF6\u4E0A\u4F20\u5931\u8D25:", error);
      file.error = error.message;
      if (localFilePath && fs7.existsSync(localFilePath)) {
        try {
          fs7.unlinkSync(localFilePath);
          console.log(`\u{1F916} \u4E0A\u4F20\u5C1D\u8BD5\u5931\u8D25\uFF0C\u5DF2\u81EA\u52A8\u6E05\u7406\u672C\u5730\u5783\u573E\u7F13\u5B58: ${localFilePath}`);
        } catch (e) {
          console.error("\u{1F916} \u81EA\u52A8\u6E05\u7406\u5783\u573E\u7F13\u5B58\u5931\u8D25:", e);
        }
      }
      return false;
    }
  };
  const queueTask = async (signal) => {
    file.status = "uploading";
    const firstAttemptSuccess = await attemptUpload(signal);
    if (!firstAttemptSuccess && !signal.aborted && !file.retried) {
      file.retried = true;
      file.status = "uploading";
      file.error = void 0;
      const secondAttemptSuccess = await attemptUpload(signal);
      if (!secondAttemptSuccess) {
        file.status = "failed";
      }
    } else if (!firstAttemptSuccess) {
      file.status = "failed";
    }
  };
  const taskDisplayName = queue?.folderName ? `${queue.folderName}/${file.fileName}` : file.fileName;
  return downloadQueue.add(taskDisplayName, queueTask);
}
async function processMediaGroupFilesBounded(client2, queue, onFileSettled) {
  for (let offset = 0; offset < queue.files.length; offset += TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE) {
    const batch = queue.files.slice(offset, offset + TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE);
    await Promise.all(batch.map((file) => processFileUpload(client2, file, queue).finally(onFileSettled)));
  }
}
async function processBatchUpload(client2, mediaGroupId) {
  const queue = mediaGroupQueues.get(mediaGroupId);
  if (!queue || queue.processingStarted) return;
  queue.processingStarted = true;
  const firstMessage = queue.files[0]?.message;
  if (!firstMessage) return;
  let folderName = "";
  for (const file of queue.files) {
    const caption = file.message.message || file.message.text || "";
    if (caption && caption.trim()) {
      folderName = caption.split(/\r?\n/)[0].trim();
      break;
    }
  }
  const chatId = queue.chatId;
  const batchId = mediaGroupId;
  if (!folderName || isOpaqueTelegramIdentifier(folderName)) {
    folderName = await getTelegramBatchFolderName(firstMessage, mediaGroupId);
  }
  await checkAndResetSession(client2, chatId);
  registerBatch(chatId.toString(), batchId, {
    id: batchId,
    folderName,
    folderPath: void 0,
    totalFiles: queue.files.length,
    completed: 0,
    successful: 0,
    failed: 0,
    providerName: storageManager.getProvider().name,
    queuePending: 0
  });
  const sanitizedFolderName = sanitizeFilename(folderName);
  const targetDir = path10.join(UPLOAD_DIR, sanitizedFolderName);
  if (!fs7.existsSync(targetDir)) {
    fs7.mkdirSync(targetDir, { recursive: true });
  }
  queue.folderName = sanitizedFolderName;
  for (const file of queue.files) {
    file.targetDir = targetDir;
  }
  const firstBatchFile = queue.files[0];
  if (firstBatchFile) {
    const chatName = await getTelegramChatName(firstBatchFile.message);
    const batchFolder = null;
    const storageRules = await getStoragePathRules();
    const automaticPreview = buildStorageFolderWithRules({
      source: "telegram",
      chatName,
      folder: batchFolder,
      mimeType: firstBatchFile.mimeType,
      fileName: firstBatchFile.fileName
    }, storageRules);
    const storageFolder = resolveTelegramBatchStorageFolder(chatId.toString(), automaticPreview);
    queue.storageFolder = storageFolder;
    const folderPreview = storageFolder;
    updateBatch(chatId.toString(), batchId, { folderName: queue.folderName, folderPath: folderPreview || void 0 });
    queue.folderPath = folderPreview || void 0;
    rememberTransferDestination(chatId.toString(), folderPreview, storageManager.getProvider().name);
  }
  if (!silentSessionMap.has(chatId.toString())) {
    await runStatusAction(chatId, async () => {
      const stats = downloadQueue.getStats();
      await refreshConsolidatedMessage(client2, chatId, firstMessage);
    });
  }
  const onBatchProgress = async () => {
    const completed = queue.files.filter((f) => f.status === "success" || f.status === "failed").length;
    const successful = queue.files.filter((f) => f.status === "success").length;
    const failed = queue.files.filter((f) => f.status === "failed").length;
    const currentFile = queue.files.find((f) => f.status === "uploading" || f.status === "queued") || queue.files.find((f) => f.status === "pending");
    const stats = downloadQueue.getStats();
    updateBatch(chatId.toString(), batchId, {
      completed,
      successful,
      failed,
      queuePending: stats.pending,
      currentFileName: currentFile?.fileName
    });
    if (silentSessionMap.has(chatId.toString())) {
      await runStatusAction(chatId, async () => {
        await refreshSilentProgress(client2, chatId);
      });
    } else {
      await runStatusAction(chatId, async () => {
        await refreshConsolidatedMessage(client2, chatId);
      });
    }
  };
  const refreshBatchProgressAndFinalizeSilent = async () => {
    await onBatchProgress();
    const chatIdStr = chatId.toString();
    if (silentSessionMap.has(chatIdStr)) {
      const sess = getSilentSession(chatIdStr);
      const failedFiles = getConsolidatedFiles(chatIdStr).filter((f) => f.phase === "failed").length;
      const failedBatches = getConsolidatedBatches(chatIdStr).reduce((sum, b) => sum + (b.failed || 0), 0);
      sess.failed = Math.max(sess.failed, failedFiles + failedBatches);
      await finalizeSilentSessionIfDone(client2, chatId);
    }
  };
  let lastTime = 0;
  const statusUpdater = setInterval(async () => {
    const now = Date.now();
    if (now - lastTime < 3e3) return;
    lastTime = now;
    await onBatchProgress();
  }, 3e3);
  try {
    await processMediaGroupFilesBounded(client2, queue, refreshBatchProgressAndFinalizeSilent);
    await onBatchProgress();
    await finalizeSilentSessionIfDone(client2, chatId);
  } finally {
    clearInterval(statusUpdater);
    setTimeout(() => {
      removeBatch(chatId.toString(), batchId);
    }, 8e3);
    mediaGroupQueues.delete(mediaGroupId);
  }
}
var pendingCleanups = /* @__PURE__ */ new Map();
async function handleCleanupCallback(cleanupId) {
  const cleanupInfo = pendingCleanups.get(cleanupId);
  if (!cleanupInfo) {
    return { success: false, message: "\u8BE5\u6E05\u7406\u4EFB\u52A1\u5DF2\u8FC7\u671F\u6216\u4E0D\u5B58\u5728" };
  }
  try {
    if (cleanupInfo.localPath && fs7.existsSync(cleanupInfo.localPath)) {
      fs7.unlinkSync(cleanupInfo.localPath);
    }
    pendingCleanups.delete(cleanupId);
    return {
      success: true,
      message: `\u2705 \u5DF2\u6E05\u7406 ${cleanupInfo.fileName} \u7684\u5783\u573E\u7F13\u5B58 (${formatBytes(cleanupInfo.size)})`
    };
  } catch (error) {
    console.error("\u{1F916} \u6E05\u7406\u5783\u573E\u7F13\u5B58\u5931\u8D25:", error);
    return { success: false, message: `\u6E05\u7406\u5931\u8D25: ${error.message}` };
  }
}
function sourceKeyForDownloadRef(source) {
  if (typeof source === "string") return source;
  const anySource = source;
  const id = anySource?.channelId || anySource?.chatId || anySource?.userId || anySource?.id;
  if (id !== void 0 && id !== null) {
    return `${anySource?.className || "peer"}:${id.toString()}`;
  }
  return JSON.stringify(source);
}
function normalizeTelegramDownloadRefs(refs, defaultSourceEntity) {
  if (!refs) return void 0;
  return refs.filter((ref) => ref.id > 0).map((ref) => ({ ...ref, source: ref.source || defaultSourceEntity }));
}
async function downloadTelegramChannelRange(botClient, requestMessage, source, startMessageId, limit = 50, direction = "older", explicitIds, folderOverride, explicitRefs, onItemSettled) {
  const userClient2 = getTelegramUserClient();
  if (!userClient2 || !isTelegramUserClientReady()) {
    throw new Error("Telegram \u7528\u6237\u8D26\u53F7\u4E0B\u8F7D\u5668\u672A\u5C31\u7EEA\uFF1A\u8BF7\u5148\u914D\u7F6E TELEGRAM_API_ID / TELEGRAM_API_HASH \u5E76\u751F\u6210 user session");
  }
  const safeLimit = Math.max(1, Math.floor(limit || TG_BATCH_DEFAULT_LIMIT));
  const sourceEntity = source.startsWith("@") || /^-?\d+$/.test(source) || /^https?:\/\//i.test(source) ? source : `@${source}`;
  const normalizedExplicitRefs = normalizeTelegramDownloadRefs(explicitRefs, sourceEntity);
  const ids = normalizedExplicitRefs?.map((ref) => ref.id) || explicitIds?.filter((id) => id > 0) || Array.from({ length: safeLimit }, (_, index) => direction === "newer" ? startMessageId + index : startMessageId - index).filter((id) => id > 0);
  if (ids.length === 0) {
    throw new Error("\u8D77\u59CB\u6D88\u606F ID \u65E0\u6548");
  }
  const chatId = requestMessage.chatId;
  if (!chatId) {
    throw new Error("\u65E0\u6CD5\u8BC6\u522B\u5F53\u524D Bot \u4F1A\u8BDD");
  }
  await checkAndResetSession(botClient, chatId);
  let found = 0;
  let skipped = 0;
  const chatIdStr = chatId.toString();
  const taskFolderOverride = folderOverride !== void 0 ? folderOverride : void 0;
  let taskResolvedStorageFolder;
  const downloadableRefs = [];
  const successfulMessageIds = [];
  const failedMessageIds = [];
  const skippedMessageIds = [];
  if (normalizedExplicitRefs) {
    for (const ref of normalizedExplicitRefs) {
      const refSource = ref.source || sourceEntity;
      const fileInfo = ref.fileInfo;
      if (!fileInfo) {
        skipped += 1;
        skippedMessageIds.push(ref.id);
        await onItemSettled?.(ref, "skipped");
        continue;
      }
      downloadableRefs.push({
        id: ref.id,
        sourceKey: sourceKeyForDownloadRef(refSource),
        sourceEntity: refSource,
        origin: ref.origin || "channel",
        channelPostId: ref.channelPostId,
        fileInfo,
        totalSize: ref.totalSize || 0,
        message: ref.message
      });
    }
  } else {
    for (let offset = 0; offset < ids.length; offset += TG_LARGE_TASK_SEGMENT_SIZE) {
      const scanIds = ids.slice(offset, offset + TG_LARGE_TASK_SEGMENT_SIZE);
      const scanMessages = await userClient2.getMessages(sourceEntity, { ids: scanIds });
      const returnedIds = /* @__PURE__ */ new Set();
      for (const sourceMessage of scanMessages) {
        if (!sourceMessage) continue;
        returnedIds.add(sourceMessage.id);
        const fileInfo = extractFileInfo(sourceMessage);
        if (!fileInfo) {
          skipped += 1;
          skippedMessageIds.push(sourceMessage.id);
          continue;
        }
        downloadableRefs.push({
          id: sourceMessage.id,
          sourceKey: sourceKeyForDownloadRef(sourceEntity),
          sourceEntity,
          origin: "channel",
          fileInfo,
          totalSize: getEstimatedFileSize(sourceMessage)
        });
      }
      for (const requestedId of scanIds) {
        if (!returnedIds.has(requestedId)) {
          skipped += 1;
          skippedMessageIds.push(requestedId);
        }
      }
    }
  }
  const batchId = `tg-range-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (downloadableRefs.length > 0) {
    const firstRef = downloadableRefs[0];
    if (taskFolderOverride !== void 0) {
      taskResolvedStorageFolder = taskFolderOverride;
    } else if (firstRef) {
      const firstMessage = (await userClient2.getMessages(firstRef.sourceEntity, { ids: [firstRef.id] }))[0];
      if (firstMessage) {
        const chatName = await getTelegramChatName(firstMessage);
        const storageRules = await getStoragePathRules();
        const automaticPreview = buildStorageFolderWithRules({
          source: "telegram",
          chatName,
          mimeType: firstRef.fileInfo.mimeType,
          fileName: firstRef.fileInfo.fileName
        }, storageRules);
        taskResolvedStorageFolder = resolveTelegramTaskStorageFolder(chatIdStr, automaticPreview).folder;
      }
    }
    registerBatch(chatIdStr, batchId, {
      id: batchId,
      folderName: sourceEntity.toString(),
      folderPath: taskResolvedStorageFolder || void 0,
      totalFiles: downloadableRefs.length,
      completed: 0,
      successful: 0,
      failed: 0,
      providerName: storageManager.getProvider().name,
      queuePending: 0
    });
    await trySilentMode(botClient, chatId, requestMessage);
    await refreshConsolidatedMessage(botClient, chatId, requestMessage);
  }
  let completed = 0;
  let successful = 0;
  let failed = 0;
  let lastStatusRefresh = 0;
  const refreshSegmentStatus = async (force = false, currentFileName) => {
    if (!shouldRefreshLargeTaskStatus(lastStatusRefresh, completed, force)) return;
    lastStatusRefresh = Date.now();
    const stats = downloadQueue.getStats();
    updateBatch(chatIdStr, batchId, {
      completed,
      successful,
      failed,
      queuePending: stats.pending,
      currentFileName
    });
    if (silentSessionMap.has(chatIdStr)) {
      await refreshSilentProgress(botClient, chatId);
      await finalizeSilentSessionIfDone(botClient, chatId);
    } else {
      await refreshConsolidatedMessage(botClient, chatId);
    }
  };
  for (let offset = 0; offset < downloadableRefs.length; offset += TG_LARGE_TASK_SEGMENT_SIZE) {
    const segment = downloadableRefs.slice(offset, offset + TG_LARGE_TASK_SEGMENT_SIZE);
    const segmentBytes = segment.reduce((sum, item) => sum + (item.totalSize || 0), 0);
    await waitForDiskWatermark(segmentBytes);
    const segmentMessagesBySource = /* @__PURE__ */ new Map();
    const refsBySource = /* @__PURE__ */ new Map();
    for (const item of segment) {
      const items = refsBySource.get(item.sourceKey) || [];
      items.push(item);
      refsBySource.set(item.sourceKey, items);
    }
    for (const [sourceKey, sourceItems] of refsBySource) {
      const preloadedMessageById = /* @__PURE__ */ new Map();
      const missingSourceItems = [];
      for (const sourceItem of sourceItems) {
        if (sourceItem.message) {
          preloadedMessageById.set(sourceItem.id, sourceItem.message);
        } else {
          missingSourceItems.push(sourceItem);
        }
      }
      if (missingSourceItems.length > 0) {
        const segmentIds = missingSourceItems.map((item) => item.id);
        const segmentMessages = await userClient2.getMessages(sourceItems[0].sourceEntity, { ids: segmentIds });
        for (const segmentMessage of segmentMessages) {
          if (segmentMessage) preloadedMessageById.set(segmentMessage.id, segmentMessage);
        }
      }
      segmentMessagesBySource.set(sourceKey, preloadedMessageById);
    }
    await Promise.all(segment.map(async (item) => {
      const { fileName, mimeType } = item.fileInfo;
      const message = segmentMessagesBySource.get(item.sourceKey)?.get(item.id);
      if (!message) {
        skipped += 1;
        failed += 1;
        completed += 1;
        failedMessageIds.push(item.id);
        await refreshSegmentStatus(false, fileName);
        await onItemSettled?.(item, "failed", "\u6D88\u606F\u4E0D\u5B58\u5728\u6216\u65E0\u6CD5\u91CD\u65B0\u8BFB\u53D6");
        return;
      }
      const uploadItem = {
        fileName,
        mimeType,
        message,
        status: "pending"
      };
      try {
        if (taskResolvedStorageFolder !== void 0) {
          updateBatch(chatIdStr, batchId, { folderPath: taskResolvedStorageFolder || void 0 });
        } else if (!getConsolidatedBatches(chatIdStr).find((batch) => batch.id === batchId)?.folderPath) {
          const chatName = await getTelegramChatName(message);
          const storageRules = await getStoragePathRules();
          const automaticPreview = buildStorageFolderWithRules({
            source: "telegram",
            chatName,
            mimeType,
            fileName
          }, storageRules);
          const resolved = resolveTelegramTaskStorageFolder(chatIdStr, automaticPreview).folder;
          taskResolvedStorageFolder = resolved;
          updateBatch(chatIdStr, batchId, { folderPath: resolved || void 0 });
        }
        uploadItem.folderOverride = taskResolvedStorageFolder !== void 0 ? taskResolvedStorageFolder : taskFolderOverride;
        await refreshSegmentStatus(true, fileName);
        await processFileUpload(userClient2, uploadItem);
        if (uploadItem.status === "success") {
          successful += 1;
          successfulMessageIds.push(item.id);
          await onItemSettled?.(item, "success");
        } else {
          failed += 1;
          failedMessageIds.push(item.id);
          await onItemSettled?.(item, "failed", uploadItem.error || "\u4E0B\u8F7D\u5931\u8D25");
        }
      } catch (err) {
        console.error(`\u{1F916} \u9891\u9053\u5206\u6BB5\u4E0B\u8F7D\u4EFB\u52A1\u5F02\u5E38: ${fileName}`, err);
        failed += 1;
        failedMessageIds.push(item.id);
        await onItemSettled?.(item, "failed", err instanceof Error ? err.message : String(err));
      } finally {
        completed += 1;
        found += 1;
        await refreshSegmentStatus(false, fileName);
      }
    }));
    await refreshSegmentStatus(true, segment[segment.length - 1]?.fileInfo.fileName);
  }
  if (downloadableRefs.length > 0) {
    updateBatch(chatIdStr, batchId, { completed, successful, failed, queuePending: 0, currentFileName: void 0 });
    await refreshSegmentStatus(true);
    await finalizeSilentSessionIfDone(botClient, chatId);
    setTimeout(() => removeBatch(chatIdStr, batchId), 8e3);
  }
  return {
    requested: ids.length,
    found,
    skipped,
    failed,
    successful,
    successfulMessageIds,
    failedMessageIds,
    skippedMessageIds: skippedMessageIds.filter((id) => id > 0),
    firstId: ids[0],
    lastId: ids[ids.length - 1]
  };
}
async function handleFileUpload(client2, event) {
  const message = event.message;
  const senderId = message.senderId?.toJSNumber();
  if (!senderId) return;
  if (!await isAuthenticatedAsync(senderId)) {
    await message.reply({ message: MSG.AUTH_REQUIRED_UPLOAD });
    return;
  }
  const fileInfo = extractFileInfo(message);
  if (!fileInfo) {
    if (message.media) {
      if (message.media.className === "MessageMediaWebPage") return;
      await message.reply({ message: MSG.UNSUPPORTED_MEDIA });
    }
    return;
  }
  const { fileName, mimeType } = fileInfo;
  const mediaGroupId = message.groupedId?.toString();
  if (mediaGroupId) {
    if (message.chatId) {
      await checkAndResetSession(client2, message.chatId);
    }
    let queue = mediaGroupQueues.get(mediaGroupId);
    if (!queue) {
      queue = {
        chatId: message.chatId,
        files: [],
        processingStarted: false,
        createdAt: Date.now()
      };
      mediaGroupQueues.set(mediaGroupId, queue);
      setTimeout(() => {
        processBatchUpload(client2, mediaGroupId);
      }, MEDIA_GROUP_DELAY);
    }
    queue.files.push({
      fileName,
      mimeType,
      message,
      status: "pending"
    });
    if (message.chatId) {
      const chatIdStr = message.chatId.toString();
      const batchId = mediaGroupId;
      const batchMap = chatActiveBatches.get(chatIdStr);
      if (!batchMap || !batchMap.has(batchId)) {
        registerBatch(chatIdStr, batchId, {
          id: batchId,
          folderName: queue.folderName || "media-group",
          folderPath: void 0,
          totalFiles: queue.files.length,
          completed: 0,
          successful: 0,
          failed: 0,
          providerName: storageManager.getProvider().name,
          queuePending: 0
        });
      } else {
        updateBatch(chatIdStr, batchId, {
          totalFiles: queue.files.length
        });
      }
    }
    if (message.chatId) {
      await trySilentMode(client2, message.chatId, message);
      const taskId = getSessionTaskId(message.chatId.toString());
      if (taskId) registerTaskControlScope(taskId, message.chatId.toString(), senderId);
    }
  } else {
    let finalFileName = fileName;
    const caption = message.message || "";
    if (caption && caption.trim()) {
      const ext = path10.extname(fileName);
      const firstLine = caption.split(/\r?\n/)[0].trim();
      const sanitizedCaption = sanitizeFilename(firstLine);
      if (ext && !sanitizedCaption.toLowerCase().endsWith(ext.toLowerCase())) {
        finalFileName = `${sanitizedCaption}${ext}`;
      } else {
        finalFileName = sanitizedCaption;
      }
    }
    const typeEmoji = getTypeEmoji(mimeType);
    const totalSize = getEstimatedFileSize(message);
    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const chatId = message.chatId;
    const chatIdStr = chatId.toString();
    if (message.chatId) {
      await checkAndResetSession(client2, chatId);
    }
    registerUpload(chatIdStr, uploadId, {
      fileName: finalFileName,
      typeEmoji,
      phase: "queued",
      total: totalSize
    });
    let statusMsg;
    const useConsolidated = () => getActiveUploadCount(chatIdStr) >= 2 || getActiveBatchCount(chatIdStr) > 0;
    await trySilentMode(client2, chatId, message);
    const silentTaskId = getSessionTaskId(chatIdStr);
    if (silentTaskId) registerTaskControlScope(silentTaskId, chatIdStr, senderId);
    if (!silentSessionMap.has(chatIdStr) && getBackgroundFileCount(chatIdStr) <= 3) {
      await runStatusAction(chatId, async () => {
        if (useConsolidated()) {
          await refreshConsolidatedMessage(client2, chatId, message);
        } else {
          await deleteLastStatusMessage(client2, chatId);
          statusMsg = await safeReply(message, {
            message: buildDownloadProgress(finalFileName, 0, totalSize, typeEmoji)
          });
          if (statusMsg) {
            updateLastStatusMessageId(chatId, statusMsg.id, false);
          }
        }
      });
    }
    const stats = downloadQueue.getStats();
    if (!useConsolidated() && statusMsg && (stats.active >= 2 || stats.pending > 0) && !silentSessionMap.has(chatIdStr)) {
      await runStatusAction(chatId, async () => {
        await safeEditMessage(client2, chatId, {
          message: statusMsg.id,
          text: buildQueuedMessage(finalFileName, stats.pending)
        });
      });
    }
    let lastUpdateTime = 0;
    const onProgress = async (downloaded, total) => {
      const now = Date.now();
      if (now - lastUpdateTime < 3e3) return;
      lastUpdateTime = now;
      updateUploadPhase(chatIdStr, uploadId, { phase: "downloading", downloaded, total });
      if (silentSessionMap.has(chatIdStr)) {
        await runStatusAction(chatId, async () => {
          await refreshSilentProgress(client2, chatId);
        });
        return;
      }
      if (useConsolidated()) {
        await runStatusAction(chatId, async () => {
          await refreshConsolidatedMessage(client2, chatId);
        });
      } else if (statusMsg) {
        await runStatusAction(chatId, async () => {
          await safeEditMessage(client2, chatId, {
            message: statusMsg.id,
            text: buildDownloadProgress(finalFileName, downloaded, total, typeEmoji)
          });
        });
      }
    };
    let retryCount = 0;
    const maxRetries = 1;
    let lastLocalPath;
    let lastError;
    const attemptSingleUpload = async (signal) => {
      let localFilePath;
      try {
        if (signal?.aborted) throw new Error("\u4E0B\u8F7D\u4EFB\u52A1\u5DF2\u505C\u6B62");
        const activeAccountId = storageManager.getActiveAccountId();
        const chatName = await getTelegramChatName(message);
        const storageRules = await getStoragePathRules();
        const automaticFolder = buildStorageFolderWithRules({
          source: "telegram",
          chatName,
          mimeType,
          fileName: finalFileName
        }, storageRules);
        const storageFolder = resolveTelegramStorageFolder(chatIdStr, automaticFolder);
        const storedName = await getUniqueStoredName(finalFileName, storageFolder, activeAccountId);
        const downloadSource = await resolveDownloadSource(client2, message);
        const result = await downloadAndSaveFile(downloadSource.client, downloadSource.message, fileName, void 0, onProgress, signal);
        if (!result) {
          lastError = "\u4E0B\u8F7D\u5931\u8D25";
          return false;
        }
        localFilePath = result.filePath;
        lastLocalPath = localFilePath;
        const { actualSize } = result;
        const fileType = getFileType(mimeType);
        const duplicateMode = await getDuplicateMode();
        if (duplicateMode === "skip") {
          const duplicate = await findDuplicateFile(finalFileName, storageFolder, actualSize, activeAccountId);
          if (duplicate) {
            if (fs7.existsSync(localFilePath)) fs7.unlinkSync(localFilePath);
            lastLocalPath = void 0;
            updateUploadPhase(chatIdStr, uploadId, { phase: "success", size: actualSize, providerName: storageManager.getProvider().name, fileType, folder: storageFolder });
            rememberTransferDestination(chatIdStr, storageFolder, storageManager.getProvider().name);
            if (statusMsg && !silentSessionMap.has(chatIdStr)) {
              await runStatusAction(chatId, async () => {
                await client2.editMessage(chatId, {
                  message: statusMsg.id,
                  text: buildDuplicateSkipped(finalFileName, storageFolder, duplicate.id)
                });
              });
            }
            return true;
          }
        }
        updateUploadPhase(chatIdStr, uploadId, { phase: "saving" });
        if (silentSessionMap.has(chatIdStr)) {
          await runStatusAction(chatId, async () => {
            await refreshSilentProgress(client2, chatId);
          });
        } else if (useConsolidated()) {
          await runStatusAction(chatId, async () => {
            await refreshConsolidatedMessage(client2, chatId);
          });
        } else if (statusMsg && !silentSessionMap.has(chatIdStr)) {
          await runStatusAction(chatId, async () => {
            await safeEditMessage(client2, chatId, {
              message: statusMsg.id,
              text: buildSavingFile(finalFileName, typeEmoji)
            });
          });
        }
        const provider = storageManager.getProvider();
        let thumbnailPath = null;
        let dimensions = {};
        if (provider.name === "local" && (mimeType.startsWith("image/") || mimeType.startsWith("video/"))) {
          try {
            thumbnailPath = await generateThumbnail(localFilePath, storedName, mimeType);
            dimensions = await getImageDimensions(localFilePath, mimeType);
          } catch (thumbErr) {
          }
        }
        let finalPath = localFilePath;
        let sourceRef = provider.name;
        try {
          finalPath = await provider.saveFile(localFilePath, storedName, mimeType, storageFolder);
          if (fs7.existsSync(localFilePath)) {
            fs7.unlinkSync(localFilePath);
          }
          lastLocalPath = void 0;
          localFilePath = void 0;
        } catch (err) {
          lastError = err.message;
          throw err;
        }
        await query(`
                    INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                `, [finalFileName, storedName, fileType, mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, storageFolder, activeAccountId]);
        updateUploadPhase(chatIdStr, uploadId, { phase: "success", size: actualSize, providerName: provider.name, fileType, folder: storageFolder });
        rememberTransferDestination(chatIdStr, storageFolder, provider.name);
        if (useConsolidated()) {
          await runStatusAction(chatId, async () => {
            await refreshConsolidatedMessage(client2, chatId);
          });
        } else if (statusMsg && !silentSessionMap.has(chatIdStr)) {
          await runStatusAction(chatId, async () => {
            await client2.editMessage(chatId, {
              message: statusMsg.id,
              text: buildUploadSuccess(finalFileName, actualSize, fileType, provider.name, storageFolder)
            });
          });
        }
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF";
        if (localFilePath && fs7.existsSync(localFilePath)) {
          try {
            fs7.unlinkSync(localFilePath);
          } catch (e) {
          }
        }
        lastLocalPath = void 0;
        return false;
      }
    };
    const singleUploadTask = async (signal) => {
      let success = await attemptSingleUpload(signal);
      if (!success && !signal.aborted && retryCount < maxRetries) {
        retryCount++;
        if (lastLocalPath && fs7.existsSync(lastLocalPath)) {
          try {
            fs7.unlinkSync(lastLocalPath);
          } catch (e) {
          }
        }
        lastLocalPath = void 0;
        updateUploadPhase(chatIdStr, uploadId, { phase: "retrying" });
        if (silentSessionMap.has(chatIdStr)) {
          await runStatusAction(chatId, async () => {
            await refreshSilentProgress(client2, chatId);
          });
        } else if (useConsolidated()) {
          await runStatusAction(chatId, async () => {
            await refreshConsolidatedMessage(client2, chatId);
          });
        } else if (statusMsg && !silentSessionMap.has(chatIdStr)) {
          await runStatusAction(chatId, async () => {
            await client2.editMessage(chatId, {
              message: statusMsg.id,
              text: buildRetryMessage(finalFileName, typeEmoji)
            });
          });
        }
        success = await attemptSingleUpload(signal);
      }
      if (signal.aborted) {
        lastError = "\u7528\u6237\u5F3A\u5236\u505C\u6B62\u4E0B\u8F7D\u4EFB\u52A1";
        updateUploadPhase(chatIdStr, uploadId, { phase: "failed", error: lastError });
        if (statusMsg && !silentSessionMap.has(chatIdStr)) {
          await runStatusAction(chatId, async () => {
            await client2.editMessage(chatId, {
              message: statusMsg.id,
              text: buildUploadFail(finalFileName, lastError)
            }).catch(() => {
            });
          });
        }
      } else if (!success) {
        updateUploadPhase(chatIdStr, uploadId, { phase: "failed", error: lastError || "\u672A\u77E5\u9519\u8BEF" });
        if (silentSessionMap.has(chatIdStr)) {
          const sess = getSilentSession(chatIdStr);
          sess.completed += 1;
          sess.failed += 1;
          await refreshSilentProgress(client2, chatId);
          await finalizeSilentSessionIfDone(client2, chatId);
        }
        if (useConsolidated()) {
          await runStatusAction(chatId, async () => {
            await refreshConsolidatedMessage(client2, chatId);
          });
        } else if (statusMsg && !silentSessionMap.has(chatIdStr)) {
          await runStatusAction(chatId, async () => {
            await client2.editMessage(chatId, {
              message: statusMsg.id,
              text: buildUploadFail(finalFileName, lastError || "\u672A\u77E5\u9519\u8BEF")
            }).catch(() => {
            });
          });
        } else {
          await safeReply(message, {
            message: buildUploadFail(finalFileName, lastError || "\u672A\u77E5\u9519\u8BEF")
          });
        }
      } else {
        if (silentSessionMap.has(chatIdStr)) {
          const sess = getSilentSession(chatIdStr);
          sess.completed += 1;
          await refreshSilentProgress(client2, chatId);
          await finalizeSilentSessionIfDone(client2, chatId);
        }
      }
      setTimeout(() => {
        removeUpload(chatIdStr, uploadId);
      }, 8e3);
    };
    downloadQueue.add(finalFileName, singleUploadTask).catch((err) => {
      console.error(`\u{1F916} \u5355\u6587\u4EF6\u4E0B\u8F7D\u4EFB\u52A1\u5F02\u5E38: ${finalFileName}`, err);
      removeUpload(chatIdStr, uploadId);
    });
  }
}

// src/services/telegramCommands.ts
init_storage();

// src/services/telegramChannelJobs.ts
init_db();
var SUBSCRIPTION_INTERVAL_MS = Math.max(6e4, parseInt(process.env.TELEGRAM_SUBSCRIPTION_INTERVAL_MS || "300000", 10) || 3e5);
var SUBSCRIPTION_SCAN_LIMIT = Math.max(1, parseInt(process.env.TELEGRAM_SUBSCRIPTION_SCAN_LIMIT || "100", 10) || 100);
var TG_JOB_RECOVERY_DELAY_MS = Math.max(1e3, parseInt(process.env.TG_JOB_RECOVERY_DELAY_MS || "10000", 10) || 1e4);
var TG_JOB_SCAN_SEGMENT_SIZE = Math.max(20, parseInt(process.env.TG_JOB_SCAN_SEGMENT_SIZE || "100", 10) || 100);
var TG_JOB_DOWNLOAD_BATCH_SIZE = Math.max(1, parseInt(process.env.TG_JOB_DOWNLOAD_BATCH_SIZE || "20", 10) || 20);
var TG_JOB_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.TG_JOB_MAX_ATTEMPTS || "3", 10) || 3);
var TELEGRAM_COMMENTS_MAX_PER_POST = Math.max(1, parseInt(process.env.TELEGRAM_COMMENTS_MAX_PER_POST || "200", 10) || 200);
var subscriptionTimer = null;
var recoveryStarted = false;
var recoveryRunning = false;
function parseTelegramSourceAllowlist(raw) {
  return (raw || "").split(",").map((item) => item.trim()).filter(Boolean).map((item) => normalizeSource(item).toLowerCase());
}
async function getTelegramSourceAllowlist() {
  const envList = parseTelegramSourceAllowlist(process.env.TELEGRAM_ALLOWED_SOURCES || process.env.TELEGRAM_SOURCE_ALLOWLIST || "");
  if (envList.length > 0) return envList;
  const stored = await getSetting("telegram_allowed_sources", "");
  return parseTelegramSourceAllowlist(stored || "");
}
async function assertTelegramSourceAllowed(source) {
  const normalized = normalizeSource(source).toLowerCase();
  const allowlist = await getTelegramSourceAllowlist();
  if (allowlist.length === 0) {
    if (/^-?\d+$/.test(normalized)) {
      throw new Error("\u672A\u914D\u7F6E Telegram \u6765\u6E90\u767D\u540D\u5355\uFF0C\u7981\u6B62\u4F7F\u7528\u6570\u5B57 ID/\u79C1\u804A/\u79C1\u5BC6\u7FA4\u7EC4\u6765\u6E90\u3002\u8BF7\u914D\u7F6E TELEGRAM_ALLOWED_SOURCES\u3002");
    }
    return;
  }
  if (!allowlist.includes(normalized)) {
    throw new Error(`\u6765\u6E90 ${source} \u4E0D\u5728 Telegram \u4E0B\u8F7D\u767D\u540D\u5355\u4E2D`);
  }
}
function maxProcessedMessageId(result) {
  return Math.max(0, ...result.successfulMessageIds, ...result.skippedMessageIds);
}
function requireUserClient() {
  const userClient2 = getTelegramUserClient();
  if (!userClient2 || !isTelegramUserClientReady()) {
    throw new Error("Telegram \u7528\u6237\u8D26\u53F7\u4E0B\u8F7D\u5668\u672A\u5C31\u7EEA");
  }
  return userClient2;
}
function normalizeSource(source) {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("\u9891\u9053\u4E0D\u80FD\u4E3A\u7A7A");
  if (trimmed.startsWith("@") || /^-?\d+$/.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `@${trimmed}`;
}
function getEntityTitle(entity, fallback) {
  return entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || entity?.username || fallback;
}
function messageHasMedia(message) {
  if (!message) return false;
  return Boolean(message.media || message.document || message.photo || message.video || message.audio || message.voice || message.sticker);
}
function normalizeHashtag(tagInput) {
  const trimmed = tagInput.trim();
  if (!trimmed) throw new Error("\u6807\u7B7E\u4E0D\u80FD\u4E3A\u7A7A");
  const withoutHash = trimmed.replace(/^#+/, "");
  if (!withoutHash || /\s/.test(withoutHash)) throw new Error("\u6807\u7B7E\u683C\u5F0F\u5E94\u4E3A #xxx\uFF0C\u4E0D\u80FD\u5305\u542B\u7A7A\u683C");
  return `#${withoutHash}`;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function messageTextForTag(message) {
  if (!message) return "";
  return [message.message, message.text, message.caption].filter(Boolean).join("\n");
}
function messageMatchesHashtag(message, normalizedTag) {
  const body = messageTextForTag(message);
  if (!body) return false;
  const tag = escapeRegExp(normalizedTag.slice(1));
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])#${tag}(?![\\p{L}\\p{N}_])`, "iu");
  return pattern.test(body);
}
async function getLatestMessageId(userClient2, source) {
  const [latest] = await userClient2.getMessages(source, { limit: 1 });
  return latest?.id || 0;
}
function messageGroupId(message) {
  const groupedId = message?.groupedId;
  return groupedId ? groupedId.toString() : void 0;
}
async function expandMessagesWithMediaGroups(userClient2, source, messages) {
  const byId = /* @__PURE__ */ new Map();
  const seenGroups = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (messageHasMedia(message)) byId.set(message.id, message);
    const groupId = messageGroupId(message);
    if (!groupId || seenGroups.has(groupId)) continue;
    seenGroups.add(groupId);
    const ids = Array.from({ length: 41 }, (_, index) => message.id - 20 + index).filter((id) => id > 0);
    const nearby = await userClient2.getMessages(source, { ids });
    for (const candidate of nearby) {
      if (candidate && messageHasMedia(candidate) && messageGroupId(candidate) === groupId) {
        byId.set(candidate.id, candidate);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}
function sourcePeerKey(value, fallback) {
  if (value === void 0 || value === null) return fallback;
  return String(value);
}
async function persistDownloadRefs(jobId, source, refs, folderOverride) {
  for (const ref of refs) {
    await query(
      `INSERT INTO telegram_download_items (
                job_id, source, source_peer, origin, message_id, grouped_id, channel_post_id,
                file_name, mime_type, total_size, folder_override, status, error, last_error, locked_at, completed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NULL, NULL, NULL, NULL)
             ON CONFLICT (job_id, source_peer, message_id)
             DO UPDATE SET
                file_name = COALESCE(EXCLUDED.file_name, telegram_download_items.file_name),
                mime_type = COALESCE(EXCLUDED.mime_type, telegram_download_items.mime_type),
                total_size = COALESCE(EXCLUDED.total_size, telegram_download_items.total_size),
                folder_override = EXCLUDED.folder_override,
                updated_at = NOW()`,
      [
        jobId,
        source,
        sourcePeerKey(ref.source, source),
        ref.origin || "channel",
        ref.id,
        null,
        ref.channelPostId || null,
        ref.fileInfo?.fileName || null,
        ref.fileInfo?.mimeType || null,
        ref.totalSize || 0,
        folderOverride || null
      ]
    );
  }
}
async function getDiscussionMediaRefs(userClient2, source, postMessages, options = {}) {
  if (!options.includeComments || postMessages.length === 0) {
    return { refs: [], scanned: 0, mediaFound: 0 };
  }
  const maxPerPost = Math.max(1, Math.floor(options.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST));
  const refs = [];
  let scanned = 0;
  let mediaFound = 0;
  const seen = /* @__PURE__ */ new Set();
  for (const post of postMessages) {
    const declaredReplies = Number(post.replies?.replies || 0);
    if (declaredReplies <= 0) continue;
    let offsetId = 0;
    let scannedForPost = 0;
    while (scannedForPost < maxPerPost) {
      const batch = await userClient2.getMessages(source, {
        limit: Math.min(100, maxPerPost - scannedForPost),
        offsetId,
        replyTo: post.id
      });
      if (!batch.length) break;
      for (const comment of batch) {
        if (!comment) continue;
        scanned += 1;
        scannedForPost += 1;
        offsetId = comment.id;
        if (options.startDate || options.endDate) {
          const commentDate = new Date((comment.date || 0) * 1e3);
          if (options.startDate && commentDate < options.startDate) continue;
          if (options.endDate && commentDate > options.endDate) continue;
        }
        if (options.tag && !messageMatchesHashtag(comment, options.tag)) continue;
        const fileInfo = extractFileInfo(comment);
        if (!fileInfo) continue;
        const sourceKey = `${comment.chatId?.toString() || source}:${comment.id}`;
        if (seen.has(sourceKey)) continue;
        seen.add(sourceKey);
        mediaFound += 1;
        const ref = {
          id: comment.id,
          source: comment.chatId || source,
          origin: "comment",
          channelPostId: post.id,
          fileInfo,
          totalSize: getEstimatedFileSize(comment),
          message: comment
        };
        refs.push(ref);
        await options.onRefDiscovered?.(ref);
      }
      if (batch.length === 0 || scannedForPost >= maxPerPost) break;
    }
  }
  return { refs, scanned, mediaFound };
}
function toChannelDownloadRef(source, message) {
  const fileInfo = extractFileInfo(message);
  if (!fileInfo) return null;
  return {
    id: message.id,
    source,
    origin: "channel",
    fileInfo,
    totalSize: getEstimatedFileSize(message)
  };
}
async function buildDownloadScanResult(userClient2, source, messages, options = {}) {
  const refs = messages.map((message) => toChannelDownloadRef(source, message)).filter((ref) => Boolean(ref));
  for (const ref of refs) {
    await options.onRefDiscovered?.(ref);
  }
  const commentScan = await getDiscussionMediaRefs(userClient2, source, messages, options);
  refs.push(...commentScan.refs);
  return {
    messages,
    refs,
    channelMediaFound: refs.length,
    commentMessagesScanned: commentScan.scanned,
    commentMediaFound: commentScan.mediaFound
  };
}
async function markDownloadRefsDownloading(jobId, refs) {
  for (const ref of refs) {
    const sourcePeer = sourcePeerKey(ref.source, ref.origin === "comment" ? "comment" : "channel");
    await query(
      `UPDATE telegram_download_items
             SET status = 'downloading', locked_at = NOW(), updated_at = NOW()
             WHERE job_id = $1 AND source_peer = $2 AND message_id = $3
               AND status IN ('pending', 'failed')`,
      [jobId, sourcePeer, ref.id]
    );
  }
}
async function markDownloadRefStatus(jobId, ref, status, error) {
  const sourcePeer = sourcePeerKey(ref.source, ref.origin === "comment" ? "comment" : "channel");
  await query(
    `UPDATE telegram_download_items
         SET status = $3::varchar,
             error = $4,
             last_error = $4,
             attempts = CASE WHEN $3::text = 'failed' THEN attempts + 1 ELSE attempts END,
             completed_at = CASE WHEN $3::text IN ('success', 'skipped') THEN NOW() ELSE completed_at END,
             locked_at = NULL,
             updated_at = NOW()
         WHERE job_id = $1 AND source_peer = $2 AND message_id = $5`,
    [jobId, sourcePeer, status, error || null, ref.id]
  );
}
async function persistDownloadMessages(jobId, source, messages, folderOverride) {
  const refs = messages.map((message) => toChannelDownloadRef(source, message)).filter((ref) => Boolean(ref));
  await persistDownloadRefs(jobId, source, refs, folderOverride);
}
function parseDateOnly(value, endOfDay = false) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("\u65E5\u671F\u683C\u5F0F\u5FC5\u987B\u662F YYYY-MM-DD");
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return new Date(Date.UTC(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0
  ));
}
async function createJob(userId, chatId, kind, source, params) {
  const result = await query(
    `INSERT INTO telegram_background_jobs (user_id, chat_id, kind, source, params, status, scan_status, download_status, scan_cursor)
         VALUES ($1, $2, $3, $4, $5, 'queued', 'pending', 'pending', '{}'::jsonb)
         RETURNING id`,
    [userId, chatId || null, kind, source, JSON.stringify(params)]
  );
  return result.rows[0].id;
}
async function getJob(jobId) {
  const result = await query(`SELECT * FROM telegram_background_jobs WHERE id = $1`, [jobId]);
  return result.rows[0] || null;
}
async function updateJob(jobId, updates) {
  const entries = Object.entries(updates);
  if (entries.length === 0) return;
  const setSql = entries.map(([key], index) => `${key} = $${index + 2}`).join(", ");
  await query(`UPDATE telegram_background_jobs SET ${setSql}, updated_at = NOW() WHERE id = $1`, [jobId, ...entries.map(([, value]) => value)]);
}
async function hydratePendingDownloadRefs(userClient2, jobId) {
  const result = await query(
    `SELECT id, source_peer, message_id
         FROM telegram_download_items
         WHERE job_id = $1
           AND status = 'pending'
           AND (file_name IS NULL OR mime_type IS NULL)
         ORDER BY created_at ASC
         LIMIT 100`,
    [jobId]
  );
  let hydrated = 0;
  for (const row of result.rows) {
    try {
      const messages = await userClient2.getMessages(row.source_peer, { ids: [Number(row.message_id)] });
      const message = messages?.[0];
      if (!message) {
        await query(
          `UPDATE telegram_download_items
                     SET status = 'failed', error = $2, last_error = $2, attempts = attempts + 1, updated_at = NOW()
                     WHERE id = $1`,
          [row.id, "\u6D88\u606F\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u8865\u5168\u6587\u4EF6\u5143\u6570\u636E"]
        );
        continue;
      }
      const fileInfo = extractFileInfo(message);
      if (!fileInfo) {
        await query(
          `UPDATE telegram_download_items
                     SET status = 'skipped', error = $2, last_error = $2, completed_at = NOW(), updated_at = NOW()
                     WHERE id = $1`,
          [row.id, "\u6D88\u606F\u4E0D\u5305\u542B\u53EF\u4E0B\u8F7D\u5A92\u4F53\uFF0C\u65E0\u6CD5\u8865\u5168\u6587\u4EF6\u5143\u6570\u636E"]
        );
        continue;
      }
      await query(
        `UPDATE telegram_download_items
                 SET file_name = $2, mime_type = $3, total_size = $4, updated_at = NOW()
                 WHERE id = $1`,
        [row.id, fileInfo.fileName, fileInfo.mimeType, getEstimatedFileSize(message)]
      );
      hydrated += 1;
    } catch (error) {
      console.warn("\u267B\uFE0F \u8865\u5168 Telegram \u4E0B\u8F7D\u6761\u76EE\u5143\u6570\u636E\u5931\u8D25:", error);
    }
  }
  return hydrated;
}
async function subscribeTelegramChannel(userId, chatId, sourceInput, folderOverride) {
  const userClient2 = requireUserClient();
  const source = normalizeSource(sourceInput);
  await assertTelegramSourceAllowed(source);
  const entity = await userClient2.getEntity(source);
  const latestMessageId = await getLatestMessageId(userClient2, source);
  const title = getEntityTitle(entity, source);
  const result = await query(
    `INSERT INTO telegram_channel_subscriptions (user_id, chat_id, source, title, last_message_id, folder_override, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (user_id, source)
         DO UPDATE SET chat_id = EXCLUDED.chat_id, title = EXCLUDED.title, folder_override = EXCLUDED.folder_override, enabled = true, updated_at = NOW()
         RETURNING id, source, title, last_message_id, folder_override, enabled`,
    [userId, chatId || null, source, title, latestMessageId, folderOverride || null]
  );
  return result.rows[0];
}
async function listTelegramSubscriptions(userId, includeDisabled = false) {
  const result = await query(
    `SELECT id, source, title, last_message_id, folder_override, enabled, updated_at
         FROM telegram_channel_subscriptions
         WHERE user_id = $1
           AND ($2::boolean OR enabled = true)
         ORDER BY updated_at DESC`,
    [userId, includeDisabled]
  );
  return result.rows;
}
async function updateTelegramSubscriptionFolder(userId, selector, folderOverride) {
  const trimmed = selector.trim();
  const result = await query(
    `UPDATE telegram_channel_subscriptions
         SET folder_override = $2, updated_at = NOW()
         WHERE user_id = $1 AND id::text LIKE $3 AND enabled = true
         RETURNING id, source, title, last_message_id, folder_override, enabled`,
    [userId, folderOverride || null, `${trimmed}%`]
  );
  return result.rows[0] || null;
}
async function unsubscribeTelegramChannel(userId, selector) {
  const trimmed = selector.trim();
  const normalizedSelector = /^@|^https?:\/\//i.test(trimmed) || /^-?\d+$/.test(trimmed) ? normalizeSource(trimmed) : trimmed;
  const result = await query(
    `UPDATE telegram_channel_subscriptions
         SET enabled = false, updated_at = NOW()
         WHERE user_id = $1 AND (source = $2 OR id::text LIKE $3)
         RETURNING source, title`,
    [userId, normalizedSelector, `${trimmed}%`]
  );
  return result.rows[0] || null;
}
async function getJobItemStats(jobId) {
  const result = await query(
    `SELECT status, COUNT(*)::int AS count
         FROM telegram_download_items
         WHERE job_id = $1
         GROUP BY status`,
    [jobId]
  );
  const stats = { pending: 0, downloading: 0, success: 0, failed: 0, skipped: 0 };
  for (const row of result.rows) stats[row.status] = Number(row.count || 0);
  return stats;
}
async function getJobProgress(jobId) {
  const job = await getJob(jobId);
  if (!job) return null;
  const params = job.params || {};
  const cursor = job.scan_cursor || params.scan || {};
  const stats = await getJobItemStats(jobId);
  return {
    jobId,
    source: job.source,
    mode: job.kind === "tag_download" ? "tag" : "date",
    status: job.status,
    scanStatus: job.scan_status || "pending",
    downloadStatus: job.download_status || "pending",
    channelMessagesScanned: Number(cursor.channelMessagesScanned || 0),
    channelMediaFound: Number(cursor.channelMediaFound || 0),
    commentMessagesScanned: Number(cursor.commentMessagesScanned || 0),
    commentMediaFound: Number(cursor.commentMediaFound || 0),
    totalMediaFound: Number(job.total_count || 0),
    completed: Number(stats.success || 0),
    pending: Number(stats.pending || 0),
    downloading: Number(stats.downloading || 0),
    failed: Number(stats.failed || 0),
    skipped: Number(stats.skipped || 0),
    cooldownUntil: job.cooldown_until ? new Date(job.cooldown_until).toISOString() : null
  };
}
async function notifyProgress(jobId, options) {
  const progress = await getJobProgress(jobId);
  if (progress) await options.onProgress?.(progress);
}
function isFloodWait(error) {
  const anyErr = error;
  const text = `${anyErr?.message || ""} ${anyErr?.errorMessage || ""}`;
  const seconds = Number(anyErr?.seconds || anyErr?.value || text.match(/FLOOD_WAIT_?(\d+)/i)?.[1] || 0);
  if (seconds > 0 || /FLOOD|Too many requests/i.test(text)) return { seconds: Math.max(30, seconds || 60) };
  return null;
}
async function ensureJobCanRun(jobId) {
  const job = await getJob(jobId);
  if (!job) return "cancelled";
  if (job.cancelled_at || job.status === "cancelled") return "cancelled";
  if (job.paused_at || job.status === "paused") return "paused";
  if (job.cooldown_until && new Date(job.cooldown_until).getTime() > Date.now()) return "cooldown";
  return "run";
}
async function waitUntilRunnable(jobId, options) {
  while (true) {
    const state = await ensureJobCanRun(jobId);
    if (state === "run") return true;
    if (state === "cancelled") return false;
    await notifyProgress(jobId, options);
    await new Promise((resolve) => setTimeout(resolve, state === "cooldown" ? 5e3 : 2e3));
  }
}
async function claimPendingDownloadRefs(jobId, limit = TG_JOB_DOWNLOAD_BATCH_SIZE) {
  const result = await query(
    `UPDATE telegram_download_items i
         SET status = 'downloading', locked_at = NOW(), updated_at = NOW()
         WHERE i.id IN (
             SELECT id FROM telegram_download_items
             WHERE job_id = $1
               AND status = 'pending'
               AND attempts < $2
               AND file_name IS NOT NULL
               AND mime_type IS NOT NULL
             ORDER BY created_at ASC
             LIMIT $3
         )
         RETURNING source, source_peer, origin, message_id, channel_post_id, file_name, mime_type, total_size, folder_override`,
    [jobId, TG_JOB_MAX_ATTEMPTS, limit]
  );
  return result.rows.filter((row) => row.file_name && row.mime_type).map((row) => ({
    id: Number(row.message_id),
    source: row.source_peer || row.source,
    origin: row.origin === "comment" ? "comment" : "channel",
    channelPostId: row.channel_post_id || void 0,
    fileInfo: { fileName: row.file_name, mimeType: row.mime_type },
    totalSize: Number(row.total_size || 0)
  }));
}
async function downloadClaimedRefs(botClient, requestMessage, jobId, source, refs, folderOverride, options) {
  if (refs.length === 0) return { found: 0, skipped: 0, failed: 0, successful: 0 };
  await updateJob(jobId, { status: "running", download_status: "active", error: null });
  try {
    const result = await downloadTelegramChannelRange(botClient, requestMessage, source, 0, refs.length, "older", refs.map((ref) => ref.id), folderOverride, refs, async (ref, status, error) => {
      await markDownloadRefStatus(jobId, ref, status, error);
      await notifyProgress(jobId, options);
    });
    return result;
  } catch (error) {
    const flood = isFloodWait(error);
    if (flood) {
      const cooldownUntil = new Date(Date.now() + flood.seconds * 1e3);
      await updateJob(jobId, { status: "running", cooldown_until: cooldownUntil, error: `Telegram FloodWait\uFF0C\u51B7\u5374\u5230 ${cooldownUntil.toISOString()}` });
      for (const ref of refs) await markDownloadRefStatus(jobId, ref, "failed", `FloodWait ${flood.seconds}s`);
      return { found: 0, skipped: 0, failed: refs.length, successful: 0 };
    }
    for (const ref of refs) await markDownloadRefStatus(jobId, ref, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}
async function downloadPendingForJob(botClient, requestMessage, jobId, source, folderOverride, options, drain = false) {
  let aggregate = { found: 0, skipped: 0, failed: 0, successful: 0 };
  const userClient2 = getTelegramUserClient();
  while (await waitUntilRunnable(jobId, options)) {
    if (userClient2) await hydratePendingDownloadRefs(userClient2, jobId);
    const refs = await claimPendingDownloadRefs(jobId);
    if (refs.length === 0) break;
    const result = await downloadClaimedRefs(botClient, requestMessage, jobId, source, refs, folderOverride, options);
    aggregate = {
      found: aggregate.found + (result.found || 0),
      skipped: aggregate.skipped + (result.skipped || 0),
      failed: aggregate.failed + (result.failed || 0),
      successful: aggregate.successful + (result.successful || 0)
    };
    if (!drain) break;
  }
  return aggregate;
}
async function finalizeTelegramJob(jobId, options) {
  const stats = await getJobItemStats(jobId);
  const pending = Number(stats.pending || 0) + Number(stats.downloading || 0);
  const failed = Number(stats.failed || 0);
  const status = pending > 0 ? "running" : failed > 0 ? "completed_with_errors" : "completed";
  await updateJob(jobId, {
    status,
    download_status: pending > 0 ? "active" : "done",
    enqueued_count: Number(stats.success || 0),
    skipped_count: Number(stats.skipped || 0),
    error: failed > 0 ? `${failed} \u4E2A\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25` : null,
    finished_at: pending > 0 ? null : /* @__PURE__ */ new Date()
  });
  await notifyProgress(jobId, options);
}
async function scanChannelSegment(userClient2, jobId, source, params, cursor, options) {
  const mode = params.mode;
  const offsetId = Number(cursor.offsetId || 0);
  const batch = await userClient2.getMessages(source, {
    limit: TG_JOB_SCAN_SEGMENT_SIZE,
    offsetId,
    ...mode === "tag" ? { search: params.tag } : {}
  });
  if (!batch.length) return { messages: [], done: true, nextOffsetId: offsetId };
  let done = false;
  let nextOffsetId = offsetId;
  const matched = [];
  for (const message of batch) {
    nextOffsetId = message.id;
    if (mode === "date") {
      const messageDate = new Date((message.date || 0) * 1e3);
      const startDate = new Date(params.startDateIso);
      const endDate = new Date(params.endDateIso);
      if (messageDate > endDate) continue;
      if (messageDate < startDate) {
        done = true;
        break;
      }
      if (messageHasMedia(message)) matched.push(message);
    } else if (messageHasMedia(message) && messageMatchesHashtag(message, params.tag)) {
      matched.push(message);
    }
  }
  const expanded = await expandMessagesWithMediaGroups(userClient2, source, matched);
  return { messages: expanded, done: done || batch.length < TG_JOB_SCAN_SEGMENT_SIZE, nextOffsetId };
}
async function runSegmentedTelegramJob(botClient, requestMessage, jobId, source, folderOverride, options) {
  const userClient2 = requireUserClient();
  const job = await getJob(jobId);
  const params = job?.params || {};
  let cursor = job?.scan_cursor || {};
  const discoveredRefKeys = /* @__PURE__ */ new Set();
  let totals = { found: 0, skipped: 0, failed: 0, successful: 0 };
  await updateJob(jobId, { status: "running", scan_status: "scanning", download_status: "active", started_at: job?.started_at || /* @__PURE__ */ new Date(), error: null });
  while (await waitUntilRunnable(jobId, options)) {
    const current = await getJob(jobId);
    cursor = current?.scan_cursor || cursor || {};
    if (current?.scan_status === "done") break;
    try {
      const segment = await scanChannelSegment(userClient2, jobId, source, params, cursor, options);
      const onRefDiscovered = async (ref) => {
        const key = `${sourcePeerKey(ref.source, source)}:${ref.id}`;
        if (discoveredRefKeys.has(key)) return;
        discoveredRefKeys.add(key);
        await persistDownloadRefs(jobId, source, [ref], folderOverride);
      };
      const scan = await buildDownloadScanResult(userClient2, source, segment.messages, {
        ...options,
        tag: params.tag,
        startDate: params.startDateIso ? new Date(params.startDateIso) : void 0,
        endDate: params.endDateIso ? new Date(params.endDateIso) : void 0,
        onRefDiscovered
      });
      cursor = {
        ...cursor,
        phase: segment.done ? "done" : "channel",
        offsetId: segment.nextOffsetId,
        channelMessagesScanned: Number(cursor.channelMessagesScanned || 0) + segment.messages.length,
        channelMediaFound: Number(cursor.channelMediaFound || 0) + scan.channelMediaFound,
        commentMessagesScanned: Number(cursor.commentMessagesScanned || 0) + scan.commentMessagesScanned,
        commentMediaFound: Number(cursor.commentMediaFound || 0) + scan.commentMediaFound
      };
      const stats = await getJobItemStats(jobId);
      await updateJob(jobId, { scan_cursor: JSON.stringify(cursor), total_count: Number(stats.pending || 0) + Number(stats.downloading || 0) + Number(stats.success || 0) + Number(stats.failed || 0) + Number(stats.skipped || 0), scan_status: segment.done ? "done" : "scanning" });
      await notifyProgress(jobId, options);
      const partial = await downloadPendingForJob(botClient, requestMessage, jobId, source, folderOverride, options, false);
      totals = { found: totals.found + partial.found, skipped: totals.skipped + partial.skipped, failed: totals.failed + partial.failed, successful: totals.successful + partial.successful };
      if (segment.done) break;
    } catch (error) {
      const flood = isFloodWait(error);
      if (!flood) throw error;
      const cooldownUntil = new Date(Date.now() + flood.seconds * 1e3);
      await updateJob(jobId, { cooldown_until: cooldownUntil, error: `Telegram FloodWait\uFF0C\u51B7\u5374\u5230 ${cooldownUntil.toISOString()}` });
    }
  }
  const runnable = await waitUntilRunnable(jobId, options);
  if (!runnable) {
    await updateJob(jobId, { status: "cancelled", scan_status: "cancelled", download_status: "cancelled", finished_at: /* @__PURE__ */ new Date() });
    return { jobId, ...totals, requested: 0, commentMessagesScanned: Number(cursor.commentMessagesScanned || 0), commentMediaFound: Number(cursor.commentMediaFound || 0) };
  }
  await updateJob(jobId, { scan_status: "done" });
  const drained = await downloadPendingForJob(botClient, requestMessage, jobId, source, folderOverride, options, true);
  totals = { found: totals.found + drained.found, skipped: totals.skipped + drained.skipped, failed: totals.failed + drained.failed, successful: totals.successful + drained.successful };
  await finalizeTelegramJob(jobId, options);
  return { jobId, ...totals, requested: totals.found + totals.skipped, commentMessagesScanned: Number(cursor.commentMessagesScanned || 0), commentMediaFound: Number(cursor.commentMediaFound || 0) };
}
async function enqueueTelegramDateDownload(botClient, requestMessage, userId, sourceInput, startDateText, endDateText, folderOverride, options = {}) {
  const source = normalizeSource(sourceInput);
  await assertTelegramSourceAllowed(source);
  const startDate = parseDateOnly(startDateText);
  const endDate = parseDateOnly(endDateText, true);
  if (startDate > endDate) throw new Error("\u5F00\u59CB\u65E5\u671F\u4E0D\u80FD\u665A\u4E8E\u7ED3\u675F\u65E5\u671F");
  const jobId = await createJob(userId, requestMessage.chatId?.toString(), "date_range", source, {
    mode: "date",
    startDate: startDateText,
    endDate: endDateText,
    startDateIso: startDate.toISOString(),
    endDateIso: endDate.toISOString(),
    folderOverride: folderOverride || null,
    includeComments: Boolean(options.includeComments),
    commentsMaxPerPost: options.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST
  });
  return runSegmentedTelegramJob(botClient, requestMessage, jobId, source, folderOverride, options);
}
async function enqueueTelegramTagDownload(botClient, requestMessage, userId, sourceInput, tagInput, folderOverride, options = {}) {
  const source = normalizeSource(sourceInput);
  await assertTelegramSourceAllowed(source);
  const tag = normalizeHashtag(tagInput);
  const jobId = await createJob(userId, requestMessage.chatId?.toString(), "tag_download", source, {
    mode: "tag",
    tag,
    folderOverride: folderOverride || null,
    includeComments: Boolean(options.includeComments),
    commentsMaxPerPost: options.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST
  });
  const result = await runSegmentedTelegramJob(botClient, requestMessage, jobId, source, folderOverride, options);
  return { ...result, tag };
}
async function listTelegramActiveTaskQueues(userId, limit = 10) {
  const result = await query(
    `WITH item_stats AS (
             SELECT
                 job_id,
                 COUNT(*)::int AS item_count,
                 COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                 COUNT(*) FILTER (WHERE status = 'downloading')::int AS downloading_count,
                 COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
                 COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
                 COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped_count_items,
                 COUNT(*) FILTER (WHERE status = 'pending' AND (file_name IS NULL OR mime_type IS NULL))::int AS missing_metadata_count,
                 MAX(updated_at) FILTER (WHERE status IN ('pending', 'downloading')) AS queue_updated_at
             FROM telegram_download_items
             GROUP BY job_id
         )
         SELECT
             j.id, j.kind, j.source, j.status, j.scan_status, j.download_status,
             j.scan_cursor, j.cooldown_until, j.paused_at, j.cancelled_at,
             j.total_count, j.enqueued_count, j.skipped_count, j.duplicate_count,
             j.error, j.started_at, j.finished_at, j.created_at, j.updated_at,
             COALESCE(s.item_count, 0)::int AS item_count,
             COALESCE(s.pending_count, 0)::int AS pending_count,
             COALESCE(s.downloading_count, 0)::int AS downloading_count,
             COALESCE(s.success_count, 0)::int AS success_count,
             COALESCE(s.failed_count, 0)::int AS failed_count,
             COALESCE(s.skipped_count_items, 0)::int AS skipped_count_items,
             COALESCE(s.missing_metadata_count, 0)::int AS missing_metadata_count,
             s.queue_updated_at,
             (
                 j.status = 'running'
                 AND (
                     COALESCE(s.downloading_count, 0) > 0
                     OR j.scan_status = 'scanning'
                     OR (j.cooldown_until IS NOT NULL AND j.cooldown_until > NOW())
                 )
             ) AS is_actively_running
         FROM telegram_background_jobs j
         LEFT JOIN item_stats s ON s.job_id = j.id
         WHERE j.user_id = $1
           AND j.cancelled_at IS NULL
           AND j.finished_at IS NULL
           AND (
               (
                   j.status = 'running'
                   AND (
                       COALESCE(s.downloading_count, 0) > 0
                       OR j.scan_status = 'scanning'
                       OR (j.cooldown_until IS NOT NULL AND j.cooldown_until > NOW())
                   )
               )
               OR (
                   j.status = 'paused'
                   AND (COALESCE(s.pending_count, 0) > 0 OR COALESCE(s.downloading_count, 0) > 0 OR j.scan_status = 'scanning')
               )
           )
         ORDER BY
             CASE WHEN j.status = 'paused' THEN 1 ELSE 0 END,
             COALESCE(s.queue_updated_at, j.updated_at) DESC
         LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}
async function pauseTelegramBackgroundJob(userId, selector) {
  const result = await query(
    `UPDATE telegram_background_jobs
         SET status = 'paused', paused_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND id::text LIKE $2 AND finished_at IS NULL AND status NOT IN ('completed', 'completed_with_errors', 'cancelled')
         RETURNING id, source, status`,
    [userId, `${selector}%`]
  );
  return result.rows[0] || null;
}
async function resumeTelegramBackgroundJob(userId, selector) {
  const result = await query(
    `UPDATE telegram_background_jobs
         SET status = 'running', paused_at = NULL, finished_at = NULL, error = NULL, download_status = 'active', updated_at = NOW()
         WHERE user_id = $1 AND id::text LIKE $2 AND cancelled_at IS NULL AND status = 'paused'
         RETURNING id, source, status`,
    [userId, `${selector}%`]
  );
  return result.rows[0] || null;
}
async function cancelTelegramBackgroundJob(userId, selector) {
  const result = await query(
    `UPDATE telegram_background_jobs
         SET status = 'cancelled', scan_status = 'cancelled', download_status = 'cancelled', cancelled_at = NOW(), finished_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND id::text LIKE $2 AND finished_at IS NULL AND status NOT IN ('completed', 'completed_with_errors', 'cancelled')
         RETURNING id, source, status`,
    [userId, `${selector}%`]
  );
  if (result.rows[0]) {
    await query(`UPDATE telegram_download_items SET status = 'skipped', locked_at = NULL, updated_at = NOW() WHERE job_id = $1 AND status IN ('pending', 'downloading')`, [result.rows[0].id]);
  }
  return result.rows[0] || null;
}
async function cancelAllTelegramBackgroundJobs(userId) {
  const result = await query(
    `UPDATE telegram_background_jobs
         SET status = 'cancelled', scan_status = 'cancelled', download_status = 'cancelled', cancelled_at = NOW(), finished_at = NOW(), updated_at = NOW()
         WHERE user_id = $1
           AND status NOT IN ('completed', 'completed_with_errors', 'cancelled')
         RETURNING id, source, status`,
    [userId]
  );
  const ids = result.rows.map((row) => row.id);
  if (ids.length > 0) {
    await query(
      `UPDATE telegram_download_items
             SET status = 'skipped', locked_at = NULL, updated_at = NOW()
             WHERE job_id = ANY($1::uuid[])
               AND status IN ('pending', 'downloading')`,
      [ids]
    );
  }
  return result.rows;
}
async function retryTelegramBackgroundJob(userId, selector) {
  const result = await query(
    `SELECT id FROM telegram_background_jobs WHERE user_id = $1 AND id::text LIKE $2 LIMIT 1`,
    [userId, `${selector}%`]
  );
  const row = result.rows[0];
  if (!row) return null;
  const retry = await query(
    `UPDATE telegram_download_items
         SET status = 'pending', locked_at = NULL, last_error = NULL, error = NULL, updated_at = NOW()
         WHERE job_id = $1 AND status = 'failed'
         RETURNING id`,
    [row.id]
  );
  await updateJob(row.id, { status: "running", download_status: "active", error: null, finished_at: null });
  return { id: row.id, retried: retry.rowCount || 0 };
}
async function runSubscriptionScan(botClient) {
  const userClient2 = getTelegramUserClient();
  if (!userClient2 || !isTelegramUserClientReady()) return;
  const result = await query(
    `SELECT id, user_id, chat_id, source, last_message_id, folder_override
         FROM telegram_channel_subscriptions
         WHERE enabled = true
         ORDER BY updated_at ASC`
  );
  for (const row of result.rows) {
    try {
      await assertTelegramSourceAllowed(row.source);
      const latestMessageId = await getLatestMessageId(userClient2, row.source);
      const lastMessageId = Number(row.last_message_id || 0);
      if (!latestMessageId || latestMessageId <= lastMessageId) continue;
      const count = Math.min(SUBSCRIPTION_SCAN_LIMIT, latestMessageId - lastMessageId);
      const ids = Array.from({ length: count }, (_, index) => lastMessageId + index + 1);
      const jobId = await createJob(Number(row.user_id), row.chat_id?.toString(), "subscription_sync", row.source, { fromId: lastMessageId + 1, toId: latestMessageId });
      const candidateMessages = await expandMessagesWithMediaGroups(userClient2, row.source, (await userClient2.getMessages(row.source, { ids })).filter(Boolean));
      await persistDownloadMessages(jobId, row.source, candidateMessages, row.folder_override || null);
      await updateJob(jobId, { status: "running", started_at: /* @__PURE__ */ new Date(), total_count: ids.length });
      const targetChat = row.chat_id || row.user_id;
      const requestMessage = { chatId: targetChat, id: latestMessageId };
      const subscriptionRefs = candidateMessages.map((message) => toChannelDownloadRef(row.source, message)).filter((ref) => Boolean(ref));
      await markDownloadRefsDownloading(jobId, subscriptionRefs);
      const downloadResult = await downloadTelegramChannelRange(botClient, requestMessage, row.source, 0, ids.length, "newer", ids, row.folder_override || null, subscriptionRefs, (ref, status, error) => markDownloadRefStatus(jobId, ref, status, error));
      await updateJob(jobId, {
        status: downloadResult.failed > 0 ? "completed_with_errors" : "completed",
        enqueued_count: downloadResult.found,
        skipped_count: downloadResult.skipped,
        error: downloadResult.failed > 0 ? `${downloadResult.failed} \u4E2A\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25` : null,
        finished_at: /* @__PURE__ */ new Date()
      });
      const scannedMaxId = ids.length > 0 ? ids[ids.length - 1] : lastMessageId;
      const safeAdvanceId = downloadResult.failed > 0 ? Math.max(lastMessageId, maxProcessedMessageId(downloadResult)) : scannedMaxId;
      await query("UPDATE telegram_channel_subscriptions SET last_message_id = $1, updated_at = NOW() WHERE id = $2", [safeAdvanceId, row.id]);
      if (downloadResult.found > 0) {
        await botClient.sendMessage(targetChat, { message: `\u2705 \u8BA2\u9605 ${row.source} \u5DF2\u540C\u6B65 ${downloadResult.found} \u4E2A\u65B0\u6587\u4EF6\uFF0C\u8DF3\u8FC7 ${downloadResult.skipped} \u6761${downloadResult.failed ? `\uFF0C\u5931\u8D25 ${downloadResult.failed} \u6761` : ""}${safeAdvanceId < latestMessageId ? "\u3002\u672C\u8F6E\u8FBE\u5230\u626B\u63CF\u4E0A\u9650\u6216\u5B58\u5728\u5931\u8D25\u9879\uFF0C\u5269\u4F59\u5C06\u5728\u540E\u7EED\u7EE7\u7EED\u5904\u7406\u3002" : "\u3002"}` }).catch(() => void 0);
      }
    } catch (error) {
      console.error("\u{1F916} Telegram \u8BA2\u9605\u540C\u6B65\u5931\u8D25:", error);
    }
  }
}
async function recoverTelegramJob(botClient, job) {
  const itemResult = await query(
    `SELECT id, source, source_peer, origin, message_id, channel_post_id, file_name, mime_type, total_size, folder_override
         FROM telegram_download_items
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY created_at ASC`,
    [job.id]
  );
  if (itemResult.rows.length === 0) return;
  const missingMetadata = itemResult.rows.filter((row) => !row.file_name || !row.mime_type).length;
  if (missingMetadata > 0) {
    const userClient2 = getTelegramUserClient();
    if (userClient2) {
      await hydratePendingDownloadRefs(userClient2, job.id);
      return recoverTelegramJob(botClient, job);
    }
    await updateJob(job.id, { status: "failed", error: `${missingMetadata} \u4E2A\u5F85\u4E0B\u8F7D\u6761\u76EE\u7F3A\u5C11\u6587\u4EF6\u5143\u6570\u636E\uFF0C\u65E0\u6CD5\u6062\u590D`, finished_at: /* @__PURE__ */ new Date() });
    return;
  }
  const refs = itemResult.rows.filter((row) => row.file_name && row.mime_type).map((row) => ({
    id: Number(row.message_id),
    source: row.source_peer || row.source,
    origin: row.origin === "comment" ? "comment" : "channel",
    channelPostId: row.channel_post_id || void 0,
    fileInfo: { fileName: row.file_name, mimeType: row.mime_type },
    totalSize: Number(row.total_size || 0)
  }));
  if (refs.length === 0) return;
  const targetChat = job.chat_id || job.user_id;
  const requestMessage = { chatId: targetChat, id: 0 };
  console.log(`\u267B\uFE0F \u6062\u590D Telegram \u4E0B\u8F7D\u4EFB\u52A1 ${String(job.id).slice(0, 8)}\uFF0C\u5F85\u5904\u7406 ${refs.length} \u4E2A\u6587\u4EF6`);
  await updateJob(job.id, { status: "running", started_at: job.started_at || /* @__PURE__ */ new Date(), error: null });
  try {
    const result = await downloadTelegramChannelRange(
      botClient,
      requestMessage,
      job.source,
      0,
      refs.length,
      "older",
      refs.map((ref) => ref.id),
      itemResult.rows[0]?.folder_override || null,
      refs,
      (ref, status, error) => markDownloadRefStatus(job.id, ref, status, error)
    );
    await updateJob(job.id, {
      status: result.failed > 0 ? "completed_with_errors" : "completed",
      enqueued_count: result.found,
      skipped_count: result.skipped,
      error: result.failed > 0 ? `${result.failed} \u4E2A\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25` : null,
      finished_at: /* @__PURE__ */ new Date()
    });
    await botClient.sendMessage(targetChat, {
      message: `\u267B\uFE0F \u5DF2\u6062\u590D\u5E76\u5B8C\u6210\u4EFB\u52A1 ${String(job.id).slice(0, 8)}\uFF1A\u6210\u529F ${result.successful}\uFF0C\u8DF3\u8FC7 ${result.skipped}\uFF0C\u5931\u8D25 ${result.failed}`
    }).catch(() => void 0);
  } catch (error) {
    await updateJob(job.id, { status: "failed", error: error instanceof Error ? error.message : String(error), finished_at: /* @__PURE__ */ new Date() });
    throw error;
  }
}
async function recoverInterruptedTelegramJobs(botClient) {
  if (recoveryRunning) return;
  recoveryRunning = true;
  try {
    await query(
      `UPDATE telegram_download_items
             SET status = 'pending', locked_at = NULL, updated_at = NOW()
             WHERE status = 'downloading'
               AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '30 minutes')`
    );
    const jobs = await query(
      `SELECT DISTINCT j.*
             FROM telegram_background_jobs j
             JOIN telegram_download_items i ON i.job_id = j.id
             WHERE j.kind IN ('date_range', 'tag_download')
               AND j.finished_at IS NULL
               AND j.cancelled_at IS NULL
               AND j.status IN ('pending', 'running', 'failed', 'completed_with_errors')
               AND i.status = 'pending'
             ORDER BY j.created_at ASC
             LIMIT 5`
    );
    for (const job of jobs.rows) {
      if (job.scan_status !== "done" && (job.kind === "date_range" || job.kind === "tag_download") && job.params?.mode) {
        const targetChat = job.chat_id || job.user_id;
        const requestMessage = { chatId: targetChat, id: 0 };
        await runSegmentedTelegramJob(botClient, requestMessage, job.id, job.source, job.params?.folderOverride || null, {}).catch((error) => console.error("\u267B\uFE0F Telegram \u5206\u6BB5\u4EFB\u52A1\u6062\u590D\u5931\u8D25:", error));
      } else {
        await recoverTelegramJob(botClient, job).catch((error) => console.error("\u267B\uFE0F Telegram \u4EFB\u52A1\u6062\u590D\u5931\u8D25:", error));
      }
    }
  } finally {
    recoveryRunning = false;
  }
}
function startTelegramJobRecoveryWorker(botClient) {
  if (recoveryStarted) return;
  recoveryStarted = true;
  setTimeout(() => recoverInterruptedTelegramJobs(botClient).catch((error) => console.error("\u267B\uFE0F Telegram \u4EFB\u52A1\u6062\u590D\u626B\u63CF\u5931\u8D25:", error)), TG_JOB_RECOVERY_DELAY_MS);
  setInterval(() => recoverInterruptedTelegramJobs(botClient).catch((error) => console.error("\u267B\uFE0F Telegram \u4EFB\u52A1\u6062\u590D\u626B\u63CF\u5931\u8D25:", error)), SUBSCRIPTION_INTERVAL_MS);
}
function startTelegramSubscriptionWorker(botClient) {
  if (subscriptionTimer) return;
  subscriptionTimer = setInterval(() => {
    runSubscriptionScan(botClient).catch((error) => console.error("\u{1F916} Telegram \u8BA2\u9605\u626B\u63CF\u5F02\u5E38:", error));
  }, SUBSCRIPTION_INTERVAL_MS);
  runSubscriptionScan(botClient).catch((error) => console.error("\u{1F916} Telegram \u8BA2\u9605\u626B\u63CF\u5F02\u5E38:", error));
  console.log(`\u{1F916} Telegram \u9891\u9053\u8BA2\u9605\u626B\u63CF\u5DF2\u542F\u52A8\uFF0C\u95F4\u9694 ${Math.round(SUBSCRIPTION_INTERVAL_MS / 1e3)} \u79D2`);
}

// src/services/orphanCleanup.ts
init_db();
init_localPath();
import fs8 from "fs";
import path11 from "path";
var UPLOAD_DIR2 = path11.resolve(process.env.UPLOAD_DIR || "./data/uploads");
var THUMBNAIL_DIR2 = path11.resolve(process.env.THUMBNAIL_DIR || "./data/thumbnails");
var ORPHAN_MIN_AGE_MS = Math.max(6e4, parseInt(process.env.ORPHAN_CLEANUP_MIN_AGE_MS || "600000", 10) || 6e5);
function isAutoCleanupEnabled() {
  return ["1", "true", "yes", "on"].includes((process.env.AUTO_CLEANUP_ORPHANS || "true").toLowerCase());
}
function formatBytes2(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!fs8.existsSync(dirPath)) {
    return arrayOfFiles;
  }
  try {
    const files = fs8.readdirSync(dirPath);
    for (const file of files) {
      const fullPath = path11.join(dirPath, file);
      try {
        const stat = fs8.statSync(fullPath);
        if (stat.isDirectory()) {
          getAllFiles(fullPath, arrayOfFiles);
        } else {
          arrayOfFiles.push({
            name: file,
            path: fullPath,
            size: stat.size
          });
        }
      } catch (e) {
        console.warn(`\u{1F9F9} \u65E0\u6CD5\u8BFB\u53D6\u6587\u4EF6\u72B6\u6001: ${fullPath}`, e);
      }
    }
  } catch (e) {
    console.error(`\u{1F9F9} \u65E0\u6CD5\u8BFB\u53D6\u76EE\u5F55: ${dirPath}`, e);
  }
  return arrayOfFiles;
}
function removeEmptyDirectories(dirPath) {
  if (!fs8.existsSync(dirPath)) return;
  try {
    const files = fs8.readdirSync(dirPath);
    for (const file of files) {
      const fullPath = path11.join(dirPath, file);
      try {
        if (fs8.statSync(fullPath).isDirectory()) {
          removeEmptyDirectories(fullPath);
        }
      } catch (e) {
      }
    }
    const remainingFiles = fs8.readdirSync(dirPath);
    if (remainingFiles.length === 0 && dirPath !== UPLOAD_DIR2) {
      fs8.rmdirSync(dirPath);
      console.log(`\u{1F9F9} \u5220\u9664\u7A7A\u6587\u4EF6\u5939: ${dirPath}`);
    }
  } catch (e) {
    console.warn(`\u{1F9F9} \u5220\u9664\u7A7A\u6587\u4EF6\u5939\u5931\u8D25: ${dirPath}`, e);
  }
}
async function cleanupOrphanFiles() {
  const stats = {
    deletedCount: 0,
    freedBytes: 0,
    freedSpace: "0 B",
    deletedFiles: []
  };
  console.log("\u{1F9F9} \u5F00\u59CB\u626B\u63CF\u5B64\u513F\u6587\u4EF6...");
  try {
    const dbResult = await query(`
            SELECT stored_name, folder, path
            FROM files
            WHERE source = 'local'
              AND mime_type IS DISTINCT FROM 'application/x-directory'
        `);
    const dbFileSet = /* @__PURE__ */ new Set();
    for (const row of dbResult.rows) {
      if (row.path) {
        const relativePath = getRelativeStoragePath(UPLOAD_DIR2, row.path);
        if (relativePath) dbFileSet.add(relativePath);
      }
      if (row.stored_name) {
        const key = [row.folder, row.stored_name].filter(Boolean).join("/");
        if (key) dbFileSet.add(key);
      }
    }
    console.log(`\u{1F9F9} \u6570\u636E\u5E93\u4E2D\u5DF2\u6CE8\u518C\u6587\u4EF6\u6570: ${dbFileSet.size}`);
    const diskFiles = getAllFiles(UPLOAD_DIR2);
    console.log(`\u{1F9F9} \u78C1\u76D8\u4E0A\u6587\u4EF6\u6570: ${diskFiles.length}`);
    for (const file of diskFiles) {
      const relativePath = getRelativeStoragePath(UPLOAD_DIR2, file.path);
      if (relativePath && !dbFileSet.has(relativePath)) {
        const ageMs = Date.now() - fs8.statSync(file.path).mtimeMs;
        if (ageMs < ORPHAN_MIN_AGE_MS) continue;
        try {
          await safeUnlink(file.path, UPLOAD_DIR2);
          stats.deletedCount++;
          stats.freedBytes += file.size;
          stats.deletedFiles.push(relativePath);
          console.log(`\u{1F9F9} \u5220\u9664\u5B64\u513F\u6587\u4EF6: ${file.path} (${formatBytes2(file.size)})`);
        } catch (e) {
          console.error(`\u{1F9F9} \u5220\u9664\u6587\u4EF6\u5931\u8D25: ${file.path}`, e);
        }
      }
    }
    removeEmptyDirectories(UPLOAD_DIR2);
    stats.freedSpace = formatBytes2(stats.freedBytes);
    if (stats.deletedCount > 0) {
      console.log(`\u{1F9F9} \u6E05\u7406\u5B8C\u6210: \u5220\u9664 ${stats.deletedCount} \u4E2A\u5B64\u513F\u6587\u4EF6\uFF0C\u91CA\u653E ${stats.freedSpace}`);
    } else {
      console.log("\u{1F9F9} \u626B\u63CF\u5B8C\u6210: \u6CA1\u6709\u53D1\u73B0\u5B64\u513F\u6587\u4EF6");
    }
  } catch (error) {
    console.error("\u{1F9F9} \u5B64\u513F\u6587\u4EF6\u6E05\u7406\u5931\u8D25:", error);
    throw error;
  }
  return stats;
}
var cleanupInterval = null;
function startPeriodicCleanup(intervalMs = 60 * 60 * 1e3) {
  if (!isAutoCleanupEnabled()) {
    console.log("\u{1F9F9} \u81EA\u52A8\u5B64\u513F\u6587\u4EF6\u6E05\u7406\u5DF2\u5173\u95ED (AUTO_CLEANUP_ORPHANS=false)");
    return;
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }
  cleanupInterval = setInterval(async () => {
    console.log("\u{1F9F9} \u6267\u884C\u5B9A\u671F\u5B64\u513F\u6587\u4EF6\u6E05\u7406...");
    try {
      const stats = await cleanupOrphanFiles();
      if (stats.deletedCount > 0) {
        console.log(`\u{1F9F9} \u5B9A\u671F\u6E05\u7406\u5B8C\u6210: \u5220\u9664 ${stats.deletedCount} \u4E2A\u6587\u4EF6\uFF0C\u91CA\u653E ${stats.freedSpace}`);
      }
    } catch (e) {
      console.error("\u{1F9F9} \u5B9A\u671F\u6E05\u7406\u5931\u8D25:", e);
    }
  }, intervalMs);
  console.log(`\u{1F9F9} \u5DF2\u542F\u52A8\u5B9A\u671F\u6E05\u7406\u4EFB\u52A1 (\u95F4\u9694: ${intervalMs / 1e3 / 60} \u5206\u949F)`);
}
function stopPeriodicCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log("\u{1F9F9} \u5DF2\u505C\u6B62\u5B9A\u671F\u6E05\u7406\u4EFB\u52A1");
  }
}

// src/services/telegramCommands.ts
init_localPath();

// src/utils/fileScope.ts
init_db();
init_localPath();
import path12 from "path";
var CLOUD_SOURCES = /* @__PURE__ */ new Set(["onedrive", "aliyun_oss", "s3", "webdav", "google_drive"]);
var UPLOAD_DIR3 = path12.resolve(process.env.UPLOAD_DIR || "./data/uploads");
var THUMBNAIL_DIR3 = path12.resolve(process.env.THUMBNAIL_DIR || "./data/thumbnails");
var PREVIEW_DIR2 = path12.resolve(process.env.PREVIEW_DIR || "./data/previews");
async function getCurrentStorageScope() {
  const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
  const provider = storageManager2.getProvider();
  if (provider.name === "local") {
    return { clause: "source = 'local'", params: [] };
  }
  return { clause: "storage_account_id = $1", params: [storageManager2.getActiveAccountId()] };
}
function nextParam(scope, offset) {
  return `$${scope.params.length + offset}`;
}
async function getScopedFileById(id) {
  const scope = await getCurrentStorageScope();
  const result = await query(
    `SELECT * FROM files WHERE ${scope.clause} AND id = ${nextParam(scope, 1)}`,
    [...scope.params, id]
  );
  return result.rows[0] || null;
}
async function removePhysicalFile(file) {
  if (CLOUD_SOURCES.has(file.source)) {
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const provider = storageManager2.getProvider(`${file.source}:${file.storage_account_id}`);
    await provider.deleteFile(file.path);
  } else {
    const filePath = file.path || path12.join(UPLOAD_DIR3, file.stored_name);
    await safeUnlink(filePath, UPLOAD_DIR3);
  }
  if (file.thumbnail_path) {
    const thumbPath = path12.join(THUMBNAIL_DIR3, path12.basename(file.thumbnail_path));
    await safeUnlink(thumbPath, THUMBNAIL_DIR3);
  }
  if (file.preview_path) {
    const previewPath = path12.join(PREVIEW_DIR2, path12.basename(file.preview_path));
    await safeUnlink(previewPath, PREVIEW_DIR2);
  }
}
async function updateScopedFileById(id, setSql, values) {
  const scope = await getCurrentStorageScope();
  const idParam = nextParam(scope, values.length + 1);
  const result = await query(
    `UPDATE files SET ${setSql} WHERE ${scope.clause} AND id = ${idParam}`,
    [...scope.params, ...values, id]
  );
  return result.rowCount || 0;
}

// src/services/telegramCommands.ts
var checkDiskSpace = checkDiskSpaceModule.default || checkDiskSpaceModule;
var DOWNLOAD_WORKER_OPTIONS = [4, 8, 12, 16];
var FILE_CONCURRENCY_OPTIONS = [1, 2, 3, 4];
var STORAGE_TYPE_ORDER = ["local", "onedrive", "google_drive", "aliyun_oss", "s3", "webdav"];
var ON_VALUES = /* @__PURE__ */ new Set(["1", "true", "yes", "on"]);
var UPLOAD_DIR4 = process.env.UPLOAD_DIR || "./data/uploads";
var THUMBNAIL_DIR4 = process.env.THUMBNAIL_DIR || "./data/thumbnails";
var pendingDeleteConfirmations = /* @__PURE__ */ new Map();
var DELETE_CONFIRM_TTL_MS = 5 * 60 * 1e3;
function buildDeleteConfirmKeyboard(confirmId) {
  return new Api5.ReplyInlineMarkup({
    rows: [new Api5.KeyboardButtonRow({
      buttons: [
        new Api5.KeyboardButtonCallback({ text: "\u26A0\uFE0F \u786E\u8BA4\u5220\u9664", data: Buffer.from(`del_confirm_${confirmId}`) }),
        new Api5.KeyboardButtonCallback({ text: "\u53D6\u6D88", data: Buffer.from(`del_cancel_${confirmId}`) })
      ]
    })]
  });
}
function normalizeDownloadWorkers(value) {
  const parsed = parseInt(String(value ?? "4"), 10);
  return DOWNLOAD_WORKER_OPTIONS.includes(parsed) ? parsed : 4;
}
async function getCurrentDownloadWorkers() {
  const value = await getSetting("telegram_download_workers", process.env.TELEGRAM_DOWNLOAD_WORKERS || "4");
  return normalizeDownloadWorkers(value);
}
function buildDownloadWorkersKeyboard(current, confirmValue) {
  if (confirmValue) {
    return new Api5.ReplyInlineMarkup({
      rows: [
        new Api5.KeyboardButtonRow({
          buttons: [
            new Api5.KeyboardButtonCallback({ text: `\u26A0\uFE0F \u786E\u8BA4\u4F7F\u7528 ${confirmValue}`, data: Buffer.from(`dw_confirm_${confirmValue}`) }),
            new Api5.KeyboardButtonCallback({ text: "\u53D6\u6D88", data: Buffer.from("dw_cancel") })
          ]
        })
      ]
    });
  }
  return new Api5.ReplyInlineMarkup({
    rows: [
      new Api5.KeyboardButtonRow({
        buttons: [
          new Api5.KeyboardButtonCallback({ text: `${current === 4 ? "\u2705 " : ""}4`, data: Buffer.from("dw_set_4") }),
          new Api5.KeyboardButtonCallback({ text: `${current === 8 ? "\u2705 " : ""}8`, data: Buffer.from("dw_set_8") })
        ]
      }),
      new Api5.KeyboardButtonRow({
        buttons: [
          new Api5.KeyboardButtonCallback({ text: `${current === 12 ? "\u2705 " : ""}12 \u26A0\uFE0F`, data: Buffer.from("dw_set_12") }),
          new Api5.KeyboardButtonCallback({ text: `${current === 16 ? "\u2705 " : ""}16 \u26A0\uFE0F`, data: Buffer.from("dw_set_16") })
        ]
      })
    ]
  });
}
function buildStorageMaintenanceKeyboard(localFileCount, confirm = false) {
  if (localFileCount <= 0) return void 0;
  return new Api5.ReplyInlineMarkup({
    rows: [
      new Api5.KeyboardButtonRow({
        buttons: confirm ? [
          new Api5.KeyboardButtonCallback({ text: "\u26A0\uFE0F \u786E\u8BA4\u5220\u9664\u672C\u5730\u5168\u90E8\u4E0B\u8F7D\u6587\u4EF6", data: Buffer.from("storage_clear_confirm") }),
          new Api5.KeyboardButtonCallback({ text: "\u53D6\u6D88", data: Buffer.from("storage_clear_cancel") })
        ] : [
          new Api5.KeyboardButtonCallback({ text: `\u{1F9F9} \u5220\u9664\u672C\u5730\u5168\u90E8\u4E0B\u8F7D\u6587\u4EF6 (${localFileCount})`, data: Buffer.from("storage_clear_ask") })
        ]
      })
    ]
  });
}
function shortenStorageAccountName(name, maxLength = 22) {
  return name.length > maxLength ? `${name.slice(0, maxLength - 1)}\u2026` : name;
}
function sortStorageAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    const orderDiff = STORAGE_TYPE_ORDER.indexOf(a.type) - STORAGE_TYPE_ORDER.indexOf(b.type);
    if (orderDiff !== 0) return orderDiff;
    return (a.name || "").localeCompare(b.name || "", "zh-CN");
  });
}
function buildStorageAccountKeyboard(accounts, activeAccountId) {
  const accountButtons = sortStorageAccounts(accounts).map((account) => {
    const isActive = account.is_active || account.id === activeAccountId;
    const providerLabel = getProviderDisplayName(account.type).replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const accountName = shortenStorageAccountName(account.name || "\u672A\u547D\u540D\u8D26\u6237");
    return new Api5.KeyboardButtonRow({
      buttons: [new Api5.KeyboardButtonCallback({
        text: `${isActive ? "\u2705" : "\u2B1C"} ${providerLabel} \xB7 ${accountName}`,
        data: Buffer.from(`storage_switch_${account.id}`)
      })]
    });
  });
  return new Api5.ReplyInlineMarkup({
    rows: [
      new Api5.KeyboardButtonRow({
        buttons: [new Api5.KeyboardButtonCallback({
          text: `${!activeAccountId ? "\u2705" : "\u2B1C"} \u{1F4BE} \u672C\u5730\u5B58\u50A8`,
          data: Buffer.from("storage_switch_local")
        })]
      }),
      ...accountButtons,
      new Api5.KeyboardButtonRow({
        buttons: [new Api5.KeyboardButtonCallback({ text: "\u{1F504} \u5237\u65B0\u5217\u8868", data: Buffer.from("storage_switch_refresh") })]
      })
    ]
  });
}
function buildStorageSwitchText(accounts, activeAccountId) {
  const activeAccount = accounts.find((account) => account.is_active || account.id === activeAccountId);
  const activeLine = activeAccount ? `${getProviderDisplayName(activeAccount.type)} \xB7 ${activeAccount.name || "\u672A\u547D\u540D\u8D26\u6237"}` : getProviderDisplayName("local");
  const accountLines = sortStorageAccounts(accounts).map((account) => {
    const marker = account.id === activeAccountId || account.is_active ? "\u2705" : "\u2B1C";
    return `${marker} ${getProviderDisplayName(account.type)} \xB7 ${account.name || "\u672A\u547D\u540D\u8D26\u6237"}
   ID: \`${String(account.id).slice(0, 8)}\``;
  });
  return [
    "\u{1F5C4}\uFE0F **\u5B58\u50A8\u6E90\u5207\u6362**",
    "",
    `\u5F53\u524D\u4F7F\u7528\uFF1A${activeLine}`,
    "",
    "\u70B9\u51FB\u4E0B\u9762\u6309\u94AE\u5373\u53EF\u5207\u6362\u5230\u5DF2\u5728\u7F51\u9875\u7AEF\u914D\u7F6E\u597D\u7684\u5B58\u50A8\u8D26\u6237\uFF1B\u4E0D\u9700\u8981\u6253\u5F00\u524D\u7AEF\u9875\u9762\u3002",
    "",
    "**\u53EF\u9009\u5B58\u50A8\uFF1A**",
    `\u2705/\u2B1C ${getProviderDisplayName("local")}`,
    ...accountLines,
    "",
    "\u63D0\u793A\uFF1A\u8FD9\u91CC\u53EA\u80FD\u5207\u6362\u5DF2\u6709\u8D26\u6237\uFF1B\u65B0\u589E OAuth/\u5BC6\u94A5\u914D\u7F6E\u4ECD\u9700\u5728\u7F51\u9875\u7AEF\u5B8C\u6210\u3002"
  ].join("\n");
}
async function buildStorageSwitchView() {
  const accounts = await storageManager.getAccounts();
  const activeAccountId = storageManager.getActiveAccountId();
  return {
    text: buildStorageSwitchText(accounts, activeAccountId),
    buttons: buildStorageAccountKeyboard(accounts, activeAccountId)
  };
}
function isTelegramMessageNotModified(error) {
  const err = error;
  return err?.code === 400 && (err?.errorMessage === "MESSAGE_NOT_MODIFIED" || String(err?.message || "").includes("MESSAGE_NOT_MODIFIED"));
}
async function editStorageSwitchMessage(client2, update, toast) {
  const view = await buildStorageSwitchView();
  try {
    await client2.editMessage(update.peer, {
      message: Number(update.msgId),
      text: view.text,
      buttons: view.buttons
    });
  } catch (error) {
    if (!isTelegramMessageNotModified(error)) {
      throw error;
    }
  }
  await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: toast }));
}
async function scanLocalDownloadFiles() {
  const baseDir = path13.resolve(UPLOAD_DIR4);
  const paths = [];
  let totalSize = 0;
  if (!fs9.existsSync(baseDir)) return { count: 0, totalSize: 0, paths };
  async function walk(dir) {
    const entries = await fs9.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path13.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs9.promises.stat(fullPath);
        totalSize += stat.size;
        paths.push(fullPath);
      }
    }
  }
  await walk(baseDir);
  return { count: paths.length, totalSize, paths };
}
async function pruneEmptyDirs(dir, baseDir = path13.resolve(UPLOAD_DIR4)) {
  if (!fs9.existsSync(dir) || path13.resolve(dir) === baseDir) return;
  const entries = await fs9.promises.readdir(dir);
  if (entries.length === 0) {
    await fs9.promises.rmdir(dir);
    await pruneEmptyDirs(path13.dirname(dir), baseDir);
  }
}
function buildDownloadWorkersText(current) {
  return [
    "\u2699\uFE0F **Telegram \u5206\u7247\u5E76\u53D1\u8BBE\u7F6E**",
    "",
    `\u5F53\u524D worker \u6570\uFF1A**${current}**`,
    "",
    "\u8BF4\u660E\uFF1ATelegram \u5355\u6B21\u8BF7\u6C42\u4E0A\u9650\u4ECD\u662F 512KB\uFF0C\u8FD9\u91CC\u8C03\u6574\u7684\u662F\u5355\u4E2A\u6587\u4EF6\u5185\u90E8\u7684\u5E76\u53D1\u5206\u7247\u8BF7\u6C42\u6570\u3002",
    "\u5982\u679C\u8981\u8C03\u6574\u201C\u4E00\u6B21\u540C\u65F6\u4E0B\u8F7D\u51E0\u4E2A\u6587\u4EF6\u201D\uFF0C\u8BF7\u4F7F\u7528 /file_concurrency\u3002",
    "",
    "\u5EFA\u8BAE\uFF1A",
    "- `4`\uFF1A\u7A33\u5B9A\u4F18\u5148",
    "- `8`\uFF1A\u901F\u5EA6/\u7A33\u5B9A\u5E73\u8861",
    "- `12` / `16`\uFF1A\u6FC0\u8FDB\u6A21\u5F0F\uFF0C\u53EF\u80FD\u89E6\u53D1\u98CE\u63A7\u3001\u65AD\u6D41\u3001\u9650\u901F\uFF0C\u751A\u81F3\u8D26\u53F7\u98CE\u9669\uFF0C\u9700\u8981\u4E8C\u6B21\u786E\u8BA4"
  ].join("\n");
}
function normalizeFileConcurrency(value) {
  const parsed = parseInt(String(value ?? "2"), 10);
  return FILE_CONCURRENCY_OPTIONS.includes(parsed) ? parsed : 2;
}
async function getCurrentFileConcurrency() {
  const value = await getSetting("telegram_file_download_concurrency", process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY || String(getFileDownloadConcurrency()));
  return normalizeFileConcurrency(value);
}
function buildFileConcurrencyKeyboard(current, confirmValue) {
  if (confirmValue) {
    return new Api5.ReplyInlineMarkup({
      rows: [
        new Api5.KeyboardButtonRow({
          buttons: [
            new Api5.KeyboardButtonCallback({ text: `\u26A0\uFE0F \u786E\u8BA4\u540C\u65F6\u4E0B\u8F7D ${confirmValue} \u4E2A\u6587\u4EF6`, data: Buffer.from(`fc_confirm_${confirmValue}`) }),
            new Api5.KeyboardButtonCallback({ text: "\u53D6\u6D88", data: Buffer.from("fc_cancel") })
          ]
        })
      ]
    });
  }
  return new Api5.ReplyInlineMarkup({
    rows: [
      new Api5.KeyboardButtonRow({
        buttons: [
          new Api5.KeyboardButtonCallback({ text: `${current === 1 ? "\u2705 " : ""}1`, data: Buffer.from("fc_set_1") }),
          new Api5.KeyboardButtonCallback({ text: `${current === 2 ? "\u2705 " : ""}2`, data: Buffer.from("fc_set_2") })
        ]
      }),
      new Api5.KeyboardButtonRow({
        buttons: [
          new Api5.KeyboardButtonCallback({ text: `${current === 3 ? "\u2705 " : ""}3`, data: Buffer.from("fc_set_3") }),
          new Api5.KeyboardButtonCallback({ text: `${current === 4 ? "\u2705 " : ""}4 \u26A0\uFE0F`, data: Buffer.from("fc_set_4") })
        ]
      })
    ]
  });
}
function buildFileConcurrencyText(current) {
  const stats = getDownloadQueueStats();
  return [
    "\u{1F4E6} **Telegram \u6587\u4EF6\u7EA7\u5E76\u53D1\u8BBE\u7F6E**",
    "",
    `\u5F53\u524D\u540C\u65F6\u4E0B\u8F7D\u6587\u4EF6\u6570\uFF1A**${current}**`,
    `\u5F53\u524D\u961F\u5217\uFF1A\u8FDB\u884C\u4E2D ${stats.active}\uFF0C\u7B49\u5F85\u4E2D ${stats.pending}`,
    "",
    "\u8BF4\u660E\uFF1A\u8FD9\u91CC\u63A7\u5236\u201C\u4E00\u6B21\u540C\u65F6\u4E0B\u8F7D\u51E0\u4E2A\u6587\u4EF6\u201D\u3002",
    "\u5B83\u4E0D\u540C\u4E8E /download_workers\uFF1A\u540E\u8005\u63A7\u5236\u5355\u4E2A\u6587\u4EF6\u5185\u90E8\u7684 512KB \u5206\u7247\u5E76\u53D1\u3002",
    "",
    "\u5EFA\u8BAE\uFF1A",
    "- `1`\uFF1A\u6700\u7A33\uFF0C\u9002\u5408\u98CE\u63A7/\u9650\u901F\u65F6\u4F7F\u7528",
    "- `2`\uFF1A\u9ED8\u8BA4\u63A8\u8350\uFF0C\u901F\u5EA6\u4E0E\u7A33\u5B9A\u5E73\u8861",
    "- `3`\uFF1A\u901F\u5EA6\u4F18\u5148\uFF0C\u9002\u5408\u7EBF\u8DEF\u7A33\u5B9A\u65F6\u4F7F\u7528",
    "- `4`\uFF1A\u6FC0\u8FDB\u6A21\u5F0F\uFF0C\u53EF\u80FD\u89E6\u53D1 Telegram \u9650\u6D41\u6216\u4E91\u76D8\u4E0A\u4F20\u9650\u901F\uFF0C\u9700\u8981\u4E8C\u6B21\u786E\u8BA4",
    "",
    "\u4FEE\u6539\u540E\u4F1A\u7ACB\u5373\u5F71\u54CD\u961F\u5217\u4E2D\u65B0\u542F\u52A8\u7684\u6587\u4EF6\u4E0B\u8F7D\uFF1B\u5DF2\u5728\u8FDB\u884C\u4E2D\u7684\u6587\u4EF6\u4E0D\u4F1A\u88AB\u4E2D\u65AD\u3002"
  ].join("\n");
}
function isOn(value, defaultValue = true) {
  if (value === void 0 || value === null || value === "") return defaultValue;
  return ON_VALUES.has(String(value).toLowerCase());
}
async function getPathCenterState() {
  return { automaticBySource: true, automaticByType: true };
}
function buildDuplicateModeKeyboard(mode) {
  return new Api5.ReplyInlineMarkup({
    rows: [
      new Api5.KeyboardButtonRow({
        buttons: [
          new Api5.KeyboardButtonCallback({ text: `${mode === "skip" ? "\u2705" : "\u2B1C"} \u8DF3\u8FC7\u91CD\u590D`, data: Buffer.from("dm_set_skip") }),
          new Api5.KeyboardButtonCallback({ text: `${mode === "copy" ? "\u2705" : "\u2B1C"} \u751F\u6210\u526F\u672C`, data: Buffer.from("dm_set_copy") })
        ]
      })
    ]
  });
}
function buildDuplicateModeText(mode) {
  return [
    "\u{1F9EC} **\u91CD\u590D\u6587\u4EF6\u5904\u7406**",
    "",
    `\u5F53\u524D\u6A21\u5F0F\uFF1A${mode === "skip" ? "\u8DF3\u8FC7\u91CD\u590D" : "\u751F\u6210\u526F\u672C"}`,
    "",
    "- \u8DF3\u8FC7\u91CD\u590D\uFF1A\u540C\u540D + \u540C\u76EE\u5F55 + \u540C\u5927\u5C0F\u65F6\u4E0D\u518D\u4FDD\u5B58",
    "- \u751F\u6210\u526F\u672C\uFF1A\u81EA\u52A8\u6539\u540D\u4E3A `\u6587\u4EF6 (1).ext` \u4FDD\u7559\u526F\u672C",
    "",
    "\u8BF4\u660E\uFF1A\u4FEE\u6539\u540E\u53EA\u5F71\u54CD\u540E\u7EED\u65B0\u4E0A\u4F20/\u8F6C\u5B58\u6587\u4EF6\u3002"
  ].join("\n");
}
async function getCleanupEnabledSetting() {
  const value = await getSetting("auto_cleanup_orphans", process.env.AUTO_CLEANUP_ORPHANS || "true");
  return isOn(value, true);
}
function buildCleanupSettingsKeyboard(enabled) {
  return new Api5.ReplyInlineMarkup({
    rows: [
      new Api5.KeyboardButtonRow({
        buttons: [
          new Api5.KeyboardButtonCallback({ text: `${!enabled ? "\u2705" : "\u2B1C"} \u5173\u95ED\u81EA\u52A8\u6E05\u7406`, data: Buffer.from("cs_set_off") }),
          new Api5.KeyboardButtonCallback({ text: `${enabled ? "\u2705" : "\u2B1C"} \u5F00\u542F\u81EA\u52A8\u6E05\u7406`, data: Buffer.from("cs_set_on") })
        ]
      })
    ]
  });
}
function buildCleanupSettingsText(enabled) {
  return [
    "\u{1F9F9} **\u81EA\u52A8\u6E05\u7406\u8BBE\u7F6E**",
    "",
    `\u5F53\u524D\u72B6\u6001\uFF1A${enabled ? "\u2705 \u5F00\u542F" : "\u2B1C \u5173\u95ED"}`,
    "",
    "\u5F00\u542F\u540E\u4F1A\u81EA\u52A8\u6E05\u7406\u672C\u5730 uploads \u4E2D\u672A\u767B\u8BB0\u5230\u6570\u636E\u5E93\u7684\u5B64\u513F\u6587\u4EF6\u3002",
    "\u5982\u679C\u4F60\u4E3B\u8981\u4F7F\u7528\u672C\u5730\u5B58\u50A8\uFF0C\u5EFA\u8BAE\u70B9\u201C\u5173\u95ED\u81EA\u52A8\u6E05\u7406\u201D\uFF0C\u9632\u6B62\u9ED8\u8BA4\u5220\u9664\u6587\u4EF6\u3002",
    "",
    "\u8BF4\u660E\uFF1A\u53EA\u5F71\u54CD\u672C\u5730 uploads \u5B64\u513F\u6587\u4EF6\uFF0C\u4E0D\u4F1A\u4E3B\u52A8\u6E05\u7406\u7B2C\u4E09\u65B9\u4E91\u5B58\u50A8\u3002"
  ].join("\n");
}
function getCallbackChatKey(update) {
  const peer = update.peer;
  const value = peer?.userId || peer?.chatId || peer?.channelId || update.userId;
  if (value && typeof value.toJSNumber === "function") return String(value.toJSNumber());
  if (value !== void 0 && value !== null) return String(value);
  return String(update.userId.toJSNumber());
}
async function handleStart(message, senderId) {
  if (await isAuthenticatedAsync(senderId)) {
    await message.reply({ message: buildWelcomeBack() });
  } else {
    passwordInputState.set(senderId, { password: "" });
  }
}
async function handleHelp(message) {
  await message.reply({ message: buildHelp() });
}
async function handleStorage(message) {
  try {
    const scope = await getCurrentStorageScope();
    const diskPath = os.platform() === "win32" ? "C:" : "/";
    const diskSpace = await checkDiskSpace(diskPath);
    const result = await query(`
            SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size
            FROM files
            WHERE ${scope.clause}
        `, scope.params);
    const tgVaultStats = result.rows[0];
    const totalSize = parseInt(tgVaultStats.total_size);
    const fileCount = parseInt(tgVaultStats.file_count);
    const usedPercent = Math.round((diskSpace.size - diskSpace.free) / diskSpace.size * 100);
    const queueStats = getDownloadQueueStats();
    const localStats = await scanLocalDownloadFiles();
    const reply = buildStorageReport({
      diskTotal: diskSpace.size,
      diskFree: diskSpace.free,
      diskUsedPercent: usedPercent,
      fileCount,
      totalFileSize: totalSize,
      localFileCount: localStats.count,
      localTotalSize: localStats.totalSize,
      queueActive: queueStats.active,
      queuePending: queueStats.pending
    });
    await message.reply({
      message: reply,
      buttons: buildStorageMaintenanceKeyboard(localStats.count)
    });
  } catch (error) {
    console.error("\u{1F916} \u83B7\u53D6\u5B58\u50A8\u7EDF\u8BA1\u5931\u8D25:", error);
    await message.reply({ message: MSG.ERR_STORAGE });
  }
}
async function handleStorageSwitch(message) {
  try {
    const view = await buildStorageSwitchView();
    await message.reply({ message: view.text, buttons: view.buttons });
  } catch (error) {
    console.error("\u{1F916} \u83B7\u53D6\u5B58\u50A8\u6E90\u5207\u6362\u83DC\u5355\u5931\u8D25:", error);
    await message.reply({ message: `\u274C \u83B7\u53D6\u5B58\u50A8\u6E90\u5207\u6362\u83DC\u5355\u5931\u8D25: ${error.message}` });
  }
}
async function handleStorageSwitchCallback(client2, update, data) {
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  try {
    if (data === "storage_switch_refresh") {
      await editStorageSwitchMessage(client2, update, "\u5DF2\u5237\u65B0");
      return;
    }
    const accountId = data.replace(/^storage_switch_/, "");
    if (!accountId) {
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u65E0\u6548\u7684\u5B58\u50A8\u6E90\u9009\u62E9", alert: true }));
      return;
    }
    if (accountId === "local") {
      if (!storageManager.getActiveAccountId()) {
        await editStorageSwitchMessage(client2, update, "\u5F53\u524D\u5DF2\u7ECF\u662F\u672C\u5730\u5B58\u50A8");
        return;
      }
      await storageManager.switchAccount("local");
      await editStorageSwitchMessage(client2, update, "\u5DF2\u5207\u6362\u5230\u672C\u5730\u5B58\u50A8");
      return;
    }
    const accounts = await storageManager.getAccounts();
    const selected = accounts.find((account) => account.id === accountId);
    if (!selected) {
      await editStorageSwitchMessage(client2, update, "\u8BE5\u5B58\u50A8\u8D26\u6237\u5DF2\u4E0D\u5B58\u5728");
      return;
    }
    if (selected.is_active || storageManager.getActiveAccountId() === accountId) {
      await editStorageSwitchMessage(client2, update, "\u5F53\u524D\u5DF2\u7ECF\u5728\u4F7F\u7528\u8BE5\u8D26\u6237");
      return;
    }
    await storageManager.switchAccount(accountId);
    await editStorageSwitchMessage(client2, update, `\u5DF2\u5207\u6362\u5230 ${selected.name || getProviderDisplayName(selected.type)}`);
  } catch (error) {
    console.error("\u{1F916} \u5207\u6362\u5B58\u50A8\u6E90\u5931\u8D25:", error);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u5207\u6362\u5931\u8D25: ${error.message}`, alert: true }));
  }
}
async function handleStorageCleanupCallback(client2, update, data) {
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  try {
    const stats = await scanLocalDownloadFiles();
    if (data === "storage_clear_cancel") {
      await client2.editMessage(update.peer, {
        message: Number(update.msgId),
        text: stats.count > 0 ? `\u5DF2\u53D6\u6D88\u6E05\u7406\u3002\u5F53\u524D\u672C\u5730\u4E0B\u8F7D\u6587\u4EF6\uFF1A${stats.count} \u4E2A\uFF0C\u5360\u7528 ${formatBytes(stats.totalSize)}\u3002` : "\u5DF2\u53D6\u6D88\u6E05\u7406\u3002\u5F53\u524D\u6CA1\u6709\u672C\u5730\u4E0B\u8F7D\u6587\u4EF6\u3002",
        buttons: buildStorageMaintenanceKeyboard(stats.count)
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u53D6\u6D88" }));
      return;
    }
    if (data === "storage_clear_ask") {
      await client2.editMessage(update.peer, {
        message: Number(update.msgId),
        text: [
          "\u26A0\uFE0F **\u786E\u8BA4\u5220\u9664\u672C\u5730\u670D\u52A1\u5668\u5168\u90E8\u4E0B\u8F7D\u6587\u4EF6\uFF1F**",
          "",
          `\u5C06\u5220\u9664 uploads \u672C\u5730\u76EE\u5F55\u4E2D\u7684 **${stats.count}** \u4E2A\u6587\u4EF6\uFF0C\u5360\u7528 **${formatBytes(stats.totalSize)}**\u3002`,
          "\u8FD9\u53EA\u6E05\u7406\u670D\u52A1\u5668\u672C\u5730\u4E0B\u8F7D/\u7F13\u5B58\u6587\u4EF6\uFF0C\u4E0D\u4F1A\u4E3B\u52A8\u5220\u9664 OneDrive \u7B49\u4E91\u7AEF\u5B58\u50A8\u91CC\u7684\u6587\u4EF6\u8BB0\u5F55\u3002",
          "",
          "\u5982\u786E\u8BA4\uFF0C\u8BF7\u70B9\u51FB\u4E0B\u65B9\u7EA2\u8272\u786E\u8BA4\u6309\u94AE\u3002"
        ].join("\n"),
        buttons: buildStorageMaintenanceKeyboard(stats.count, true)
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u9700\u8981\u4E8C\u6B21\u786E\u8BA4" }));
      return;
    }
    if (data === "storage_clear_confirm") {
      let deletedCount = 0;
      let deletedBytes = 0;
      for (const filePath of stats.paths) {
        const size = fs9.existsSync(filePath) ? fs9.statSync(filePath).size : 0;
        if (await safeUnlink(filePath, UPLOAD_DIR4)) {
          deletedCount += 1;
          deletedBytes += size;
          await pruneEmptyDirs(path13.dirname(filePath));
        }
      }
      const after = await scanLocalDownloadFiles();
      await client2.editMessage(update.peer, {
        message: Number(update.msgId),
        text: [
          "\u2705 **\u672C\u5730\u670D\u52A1\u5668\u4E0B\u8F7D\u6587\u4EF6\u5DF2\u6E05\u7406**",
          "",
          `\u5DF2\u5220\u9664\uFF1A${deletedCount} \u4E2A\u6587\u4EF6`,
          `\u91CA\u653E\u7A7A\u95F4\uFF1A${formatBytes(deletedBytes)}`,
          `\u5269\u4F59\u672C\u5730\u6587\u4EF6\uFF1A${after.count} \u4E2A`
        ].join("\n"),
        buttons: buildStorageMaintenanceKeyboard(after.count)
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u5DF2\u5220\u9664 ${deletedCount} \u4E2A\u6587\u4EF6` }));
    }
  } catch (error) {
    console.error("\u{1F916} \u6E05\u7406\u672C\u5730\u4E0B\u8F7D\u6587\u4EF6\u5931\u8D25:", error);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u6E05\u7406\u5931\u8D25: ${error.message}`, alert: true }));
  }
}
async function handleDelete(message, args) {
  if (args.length === 0) {
    await message.reply({
      message: "\u274C \u8BF7\u63D0\u4F9B\u8981\u5220\u9664\u7684\u6587\u4EF6 ID \u524D\u7F00\n\n\u7528\u6CD5\uFF1A/delete <\u81F3\u5C11 8 \u4F4D ID \u524D\u7F00>\n\u63D0\u793A\uFF1A\u8BF7\u4ECE\u7F51\u9875\u7AEF\u6587\u4EF6\u5217\u8868\u590D\u5236\u6587\u4EF6 ID\u3002"
    });
    return;
  }
  const selector = args[0].trim();
  try {
    const scope = await getCurrentStorageScope();
    if (/^\d+$/.test(selector)) {
      await message.reply({ message: "\u274C \u4E3A\u907F\u514D\u8BEF\u5220\uFF0CTelegram Bot \u4E0D\u518D\u652F\u6301\u6309\u5217\u8868\u5E8F\u53F7\u5220\u9664\u3002\u8BF7\u4ECE\u7F51\u9875\u7AEF\u590D\u5236\u81F3\u5C11 8 \u4F4D\u6587\u4EF6 ID \u524D\u7F00\u3002" });
      return;
    }
    if (selector.length < 8) {
      await message.reply({ message: "\u274C ID \u524D\u7F00\u81F3\u5C11\u9700\u8981 8 \u4F4D\u3002\u8BF7\u4ECE\u7F51\u9875\u7AEF\u6587\u4EF6\u5217\u8868\u590D\u5236\u66F4\u957F\u7684\u6587\u4EF6 ID\u3002" });
      return;
    }
    const result = await query(`
            SELECT *
            FROM files
            WHERE ${scope.clause} AND id::text LIKE ${nextParam(scope, 1)}
            ORDER BY created_at DESC
            LIMIT 3
        `, [...scope.params, selector + "%"]);
    if (result.rows.length === 0) {
      await message.reply({ message: `\u274C \u672A\u627E\u5230 ID \u4EE5 "${selector}" \u5F00\u5934\u7684\u6587\u4EF6` });
      return;
    }
    if (result.rows.length > 1) {
      await message.reply({ message: `\u274C ID \u524D\u7F00 "${selector}" \u5339\u914D\u5230\u591A\u4E2A\u6587\u4EF6\uFF0C\u8BF7\u590D\u5236\u66F4\u957F\u7684 ID \u524D\u7F00\u540E\u91CD\u8BD5\u3002` });
      return;
    }
    const file = result.rows[0];
    const confirmId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    pendingDeleteConfirmations.set(confirmId, { fileId: file.id, name: file.name, size: Number(file.size || 0), selector, createdAt: Date.now() });
    await message.reply({
      message: [
        "\u26A0\uFE0F **\u786E\u8BA4\u5220\u9664\u8FD9\u4E2A\u6587\u4EF6\uFF1F**",
        "",
        `\u{1F4C4} ${file.name}`,
        `\u{1F194} ${String(file.id).slice(0, 12)}`,
        `\u{1F4E6} ${formatBytes(Number(file.size || 0))}`,
        file.folder ? `\u{1F4C1} ${file.folder}` : "",
        "",
        "\u5220\u9664\u4F1A\u79FB\u9664\u6570\u636E\u5E93\u8BB0\u5F55\u5E76\u5C1D\u8BD5\u5220\u9664\u5B9E\u9645\u6587\u4EF6\u3002\u8BF7\u786E\u8BA4\u65E0\u8BEF\u540E\u70B9\u51FB\u6309\u94AE\u3002"
      ].filter(Boolean).join("\n"),
      buttons: buildDeleteConfirmKeyboard(confirmId)
    });
  } catch (error) {
    console.error("\u{1F916} \u5220\u9664\u6587\u4EF6\u5931\u8D25:", error);
    await message.reply({ message: `${MSG.ERR_DELETE}: ${error.message}` });
  }
}
async function handleDeleteConfirmCallback(client2, update, data) {
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  const match = data.match(/^del_(confirm|cancel)_(.+)$/);
  if (!match) return;
  const [, action, confirmId] = match;
  const pending = pendingDeleteConfirmations.get(confirmId);
  if (!pending || Date.now() - pending.createdAt > DELETE_CONFIRM_TTL_MS) {
    pendingDeleteConfirmations.delete(confirmId);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5220\u9664\u786E\u8BA4\u5DF2\u8FC7\u671F", alert: true }));
    return;
  }
  if (action === "cancel") {
    pendingDeleteConfirmations.delete(confirmId);
    await client2.editMessage(update.peer, { message: Number(update.msgId), text: `\u5DF2\u53D6\u6D88\u5220\u9664\uFF1A${pending.name}`, buttons: new Api5.ReplyInlineMarkup({ rows: [] }) });
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u53D6\u6D88" }));
    return;
  }
  try {
    const scope = await getCurrentStorageScope();
    const result = await query(`SELECT * FROM files WHERE ${scope.clause} AND id = ${nextParam(scope, 1)} LIMIT 1`, [...scope.params, pending.fileId]);
    const file = result.rows[0];
    if (!file) {
      pendingDeleteConfirmations.delete(confirmId);
      await client2.editMessage(update.peer, { message: Number(update.msgId), text: "\u274C \u6587\u4EF6\u5DF2\u4E0D\u5B58\u5728\u6216\u4E0D\u5728\u5F53\u524D\u5B58\u50A8\u8303\u56F4\u5185\u3002", buttons: new Api5.ReplyInlineMarkup({ rows: [] }) });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u6587\u4EF6\u4E0D\u5B58\u5728", alert: true }));
      return;
    }
    try {
      await removePhysicalFile(file);
    } catch (err) {
      console.warn("\u{1F916} \u6587\u4EF6\u7269\u7406\u5220\u9664\u5931\u8D25\u6216\u6587\u4EF6\u5DF2\u4E0D\u5B58\u5728:", err);
    }
    await query("DELETE FROM files WHERE id = $1", [file.id]);
    pendingDeleteConfirmations.delete(confirmId);
    await client2.editMessage(update.peer, { message: Number(update.msgId), text: buildDeleteSuccess(file.name, file.id), buttons: new Api5.ReplyInlineMarkup({ rows: [] }) });
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u5220\u9664" }));
  } catch (error) {
    console.error("\u{1F916} \u786E\u8BA4\u5220\u9664\u6587\u4EF6\u5931\u8D25:", error);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u5220\u9664\u5931\u8D25: ${error.message}`, alert: true }));
  }
}
function formatTaskAge(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1e3));
  if (diffSeconds < 60) return "\u521A\u521A";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} \u5206\u949F\u524D`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} \u5C0F\u65F6\u524D`;
  return `${Math.floor(diffHours / 24)} \u5929\u524D`;
}
function buildChannelTaskQueueReport(jobs) {
  const labelStatus = (value) => ({
    pending: "\u7B49\u5F85",
    queued: "\u6392\u961F",
    scanning: "\u626B\u63CF\u4E2D",
    active: "\u4F20\u8F93\u4E2D",
    done: "\u5B8C\u6210",
    running: "\u8FD0\u884C\u4E2D",
    paused: "\u5DF2\u6682\u505C",
    failed: "\u5931\u8D25",
    cancelled: "\u5DF2\u53D6\u6D88",
    completed: "\u5B8C\u6210",
    completed_with_errors: "\u90E8\u5206\u5B8C\u6210"
  })[value || ""] || (value || "\u672A\u77E5");
  const lines = ["\u{1F4E1} **\u9891\u9053\u4EFB\u52A1\u961F\u5217**"];
  jobs.forEach((job, index) => {
    const total = Number(job.total_count || job.item_count || 0);
    const pending = Number(job.pending_count || 0);
    const downloading = Number(job.downloading_count || 0);
    const success = Number(job.success_count || 0);
    const failed = Number(job.failed_count || 0);
    const skipped = Number(job.skipped_count_items || job.skipped_count || 0);
    const done = success + failed + skipped;
    const missing = Number(job.missing_metadata_count || 0);
    const activeNow = Boolean(job.is_actively_running);
    const paused = job.status === "paused";
    const cooldownUntilMs = job.cooldown_until ? new Date(job.cooldown_until).getTime() : 0;
    const inCooldown = cooldownUntilMs > Date.now();
    const statusText = paused ? "\u5DF2\u6682\u505C" : inCooldown ? "\u51B7\u5374\u7B49\u5F85\u4E2D" : activeNow ? "\u6B63\u5728\u8FD0\u884C" : "\u7B49\u5F85\u63A5\u624B";
    const icon = paused ? "\u23F8\uFE0F" : inCooldown ? "\u{1F9CA}" : activeNow ? "\u{1F7E2}" : "\u23F3";
    const updatedText = formatTaskAge(job.updated_at);
    const id = String(job.id).slice(0, 8);
    lines.push([
      "",
      `${index + 1}. ${icon} **${statusText}** \xB7 ${job.kind}`,
      `   \u6765\u6E90\uFF1A${job.source}`,
      `   \u9636\u6BB5\uFF1A\u626B\u63CF ${labelStatus(job.scan_status)} \xB7 \u4E0B\u8F7D ${labelStatus(job.download_status)}`,
      `   \u961F\u5217\uFF1A\u4E0B\u8F7D\u4E2D ${downloading} \xB7 \u5F85\u5904\u7406 ${pending} \xB7 \u5DF2\u5B8C\u6210 ${done}/${total}`,
      failed > 0 ? `   \u5F02\u5E38\uFF1A\u5931\u8D25 ${failed} \xB7 \u8DF3\u8FC7 ${skipped}` : skipped > 0 ? `   \u8DF3\u8FC7\uFF1A${skipped}` : "",
      missing > 0 ? `   \u63D0\u793A\uFF1A${missing} \u4E2A\u5F85\u5904\u7406\u6761\u76EE\u6B63\u5728\u8865\u5168\u6587\u4EF6\u4FE1\u606F` : "",
      inCooldown ? `   \u51B7\u5374\u5230\uFF1A${new Date(job.cooldown_until).toLocaleString("zh-CN", { hour12: false })}` : "",
      updatedText ? `   \u6700\u8FD1\u6D3B\u52A8\uFF1A${updatedText}` : "",
      `   ID\uFF1A${id}`
    ].filter(Boolean).join("\n"));
  });
  return lines.join("\n");
}
function buildTasksKeyboard(jobs) {
  if (jobs.length === 0) return void 0;
  const rows = [];
  for (const job of jobs.slice(0, 8)) {
    const id = String(job.id).slice(0, 8);
    const paused = job.status === "paused";
    rows.push(new Api5.KeyboardButtonRow({
      buttons: [
        new Api5.KeyboardButtonCallback({
          text: `${paused ? "\u25B6\uFE0F \u7EE7\u7EED" : "\u23F8 \u6682\u505C"} ${id}`,
          data: Buffer.from(`ctq_${paused ? "resume" : "pause"}_${id}`)
        }),
        new Api5.KeyboardButtonCallback({
          text: `\u{1F6D1} \u53D6\u6D88 ${id}`,
          data: Buffer.from(`ctq_cancel_${id}`)
        })
      ]
    }));
  }
  if (jobs.length > 1) {
    rows.push(new Api5.KeyboardButtonRow({
      buttons: [new Api5.KeyboardButtonCallback({ text: "\u{1F6D1} \u53D6\u6D88\u5168\u90E8\u9891\u9053\u4EFB\u52A1", data: Buffer.from("ctq_cancel_all") })]
    }));
  }
  return new Api5.ReplyInlineMarkup({ rows });
}
async function handleTasks(message) {
  try {
    const status = getTaskStatus();
    const activeCount = status.active.length;
    const pendingCount = status.pending.length;
    const senderId = message.senderId?.toJSNumber();
    const jobs = senderId ? await listTelegramActiveTaskQueues(senderId, 10) : [];
    if (activeCount === 0 && pendingCount === 0 && jobs.length === 0) {
      await message.reply({ message: MSG.EMPTY_TASKS });
      return;
    }
    const sections = [];
    if (activeCount > 0 || pendingCount > 0) {
      sections.push(buildTasksReport(status.active, status.pending));
    }
    if (jobs.length > 0) {
      sections.push(buildChannelTaskQueueReport(jobs));
    }
    await message.reply({
      message: sections.filter(Boolean).join("\n\n"),
      buttons: buildTasksKeyboard(jobs)
    });
  } catch (error) {
    console.error("\u{1F916} \u83B7\u53D6\u4EFB\u52A1\u5217\u8868\u5931\u8D25:", error);
    await message.reply({ message: MSG.ERR_TASKS });
  }
}
async function handleStopTasks(message) {
  try {
    const result = forceStopDownloadTasks("\u7528\u6237\u901A\u8FC7 /stop_tasks \u5F3A\u5236\u505C\u6B62");
    if (result.total === 0) {
      await message.reply({ message: "\u{1F4EE} \u5F53\u524D\u6CA1\u6709\u53EF\u505C\u6B62\u7684\u4E0B\u8F7D\u4EFB\u52A1" });
      return;
    }
    await message.reply({
      message: `\u{1F6D1} \u5DF2\u53D1\u9001\u505C\u6B62\u6307\u4EE4

\u5904\u7406\u4E2D: ${result.active}
\u7B49\u5F85\u4E2D: ${result.pending}

\u6B63\u5728\u4E0B\u8F7D\u7684\u4EFB\u52A1\u4F1A\u5728\u5F53\u524D\u5206\u7247\u7ED3\u675F\u540E\u505C\u6B62\uFF0C\u5E76\u81EA\u52A8\u6E05\u7406\u4E34\u65F6\u6587\u4EF6\u3002`
    });
  } catch (error) {
    console.error("\u{1F916} \u5F3A\u5236\u505C\u6B62\u4EFB\u52A1\u5931\u8D25:", error);
    await message.reply({ message: `\u274C \u5F3A\u5236\u505C\u6B62\u4EFB\u52A1\u5931\u8D25: ${error.message}` });
  }
}
async function handlePauseTasks(message, args = []) {
  const taskId = args[0];
  const senderId = message.senderId?.toJSNumber();
  if (taskId && senderId) {
    const job = await pauseTelegramBackgroundJob(senderId, taskId);
    if (job) {
      await message.reply({ message: `\u23F8\uFE0F \u5DF2\u6682\u505C\u9891\u9053\u4EFB\u52A1 ${String(job.id).slice(0, 8)}
\u6765\u6E90\uFF1A${job.source}` });
      return;
    }
  }
  const result = pauseDownloadTasks(taskId);
  await message.reply({ message: `\u23F8\uFE0F \u5DF2\u6682\u505C\u5168\u5C40\u4E0B\u8F7D\u961F\u5217${taskId ? `
\u4EFB\u52A1\u5361: ${taskId}` : ""}

\u8FDB\u884C\u4E2D: ${result.active}
\u7B49\u5F85\u4E2D: ${result.pending}

\u5F53\u524D\u6B63\u5728\u4E0B\u8F7D\u7684\u6587\u4EF6\u4F1A\u7EE7\u7EED\u5B8C\u6210\uFF0C\u65B0\u7684\u7B49\u5F85\u4EFB\u52A1\u6682\u4E0D\u5F00\u59CB\u3002` });
}
async function handleResumeTasks(message, args = []) {
  const taskId = args[0];
  const senderId = message.senderId?.toJSNumber();
  if (taskId && senderId) {
    const job = await resumeTelegramBackgroundJob(senderId, taskId);
    if (job) {
      await message.reply({ message: `\u25B6\uFE0F \u5DF2\u7EE7\u7EED\u9891\u9053\u4EFB\u52A1 ${String(job.id).slice(0, 8)}
\u6765\u6E90\uFF1A${job.source}` });
      return;
    }
  }
  const result = resumeDownloadTasks(taskId);
  await message.reply({ message: `\u25B6\uFE0F \u5DF2\u7EE7\u7EED\u5168\u5C40\u4E0B\u8F7D\u961F\u5217${taskId ? `
\u4EFB\u52A1\u5361: ${taskId}` : ""}

\u8FDB\u884C\u4E2D: ${result.active}
\u7B49\u5F85\u4E2D: ${result.pending}` });
}
async function handleCancelTask(message, args) {
  const selector = args.join(" ").trim() || "all";
  const senderId = message.senderId?.toJSNumber();
  if (senderId) {
    if (selector === "all") {
      const jobs = await cancelAllTelegramBackgroundJobs(senderId);
      const result2 = cancelDownloadTask(selector);
      if (jobs.length > 0 || result2.total > 0) {
        await message.reply({ message: `\u{1F6D1} \u5DF2\u53D6\u6D88\u4EFB\u52A1

\u9891\u9053\u4EFB\u52A1: ${jobs.length}
\u666E\u901A\u4E0B\u8F7D: \u5904\u7406\u4E2D ${result2.active} / \u7B49\u5F85 ${result2.pending}` });
        return;
      }
    } else {
      const job = await cancelTelegramBackgroundJob(senderId, selector);
      if (job) {
        await message.reply({ message: `\u{1F6D1} \u5DF2\u53D6\u6D88\u9891\u9053\u4EFB\u52A1 ${String(job.id).slice(0, 8)}
\u6765\u6E90\uFF1A${job.source}` });
        return;
      }
    }
  }
  const result = cancelDownloadTask(selector);
  await message.reply({ message: result.total > 0 ? `\u{1F6D1} \u5DF2\u53D6\u6D88\u5339\u914D\u4EFB\u52A1

\u5339\u914D: ${selector}
\u5904\u7406\u4E2D: ${result.active}
\u7B49\u5F85\u4E2D: ${result.pending}` : `\u{1F4EE} \u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u4EFB\u52A1\uFF0C\u672A\u6E05\u7A7A\u5168\u5C40\u961F\u5217\uFF1A${selector}` });
}
async function handleChannelTaskQueueCallback(client2, update, data) {
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  try {
    const match = data.match(/^ctq_(pause|resume|cancel)_([0-9a-f]{4,}|all)$/i);
    if (!match) return;
    const [, action, selector] = match;
    let toast = "";
    if (selector === "all" && action === "cancel") {
      const jobs2 = await cancelAllTelegramBackgroundJobs(userId);
      toast = jobs2.length > 0 ? `\u5DF2\u53D6\u6D88 ${jobs2.length} \u4E2A\u9891\u9053\u4EFB\u52A1` : "\u6CA1\u6709\u53EF\u53D6\u6D88\u7684\u9891\u9053\u4EFB\u52A1";
    } else if (action === "pause") {
      const job = await pauseTelegramBackgroundJob(userId, selector);
      toast = job ? `\u5DF2\u6682\u505C ${String(job.id).slice(0, 8)}` : "\u4EFB\u52A1\u4E0D\u5B58\u5728\u6216\u5DF2\u7ED3\u675F";
    } else if (action === "resume") {
      const job = await resumeTelegramBackgroundJob(userId, selector);
      toast = job ? `\u5DF2\u7EE7\u7EED ${String(job.id).slice(0, 8)}` : "\u4EFB\u52A1\u4E0D\u5B58\u5728\u6216\u4E0D\u5728\u6682\u505C\u72B6\u6001";
    } else {
      const job = await cancelTelegramBackgroundJob(userId, selector);
      toast = job ? `\u5DF2\u53D6\u6D88 ${String(job.id).slice(0, 8)}` : "\u4EFB\u52A1\u4E0D\u5B58\u5728\u6216\u5DF2\u7ED3\u675F";
    }
    const jobs = await listTelegramActiveTaskQueues(userId, 10);
    const status = getTaskStatus();
    const sections = [];
    if (status.active.length > 0 || status.pending.length > 0) sections.push(buildTasksReport(status.active, status.pending));
    if (jobs.length > 0) sections.push(buildChannelTaskQueueReport(jobs));
    await client2.editMessage(update.peer, {
      message: Number(update.msgId),
      text: sections.length > 0 ? sections.join("\\n\\n") : MSG.EMPTY_TASKS,
      buttons: buildTasksKeyboard(jobs) || new Api5.ReplyInlineMarkup({ rows: [] })
    });
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: toast }));
  } catch (error) {
    console.error("\u{1F916} \u9891\u9053\u4EFB\u52A1\u6309\u94AE\u64CD\u4F5C\u5931\u8D25:", error);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u64CD\u4F5C\u5931\u8D25: ${error.message}`, alert: true }));
  }
}
async function handleRetryFailedTasks(message, args) {
  const senderId = message.senderId?.toJSNumber();
  const jobSelector = args.find((arg) => /^[0-9a-f-]{4,}$/i.test(arg));
  if (senderId && jobSelector) {
    const jobRetry = await retryTelegramBackgroundJob(senderId, jobSelector);
    if (jobRetry) {
      await message.reply({ message: jobRetry.retried > 0 ? `\u{1F504} \u5DF2\u91CD\u65B0\u52A0\u5165\u9891\u9053\u4EFB\u52A1\u5931\u8D25\u9879 ${jobRetry.retried} \u4E2A
\u4EFB\u52A1: ${String(jobRetry.id).slice(0, 8)}` : "\u{1F4EE} \u8BE5\u9891\u9053\u4EFB\u52A1\u6CA1\u6709\u53EF\u91CD\u8BD5\u5931\u8D25\u9879" });
      return;
    }
  }
  const taskId = args.find((arg) => /^t[a-z0-9]+/i.test(arg));
  const numericArg = args.find((arg) => /^\d+$/.test(arg));
  const limit = Math.max(1, Math.min(50, parseInt(numericArg || "10", 10) || 10));
  const result = await retryFailedDownloadTasks(limit, taskId);
  await message.reply({ message: result.retried > 0 ? `\u{1F504} \u5DF2\u91CD\u65B0\u52A0\u5165 ${result.retried} \u4E2A\u5931\u8D25\u4EFB\u52A1${taskId ? `
\u4EFB\u52A1: ${taskId}` : ""}` : "\u{1F4EE} \u6700\u8FD1\u6CA1\u6709\u53EF\u91CD\u8BD5\u7684\u5931\u8D25\u4EFB\u52A1" });
}
async function handleDownloadWorkers(message) {
  try {
    const current = await getCurrentDownloadWorkers();
    await message.reply({
      message: buildDownloadWorkersText(current),
      buttons: buildDownloadWorkersKeyboard(current)
    });
  } catch (error) {
    console.error("\u{1F916} \u83B7\u53D6\u5206\u7247\u5E76\u53D1\u8BBE\u7F6E\u5931\u8D25:", error);
    await message.reply({ message: `\u274C \u83B7\u53D6\u5206\u7247\u5E76\u53D1\u8BBE\u7F6E\u5931\u8D25: ${error.message}` });
  }
}
async function handleFileConcurrency(message) {
  try {
    const current = await getCurrentFileConcurrency();
    setFileDownloadConcurrency(current);
    await message.reply({
      message: buildFileConcurrencyText(current),
      buttons: buildFileConcurrencyKeyboard(current)
    });
  } catch (error) {
    console.error("\u{1F916} \u83B7\u53D6\u6587\u4EF6\u7EA7\u5E76\u53D1\u8BBE\u7F6E\u5931\u8D25:", error);
    await message.reply({ message: `\u274C \u83B7\u53D6\u6587\u4EF6\u7EA7\u5E76\u53D1\u8BBE\u7F6E\u5931\u8D25: ${error.message}` });
  }
}
async function handlePathRules(message) {
  const pathCenterState = await getPathCenterState();
  await message.reply({
    message: buildPathSettingsText(pathCenterState, message.chatId?.toString() || "unknown"),
    buttons: buildPathSettingsKeyboard(pathCenterState)
  });
}
async function handlePathOnce(message, args) {
  const folder = args.join(" ").trim();
  if (!folder) {
    await message.reply({ message: "\u274C \u7528\u6CD5\uFF1A/p <\u76EE\u5F55>\n\u4F8B\u5982\uFF1A/p PIXIV/\u6BCF\u65E5Top50" });
    return;
  }
  try {
    const normalized = await setNextTelegramPathPersistent(message.chatId?.toString() || "unknown", folder);
    await message.reply({ message: `\u{1F4CC} \u5DF2\u8BBE\u7F6E\u4E0B\u4E00\u6B21\u4E0B\u8F7D\u76EE\u5F55\uFF1A\`${normalized}\`
${buildPathPreviewLine(normalized)}

\u6B64\u8BBE\u7F6E\u4F1A\u5728\u4E0B\u4E00\u6B21\u6210\u529F\u8FDB\u5165\u4E0B\u8F7D\u6D41\u7A0B\u65F6\u81EA\u52A8\u5931\u6548\u3002` });
  } catch (error) {
    await message.reply({ message: `\u274C \u8DEF\u5F84\u65E0\u6548\uFF1A${error.message}` });
  }
}
async function handlePathSession(message, args) {
  const folder = args.join(" ").trim();
  if (!folder) {
    await message.reply({ message: "\u274C \u7528\u6CD5\uFF1A/ps <\u76EE\u5F55>\n\u4F8B\u5982\uFF1A/ps \u76F8\u518C/2026-07" });
    return;
  }
  try {
    const normalized = await setSessionTelegramPathPersistent(message.chatId?.toString() || "unknown", folder);
    await message.reply({ message: `\u{1F4CD} \u5DF2\u8BBE\u7F6E\u672C\u4F1A\u8BDD\u4E0B\u8F7D\u76EE\u5F55\uFF1A\`${normalized}\`
${buildPathPreviewLine(normalized)}

\u540E\u7EED\u6B64\u804A\u5929\u4E2D\u7684\u4E0B\u8F7D\u4F1A\u4F18\u5148\u4FDD\u5B58\u5230\u8BE5\u76EE\u5F55\uFF0C\u53D1\u9001 /pc \u53EF\u6E05\u9664\u3002` });
  } catch (error) {
    await message.reply({ message: `\u274C \u8DEF\u5F84\u65E0\u6548\uFF1A${error.message}` });
  }
}
async function handlePathClear(message) {
  clearTelegramPathState(message.chatId?.toString() || "unknown");
  await message.reply({ message: "\u{1F9F9} \u5DF2\u6E05\u9664\u4E0B\u4E00\u6B21/\u672C\u4F1A\u8BDD\u81EA\u5B9A\u4E49\u4E0B\u8F7D\u76EE\u5F55\uFF0C\u540E\u7EED\u6062\u590D\u4F7F\u7528\u9ED8\u8BA4\u81EA\u52A8\u5206\u7C7B\u76EE\u5F55\u3002" });
}
async function handlePathRulesCallback(client2, update, data) {
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  try {
    const pathCenterState = await getPathCenterState();
    const chatKey = getCallbackChatKey(update);
    if (data === "pr_clear_custom") {
      clearTelegramPathState(chatKey);
    } else if (data === "pr_recent") {
      const recent = await getRecentTelegramPathsPersistent(chatKey);
      await client2.sendMessage(update.peer, {
        message: recent.length > 0 ? ["\u{1F558} **\u6700\u8FD1\u4F7F\u7528\u76EE\u5F55**", "", ...recent.map((item, index) => `${index + 1}. ${item}`), "", "\u8981\u4F7F\u7528\u5176\u4E2D\u4E00\u4E2A\u76EE\u5F55\uFF0C\u8BF7\u76F4\u63A5\u590D\u5236\u53D1\u9001\uFF0C\u6216\u53D1\u9001 `/p <\u76EE\u5F55>` / `/ps <\u76EE\u5F55>`\u3002"].join("\n") : "\u{1F558} \u6682\u65E0\u6700\u8FD1\u4F7F\u7528\u76EE\u5F55\u3002\u8BBE\u7F6E\u8FC7 `/p`\u3001`/ps`\u3001\u8BA2\u9605\u4E13\u5C5E\u76EE\u5F55\u6216\u4E0B\u8F7D\u4EFB\u52A1\u4E13\u5C5E\u76EE\u5F55\u540E\u4F1A\u81EA\u52A8\u8BB0\u5F55\u3002"
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u53D1\u9001\u6700\u8FD1\u76EE\u5F55" }));
      return;
    } else if (data === "pr_help_once" || data === "pr_help_session") {
      const mode = data === "pr_help_once" ? "once" : "session";
      setPendingTelegramPathInput(chatKey, userId, mode);
      await client2.sendMessage(update.peer, { message: await buildPendingPathPromptPersistent(mode, chatKey) });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u8BF7\u76F4\u63A5\u53D1\u9001\u76EE\u5F55\uFF0C\u6216\u53D1\u9001\u201C\u53D6\u6D88\u201D\u9000\u51FA" }));
      return;
    }
    await client2.editMessage(update.peer, {
      message: Number(update.msgId),
      text: buildPathSettingsText(pathCenterState, chatKey),
      buttons: buildPathSettingsKeyboard(pathCenterState)
    });
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u4FDD\u5B58\u4F4D\u7F6E\u5DF2\u66F4\u65B0" }));
  } catch (error) {
    console.error("\u{1F916} \u8BBE\u7F6E\u4FDD\u5B58\u4F4D\u7F6E\u5931\u8D25:", error);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u8BBE\u7F6E\u5931\u8D25: ${error.message}`, alert: true }));
  }
}
async function handleDuplicateMode(message) {
  const mode = await getDuplicateMode();
  await message.reply({
    message: buildDuplicateModeText(mode),
    buttons: buildDuplicateModeKeyboard(mode)
  });
}
async function handleDuplicateModeCallback(client2, update, data) {
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  try {
    const match = data.match(/^dm_set_(skip|copy)$/);
    if (!match) return;
    const mode = match[1];
    await setSetting("duplicate_file_mode", mode);
    await client2.editMessage(update.peer, {
      message: Number(update.msgId),
      text: buildDuplicateModeText(mode),
      buttons: buildDuplicateModeKeyboard(mode)
    });
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u5DF2\u8BBE\u7F6E\u4E3A${mode === "skip" ? "\u8DF3\u8FC7\u91CD\u590D" : "\u751F\u6210\u526F\u672C"}` }));
  } catch (error) {
    console.error("\u{1F916} \u8BBE\u7F6E\u91CD\u590D\u6587\u4EF6\u5904\u7406\u5931\u8D25:", error);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u8BBE\u7F6E\u5931\u8D25: ${error.message}`, alert: true }));
  }
}
async function handleCleanupSettings(message) {
  const enabled = await getCleanupEnabledSetting();
  await message.reply({
    message: buildCleanupSettingsText(enabled),
    buttons: buildCleanupSettingsKeyboard(enabled)
  });
}
async function handleCleanupSettingsCallback(client2, update, data) {
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  try {
    const enabled = data === "cs_set_on";
    await setSetting("auto_cleanup_orphans", String(enabled));
    process.env.AUTO_CLEANUP_ORPHANS = String(enabled);
    if (enabled) {
      startPeriodicCleanup();
    } else {
      stopPeriodicCleanup();
    }
    await client2.editMessage(update.peer, {
      message: Number(update.msgId),
      text: buildCleanupSettingsText(enabled),
      buttons: buildCleanupSettingsKeyboard(enabled)
    });
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: enabled ? "\u5DF2\u5F00\u542F\u81EA\u52A8\u6E05\u7406" : "\u5DF2\u5173\u95ED\u81EA\u52A8\u6E05\u7406" }));
  } catch (error) {
    console.error("\u{1F916} \u8BBE\u7F6E\u81EA\u52A8\u6E05\u7406\u5931\u8D25:", error);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u8BBE\u7F6E\u5931\u8D25: ${error.message}`, alert: true }));
  }
}
async function handleDownloadWorkersCallback(client2, update, data) {
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: MSG.AUTH_REQUIRED,
      alert: true
    }));
    return;
  }
  try {
    if (data === "dw_cancel") {
      const current = await getCurrentDownloadWorkers();
      await client2.editMessage(update.peer, {
        message: Number(update.msgId),
        text: buildDownloadWorkersText(current),
        buttons: buildDownloadWorkersKeyboard(current)
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u53D6\u6D88" }));
      return;
    }
    const setMatch = data.match(/^dw_set_(4|8|12|16)$/);
    if (setMatch) {
      const workers = Number(setMatch[1]);
      if (workers >= 12) {
        await client2.editMessage(update.peer, {
          message: Number(update.msgId),
          text: [
            `\u26A0\uFE0F **\u786E\u8BA4\u4F7F\u7528 ${workers} workers\uFF1F**`,
            "",
            "\u8FD9\u662F\u6FC0\u8FDB\u5206\u7247\u5E76\u53D1\u6A21\u5F0F\uFF0C\u53EF\u80FD\u51FA\u73B0\uFF1A",
            "- Telegram \u98CE\u63A7\u6216\u9650\u6D41",
            "- \u4E0B\u8F7D\u65AD\u6D41 / \u91CD\u8BD5\u589E\u591A",
            "- user session \u8D26\u53F7\u98CE\u9669\uFF0C\u6781\u7AEF\u60C5\u51B5\u4E0B\u53EF\u80FD\u5F71\u54CD\u8D26\u53F7",
            "",
            "\u5982\u679C\u53EA\u662F\u65E5\u5E38\u4E0B\u8F7D\uFF0C\u5EFA\u8BAE\u4F7F\u7528 4 \u6216 8\u3002"
          ].join("\n"),
          buttons: buildDownloadWorkersKeyboard(workers, workers)
        });
        await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u9700\u8981\u4E8C\u6B21\u786E\u8BA4" }));
        return;
      }
      await setSetting("telegram_download_workers", String(workers));
      await client2.editMessage(update.peer, {
        message: Number(update.msgId),
        text: `${buildDownloadWorkersText(workers)}

\u2705 \u5DF2\u5207\u6362\u4E3A ${workers} workers\uFF0C\u540E\u7EED\u65B0\u4E0B\u8F7D\u4EFB\u52A1\u7ACB\u5373\u751F\u6548\u3002`,
        buttons: buildDownloadWorkersKeyboard(workers)
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u5DF2\u8BBE\u7F6E\u4E3A ${workers}` }));
      return;
    }
    const confirmMatch = data.match(/^dw_confirm_(12|16)$/);
    if (confirmMatch) {
      const workers = Number(confirmMatch[1]);
      await setSetting("telegram_download_workers", String(workers));
      await client2.editMessage(update.peer, {
        message: Number(update.msgId),
        text: `${buildDownloadWorkersText(workers)}

\u26A0\uFE0F \u5DF2\u786E\u8BA4\u5E76\u5207\u6362\u4E3A ${workers} workers\u3002\u82E5\u51FA\u73B0\u65AD\u6D41\u3001\u9650\u901F\u3001\u98CE\u63A7\u63D0\u793A\uFF0C\u8BF7\u7ACB\u5373\u964D\u56DE 4 \u6216 8\u3002`,
        buttons: buildDownloadWorkersKeyboard(workers)
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u5DF2\u786E\u8BA4 ${workers} workers`, alert: true }));
    }
  } catch (error) {
    console.error("\u{1F916} \u8BBE\u7F6E\u5E76\u53D1\u4E0B\u8F7D worker \u5931\u8D25:", error);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: `\u8BBE\u7F6E\u5931\u8D25: ${error.message}`,
      alert: true
    }));
  }
}
async function handleFileConcurrencyCallback(client2, update, data) {
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: MSG.AUTH_REQUIRED,
      alert: true
    }));
    return;
  }
  try {
    if (data === "fc_cancel") {
      const current = await getCurrentFileConcurrency();
      setFileDownloadConcurrency(current);
      await client2.editMessage(update.peer, {
        message: Number(update.msgId),
        text: buildFileConcurrencyText(current),
        buttons: buildFileConcurrencyKeyboard(current)
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u53D6\u6D88" }));
      return;
    }
    const setMatch = data.match(/^fc_set_(1|2|3|4)$/);
    if (setMatch) {
      const concurrency = Number(setMatch[1]);
      if (concurrency === 4) {
        await client2.editMessage(update.peer, {
          message: Number(update.msgId),
          text: [
            "\u26A0\uFE0F **\u786E\u8BA4\u540C\u65F6\u4E0B\u8F7D 4 \u4E2A\u6587\u4EF6\uFF1F**",
            "",
            "\u8FD9\u662F\u6587\u4EF6\u7EA7\u6FC0\u8FDB\u5E76\u53D1\u6A21\u5F0F\uFF0C\u53EF\u80FD\u51FA\u73B0\uFF1A",
            "- Telegram \u98CE\u63A7\u6216\u9650\u6D41",
            "- \u4E91\u76D8\u4E0A\u4F20\u9650\u901F / \u5931\u8D25\u91CD\u8BD5\u589E\u591A",
            "- \u670D\u52A1\u5668\u78C1\u76D8\u548C\u7F51\u7EDC\u538B\u529B\u660E\u663E\u589E\u52A0",
            "",
            "\u5982\u679C\u53EA\u662F\u65E5\u5E38\u4E0B\u8F7D\uFF0C\u5EFA\u8BAE\u4F7F\u7528 2 \u6216 3\u3002"
          ].join("\n"),
          buttons: buildFileConcurrencyKeyboard(concurrency, concurrency)
        });
        await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u9700\u8981\u4E8C\u6B21\u786E\u8BA4" }));
        return;
      }
      await setSetting("telegram_file_download_concurrency", String(concurrency));
      const normalized = setFileDownloadConcurrency(concurrency);
      await client2.editMessage(update.peer, {
        message: Number(update.msgId),
        text: `${buildFileConcurrencyText(normalized)}

\u2705 \u5DF2\u5207\u6362\u4E3A\u540C\u65F6\u4E0B\u8F7D ${normalized} \u4E2A\u6587\u4EF6\u3002`,
        buttons: buildFileConcurrencyKeyboard(normalized)
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `\u5DF2\u8BBE\u7F6E\u4E3A ${normalized}` }));
      return;
    }
    const confirmMatch = data.match(/^fc_confirm_4$/);
    if (confirmMatch) {
      await setSetting("telegram_file_download_concurrency", "4");
      const normalized = setFileDownloadConcurrency(4);
      await client2.editMessage(update.peer, {
        message: Number(update.msgId),
        text: `${buildFileConcurrencyText(normalized)}

\u26A0\uFE0F \u5DF2\u786E\u8BA4\u5E76\u5207\u6362\u4E3A\u540C\u65F6\u4E0B\u8F7D 4 \u4E2A\u6587\u4EF6\u3002\u82E5\u51FA\u73B0\u9650\u6D41\u3001\u65AD\u6D41\u6216\u4E0A\u4F20\u5931\u8D25\uFF0C\u8BF7\u7ACB\u5373\u964D\u56DE 2 \u6216 3\u3002`,
        buttons: buildFileConcurrencyKeyboard(normalized)
      });
      await client2.invoke(new Api5.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u786E\u8BA4 4 \u4E2A\u6587\u4EF6\u5E76\u53D1", alert: true }));
    }
  } catch (error) {
    console.error("\u{1F916} \u8BBE\u7F6E\u6587\u4EF6\u7EA7\u5E76\u53D1\u5931\u8D25:", error);
    await client2.invoke(new Api5.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: `\u8BBE\u7F6E\u5931\u8D25: ${error.message}`,
      alert: true
    }));
  }
}

// src/services/ytDlpDownload.ts
init_db();
init_storage();
import fs10 from "fs";
import path14 from "path";
import { spawn } from "child_process";
import os2 from "os";
var YtDlpQueue = class {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
  }
  maxConcurrent;
  queue = [];
  activeCount = 0;
  add(job) {
    this.queue.push(job);
    this.process();
  }
  process() {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      this.activeCount += 1;
      job().finally(() => {
        this.activeCount -= 1;
        this.process();
      });
    }
  }
};
var YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
var YTDLP_WORK_DIR = process.env.YTDLP_WORK_DIR || "./data/uploads/ytdlp";
var YTDLP_MAX_CONCURRENT = Math.max(1, parseInt(process.env.YTDLP_MAX_CONCURRENT || "1", 10) || 1);
var ytDlpQueue = new YtDlpQueue(YTDLP_MAX_CONCURRENT);
function ensureDir(p) {
  if (!fs10.existsSync(p)) {
    fs10.mkdirSync(p, { recursive: true });
  }
}
function safeRmDir(dir) {
  try {
    if (fs10.existsSync(dir)) {
      fs10.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
  }
}
function selectPrimaryOutputFile(taskDir) {
  const entries = fs10.readdirSync(taskDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => ({
    name: e.name,
    fullPath: path14.join(taskDir, e.name)
  })).filter((f) => !f.name.endsWith(".part") && !f.name.endsWith(".ytdl") && !f.name.endsWith(".json") && !f.name.endsWith(".tmp")).map((f) => ({
    ...f,
    size: fs10.existsSync(f.fullPath) ? fs10.statSync(f.fullPath).size : 0
  })).filter((f) => f.size > 0).sort((a, b) => b.size - a.size);
  if (files.length === 0) return null;
  return { filePath: files[0].fullPath, fileName: files[0].name, size: files[0].size };
}
async function runYtDlpDownload(url, taskDir) {
  ensureDir(taskDir);
  const outputTemplate = path14.join(taskDir, "%(title).200s-%(id)s.%(ext)s");
  const args = [
    "--no-playlist",
    "--newline",
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    "--",
    url
  ];
  await new Promise((resolve, reject) => {
    const binLower = YTDLP_BIN.toLowerCase();
    const isWindows = os2.platform() === "win32";
    const needsShell = isWindows && (binLower.endsWith(".cmd") || binLower.endsWith(".bat"));
    const child = spawn(YTDLP_BIN, args, {
      windowsHide: true,
      shell: needsShell
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 4e3) stderr = stderr.slice(-4e3);
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const msg = stderr.trim() || `yt-dlp exited with code ${code}`;
      reject(new Error(msg));
    });
  });
}
async function uploadDownloadedFile(localFilePath, originalFileName) {
  const provider = storageManager.getProvider();
  const activeAccountId = storageManager.getActiveAccountId();
  const safeName = sanitizeFilename(originalFileName);
  const ext = path14.extname(safeName) || path14.extname(localFilePath) || "";
  const mimeType = getMimeTypeFromFilename(safeName);
  const fileType = getFileType(mimeType);
  const storageRules = await getStoragePathRules();
  const folder = buildStorageFolderWithRules({ source: "ytdlp", mimeType, fileName: safeName }, storageRules) || "ytdlp";
  const storedName = await getUniqueStoredName(safeName, folder, activeAccountId);
  const stats = await fs10.promises.stat(localFilePath);
  const size = stats.size;
  const duplicateMode = await getDuplicateMode();
  if (duplicateMode === "skip") {
    const duplicate = await findDuplicateFile(safeName, folder, size, activeAccountId);
    if (duplicate) {
      return { finalPath: duplicate.path || "", providerName: provider.name, size, storedName: duplicate.name, folder };
    }
  }
  let thumbnailPath = null;
  let dimensions = {};
  if (provider.name === "local" && (mimeType.startsWith("image/") || mimeType.startsWith("video/"))) {
    try {
      thumbnailPath = await generateThumbnail(localFilePath, storedName, mimeType);
      dimensions = await getImageDimensions(localFilePath, mimeType);
    } catch {
    }
  }
  let finalPath = await provider.saveFile(localFilePath, storedName, mimeType, folder);
  try {
    if (fs10.existsSync(localFilePath)) await fs10.promises.unlink(localFilePath);
  } catch {
  }
  await query(`
        INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [safeName, storedName, fileType, mimeType, size, finalPath, thumbnailPath, dimensions.width, dimensions.height, provider.name, folder, activeAccountId]);
  return { finalPath, providerName: provider.name, size, storedName, folder };
}
async function handleYtDlpCommand(message, url) {
  const task = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    url,
    status: "pending",
    createdAt: Date.now()
  };
  const workBaseDir = path14.isAbsolute(YTDLP_WORK_DIR) ? YTDLP_WORK_DIR : path14.join(process.cwd(), YTDLP_WORK_DIR);
  ensureDir(workBaseDir);
  const taskDir = path14.join(workBaseDir, task.id);
  await message.reply({ message: `\u23EC \u5F00\u59CB\u89E3\u6790\u5E76\u4E0B\u8F7D...
Task: ${task.id}` });
  ytDlpQueue.add(async () => {
    task.status = "active";
    task.startedAt = Date.now();
    try {
      await runYtDlpDownload(task.url, taskDir);
      const primary = selectPrimaryOutputFile(taskDir);
      if (!primary) {
        throw new Error("\u4E0B\u8F7D\u5B8C\u6210\u4F46\u672A\u627E\u5230\u8F93\u51FA\u6587\u4EF6");
      }
      const uploadResult = await uploadDownloadedFile(primary.filePath, primary.fileName);
      task.status = "success";
      task.finishedAt = Date.now();
      const text = `\u2705 \u5DF2\u4E0A\u4F20

\u6587\u4EF6: ${primary.fileName}
\u5927\u5C0F: ${formatBytes(uploadResult.size)}
\u5B58\u50A8\u6E90: ${uploadResult.providerName}`;
      try {
        await message.reply({ message: text });
      } catch {
      }
    } catch (e) {
      task.status = "failed";
      task.finishedAt = Date.now();
      task.error = e instanceof Error ? e.message : String(e);
      const errText = (task.error || "\u672A\u77E5\u9519\u8BEF").toString().trim();
      const trimmed = errText.length > 1500 ? errText.slice(0, 1500) + "..." : errText;
      try {
        await message.reply({ message: `\u274C \u4E0B\u8F7D/\u4E0A\u4F20\u5931\u8D25

\u539F\u56E0: ${trimmed}` });
      } catch {
      }
    } finally {
      safeRmDir(taskDir);
    }
  });
}

// src/services/telegramBot.ts
init_db();

// src/utils/networkSecurity.ts
import dns from "dns/promises";
import net from "net";
function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part) >>> 0, 0);
}
function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  const ranges = [
    ["0.0.0.0", "0.255.255.255"],
    ["10.0.0.0", "10.255.255.255"],
    ["127.0.0.0", "127.255.255.255"],
    ["169.254.0.0", "169.254.255.255"],
    ["172.16.0.0", "172.31.255.255"],
    ["192.168.0.0", "192.168.255.255"],
    ["224.0.0.0", "239.255.255.255"],
    ["240.0.0.0", "255.255.255.255"]
  ];
  return ranges.some(([start, end]) => n >= ipv4ToInt(start) && n <= ipv4ToInt(end));
}
function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}
function isPrivateAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}
async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("\u94FE\u63A5\u683C\u5F0F\u65E0\u6548");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("\u4EC5\u5141\u8BB8 http/https \u94FE\u63A5");
  }
  const hostname = parsed.hostname;
  if (!hostname || ["localhost", "localhost.localdomain"].includes(hostname.toLowerCase())) {
    throw new Error("\u4E0D\u5141\u8BB8\u8BBF\u95EE\u672C\u673A\u5730\u5740");
  }
  const directIpVersion = net.isIP(hostname);
  const addresses = directIpVersion ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("\u4E0D\u5141\u8BB8\u8BBF\u95EE\u5185\u7F51\u3001\u56DE\u73AF\u6216\u4FDD\u7559\u5730\u5740");
  }
  return parsed;
}
async function assertPublicStorageEndpoint(rawUrl) {
  const parsed = await assertPublicHttpUrl(rawUrl);
  if (parsed.protocol !== "https:" && process.env.ALLOW_INSECURE_STORAGE_ENDPOINTS !== "true") {
    throw new Error("\u5B58\u50A8\u7AEF\u70B9\u4EC5\u5141\u8BB8 https\uFF1B\u5982\u786E\u9700 http\uFF0C\u8BF7\u663E\u5F0F\u8BBE\u7F6E ALLOW_INSECURE_STORAGE_ENDPOINTS=true");
  }
  return parsed;
}

// src/services/telegramBot.ts
var SESSION_FILE = process.env.TELEGRAM_SESSION_FILE || "./data/telegram_session.txt";
var client = null;
function buildTelegramDownloadModeKeyboard() {
  return new Api6.ReplyInlineMarkup({
    rows: [
      new Api6.KeyboardButtonRow({
        buttons: [
          new Api6.KeyboardButtonCallback({ text: "\u{1F5D3}\uFE0F \u6309\u65E5\u671F\u4E0B\u8F7D", data: Buffer.from("tgd_mode_date") }),
          new Api6.KeyboardButtonCallback({ text: "\u{1F3F7}\uFE0F \u6309\u6807\u7B7E\u4E0B\u8F7D", data: Buffer.from("tgd_mode_tag") })
        ]
      }),
      new Api6.KeyboardButtonRow({
        buttons: [new Api6.KeyboardButtonCallback({ text: "\u53D6\u6D88", data: Buffer.from("tgd_cancel") })]
      })
    ]
  });
}
function buildTelegramCommentsKeyboard() {
  return new Api6.ReplyInlineMarkup({
    rows: [
      new Api6.KeyboardButtonRow({
        buttons: [
          new Api6.KeyboardButtonCallback({ text: "\u4EC5\u9891\u9053\u6B63\u6587", data: Buffer.from("tgd_comments_off") }),
          new Api6.KeyboardButtonCallback({ text: "\u9891\u9053 + \u8BC4\u8BBA\u533A", data: Buffer.from("tgd_comments_on") })
        ]
      }),
      new Api6.KeyboardButtonRow({
        buttons: [new Api6.KeyboardButtonCallback({ text: "\u53D6\u6D88", data: Buffer.from("tgd_cancel") })]
      })
    ]
  });
}
var telegramWizardStates = /* @__PURE__ */ new Map();
var telegramRateBuckets = /* @__PURE__ */ new Map();
var TELEGRAM_MESSAGE_RATE_WINDOW_MS = Math.max(1e4, parseInt(process.env.TELEGRAM_RATE_WINDOW_MS || "60000", 10) || 6e4);
var TELEGRAM_MESSAGE_RATE_MAX = Math.max(5, parseInt(process.env.TELEGRAM_RATE_MAX || "30", 10) || 30);
var TELEGRAM_HEAVY_RATE_WINDOW_MS = Math.max(6e4, parseInt(process.env.TELEGRAM_HEAVY_RATE_WINDOW_MS || "600000", 10) || 6e5);
var TELEGRAM_HEAVY_RATE_MAX = Math.max(1, parseInt(process.env.TELEGRAM_HEAVY_RATE_MAX || "5", 10) || 5);
var TELEGRAM_HEAVY_COMMANDS = /* @__PURE__ */ new Set(["/ytdlp", "/tg_download", "/tg_date", "/tg_tag", "/cleanup_settings"]);
var pinFailureState = /* @__PURE__ */ new Map();
var TELEGRAM_PIN_FAIL_WINDOW_MS = Math.max(6e4, parseInt(process.env.TELEGRAM_PIN_FAIL_WINDOW_MS || "900000", 10) || 9e5);
var TELEGRAM_PIN_FAIL_MAX = Math.max(3, parseInt(process.env.TELEGRAM_PIN_FAIL_MAX || "5", 10) || 5);
var TELEGRAM_PIN_LOCK_MS = Math.max(6e4, parseInt(process.env.TELEGRAM_PIN_LOCK_MS || "900000", 10) || 9e5);
var TELEGRAM_PIN_REQUIRED_LENGTH = 4;
function getPinLockSeconds(userId) {
  const state = pinFailureState.get(userId);
  if (!state?.lockedUntil) return 0;
  const remaining = state.lockedUntil - Date.now();
  if (remaining <= 0) {
    pinFailureState.delete(userId);
    return 0;
  }
  return Math.ceil(remaining / 1e3);
}
function recordPinFailure(userId) {
  const now = Date.now();
  const current = pinFailureState.get(userId);
  const state = !current || now - current.windowStartedAt >= TELEGRAM_PIN_FAIL_WINDOW_MS ? { windowStartedAt: now, failed: 0 } : current;
  state.failed += 1;
  if (state.failed >= TELEGRAM_PIN_FAIL_MAX) {
    state.lockedUntil = now + TELEGRAM_PIN_LOCK_MS;
  }
  pinFailureState.set(userId, state);
  return { locked: Boolean(state.lockedUntil && state.lockedUntil > now), retryAfterSeconds: state.lockedUntil ? Math.ceil((state.lockedUntil - now) / 1e3) : 0 };
}
function clearPinFailures(userId) {
  pinFailureState.delete(userId);
}
function consumeTelegramRateLimit(userId, text) {
  const now = Date.now();
  const normalized = text.trim().split(/\s+/, 1)[0].replace(/@\w+$/, "").toLowerCase();
  const checks = [
    { key: `${userId}:all`, windowMs: TELEGRAM_MESSAGE_RATE_WINDOW_MS, max: TELEGRAM_MESSAGE_RATE_MAX }
  ];
  if (TELEGRAM_HEAVY_COMMANDS.has(normalized)) {
    checks.push({ key: `${userId}:heavy:${normalized}`, windowMs: TELEGRAM_HEAVY_RATE_WINDOW_MS, max: TELEGRAM_HEAVY_RATE_MAX });
  }
  let longestRetryAfter = 0;
  for (const check of checks) {
    const bucket = telegramRateBuckets.get(check.key);
    if (!bucket || now - bucket.windowStartedAt >= check.windowMs) {
      telegramRateBuckets.set(check.key, { windowStartedAt: now, count: 1 });
      continue;
    }
    if (bucket.count >= check.max) {
      longestRetryAfter = Math.max(longestRetryAfter, Math.ceil((check.windowMs - (now - bucket.windowStartedAt)) / 1e3));
      continue;
    }
    bucket.count += 1;
  }
  for (const [key, bucket] of telegramRateBuckets) {
    if (now - bucket.windowStartedAt > Math.max(TELEGRAM_MESSAGE_RATE_WINDOW_MS, TELEGRAM_HEAVY_RATE_WINDOW_MS) * 2) {
      telegramRateBuckets.delete(key);
    }
  }
  return { limited: longestRetryAfter > 0, retryAfterSeconds: longestRetryAfter };
}
function isCancelInput(text) {
  return /^(取消|cancel|退出|stop)$/i.test(text.trim());
}
function buildTelegramWizardPrompt(state) {
  const title = state.kind === "tg_sub_manage" ? "\u{1F4E1} **\u8BA2\u9605\u9891\u9053\u7BA1\u7406**" : state.kind === "tg_tag" ? "\u{1F3F7}\uFE0F **\u6309\u6807\u7B7E\u4E0B\u8F7D\u9891\u9053\u6587\u4EF6**" : state.kind === "tg_date" ? "\u{1F5D3}\uFE0F **\u6309\u65E5\u671F\u4E0B\u8F7D\u9891\u9053\u6587\u4EF6**" : "\u{1F4E6} **\u9891\u9053\u6587\u4EF6\u4E0B\u8F7D**";
  if (state.step === "mode") {
    return [
      title,
      "",
      "\u8BF7\u9009\u62E9\u4E0B\u8F7D\u65B9\u5F0F\uFF1A",
      "`\u65E5\u671F` \u2014 \u4E0B\u8F7D\u67D0\u4E2A\u65E5\u671F\u8303\u56F4\u5185\u7684\u9891\u9053\u5A92\u4F53",
      "`\u6807\u7B7E` \u2014 \u4E0B\u8F7D\u5E26\u6307\u5B9A #\u6807\u7B7E \u7684\u9891\u9053\u5A92\u4F53",
      "",
      "\u4E5F\u53EF\u4EE5\u76F4\u63A5\u53D1\u9001\uFF1A`date` / `tag`\u3002",
      "\u53D1\u9001\u201C\u53D6\u6D88\u201D\u53EF\u9000\u51FA\u3002"
    ].join("\n");
  }
  if (state.step === "source") {
    return [
      title,
      "",
      "\u8BF7\u53D1\u9001\u9891\u9053\u7528\u6237\u540D\u6216\u94FE\u63A5\uFF1A",
      "\u4F8B\u5982\uFF1A`@channel_username` \u6216 `https://t.me/channel_username`",
      "",
      "\u4E5F\u53EF\u4EE5\u76F4\u63A5\u53D1\u9001\uFF1A`@\u9891\u9053 comments` \u6216 `@\u9891\u9053 no-comments`\u3002",
      "",
      "\u53D1\u9001\u201C\u53D6\u6D88\u201D\u53EF\u9000\u51FA\u3002"
    ].join("\n");
  }
  if (state.step === "path") {
    const scopeText = state.kind === "tg_sub_manage" ? state.subscriptionId ? "\u8FD9\u4E2A\u8BA2\u9605" : "\u672C\u6B21\u8BA2\u9605" : "\u672C\u6B21\u4E0B\u8F7D\u4EFB\u52A1";
    return [
      title,
      `\u{1F4CD} \u9891\u9053\uFF1A${state.subscriptionSource || state.source}`,
      "",
      `\u662F\u5426\u8981\u7ED9${scopeText}\u5355\u72EC\u6307\u5B9A\u4FDD\u5B58\u76EE\u5F55\uFF1F`,
      "",
      "\u76F4\u63A5\u53D1\u9001\u76EE\u5F55\uFF0C\u4F8B\u5982\uFF1A`\u9891\u9053\u5907\u4EFD/\u58C1\u7EB8`",
      "\u53D1\u9001 `\u8DF3\u8FC7` / `skip` \u4F7F\u7528\u9ED8\u8BA4\u4FDD\u5B58\u8DEF\u5F84\u89C4\u5219\u3002",
      "",
      `\u8BF4\u660E\uFF1A\u8FD9\u91CC\u8BBE\u7F6E\u7684\u76EE\u5F55\u53EA\u5BF9${scopeText}\u751F\u6548\uFF0C\u4E0D\u4F1A\u6539\u53D8\u5168\u5C40 /path_rules\uFF0C\u4E5F\u4E0D\u4F1A\u5F71\u54CD\u5176\u5B83\u4E0B\u8F7D\u3002`,
      "\u53D1\u9001\u201C\u53D6\u6D88\u201D\u53EF\u9000\u51FA\u3002"
    ].join("\n");
  }
  if (state.step === "comments") {
    return [
      title,
      `\u{1F4CD} \u9891\u9053\uFF1A${state.subscriptionSource || state.source}`,
      state.customFolder ? `\u{1F4C1} \u4FDD\u5B58\u76EE\u5F55\uFF1A${state.customFolder}` : "\u{1F4C1} \u4FDD\u5B58\u7B56\u7565\uFF1A\u9ED8\u8BA4\u81EA\u52A8\u5206\u7C7B",
      "",
      "\u662F\u5426\u540C\u65F6\u626B\u63CF\u9891\u9053\u5E16\u5B50\u4E0B\u65B9\u7684\u8BC4\u8BBA\u533A\u6587\u4EF6\uFF1F",
      "",
      `\u9ED8\u8BA4\u5173\u95ED\uFF1B\u5F00\u542F\u540E\u6BCF\u4E2A\u9891\u9053\u5E16\u5B50\u6700\u591A\u626B\u63CF ${state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST} \u6761\u8BC4\u8BBA\u3002`,
      "\u6587\u5B57\u8BC4\u8BBA\u3001\u666E\u901A\u94FE\u63A5\u548C\u5176\u5B83\u65E0\u6587\u4EF6\u6D88\u606F\u4F1A\u81EA\u52A8\u5FFD\u7565\u3002",
      "",
      "\u4E5F\u53EF\u4EE5\u53D1\u9001\uFF1A`\u5F00` / `\u5173` / `yes` / `no`\u3002",
      "\u53D1\u9001\u201C\u53D6\u6D88\u201D\u53EF\u9000\u51FA\u3002"
    ].join("\n");
  }
  if (state.step === "tag") {
    return [
      title,
      `\u{1F4CD} \u9891\u9053\uFF1A${state.subscriptionSource || state.source}`,
      "",
      "\u8BF7\u53D1\u9001\u8981\u4E0B\u8F7D\u7684\u6807\u7B7E\uFF1A",
      "\u4F8B\u5982\uFF1A`#\u58C1\u7EB8` \u6216 `\u58C1\u7EB8`",
      "",
      "\u53D1\u9001\u201C\u53D6\u6D88\u201D\u53EF\u9000\u51FA\u3002"
    ].join("\n");
  }
  if (state.step === "start_date") {
    return [
      title,
      `\u{1F4CD} \u9891\u9053\uFF1A${state.subscriptionSource || state.source}`,
      "",
      "\u8BF7\u53D1\u9001\u5F00\u59CB\u65E5\u671F\uFF1A",
      "\u683C\u5F0F\uFF1A`YYYY-MM-DD`\uFF0C\u4F8B\u5982 `2026-06-01`",
      "",
      "\u53D1\u9001\u201C\u53D6\u6D88\u201D\u53EF\u9000\u51FA\u3002"
    ].join("\n");
  }
  return [
    title,
    `\u{1F4CD} \u9891\u9053\uFF1A${state.source}`,
    `\u{1F5D3}\uFE0F \u5F00\u59CB\u65E5\u671F\uFF1A${state.startDate}`,
    "",
    "\u8BF7\u53D1\u9001\u7ED3\u675F\u65E5\u671F\uFF1A",
    "\u683C\u5F0F\uFF1A`YYYY-MM-DD`\uFF0C\u4F8B\u5982 `2026-06-27`",
    "",
    "\u53D1\u9001\u201C\u53D6\u6D88\u201D\u53EF\u9000\u51FA\u3002"
  ].join("\n");
}
function isDateOnly(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text.trim());
}
async function updateJobProgressMessage(statusMessage, summary) {
  const totalDone = summary.completed + summary.failed + summary.skipped;
  const lines = [
    summary.status === "paused" ? `\u23F8\uFE0F **\u9891\u9053\u4E0B\u8F7D\u5DF2\u6682\u505C**` : summary.status === "cancelled" ? `\u{1F6D1} **\u9891\u9053\u4E0B\u8F7D\u5DF2\u53D6\u6D88**` : totalDone >= summary.totalMediaFound && summary.scanStatus === "done" ? `\u2705 **\u9891\u9053\u4EFB\u52A1\u5B8C\u6210**` : `\u{1F50E} **\u9891\u9053\u4EFB\u52A1\u8FD0\u884C\u4E2D**`,
    `\u{1F194} job: ${summary.jobId.slice(0, 8)}`,
    `\u{1F4CD} \u9891\u9053\uFF1A${summary.source}`,
    ``,
    `\u{1F50E} \u626B\u63CF\uFF1A${summary.scanStatus}`,
    `\u{1F4C4} \u9891\u9053\u6B63\u6587\uFF1A\u5DF2\u626B ${summary.channelMessagesScanned} \u6761\uFF0C\u53D1\u73B0 ${summary.channelMediaFound} \u4E2A\u6587\u4EF6`,
    `\u{1F4AC} \u8BC4\u8BBA\u533A\uFF1A\u5DF2\u626B ${summary.commentMessagesScanned} \u6761\uFF0C\u53D1\u73B0 ${summary.commentMediaFound} \u4E2A\u6587\u4EF6`,
    ``,
    `\u2B07\uFE0F \u4E0B\u8F7D\uFF1A${summary.downloadStatus}`,
    `\u2705 \u6210\u529F ${summary.completed}\u3000\u23F3 \u5F85\u4E0B\u8F7D ${summary.pending}\u3000\u{1F504} \u4E0B\u8F7D\u4E2D ${summary.downloading}\u3000\u274C \u5931\u8D25 ${summary.failed}\u3000\u23ED \u8DF3\u8FC7 ${summary.skipped}`,
    summary.cooldownUntil ? `\u23F3 FloodWait \u51B7\u5374\u5230\uFF1A${summary.cooldownUntil}` : "",
    ``,
    `\u63A7\u5236\uFF1A/task_pause ${summary.jobId.slice(0, 8)} \xB7 /task_resume ${summary.jobId.slice(0, 8)} \xB7 /task_cancel ${summary.jobId.slice(0, 8)}`
  ].filter(Boolean);
  await statusMessage.edit({ text: lines.join("\n") }).catch(() => void 0);
}
async function updateScanStatusMessage(statusMessage, summary) {
  const lines = [
    `\u{1F50E} **\u626B\u63CF\u5B8C\u6210\uFF0C\u5F00\u59CB\u4E0B\u8F7D**`,
    `\u{1F4CD} \u9891\u9053\uFF1A${summary.source}`,
    ``,
    `\u{1F4C4} \u9891\u9053\u6B63\u6587\uFF1A\u626B\u63CF ${summary.channelMessagesScanned} \u6761\uFF0C\u53D1\u73B0 ${summary.channelMediaFound} \u4E2A\u6587\u4EF6`,
    summary.commentsEnabled ? `\u{1F4AC} \u8BC4\u8BBA\u533A\uFF1A\u626B\u63CF ${summary.commentMessagesScanned} \u6761\uFF0C\u53D1\u73B0 ${summary.commentMediaFound} \u4E2A\u6587\u4EF6\uFF08\u6BCF\u5E16\u6700\u591A ${summary.commentsMaxPerPost} \u6761\uFF09` : `\u{1F4AC} \u8BC4\u8BBA\u533A\uFF1A\u672A\u542F\u7528`,
    `\u{1F4E6} \u5F85\u4E0B\u8F7D\uFF1A${summary.totalMediaFound} \u4E2A\u6587\u4EF6`,
    ``,
    `\u23F3 \u6B63\u5728\u52A0\u5165\u4E0B\u8F7D\u961F\u5217\uFF0C\u53EF\u7528 /tasks \u67E5\u770B\u540E\u53F0\u4EFB\u52A1\u3002`
  ];
  await statusMessage.edit({ text: lines.join("\n") }).catch(() => void 0);
}
async function replyWithJobResult(statusMessage, fallbackMessage, promise, kind) {
  promise.then((result) => {
    const commentLine = result.commentMediaFound || result.commentMessagesScanned ? `
\u8BC4\u8BBA\u533A: \u626B\u63CF ${result.commentMessagesScanned || 0} \u6761\uFF0C\u53D1\u73B0 ${result.commentMediaFound || 0} \u4E2A\u6587\u4EF6` : "";
    const text = kind === "tag" ? `\u2705 \u6807\u7B7E\u4E0B\u8F7D\u4EFB\u52A1\u5B8C\u6210
\u6807\u7B7E: ${result.tag}
ID: ${String(result.jobId).slice(0, 8)}
\u5165\u961F: ${result.found}
\u8DF3\u8FC7: ${result.skipped}
\u5931\u8D25: ${result.failed}${commentLine}` : `\u2705 \u65E5\u671F\u8303\u56F4\u4EFB\u52A1\u5B8C\u6210
ID: ${String(result.jobId).slice(0, 8)}
\u5165\u961F: ${result.found}
\u8DF3\u8FC7: ${result.skipped}
\u5931\u8D25: ${result.failed}${commentLine}`;
    statusMessage.edit({ text }).catch(() => fallbackMessage.reply({ message: text }).catch(() => void 0));
  }).catch((error) => {
    const text = `\u274C ${kind === "tag" ? "\u6807\u7B7E" : "\u65E5\u671F"}\u4E0B\u8F7D\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}`;
    statusMessage.edit({ text }).catch(() => fallbackMessage.reply({ message: text }).catch(() => void 0));
  });
}
async function startTelegramWizard(message, senderId, kind) {
  const state = { kind, step: kind === "tg_download" ? "mode" : "source" };
  telegramWizardStates.set(senderId, state);
  if (kind === "tg_sub_manage") {
    const rows = await listTelegramSubscriptions(senderId);
    await message.reply({ message: buildSubscriptionManagePanel(rows), buttons: buildSubscriptionActionKeyboard(rows) });
    return;
  }
  await message.reply({
    message: buildTelegramWizardPrompt(state),
    buttons: kind === "tg_download" ? buildTelegramDownloadModeKeyboard() : void 0
  });
}
async function handleTelegramWizardMessage(message, senderId, text) {
  const state = telegramWizardStates.get(senderId);
  if (!state) return false;
  const input = text.trim();
  if (!input) return true;
  if (isCancelInput(input)) {
    telegramWizardStates.delete(senderId);
    await message.reply({ message: "\u5DF2\u53D6\u6D88 Telegram \u9891\u9053\u64CD\u4F5C\u5411\u5BFC\u3002" });
    return true;
  }
  if (state.step === "mode") {
    const normalizedMode = input.toLowerCase();
    if (["date", "\u65E5\u671F", "\u6309\u65E5\u671F"].includes(normalizedMode)) {
      state.kind = "tg_date";
      state.step = "source";
    } else if (["tag", "\u6807\u7B7E", "\u6309\u6807\u7B7E"].includes(normalizedMode)) {
      state.kind = "tg_tag";
      state.step = "source";
    } else {
      await message.reply({ message: "\u274C \u8BF7\u53D1\u9001 `date`/`\u65E5\u671F` \u6216 `tag`/`\u6807\u7B7E`\uFF0C\u4E5F\u53EF\u4EE5\u53D1\u9001\u201C\u53D6\u6D88\u201D\u9000\u51FA\u3002" });
      return true;
    }
    await message.reply({ message: buildTelegramWizardPrompt(state) });
    return true;
  }
  if (state.step === "source") {
    const sourceParts = input.split(/\s+/).filter(Boolean);
    const commentFlag = sourceParts[sourceParts.length - 1]?.toLowerCase();
    if (["comments", "--comments", "include-comments", "\u8BC4\u8BBA", "\u8BC4\u8BBA\u533A"].includes(commentFlag)) {
      state.includeComments = true;
      state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
      sourceParts.pop();
    } else if (["no-comments", "--no-comments", "channel-only", "\u4EC5\u9891\u9053"].includes(commentFlag)) {
      state.includeComments = false;
      state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
      sourceParts.pop();
    }
    state.source = sourceParts.join(" ") || input;
    if (state.kind === "tg_sub_manage") {
      if (/^\d+$/.test(input)) {
        const rows = await listTelegramSubscriptions(senderId);
        const index = parseInt(input, 10) - 1;
        const target = rows[index];
        if (!target) {
          await message.reply({ message: "\u274C \u6CA1\u6709\u8FD9\u4E2A\u5E8F\u53F7\uFF0C\u8BF7\u56DE\u590D\u5217\u8868\u4E2D\u7684\u5E8F\u53F7\uFF0C\u6216\u53D1\u9001\u9891\u9053\u7528\u6237\u540D/\u94FE\u63A5\u6765\u65B0\u589E\u8BA2\u9605\u3002" });
          return true;
        }
        const sub = await unsubscribeTelegramChannel(senderId, target.id);
        telegramWizardStates.delete(senderId);
        const rowsAfterCancel = await listTelegramSubscriptions(senderId);
        await message.reply({
          message: [
            sub ? `\u2705 \u5DF2\u53D6\u6D88\u8BA2\u9605 ${sub.title || sub.source}` : "\u274C \u672A\u627E\u5230\u8BE5\u8BA2\u9605",
            "",
            buildSubscriptionManagePanel(rowsAfterCancel)
          ].join("\n")
        });
        return true;
      }
      if (!input.startsWith("@") && !/^https?:\/\/t\.me\//i.test(input) && !/^-?\d+$/.test(input)) {
        await message.reply({ message: "\u274C \u8BF7\u56DE\u590D\u8BA2\u9605\u5E8F\u53F7\u6765\u53D6\u6D88\uFF0C\u6216\u53D1\u9001\u9891\u9053\u7528\u6237\u540D/\u94FE\u63A5\u6765\u65B0\u589E\u8BA2\u9605\uFF0C\u4F8B\u5982\uFF1A`@channel_username`\u3002" });
        return true;
      }
      state.step = "path";
      await message.reply({ message: buildTelegramWizardPrompt(state) });
      return true;
    }
    state.step = "path";
    await message.reply({ message: buildTelegramWizardPrompt(state) });
    return true;
  }
  if (state.step === "path") {
    const skipPath = /^(跳过|skip|默认|default|无|不用|不指定)$/i.test(input);
    if (skipPath) {
      delete state.customFolder;
    } else {
      try {
        state.customFolder = await rememberRecentTelegramPathPersistent(message.chatId?.toString() || "unknown", input);
      } catch (error) {
        await message.reply({ message: `\u274C \u8DEF\u5F84\u65E0\u6548\uFF1A${error.message}

\u8BF7\u91CD\u65B0\u53D1\u9001\u76EE\u5F55\uFF0C\u6216\u53D1\u9001\u201C\u8DF3\u8FC7\u201D\u4F7F\u7528\u9ED8\u8BA4\u4FDD\u5B58\u8DEF\u5F84\u89C4\u5219\u3002` });
        return true;
      }
    }
    if (state.kind === "tg_sub_manage") {
      telegramWizardStates.delete(senderId);
      try {
        if (state.subscriptionId) {
          const sub = await updateTelegramSubscriptionFolder(senderId, state.subscriptionId, state.customFolder || null);
          const rowsAfterUpdate = await listTelegramSubscriptions(senderId);
          await message.reply({
            message: [
              sub ? `\u2705 \u5DF2\u66F4\u65B0\u8BA2\u9605\u76EE\u5F55\uFF1A${sub.title || sub.source}` : "\u274C \u672A\u627E\u5230\u8BE5\u8BA2\u9605",
              sub && state.customFolder ? `\u{1F4C1} \u4E13\u5C5E\u76EE\u5F55\uFF1A${state.customFolder}
${buildPathPreviewLine(state.customFolder)}` : "\u{1F4C1} \u4FDD\u5B58\u7B56\u7565\uFF1A\u9ED8\u8BA4\u81EA\u52A8\u5206\u7C7B",
              "",
              buildSubscriptionManagePanel(rowsAfterUpdate)
            ].filter(Boolean).join("\n"),
            buttons: buildSubscriptionActionKeyboard(rowsAfterUpdate)
          });
        } else {
          const sub = await subscribeTelegramChannel(senderId, message.chatId?.toString(), state.source, state.customFolder);
          await message.reply({
            message: [
              `\u2705 \u5DF2\u8BA2\u9605 ${sub.title || sub.source}`,
              `\u{1F4CD} ${sub.source}`,
              state.customFolder ? `\u{1F4C1} \u672C\u8BA2\u9605\u4E13\u5C5E\u4FDD\u5B58\u76EE\u5F55\uFF1A${state.customFolder}
${buildPathPreviewLine(state.customFolder)}` : "\u{1F4C1} \u672C\u8BA2\u9605\u4F7F\u7528\u9ED8\u8BA4\u4FDD\u5B58\u8DEF\u5F84\u89C4\u5219",
              `\u4ECE\u5F53\u524D\u6700\u65B0\u6D88\u606F ID ${sub.last_message_id || 0} \u4E4B\u540E\u5F00\u59CB\u81EA\u52A8\u540C\u6B65\u3002`
            ].join("\n")
          });
        }
      } catch (error) {
        await message.reply({ message: `\u274C \u8BA2\u9605\u64CD\u4F5C\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}` });
      }
      return true;
    }
    if (state.kind === "tg_tag" || state.kind === "tg_date") {
      state.step = state.includeComments !== void 0 ? state.kind === "tg_tag" ? "tag" : "start_date" : "comments";
      await message.reply({ message: buildTelegramWizardPrompt(state), buttons: state.step === "comments" ? buildTelegramCommentsKeyboard() : void 0 });
      return true;
    }
    return true;
  }
  if (state.step === "comments") {
    const enabled = /^(开|开启|是|包含|评论|评论区|yes|y|on|true|1)$/i.test(input);
    const disabled = /^(关|关闭|否|不包含|仅频道|no|n|off|false|0)$/i.test(input);
    if (!enabled && !disabled) {
      await message.reply({ message: "\u274C \u8BF7\u53D1\u9001 `\u5F00`/`\u5173`\uFF0C\u6216\u70B9\u51FB\u6309\u94AE\u9009\u62E9\u662F\u5426\u5305\u542B\u8BC4\u8BBA\u533A\u6587\u4EF6\u3002" });
      return true;
    }
    state.includeComments = enabled;
    state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
    state.step = state.kind === "tg_tag" ? "tag" : "start_date";
    await message.reply({ message: buildTelegramWizardPrompt(state) });
    return true;
  }
  if (state.step === "tag") {
    telegramWizardStates.delete(senderId);
    try {
      const queuedMsg = await message.reply({ message: `\u23F3 \u5DF2\u5F00\u59CB\u540E\u53F0\u626B\u63CF ${state.source} \u4E2D\u5E26\u6709 ${input.startsWith("#") ? input : `#${input}`} \u7684\u5A92\u4F53\u6D88\u606F...
\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u66F4\u65B0\u7ED3\u679C\uFF0C\u53EF\u7528 /tasks \u67E5\u770B\u540E\u53F0\u4EFB\u52A1\u3002` });
      await replyWithJobResult(queuedMsg, message, enqueueTelegramTagDownload(client, message, senderId, state.source, input, state.customFolder, {
        includeComments: Boolean(state.includeComments),
        commentsMaxPerPost: state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
        onScanComplete: (summary) => updateScanStatusMessage(queuedMsg, summary),
        onProgress: (summary) => updateJobProgressMessage(queuedMsg, summary)
      }), "tag");
    } catch (error) {
      await message.reply({ message: `\u274C \u6807\u7B7E\u4E0B\u8F7D\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}` });
    }
    return true;
  }
  if (state.step === "start_date") {
    if (!isDateOnly(input)) {
      await message.reply({ message: "\u274C \u65E5\u671F\u683C\u5F0F\u5FC5\u987B\u662F YYYY-MM-DD\uFF0C\u4F8B\u5982\uFF1A2026-06-01" });
      return true;
    }
    state.startDate = input;
    state.step = "end_date";
    await message.reply({ message: buildTelegramWizardPrompt(state) });
    return true;
  }
  if (!isDateOnly(input)) {
    await message.reply({ message: "\u274C \u65E5\u671F\u683C\u5F0F\u5FC5\u987B\u662F YYYY-MM-DD\uFF0C\u4F8B\u5982\uFF1A2026-06-27" });
    return true;
  }
  telegramWizardStates.delete(senderId);
  try {
    const queuedMsg = await message.reply({ message: `\u23F3 \u5DF2\u5F00\u59CB\u540E\u53F0\u626B\u63CF ${state.source}\uFF1A${state.startDate} \u2192 ${input}...
\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u66F4\u65B0\u7ED3\u679C\uFF0C\u53EF\u7528 /tasks \u67E5\u770B\u540E\u53F0\u4EFB\u52A1\u3002` });
    await replyWithJobResult(queuedMsg, message, enqueueTelegramDateDownload(client, message, senderId, state.source, state.startDate, input, state.customFolder, {
      includeComments: Boolean(state.includeComments),
      commentsMaxPerPost: state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
      onScanComplete: (summary) => updateScanStatusMessage(queuedMsg, summary),
      onProgress: (summary) => updateJobProgressMessage(queuedMsg, summary)
    }), "date");
  } catch (error) {
    await message.reply({ message: `\u274C \u65E5\u671F\u4E0B\u8F7D\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}` });
  }
  return true;
}
function buildSubscriptionActionKeyboard(rows) {
  if (rows.length === 0) return void 0;
  return new Api6.ReplyInlineMarkup({
    rows: rows.slice(0, 8).flatMap((row, index) => [
      new Api6.KeyboardButtonRow({
        buttons: [new Api6.KeyboardButtonCallback({ text: `${index + 1}. ${row.title || row.source}`, data: Buffer.from(`tsub_view_${row.id}`) })]
      }),
      new Api6.KeyboardButtonRow({
        buttons: [
          new Api6.KeyboardButtonCallback({ text: "\u270F\uFE0F \u4FEE\u6539\u4E13\u5C5E\u76EE\u5F55", data: Buffer.from(`tsub_folder_${row.id}`) }),
          new Api6.KeyboardButtonCallback({ text: "\u{1F9F9} \u6E05\u9664\u76EE\u5F55", data: Buffer.from(`tsub_clear_${row.id}`) }),
          new Api6.KeyboardButtonCallback({ text: "\u53D6\u6D88\u8BA2\u9605", data: Buffer.from(`tsub_cancel_${row.id}`) })
        ]
      })
    ])
  });
}
function buildSubscriptionManagePanel(rows) {
  return [
    "\u{1F4E1} **\u9891\u9053\u8BA2\u9605\u7BA1\u7406**",
    "",
    rows.length > 0 ? rows.map((row, index) => [
      `${index + 1}. ${row.enabled ? "\u2705" : "\u23F8\uFE0F"} ${row.title || row.source}`,
      `   ${row.source} \xB7 last_id=${row.last_message_id || 0}`,
      row.folder_override ? `   \u{1F4C1} \u4E13\u5C5E\u76EE\u5F55\uFF1A${row.folder_override}` : "   \u{1F4C1} \u4FDD\u5B58\u7B56\u7565\uFF1A\u9ED8\u8BA4\u81EA\u52A8\u5206\u7C7B"
    ].join("\n")).join("\n") : "\u5F53\u524D\u6CA1\u6709\u542F\u7528\u4E2D\u7684\u8BA2\u9605\u3002",
    "",
    rows.length > 0 ? "\u53EF\u76F4\u63A5\u70B9\u51FB\u8BA2\u9605\u4E0B\u65B9\u6309\u94AE\u4FEE\u6539/\u6E05\u9664\u4E13\u5C5E\u76EE\u5F55\u6216\u53D6\u6D88\u8BA2\u9605\u3002" : "\u56DE\u590D\u9891\u9053\u7528\u6237\u540D\u6216\u94FE\u63A5\u53EF\u65B0\u589E\u8BA2\u9605\u3002",
    "\u56DE\u590D\u9891\u9053\u7528\u6237\u540D\u6216\u94FE\u63A5\u4E5F\u53EF\u65B0\u589E\u8BA2\u9605\u3002",
    "\u4F8B\u5982\uFF1A`@channel_username` \u6216 `https://t.me/channel_username`",
    "",
    "\u65B0\u589E\u8BA2\u9605\u65F6\u4F1A\u8BE2\u95EE\u662F\u5426\u4E3A\u672C\u8BA2\u9605\u5355\u72EC\u6307\u5B9A\u4FDD\u5B58\u76EE\u5F55\uFF1B\u8BE5\u76EE\u5F55\u53EA\u5F71\u54CD\u8FD9\u4E2A\u8BA2\u9605\uFF0C\u4E0D\u4F1A\u6539\u53D8\u5168\u5C40 /path_rules\u3002",
    "",
    "\u53D1\u9001\u201C\u53D6\u6D88\u201D\u53EF\u9000\u51FA\u3002"
  ].join("\n");
}
function formatSubscriptionList(rows) {
  if (rows.length === 0) return "\u{1F4ED} \u6682\u65E0\u9891\u9053\u8BA2\u9605\u3002\n\n\u4F7F\u7528 `/tg_sub @\u9891\u9053` \u6DFB\u52A0\u8BA2\u9605\u3002";
  return [
    "\u{1F4E1} **\u9891\u9053\u8BA2\u9605**",
    "",
    ...rows.map((row, index) => [
      `${index + 1}. ${row.enabled ? "\u2705" : "\u23F8\uFE0F"} ${row.title || row.source}`,
      `   ${row.source} \xB7 last_id=${row.last_message_id || 0}`,
      row.folder_override ? `   \u{1F4C1} \u4E13\u5C5E\u76EE\u5F55\uFF1A${row.folder_override}` : "   \u{1F4C1} \u4FDD\u5B58\u7B56\u7565\uFF1A\u9ED8\u8BA4\u81EA\u52A8\u5206\u7C7B",
      `   ID: ${String(row.id).slice(0, 8)}`
    ].join("\n"))
  ].join("\n");
}
function generatePasswordKeyboard(currentLength) {
  const display = "\u25CF".repeat(currentLength) + "-".repeat(Math.max(0, 4 - currentLength));
  const displayWithSpaces = display.split("").join(" ");
  return new Api6.ReplyInlineMarkup({
    rows: [
      new Api6.KeyboardButtonRow({
        buttons: [
          new Api6.KeyboardButtonCallback({ text: `\u{1F512}  ${displayWithSpaces}`, data: Buffer.from("pwd_display") })
        ]
      }),
      new Api6.KeyboardButtonRow({
        buttons: [
          new Api6.KeyboardButtonCallback({ text: "1", data: Buffer.from("pwd_1") }),
          new Api6.KeyboardButtonCallback({ text: "2", data: Buffer.from("pwd_2") }),
          new Api6.KeyboardButtonCallback({ text: "3", data: Buffer.from("pwd_3") })
        ]
      }),
      new Api6.KeyboardButtonRow({
        buttons: [
          new Api6.KeyboardButtonCallback({ text: "4", data: Buffer.from("pwd_4") }),
          new Api6.KeyboardButtonCallback({ text: "5", data: Buffer.from("pwd_5") }),
          new Api6.KeyboardButtonCallback({ text: "6", data: Buffer.from("pwd_6") })
        ]
      }),
      new Api6.KeyboardButtonRow({
        buttons: [
          new Api6.KeyboardButtonCallback({ text: "7", data: Buffer.from("pwd_7") }),
          new Api6.KeyboardButtonCallback({ text: "8", data: Buffer.from("pwd_8") }),
          new Api6.KeyboardButtonCallback({ text: "9", data: Buffer.from("pwd_9") })
        ]
      }),
      new Api6.KeyboardButtonRow({
        buttons: [
          new Api6.KeyboardButtonCallback({ text: "\u53D6\u6D88", data: Buffer.from("pwd_clear") }),
          new Api6.KeyboardButtonCallback({ text: "0", data: Buffer.from("pwd_0") }),
          new Api6.KeyboardButtonCallback({ text: "\u232B", data: Buffer.from("pwd_backspace") })
        ]
      })
    ]
  });
}
async function handlePasswordCallback(update) {
  if (!client) return;
  const userId = update.userId.toJSNumber();
  const data = Buffer.from(update.data || []).toString("utf-8");
  if (!data.startsWith("pwd_")) return;
  const lockSeconds = getPinLockSeconds(userId);
  if (lockSeconds > 0) {
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: `\u5BC6\u7801\u9519\u8BEF\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7 ${lockSeconds} \u79D2\u540E\u518D\u8BD5`,
      alert: true
    }));
    return;
  }
  let state = passwordInputState.get(userId);
  if (!state) {
    state = { password: "" };
    passwordInputState.set(userId, state);
  }
  try {
    if (data === "pwd_display") {
      await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
      return;
    }
    if (data === "pwd_backspace") {
      state.password = state.password.slice(0, -1);
    } else if (data === "pwd_clear") {
      state.password = "";
      passwordInputState.delete(userId);
      await client.editMessage(update.peer, {
        message: update.msgId,
        text: MSG.AUTH_CANCELLED
      });
      await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
      return;
    } else {
      const digit = data.replace("pwd_", "");
      if (/^[0-9]$/.test(digit)) {
        state.password = (state.password + digit).slice(0, TELEGRAM_PIN_REQUIRED_LENGTH);
        if (state.password.length >= TELEGRAM_PIN_REQUIRED_LENGTH) {
          const pinOk = await verifyTelegramPin(state.password);
          if (!pinOk) {
            state.password = "";
            const failure = recordPinFailure(userId);
            const text = failure.locked ? `\u274C \u5BC6\u7801\u9519\u8BEF\u6B21\u6570\u8FC7\u591A\uFF0C\u5DF2\u4E34\u65F6\u9501\u5B9A ${failure.retryAfterSeconds} \u79D2\u3002` : MSG.AUTH_WRONG;
            await client.editMessage(update.peer, {
              message: update.msgId,
              text,
              buttons: generatePasswordKeyboard(0)
            });
            await client.invoke(new Api6.messages.SetBotCallbackAnswer({
              queryId: update.queryId,
              message: failure.locked ? "\u5DF2\u4E34\u65F6\u9501\u5B9A" : "\u5BC6\u7801\u9519\u8BEF",
              alert: failure.locked
            }));
            return;
          }
          const allowedUsers = await getConfiguredTelegramAllowedUsers();
          if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
            state.password = "";
            await client.editMessage(update.peer, {
              message: update.msgId,
              text: "\u26D4 \u5F53\u524D Telegram \u7528\u6237\u4E0D\u5728\u5141\u8BB8\u5217\u8868\u4E2D\uFF0C\u8BF7\u5728 TELEGRAM_ALLOWED_USER_IDS \u6216\u540E\u53F0\u5141\u8BB8\u5217\u8868\u4E2D\u52A0\u5165\u4F60\u7684 user id\u3002",
              buttons: generatePasswordKeyboard(0)
            });
            await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u672A\u5728\u5141\u8BB8\u5217\u8868\u4E2D", alert: true }));
            return;
          }
          clearPinFailures(userId);
          passwordInputState.delete(userId);
          if (await is2FAEnabled()) {
            userStates.set(userId, {
              state: "WAITING_2FA_LOGIN" /* WAITING_2FA_LOGIN */,
              promptMessageId: update.msgId
            });
            await client.editMessage(update.peer, {
              message: update.msgId,
              text: MSG.AUTH_2FA_PROMPT
            });
            await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_2FA_TOAST }));
            return;
          }
          await persistAuthenticatedUser(userId);
          await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildAuthSuccess()
          });
          await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_SUCCESS }));
          return;
        }
      }
    }
    await client.editMessage(update.peer, {
      message: update.msgId,
      text: MSG.AUTH_INPUT_PROMPT,
      buttons: generatePasswordKeyboard(state.password.length)
    });
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
  } catch (error) {
    console.error("\u{1F916} \u5904\u7406\u5BC6\u7801\u56DE\u8C03\u5931\u8D25:", error);
    try {
      await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
    } catch (e) {
    }
  }
}
async function handleCleanupButtonCallback(update, cleanupId) {
  if (!client) return;
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  try {
    const result = await handleCleanupCallback(cleanupId);
    try {
      await client.editMessage(update.peer, {
        message: update.msgId,
        text: result.message
      });
    } catch (e) {
      console.error("\u{1F916} \u66F4\u65B0\u6E05\u7406\u7ED3\u679C\u6D88\u606F\u5931\u8D25:", e);
    }
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: result.success ? "\u2705 \u6E05\u7406\u6210\u529F" : "\u274C \u6E05\u7406\u5931\u8D25"
    }));
  } catch (error) {
    console.error("\u{1F916} \u5904\u7406\u6E05\u7406\u56DE\u8C03\u5931\u8D25:", error);
    try {
      await client.invoke(new Api6.messages.SetBotCallbackAnswer({
        queryId: update.queryId,
        message: "\u274C \u6E05\u7406\u5931\u8D25"
      }));
    } catch (e) {
    }
  }
}
async function handleTaskQueueCallback(update, data) {
  if (!client) return;
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: MSG.AUTH_REQUIRED,
      alert: true
    }));
    return;
  }
  const match = data.match(/^tq_(pause|resume|cancel)_(.+)$/);
  if (!match) return;
  const [, action, taskId] = match;
  const controlChatId = resolveTaskChatIdForControl(taskId);
  if (!controlChatId || !canControlTask(taskId, controlChatId, userId)) {
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: "\u4EFB\u52A1\u5DF2\u5B8C\u6210\u3001\u5DF2\u5931\u6548\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u804A\u5929",
      alert: true
    }));
    return;
  }
  try {
    if (action === "pause") {
      pauseDownloadTasks(taskId);
      await refreshSilentProgress(client, update.peer);
      await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u6682\u505C\u5168\u5C40\u4E0B\u8F7D\u961F\u5217" }));
      return;
    }
    if (action === "resume") {
      resumeDownloadTasks(taskId);
      await refreshSilentProgress(client, update.peer);
      await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u7EE7\u7EED\u5168\u5C40\u4E0B\u8F7D\u961F\u5217" }));
      return;
    }
    await cancelSilentTask(client, update.peer, taskId, update.msgId, userId);
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u53D6\u6D88\u540E\u53F0\u4EFB\u52A1", alert: true }));
  } catch (error) {
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: `\u64CD\u4F5C\u5931\u8D25: ${error.message}`,
      alert: true
    }));
  }
}
async function handleTelegramDownloadModeCallback(update, data) {
  if (!client) return;
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  if (data === "tgd_cancel") {
    telegramWizardStates.delete(userId);
    await client.editMessage(update.peer, { message: update.msgId, text: "\u5DF2\u53D6\u6D88\u9891\u9053\u6587\u4EF6\u4E0B\u8F7D\u5411\u5BFC\u3002" });
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u53D6\u6D88" }));
    return;
  }
  const state = telegramWizardStates.get(userId) || { kind: "tg_download", step: "mode" };
  if (data === "tgd_mode_date") {
    state.kind = "tg_date";
    state.step = "source";
    telegramWizardStates.set(userId, state);
    await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state) });
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u6309\u65E5\u671F\u4E0B\u8F7D" }));
    return;
  }
  if (data === "tgd_mode_tag") {
    state.kind = "tg_tag";
    state.step = "source";
    telegramWizardStates.set(userId, state);
    await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state) });
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u6309\u6807\u7B7E\u4E0B\u8F7D" }));
    return;
  }
  if (data === "tgd_comments_on" || data === "tgd_comments_off") {
    state.includeComments = data === "tgd_comments_on";
    state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
    state.step = state.kind === "tg_tag" ? "tag" : "start_date";
    telegramWizardStates.set(userId, state);
    await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state) });
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: state.includeComments ? "\u5C06\u5305\u542B\u8BC4\u8BBA\u533A\u6587\u4EF6" : "\u4EC5\u4E0B\u8F7D\u9891\u9053\u6B63\u6587\u6587\u4EF6"
    }));
    return;
  }
}
async function handleTelegramSubscriptionCallback(update, data) {
  if (!client) return;
  const userId = update.userId.toJSNumber();
  if (!await isAuthenticatedAsync(userId)) {
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
    return;
  }
  const match = data.match(/^tsub_(view|folder|clear|cancel)_(.+)$/);
  if (!match) return;
  const [, action, id] = match;
  const rows = await listTelegramSubscriptions(userId);
  const target = rows.find((row) => String(row.id) === id);
  if (!target) {
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u8BA2\u9605\u4E0D\u5B58\u5728\u6216\u5DF2\u53D6\u6D88", alert: true }));
    return;
  }
  if (action === "view") {
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({
      queryId: update.queryId,
      message: target.folder_override ? `\u4E13\u5C5E\u76EE\u5F55\uFF1A${target.folder_override}` : "\u5F53\u524D\u4F7F\u7528\u9ED8\u8BA4\u4FDD\u5B58\u8DEF\u5F84",
      alert: true
    }));
    return;
  }
  if (action === "folder") {
    const state = {
      kind: "tg_sub_manage",
      step: "path",
      source: target.source,
      subscriptionId: target.id,
      subscriptionTitle: target.title,
      subscriptionSource: target.source
    };
    telegramWizardStates.set(userId, state);
    await client.sendMessage(update.peer, { message: buildTelegramWizardPrompt(state) });
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u8BF7\u53D1\u9001\u65B0\u7684\u4E13\u5C5E\u76EE\u5F55" }));
    return;
  }
  if (action === "clear") {
    await updateTelegramSubscriptionFolder(userId, id, null);
    const rowsAfterClear = await listTelegramSubscriptions(userId);
    await client.editMessage(update.peer, {
      message: update.msgId,
      text: buildSubscriptionManagePanel(rowsAfterClear),
      buttons: buildSubscriptionActionKeyboard(rowsAfterClear)
    });
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u6E05\u9664\u4E13\u5C5E\u76EE\u5F55" }));
    return;
  }
  if (action === "cancel") {
    await unsubscribeTelegramChannel(userId, id);
    const rowsAfterCancel = await listTelegramSubscriptions(userId);
    await client.editMessage(update.peer, {
      message: update.msgId,
      text: buildSubscriptionManagePanel(rowsAfterCancel),
      buttons: buildSubscriptionActionKeyboard(rowsAfterCancel)
    });
    await client.invoke(new Api6.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: "\u5DF2\u53D6\u6D88\u8BA2\u9605", alert: true }));
  }
}
async function initTelegramBot() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || "0");
  const apiHash = process.env.TELEGRAM_API_HASH || "";
  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!apiId || !apiHash || !botToken) {
    console.log("\u26A0\uFE0F \u672A\u914D\u7F6E Telegram API \u51ED\u8BC1\uFF0CBot \u672A\u542F\u52A8");
    console.log("   \u9700\u8981\u8BBE\u7F6E: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_BOT_TOKEN");
    return;
  }
  try {
    console.log("\u{1F916} Telegram Bot \u6B63\u5728\u540C\u6B65\u5B58\u50A8\u914D\u7F6E...");
    await storageManager.init();
    const provider = storageManager.getProvider();
    console.log(`\u{1F916} Telegram Bot \u5F53\u524D\u5B58\u50A8\u63D0\u4F9B\u5546: ${provider.name}`);
  } catch (e) {
    console.error("\u{1F916} Telegram Bot \u540C\u6B65\u5B58\u50A8\u914D\u7F6E\u5931\u8D25:", e);
  }
  try {
    const sessionDir = path15.dirname(SESSION_FILE);
    if (!fs11.existsSync(sessionDir)) {
      fs11.mkdirSync(sessionDir, { recursive: true, mode: 448 });
    }
    let sessionString = "";
    if (fs11.existsSync(SESSION_FILE)) {
      sessionString = fs11.readFileSync(SESSION_FILE, "utf-8").trim();
    }
    const session = new StringSession2(sessionString);
    client = new TelegramClient4(session, apiId, apiHash, {
      connectionRetries: 15,
      retryDelay: 2e3,
      useWSS: false,
      deviceModel: "TG Vault Bot",
      systemVersion: "1.0.0",
      appVersion: "1.0.0",
      floodSleepThreshold: 120
    });
    console.log("\u{1F916} Telegram Bot \u6B63\u5728\u542F\u52A8...");
    await client.start({
      botAuthToken: botToken
    });
    const newSession = client.session.save();
    fs11.writeFileSync(SESSION_FILE, newSession, { mode: 384 });
    try {
      fs11.chmodSync(SESSION_FILE, 384);
    } catch (e) {
      console.warn("\u{1F916} \u4FEE\u6B63 Telegram Bot session \u6587\u4EF6\u6743\u9650\u5931\u8D25:", e);
    }
    console.log("\u{1F916} Telegram Bot \u5DF2\u8FDE\u63A5!");
    try {
      await query(`
                CREATE TABLE IF NOT EXISTS telegram_auth (
                    user_id BIGINT PRIMARY KEY,
                    authenticated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
      await loadAuthenticatedUsers();
    } catch (e) {
      console.error("\u{1F916} \u521D\u59CB\u5316 Telegram \u8BA4\u8BC1\u8868\u5931\u8D25:", e);
    }
    try {
      await client.invoke(new Api6.bots.SetBotCommands({
        scope: new Api6.BotCommandScopeDefault(),
        langCode: "zh",
        commands: [
          new Api6.BotCommand({ command: "start", description: "\u5F00\u59CB\u4F7F\u7528 / \u9A8C\u8BC1\u8EAB\u4EFD" }),
          new Api6.BotCommand({ command: "path_rules", description: "\u4FDD\u5B58\u8DEF\u5F84/\u81EA\u5B9A\u4E49\u76EE\u5F55" }),
          new Api6.BotCommand({ command: "tg_sub", description: "\u8BA2\u9605\u9891\u9053\u81EA\u52A8\u540C\u6B65" }),
          new Api6.BotCommand({ command: "tg_download", description: "\u6309\u65E5\u671F/\u6807\u7B7E\u4E0B\u8F7D\u9891\u9053\u6587\u4EF6" }),
          new Api6.BotCommand({ command: "storage_switch", description: "\u5207\u6362\u5DF2\u914D\u7F6E\u5B58\u50A8\u6E90" }),
          new Api6.BotCommand({ command: "download_workers", description: "\u8BBE\u7F6E\u5355\u6587\u4EF6\u5206\u7247\u5E76\u53D1" }),
          new Api6.BotCommand({ command: "file_concurrency", description: "\u8BBE\u7F6E\u540C\u65F6\u4E0B\u8F7D\u6587\u4EF6\u6570" }),
          new Api6.BotCommand({ command: "duplicate_mode", description: "\u8BBE\u7F6E\u91CD\u590D\u6587\u4EF6\u5904\u7406" }),
          new Api6.BotCommand({ command: "cleanup_settings", description: "\u8BBE\u7F6E\u81EA\u52A8\u6E05\u7406\u5F00\u5173" }),
          new Api6.BotCommand({ command: "storage", description: "\u67E5\u770B\u5B58\u50A8\u7EDF\u8BA1/\u6E05\u7406\u672C\u5730\u6587\u4EF6" }),
          new Api6.BotCommand({ command: "tasks", description: "\u67E5\u770B\u4EFB\u52A1\u72B6\u6001" }),
          new Api6.BotCommand({ command: "setup_2fa", description: "\u914D\u7F6E\u53CC\u91CD\u9A8C\u8BC1 (2FA)" }),
          new Api6.BotCommand({ command: "ytdlp", description: "\u89E3\u6790\u5E76\u4E0B\u8F7D\u94FE\u63A5\u5230\u5B58\u50A8\u6E90" }),
          new Api6.BotCommand({ command: "help", description: "\u663E\u793A\u9884\u89C8\u5E2E\u52A9" })
        ]
      }));
      console.log("\u{1F916} Bot \u547D\u4EE4\u83DC\u5355\u5DF2\u66F4\u65B0");
    } catch (e) {
      console.error("\u{1F916} \u66F4\u65B0 Bot \u547D\u4EE4\u83DC\u5355\u5931\u8D25:", e);
    }
    try {
      const cleanupSetting = await query("SELECT value FROM system_settings WHERE key = $1", ["auto_cleanup_orphans"]);
      if (cleanupSetting.rows[0]?.value !== void 0) {
        process.env.AUTO_CLEANUP_ORPHANS = String(cleanupSetting.rows[0].value);
      }
    } catch (e) {
      console.warn("\u{1F9F9} \u8BFB\u53D6\u81EA\u52A8\u6E05\u7406\u8BBE\u7F6E\u5931\u8D25\uFF0C\u4F7F\u7528\u73AF\u5883\u53D8\u91CF\u9ED8\u8BA4\u503C:", e);
    }
    try {
      const fileConcurrency = await loadFileDownloadConcurrencySetting();
      console.log(`\u{1F916} Telegram \u6587\u4EF6\u7EA7\u5E76\u53D1: ${fileConcurrency}`);
    } catch (e) {
      console.warn("\u{1F916} \u8BFB\u53D6\u6587\u4EF6\u7EA7\u5E76\u53D1\u8BBE\u7F6E\u5931\u8D25\uFF0C\u4F7F\u7528\u73AF\u5883\u53D8\u91CF\u9ED8\u8BA4\u503C:", e);
    }
    if (isAutoCleanupEnabled()) {
      try {
        const stats = await cleanupOrphanFiles();
        if (stats.deletedCount > 0) {
          console.log(`\u{1F9F9} \u542F\u52A8\u6E05\u7406: \u5220\u9664\u4E86 ${stats.deletedCount} \u4E2A\u5B64\u513F\u6587\u4EF6\uFF0C\u91CA\u653E ${stats.freedSpace}`);
          for (const userId of authenticatedUsers.keys()) {
            try {
              await client.sendMessage(userId, {
                message: buildCleanupNotice(stats.deletedCount, stats.freedSpace)
              });
            } catch (e) {
            }
          }
        }
      } catch (e) {
        console.error("\u{1F9F9} \u542F\u52A8\u6E05\u7406\u5931\u8D25:", e);
      }
    } else {
      console.log("\u{1F9F9} \u542F\u52A8\u5B64\u513F\u6E05\u7406\u5DF2\u8DF3\u8FC7\uFF1AAUTO_CLEANUP_ORPHANS=false");
    }
    startPeriodicCleanup();
    startTelegramSubscriptionWorker(client);
    startTelegramJobRecoveryWorker(client);
    client.addEventHandler(async (event) => {
      if (!client) return;
      try {
        const message = event.message;
        if (message.out) return;
        if (!message.text && !message.media) return;
        const senderId = message.senderId?.toJSNumber();
        if (!senderId) return;
        const messageAge = Date.now() / 1e3 - message.date;
        if (messageAge > 300) {
          console.log(`\u{1F916} \u8DF3\u8FC7\u8FC7\u65E7\u6D88\u606F (${Math.round(messageAge)}s ago, id=${message.id})`);
          return;
        }
        const text = message.text || "";
        const chatId = message.chatId;
        if (!chatId) return;
        const rateLimit4 = consumeTelegramRateLimit(senderId, text);
        if (rateLimit4.limited) {
          await message.reply({ message: `\u23F3 \u64CD\u4F5C\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 ${rateLimit4.retryAfterSeconds} \u79D2\u540E\u518D\u8BD5\u3002` });
          return;
        }
        console.log(`\u{1F916} Received text from ${senderId}: ${text}`);
        if (text === "/start") {
          await handleStart(message, senderId);
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({
              message: buildStartPrompt(),
              buttons: generatePasswordKeyboard(0)
            });
          }
          return;
        }
        if (text === "/setup_2fa" || text === "/setup-2fa") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          try {
            const qrDataUrl = await generateOTPAuthUrl();
            const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
            const buffer = Buffer.from(base64Data, "base64");
            const tempPath = path15.join(process.cwd(), `temp_qr_${senderId}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
            fs11.writeFileSync(tempPath, buffer);
            const qrMessage = await client.sendFile(chatId, {
              file: tempPath,
              caption: build2FASetupCaption()
            });
            userStates.set(senderId, {
              state: "WAITING_2FA_SETUP" /* WAITING_2FA_SETUP */,
              qrMessageId: qrMessage.id
            });
            fs11.unlinkSync(tempPath);
          } catch (e) {
            console.error("\u751F\u6210 2FA \u4E8C\u7EF4\u7801\u5931\u8D25:", e);
            await client.sendMessage(chatId, { message: MSG.AUTH_2FA_QR_FAIL });
          }
          return;
        }
        if (text === "/help") {
          await handleHelp(message);
          return;
        }
        {
          const match = text.match(/^\s*\/ytdlp(?:@\w+)?(?:\s+([\s\S]*))?\s*$/i);
          if (match) {
            console.log(`\u{1F916} /ytdlp command received from ${senderId}: ${text}`);
            if (!await isAuthenticatedAsync(senderId)) {
              await message.reply({ message: MSG.AUTH_REQUIRED });
              return;
            }
            const argsText = (match[1] || "").trim();
            if (!argsText) {
              await message.reply({ message: "\u274C \u7528\u6CD5: /ytdlp <url>" });
              return;
            }
            const parts = argsText.split(/\s+/).filter(Boolean);
            if (parts.length !== 1) {
              await message.reply({ message: "\u274C \u53EA\u5141\u8BB8\u4E00\u4E2A\u94FE\u63A5\n\n\u7528\u6CD5: /ytdlp <url>" });
              return;
            }
            const url = parts[0];
            try {
              await assertPublicHttpUrl(url);
            } catch (error) {
              await message.reply({ message: `\u274C \u65E0\u6548\u94FE\u63A5\uFF1A${error instanceof Error ? error.message : "\u4E0D\u5141\u8BB8\u8BBF\u95EE\u8BE5\u5730\u5740"}` });
              return;
            }
            await handleYtDlpCommand(message, url);
            return;
          }
        }
        if (text === "/tg_sub" || text === "/tg_subscribe") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await startTelegramWizard(message, senderId, "tg_sub_manage");
          return;
        }
        if (text === "/tg_download" || text === "/tg_dl") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await startTelegramWizard(message, senderId, "tg_download");
          return;
        }
        if (text === "/tg_date") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await startTelegramWizard(message, senderId, "tg_date");
          return;
        }
        if (text === "/tg_tag") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await startTelegramWizard(message, senderId, "tg_tag");
          return;
        }
        if (!text.startsWith("/")) {
          if (isCancelInput(text)) {
            const pendingMode = getPendingTelegramPathInput(chatId.toString(), senderId);
            if (pendingMode) {
              clearPendingTelegramPathInput(chatId.toString(), senderId);
              await message.reply({ message: "\u5DF2\u53D6\u6D88\u4FDD\u5B58\u8DEF\u5F84\u8BBE\u7F6E\u3002" });
              return;
            }
          } else {
            try {
              const appliedPath = await applyPendingTelegramPathInputPersistent(chatId.toString(), senderId, text);
              if (appliedPath) {
                await message.reply({
                  message: appliedPath.mode === "once" ? `\u{1F4CC} \u5DF2\u8BBE\u7F6E\u4E0B\u4E00\u6B21\u4E0B\u8F7D\u76EE\u5F55\uFF1A\`${appliedPath.folder}\`
${buildPathPreviewLine(appliedPath.folder)}

\u6B64\u8BBE\u7F6E\u4F1A\u5728\u4E0B\u4E00\u6B21\u6210\u529F\u8FDB\u5165\u4E0B\u8F7D\u6D41\u7A0B\u65F6\u81EA\u52A8\u5931\u6548\u3002` : `\u{1F4CD} \u5DF2\u8BBE\u7F6E\u672C\u4F1A\u8BDD\u4E0B\u8F7D\u76EE\u5F55\uFF1A\`${appliedPath.folder}\`
${buildPathPreviewLine(appliedPath.folder)}

\u540E\u7EED\u6B64\u804A\u5929\u4E2D\u7684\u4E0B\u8F7D\u4F1A\u4F18\u5148\u4FDD\u5B58\u5230\u8BE5\u76EE\u5F55\uFF0C\u53D1\u9001 /pc \u53EF\u6E05\u9664\u3002`
                });
                return;
              }
            } catch (error) {
              await message.reply({ message: `\u274C \u8DEF\u5F84\u65E0\u6548\uFF1A${error.message}

\u8BF7\u91CD\u65B0\u53D1\u9001\u76EE\u5F55\uFF0C\u6216\u53D1\u9001\u201C\u53D6\u6D88\u201D\u9000\u51FA\u672C\u6B21\u8BBE\u7F6E\u3002` });
              return;
            }
          }
          const handledTelegramWizard = await handleTelegramWizardMessage(message, senderId, text);
          if (handledTelegramWizard) return;
        }
        if (text === "/tg_subs" || text === "/tg_subscriptions") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          const rows = await listTelegramSubscriptions(senderId);
          await message.reply({ message: formatSubscriptionList(rows) });
          return;
        }
        if (text.startsWith("/tg_sub ") || text.startsWith("/tg_subscribe ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          const source = text.split(/\s+/).slice(1).join(" ").trim();
          if (!source) {
            await message.reply({ message: "\u274C \u7528\u6CD5\uFF1A/tg_sub @\u9891\u9053" });
            return;
          }
          try {
            const sub = await subscribeTelegramChannel(senderId, chatId.toString(), source, null);
            await message.reply({ message: `\u2705 \u5DF2\u8BA2\u9605 ${sub.title || sub.source}
\u{1F4CD} ${sub.source}
\u4ECE\u5F53\u524D\u6700\u65B0\u6D88\u606F ID ${sub.last_message_id || 0} \u4E4B\u540E\u5F00\u59CB\u81EA\u52A8\u540C\u6B65\u3002` });
          } catch (error) {
            await message.reply({ message: `\u274C \u8BA2\u9605\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}` });
          }
          return;
        }
        if (text.startsWith("/tg_unsub ") || text.startsWith("/tg_unsubscribe ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          const selector = text.split(/\s+/).slice(1).join(" ").trim();
          if (!selector) {
            await message.reply({ message: "\u274C \u7528\u6CD5\uFF1A/tg_unsub @\u9891\u9053 \u6216 /tg_unsub <\u8BA2\u9605ID\u524D\u7F00>" });
            return;
          }
          const sub = await unsubscribeTelegramChannel(senderId, selector);
          await message.reply({ message: sub ? `\u2705 \u5DF2\u53D6\u6D88\u8BA2\u9605 ${sub.title || sub.source}` : "\u274C \u672A\u627E\u5230\u8BE5\u8BA2\u9605" });
          return;
        }
        if (text.startsWith("/tg_download ") || text.startsWith("/tg_dl ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          const parts = text.split(/\s+/).slice(1);
          const mode = (parts.shift() || "").toLowerCase();
          if (mode === "date" || mode === "\u65E5\u671F") {
            if (parts.length !== 3) {
              await message.reply({ message: "\u274C \u7528\u6CD5\uFF1A/tg_download date @\u9891\u9053 YYYY-MM-DD YYYY-MM-DD" });
              return;
            }
            try {
              const queuedMsg = await message.reply({ message: `\u23F3 \u5DF2\u5F00\u59CB\u540E\u53F0\u626B\u63CF ${parts[0]}\uFF1A${parts[1]} \u2192 ${parts[2]}...
\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u66F4\u65B0\u7ED3\u679C\uFF0C\u53EF\u7528 /tasks \u67E5\u770B\u540E\u53F0\u4EFB\u52A1\u3002` });
              await replyWithJobResult(queuedMsg, message, enqueueTelegramDateDownload(client, message, senderId, parts[0], parts[1], parts[2]), "date");
            } catch (error) {
              await message.reply({ message: `\u274C \u65E5\u671F\u4E0B\u8F7D\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}` });
            }
            return;
          }
          if (mode === "tag" || mode === "\u6807\u7B7E") {
            if (parts.length !== 2) {
              await message.reply({ message: "\u274C \u7528\u6CD5\uFF1A/tg_download tag @\u9891\u9053 #\u6807\u7B7E" });
              return;
            }
            try {
              const queuedMsg = await message.reply({ message: `\u23F3 \u5DF2\u5F00\u59CB\u540E\u53F0\u626B\u63CF ${parts[0]} \u4E2D\u5E26\u6709 ${parts[1].startsWith("#") ? parts[1] : `#${parts[1]}`} \u7684\u5A92\u4F53\u6D88\u606F...
\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u66F4\u65B0\u7ED3\u679C\uFF0C\u53EF\u7528 /tasks \u67E5\u770B\u540E\u53F0\u4EFB\u52A1\u3002` });
              await replyWithJobResult(queuedMsg, message, enqueueTelegramTagDownload(client, message, senderId, parts[0], parts[1]), "tag");
            } catch (error) {
              await message.reply({ message: `\u274C \u6807\u7B7E\u4E0B\u8F7D\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}` });
            }
            return;
          }
          await message.reply({ message: "\u274C \u7528\u6CD5\uFF1A/tg_download date @\u9891\u9053 YYYY-MM-DD YYYY-MM-DD\n\u6216\uFF1A/tg_download tag @\u9891\u9053 #\u6807\u7B7E" });
          return;
        }
        if (text.startsWith("/tg_date ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          const parts = text.split(/\s+/).slice(1);
          if (parts.length !== 3) {
            await message.reply({ message: "\u274C \u7528\u6CD5\uFF1A/tg_date @\u9891\u9053 YYYY-MM-DD YYYY-MM-DD" });
            return;
          }
          try {
            const queuedMsg = await message.reply({ message: `\u23F3 \u5DF2\u5F00\u59CB\u540E\u53F0\u626B\u63CF ${parts[0]}\uFF1A${parts[1]} \u2192 ${parts[2]}...
\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u66F4\u65B0\u7ED3\u679C\uFF0C\u53EF\u7528 /tasks \u67E5\u770B\u540E\u53F0\u4EFB\u52A1\u3002` });
            await replyWithJobResult(queuedMsg, message, enqueueTelegramDateDownload(client, message, senderId, parts[0], parts[1], parts[2]), "date");
          } catch (error) {
            await message.reply({ message: `\u274C \u65E5\u671F\u4E0B\u8F7D\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}` });
          }
          return;
        }
        if (text.startsWith("/tg_tag ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          const parts = text.split(/\s+/).slice(1);
          if (parts.length !== 2) {
            await message.reply({ message: "\u274C \u7528\u6CD5\uFF1A/tg_tag @\u9891\u9053 #\u6807\u7B7E" });
            return;
          }
          try {
            const queuedMsg = await message.reply({ message: `\u23F3 \u5DF2\u5F00\u59CB\u540E\u53F0\u626B\u63CF ${parts[0]} \u4E2D\u5E26\u6709 ${parts[1].startsWith("#") ? parts[1] : `#${parts[1]}`} \u7684\u5A92\u4F53\u6D88\u606F...
\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u66F4\u65B0\u7ED3\u679C\uFF0C\u53EF\u7528 /tasks \u67E5\u770B\u540E\u53F0\u4EFB\u52A1\u3002` });
            await replyWithJobResult(queuedMsg, message, enqueueTelegramTagDownload(client, message, senderId, parts[0], parts[1]), "tag");
          } catch (error) {
            await message.reply({ message: `\u274C \u6807\u7B7E\u4E0B\u8F7D\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}` });
          }
          return;
        }
        if (text === "/storage") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleStorage(message);
          return;
        }
        if (text === "/storage_switch" || text === "/switch_storage" || text === "/storage_source") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleStorageSwitch(message);
          return;
        }
        if (text === "/list" || text.startsWith("/list ")) {
          await message.reply({ message: "\u{1F4CB} \u4E0A\u4F20\u8BB0\u5F55\u83DC\u5355\u5DF2\u9690\u85CF\u3002\u9700\u8981\u67E5\u770B\u6587\u4EF6\u65F6\u8BF7\u5230\u7F51\u9875\u7AEF\u6587\u4EF6\u5217\u8868\uFF0C\u6216\u4F7F\u7528 /storage \u67E5\u770B\u7EDF\u8BA1\u3002" });
          return;
        }
        if (text.startsWith("/delete ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          const args = text.split(" ").slice(1);
          await handleDelete(message, args);
          return;
        }
        if (text === "/tasks" || text === "/task") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleTasks(message);
          return;
        }
        if (text === "/task_pause" || text.startsWith("/task_pause ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handlePauseTasks(message, text.split(/\s+/).slice(1));
          return;
        }
        if (text === "/task_resume" || text.startsWith("/task_resume ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleResumeTasks(message, text.split(/\s+/).slice(1));
          return;
        }
        if (text === "/task_cancel" || text.startsWith("/task_cancel ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleCancelTask(message, text.split(/\s+/).slice(1));
          return;
        }
        if (text === "/tg_retry" || text.startsWith("/tg_retry ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleRetryFailedTasks(message, text.split(/\s+/).slice(1));
          return;
        }
        if (text === "/stop_tasks" || text === "/stop" || text === "/cancel_tasks") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleStopTasks(message);
          return;
        }
        if (text === "/download_workers" || text === "/workers") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleDownloadWorkers(message);
          return;
        }
        if (text === "/file_concurrency" || text === "/file_workers" || text === "/download_files") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleFileConcurrency(message);
          return;
        }
        if (text === "/path_rules" || text === "/path" || text === "/save_rules") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handlePathRules(message);
          return;
        }
        if (text === "/pc") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handlePathClear(message);
          return;
        }
        if (text.startsWith("/p ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handlePathOnce(message, text.split(/\s+/).slice(1));
          return;
        }
        if (text.startsWith("/ps ")) {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handlePathSession(message, text.split(/\s+/).slice(1));
          return;
        }
        if (text === "/duplicate_mode" || text === "/duplicate" || text === "/dup") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleDuplicateMode(message);
          return;
        }
        if (text === "/cleanup_settings" || text === "/cleanup") {
          if (!await isAuthenticatedAsync(senderId)) {
            await message.reply({ message: MSG.AUTH_REQUIRED });
            return;
          }
          await handleCleanupSettings(message);
          return;
        }
        const userState = userStates.get(senderId);
        if (userState && (userState.state === "WAITING_2FA_SETUP" /* WAITING_2FA_SETUP */ || userState.state === "WAITING_2FA_LOGIN" /* WAITING_2FA_LOGIN */)) {
          const cleanText = text.replace(/[\s-]/g, "");
          if (/^\d{6}$/.test(cleanText)) {
            const verified = await verifyTOTP(cleanText);
            if (verified) {
              if (userState.state === "WAITING_2FA_SETUP" /* WAITING_2FA_SETUP */) {
                if (!await isAuthenticatedAsync(senderId)) {
                  userStates.delete(senderId);
                  await message.reply({ message: MSG.AUTH_REQUIRED });
                  return;
                }
                await activate2FA();
                await message.reply({ message: MSG.AUTH_2FA_ACTIVATED });
              } else {
                await persistAuthenticatedUser(senderId);
                await message.reply({ message: MSG.AUTH_2FA_LOGIN_OK });
              }
              try {
                const messagesToDelete = [message.id];
                if (userState.qrMessageId) messagesToDelete.push(userState.qrMessageId);
                if (userState.promptMessageId) messagesToDelete.push(userState.promptMessageId);
                await client.deleteMessages(chatId, messagesToDelete, { revoke: true });
              } catch (e) {
                console.error("\u{1F916} \u5220\u9664 2FA \u76F8\u5173\u6D88\u606F\u5931\u8D25:", e);
              }
              userStates.delete(senderId);
              return;
            } else {
              const errorMsg = await message.reply({ message: MSG.AUTH_2FA_WRONG });
              try {
                await client.deleteMessages(chatId, [message.id], { revoke: true });
              } catch (e) {
              }
              return;
            }
          }
        }
        if (message.media) {
          await handleFileUpload(client, event);
        }
        if (!await isAuthenticatedAsync(senderId) && text && !text.startsWith("/")) {
          await message.reply({ message: MSG.UNKNOWN_TEXT });
        }
      } catch (error) {
        console.error("\u{1F916} \u5904\u7406\u6D88\u606F\u65F6\u53D1\u751F\u610F\u5916\u9519\u8BEF:", error);
      }
    }, new NewMessage({ incoming: true }));
    client.addEventHandler(async (update) => {
      if (update.className === "UpdateBotCallbackQuery") {
        if (!client) return;
        const activeClient = client;
        const callbackUpdate = update;
        const data = Buffer.from(callbackUpdate.data || []).toString("utf-8");
        if (data.startsWith("pwd_")) {
          await handlePasswordCallback(callbackUpdate);
          return;
        }
        if (data.startsWith("cleanup_")) {
          await handleCleanupButtonCallback(callbackUpdate, data);
          return;
        }
        if (data.startsWith("dw_")) {
          await handleDownloadWorkersCallback(activeClient, callbackUpdate, data);
          return;
        }
        if (data.startsWith("fc_")) {
          await handleFileConcurrencyCallback(activeClient, callbackUpdate, data);
          return;
        }
        if (data.startsWith("storage_switch_")) {
          await handleStorageSwitchCallback(activeClient, callbackUpdate, data);
          return;
        }
        if (data.startsWith("storage_")) {
          await handleStorageCleanupCallback(activeClient, callbackUpdate, data);
          return;
        }
        if (data.startsWith("del_")) {
          await handleDeleteConfirmCallback(activeClient, callbackUpdate, data);
          return;
        }
        if (data.startsWith("pr_")) {
          await handlePathRulesCallback(activeClient, callbackUpdate, data);
          return;
        }
        if (data.startsWith("dm_")) {
          await handleDuplicateModeCallback(activeClient, callbackUpdate, data);
          return;
        }
        if (data.startsWith("tgd_")) {
          await handleTelegramDownloadModeCallback(callbackUpdate, data);
          return;
        }
        if (data.startsWith("tsub_")) {
          await handleTelegramSubscriptionCallback(callbackUpdate, data);
          return;
        }
        if (data.startsWith("ctq_")) {
          await handleChannelTaskQueueCallback(activeClient, callbackUpdate, data);
          return;
        }
        if (data.startsWith("tq_")) {
          await handleTaskQueueCallback(callbackUpdate, data);
          return;
        }
        if (data.startsWith("cs_")) {
          await handleCleanupSettingsCallback(activeClient, callbackUpdate, data);
          return;
        }
      }
    }, new Raw({}));
    console.log("\u{1F916} Telegram Bot \u542F\u52A8\u6210\u529F! (\u6700\u5927 2GB\uFF0C\u8D26\u53F7\u7EA7\u4E0B\u8F7D\u5668\u4E0D\u53D7\u6B64\u9650\u5236)");
  } catch (error) {
    console.error("\u{1F916} Telegram Bot \u542F\u52A8\u5931\u8D25:", error);
  }
}
async function sendSecurityNotification(message) {
  if (!client || !client.connected) {
    console.warn("\u26A0\uFE0F Telegram Client \u672A\u8FDE\u63A5\uFF0C\u65E0\u6CD5\u53D1\u9001\u5B89\u5168\u901A\u77E5");
    return;
  }
  const authUsers = Array.from(authenticatedUsers.keys());
  for (const userId of authUsers) {
    try {
      await client.sendMessage(userId, { message });
    } catch (e) {
      console.error(`\u{1F916} \u5411\u7528\u6237 ${userId} \u53D1\u9001\u901A\u77E5\u5931\u8D25:`, e);
    }
  }
}

// src/routes/auth.ts
async function getIPLocation(ip) {
  try {
    if (ip === "::1" || ip === "127.0.0.1") return "\u672C\u5730\u56DE\u73AF";
    const response = await axios2.get(`http://ip-api.com/json/${ip}?lang=zh-CN`);
    if (response.data.status === "success") {
      return `${response.data.country} ${response.data.regionName} ${response.data.city} (${response.data.isp})`;
    }
  } catch (e) {
    console.error("\u83B7\u53D6 IP \u4F4D\u7F6E\u5931\u8D25:", e);
  }
  return "\u672A\u77E5\u4F4D\u7F6E";
}
async function sendLoginNotification(req) {
  const ip = getClientIP(req);
  const ua = new UAParser(req.headers["user-agent"]).getResult();
  const location = await getIPLocation(ip);
  const beijingTime = (/* @__PURE__ */ new Date()).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false
  }).replace(/\//g, "-") + " (\u4E2D\u56FD/\u4E0A\u6D77)";
  const message = `\u{1F514} **\u5B89\u5168\u767B\u5F55\u63D0\u793A**

\u{1F464} **\u8D26\u53F7**: \u7BA1\u7406\u5458
\u23F0 **\u65F6\u95F4**: ${beijingTime}
\u{1F310} **\u5730\u533A**: ${location}
\u{1F4BB} **\u8BBE\u5907**: ${ua.browser.name || "\u672A\u77E5"} ${ua.browser.version || ""} on ${ua.os.name || "\u672A\u77E5"} ${ua.os.version || ""}
\u{1F50C} **IP\u5730\u5740**: ${ip}

\u{1F4A1} \u5982\u679C\u8FD9\u4E0D\u662F\u60A8\u7684\u64CD\u4F5C\uFF0C\u8BF7\u7ACB\u5373\u68C0\u67E5\u670D\u52A1\u5668\u5B89\u5168\u8BBE\u7F6E\u3002`;
  await sendSecurityNotification(message);
}
var router = Router();
var SIGNED_URL_TYPES = /* @__PURE__ */ new Set(["preview", "thumbnail", "download"]);
var MAX_SIGNED_URL_EXPIRES_IN_SECONDS = {
  thumbnail: 24 * 60 * 60,
  preview: 60 * 60,
  download: 60 * 60
};
function normalizeSignedUrlType(value) {
  if (typeof value !== "string") return null;
  return SIGNED_URL_TYPES.has(value) ? value : null;
}
function getAuthToken(req) {
  const headerToken = req.headers["authorization"]?.replace("Bearer ", "");
  if (headerToken) return headerToken;
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.split(";").map((v) => v.trim()).find((v) => v.startsWith("tg_vault_token="));
  return match ? decodeURIComponent(match.slice("tg_vault_token=".length)) : void 0;
}
function setAuthCookie(res, token, expiresAt) {
  res.cookie("tg_vault_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/"
  });
}
function clearAuthCookie(res) {
  res.clearCookie("tg_vault_token", { path: "/" });
}
var sessions = /* @__PURE__ */ new Map();
setInterval(() => {
  const now = /* @__PURE__ */ new Date();
  sessions.forEach((session, token) => {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  });
}, 60 * 60 * 1e3);
function generateToken() {
  return crypto7.randomBytes(32).toString("hex");
}
function issueSession(req, res) {
  const token = generateToken();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY);
  sessions.set(token, { createdAt: now, expiresAt });
  sendLoginNotification(req).catch((error) => console.warn("\u53D1\u9001\u767B\u5F55\u901A\u77E5\u5931\u8D25:", error));
  setAuthCookie(res, token, expiresAt);
  res.json({
    success: true,
    expiresAt: expiresAt.toISOString()
  });
}
var loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 5,
  message: { error: "\u5C1D\u8BD5\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7 15 \u5206\u949F\u540E\u518D\u8BD5" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req)
});
router.post("/setup", loginLimiter, async (req, res) => {
  try {
    if (!await isInitialSetupRequired()) {
      return res.status(409).json({ error: "\u7BA1\u7406\u5458\u5BC6\u7801\u5DF2\u521B\u5EFA" });
    }
    const { webPassword, telegramPin } = req.body;
    const webError = validateWebPassword(webPassword);
    if (webError) return res.status(400).json({ error: webError });
    const pinError = validateTelegramPin(telegramPin);
    if (pinError) return res.status(400).json({ error: pinError });
    await createInitialAdminCredentials(webPassword, telegramPin);
    issueSession(req, res);
  } catch (error) {
    console.error("\u521D\u59CB\u5316\u7BA1\u7406\u5458\u5931\u8D25:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "\u521D\u59CB\u5316\u7BA1\u7406\u5458\u5931\u8D25" });
  }
});
router.post("/login", loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (await isInitialSetupRequired()) {
    return res.status(428).json({ error: "\u8BF7\u5148\u521B\u5EFA\u7BA1\u7406\u5458\u5BC6\u7801", setupRequired: true });
  }
  if (!password) {
    return res.status(400).json({ error: "\u8BF7\u8F93\u5165\u5BC6\u7801" });
  }
  if (!await verifyWebPassword(password)) {
    return res.status(401).json({ error: "\u8BA4\u8BC1\u5931\u8D25" });
  }
  if (await is2FAEnabled()) {
    return res.json({
      success: true,
      requiresTOTP: true,
      message: "\u8BF7\u8F93\u5165\u4E8C\u6B21\u9A8C\u8BC1\u7801"
    });
  }
  issueSession(req, res);
});
router.post("/verify-totp", loginLimiter, async (req, res) => {
  const { password, totpToken } = req.body;
  if (!password || !totpToken) {
    return res.status(400).json({ error: "\u53C2\u6570\u4E0D\u5B8C\u6574" });
  }
  if (!await verifyWebPassword(password)) {
    return res.status(401).json({ error: "\u8BA4\u8BC1\u5931\u8D25" });
  }
  if (!await verifyTOTP(totpToken)) {
    return res.status(401).json({ error: "\u8BA4\u8BC1\u5931\u8D25" });
  }
  const token = generateToken();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY);
  sessions.set(token, { createdAt: now, expiresAt });
  sendLoginNotification(req);
  setAuthCookie(res, token, expiresAt);
  res.json({
    success: true,
    expiresAt: expiresAt.toISOString()
  });
});
router.get("/2fa-setup", requireAuth, async (req, res) => {
  try {
    const qrDataUrl = await generateOTPAuthUrl();
    const enabled = await is2FAEnabled();
    res.json({ qrDataUrl, enabled });
  } catch (e) {
    console.error("\u751F\u6210 2FA \u4E8C\u7EF4\u7801\u5931\u8D25:", e);
    res.status(500).json({ error: "\u751F\u6210\u4E8C\u7EF4\u7801\u5931\u8D25" });
  }
});
router.post("/2fa-activate", requireAuth, async (req, res) => {
  const { totpToken } = req.body;
  if (!totpToken) return res.status(400).json({ error: "\u8BF7\u8F93\u5165\u9A8C\u8BC1\u7801" });
  try {
    if (await verifyTOTP(totpToken)) {
      await activate2FA();
      return res.json({ success: true, message: "2FA \u5DF2\u6210\u529F\u6FC0\u6D3B" });
    }
    res.status(401).json({ error: "\u9A8C\u8BC1\u7801\u9519\u8BEF" });
  } catch (e) {
    console.error("\u6FC0\u6D3B 2FA \u5931\u8D25:", e);
    res.status(500).json({ error: "\u6FC0\u6D3B\u5931\u8D25" });
  }
});
router.post("/2fa-disable", requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "\u8BF7\u8F93\u5165\u5BC6\u7801\u9A8C\u8BC1" });
  if (!await verifyWebPassword(password)) {
    return res.status(401).json({ error: "\u8BA4\u8BC1\u5931\u8D25" });
  }
  try {
    await disable2FA();
    res.json({ success: true, message: "2FA \u5DF2\u7981\u7528" });
  } catch (e) {
    console.error("\u7981\u7528 2FA \u5931\u8D25:", e);
    res.status(500).json({ error: "\u7981\u7528\u5931\u8D25" });
  }
});
router.get("/verify", async (req, res) => {
  if (await isInitialSetupRequired()) {
    return res.status(428).json({ valid: false, setupRequired: true, error: "\u8BF7\u5148\u521B\u5EFA\u7BA1\u7406\u5458\u5BC6\u7801" });
  }
  const token = getAuthToken(req);
  if (!token) {
    return res.status(401).json({ valid: false, error: "\u672A\u63D0\u4F9B Token" });
  }
  const session = sessions.get(token);
  if (!session || /* @__PURE__ */ new Date() > session.expiresAt) {
    sessions.delete(token || "");
    return res.status(401).json({ valid: false, error: "Token \u5DF2\u8FC7\u671F" });
  }
  res.json({ valid: true });
});
router.post("/logout", (req, res) => {
  const token = getAuthToken(req);
  if (token) {
    sessions.delete(token);
  }
  clearAuthCookie(res);
  res.json({ success: true });
});
router.get("/status", async (_req, res) => {
  const setupRequired = await isInitialSetupRequired();
  res.json({
    setupRequired,
    passwordRequired: true
  });
});
router.post("/sign-url", requireAuth, (req, res) => {
  const { fileId, expiresIn = 300, type = "preview" } = req.body;
  if (!fileId) {
    return res.status(400).json({ error: "\u7F3A\u5C11 fileId" });
  }
  const signedType = normalizeSignedUrlType(type);
  if (!signedType) {
    return res.status(400).json({ error: "\u7B7E\u540D\u7C7B\u578B\u65E0\u6548" });
  }
  const expiresInSeconds = Math.floor(Number(expiresIn));
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    return res.status(400).json({ error: "\u8FC7\u671F\u65F6\u95F4\u65E0\u6548" });
  }
  const maxExpiresIn = MAX_SIGNED_URL_EXPIRES_IN_SECONDS[signedType];
  if (expiresInSeconds > maxExpiresIn) {
    return res.status(400).json({
      error: signedType === "thumbnail" ? "\u7F29\u7565\u56FE\u7B7E\u540D\u6709\u6548\u671F\u4E0D\u80FD\u8D85\u8FC7 24 \u5C0F\u65F6" : "\u9884\u89C8/\u4E0B\u8F7D\u7B7E\u540D\u6709\u6548\u671F\u4E0D\u80FD\u8D85\u8FC7 1 \u5C0F\u65F6",
      maxExpiresIn
    });
  }
  const expires = Date.now() + expiresInSeconds * 1e3;
  const sign = generateSignature(fileId, signedType, expires);
  res.json({
    sign,
    expires,
    expiresIn: expiresInSeconds,
    type: signedType
  });
});
async function requireAuth(req, res, next) {
  if (await isInitialSetupRequired()) {
    return res.status(428).json({ error: "\u8BF7\u5148\u521B\u5EFA\u7BA1\u7406\u5458\u5BC6\u7801", setupRequired: true });
  }
  let token = getAuthToken(req);
  if (!token) {
    return res.status(401).json({ error: "\u672A\u6388\u6743\u8BBF\u95EE" });
  }
  const session = sessions.get(token);
  if (!session || /* @__PURE__ */ new Date() > session.expiresAt) {
    sessions.delete(token);
    return res.status(401).json({ error: "Token \u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55" });
  }
  next();
}
var auth_default = router;

// src/middleware/signedUrl.ts
var SIGNED_URL_TYPES2 = /* @__PURE__ */ new Set(["preview", "thumbnail", "download"]);
function normalizeSignedUrlType2(value) {
  if (!value) return null;
  return SIGNED_URL_TYPES2.has(value) ? value : null;
}
function getSignedUrlRouteParts(req) {
  let id = req.params.id;
  let type = normalizeSignedUrlType2(req.params.type);
  const match = req.path.match(/^\/?([^\/]+)\/(preview|thumbnail|download)(?:\/|$)/);
  if (match) {
    id = id || match[1];
    type = type || normalizeSignedUrlType2(match[2]);
  }
  return { id, type };
}
function generateSignature(fileId, typeOrExpires, expires) {
  const type = typeof typeOrExpires === "number" ? "preview" : typeOrExpires;
  const expiresTimestamp = typeof typeOrExpires === "number" ? typeOrExpires : expires;
  if (typeof expiresTimestamp !== "number") {
    throw new Error("Missing signed URL expiration timestamp");
  }
  const data = `${fileId}:${type}:${expiresTimestamp}`;
  return crypto8.createHmac("sha256", SESSION_SECRET).update(data).digest("hex");
}
function getSignedUrl(fileId, type, expiresIn = 24 * 60 * 60) {
  const expires = Date.now() + expiresIn * 1e3;
  const sign = generateSignature(fileId, type, expires);
  return `/api/files/${fileId}/${type}?sign=${sign}&expires=${expires}`;
}
function verifySignedUrl(req) {
  const sign = req.query.sign;
  const expires = req.query.expires;
  const { id, type } = getSignedUrlRouteParts(req);
  if (typeof sign !== "string" || typeof expires !== "string" || typeof id !== "string" || !type) {
    console.log("[SignedURL] Missing or invalid params:", { sign, expires, id, type });
    return false;
  }
  const expiresTimestamp = parseInt(expires, 10);
  if (isNaN(expiresTimestamp)) {
    console.log("[SignedURL] Invalid timestamp:", expires);
    return false;
  }
  if (Date.now() > expiresTimestamp) {
    console.log("[SignedURL] Expired signature:", { now: Date.now(), expires: expiresTimestamp });
    return false;
  }
  const expectedSign = generateSignature(id, type, expiresTimestamp);
  try {
    const received = Buffer.from(sign, "hex");
    const expected = Buffer.from(expectedSign, "hex");
    if (received.length !== expected.length || !crypto8.timingSafeEqual(received, expected)) {
      console.log("[SignedURL] Signature mismatch:", { id, type });
      return false;
    }
  } catch {
    return false;
  }
  return true;
}
function requireAuthOrSignedUrl(req, res, next) {
  if (req.method === "GET" && req.query.sign && req.query.expires) {
    if (verifySignedUrl(req)) {
      return next();
    }
  }
  return requireAuth(req, res, next);
}

// src/routes/files.ts
init_localPath();
var router2 = Router2();
var UPLOAD_DIR5 = path16.resolve(process.env.UPLOAD_DIR || "./data/uploads");
var THUMBNAIL_DIR5 = path16.resolve(process.env.THUMBNAIL_DIR || "./data/thumbnails");
var PREVIEW_DIR3 = path16.resolve(process.env.PREVIEW_DIR || "./data/previews");
async function getSafeLocalFilePath(file) {
  const candidate = file.path || path16.join(UPLOAD_DIR5, file.stored_name);
  const resolved = path16.resolve(candidate);
  if (!isPathInside(UPLOAD_DIR5, resolved)) {
    throw new Error("Unsafe local file path");
  }
  if (!fs12.existsSync(resolved)) {
    return resolved;
  }
  const real = await fs12.promises.realpath(resolved);
  if (!isPathInside(UPLOAD_DIR5, real)) {
    throw new Error("Unsafe local file path");
  }
  return real;
}
async function serveLocalPathWithRange(req, res, filePath, mimeType, cacheControl, etag) {
  const stat = fs12.statSync(filePath);
  res.set({
    "Content-Type": mimeType || "application/octet-stream",
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
    ...etag ? { "ETag": etag } : {}
  });
  const range = req.headers.range;
  if (range) {
    const parsedRange = parseRangeHeader(range, stat.size);
    if (!parsedRange) {
      res.status(416);
      res.set({
        "Content-Range": `bytes */${stat.size}`,
        "Accept-Ranges": "bytes"
      });
      res.end();
      return;
    }
    const { start, end } = parsedRange;
    const chunkSize = end - start + 1;
    res.status(206);
    res.set({
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": String(chunkSize)
    });
    fs12.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.set("Content-Length", String(stat.size));
  fs12.createReadStream(filePath).pipe(res);
}
function parseRangeHeader(range, size) {
  if (!range) return null;
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start;
  let end;
  if (match[1] === "" && match[2] === "") return null;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}
var FILES_LIST_COLUMNS = `
    id, name, stored_name, type, mime_type, size, thumbnail_path, preview_path,
    width, height, source, folder, storage_account_id, is_favorite, created_at, updated_at
`;
function encodeFileCursor(file) {
  return Buffer.from(`${new Date(file.created_at).toISOString()}|${file.id}`, "utf8").toString("base64url");
}
function decodeFileCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAt, id] = decoded.split("|");
    if (!createdAt || !id || Number.isNaN(new Date(createdAt).getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
function mapFileForList(file) {
  return {
    ...file,
    size: formatFileSize(file.size),
    date: formatRelativeTime(file.created_at),
    thumbnailUrl: file.thumbnail_path ? getSignedUrl(file.id, "thumbnail") : void 0,
    previewUrl: getSignedUrl(file.id, "preview")
  };
}
async function queryFilesPage(options) {
  const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
  const activeAccountId = storageManager2.getActiveAccountId();
  const provider = storageManager2.getProvider();
  const limit = Math.min(500, Math.max(1, parseInt(String(options.limit || "200"), 10) || 200));
  const cursor = decodeFileCursor(options.cursor);
  const whereParts = [];
  const params = [];
  if (provider.name === "local") {
    whereParts.push(`source = $${params.length + 1}`);
    params.push("local");
  } else {
    whereParts.push(`storage_account_id = $${params.length + 1}`);
    params.push(activeAccountId);
  }
  if (options.favoriteOnly) {
    whereParts.push(`is_favorite = $${params.length + 1}`);
    params.push(true);
  }
  if (cursor) {
    whereParts.push(`(created_at, id) < ($${params.length + 1}::timestamptz, $${params.length + 2}::uuid)`);
    params.push(cursor.createdAt, cursor.id);
  }
  params.push(limit + 1);
  const result = await query(
    `SELECT ${FILES_LIST_COLUMNS}
         FROM files
         WHERE ${whereParts.join(" AND ")}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
    params
  );
  const rows = result.rows.slice(0, limit);
  return {
    files: rows.map(mapFileForList),
    nextCursor: result.rows.length > limit ? encodeFileCursor(rows[rows.length - 1]) : null,
    hasMore: result.rows.length > limit
  };
}
function shouldReturnPagedEnvelope(req) {
  return req.query.page === "cursor" || req.query.cursor !== void 0 || req.query.limit !== void 0;
}
router2.get("/", async (req, res) => {
  try {
    const page = await queryFilesPage({ cursor: req.query.cursor, limit: req.query.limit });
    if (shouldReturnPagedEnvelope(req)) {
      return res.json(page);
    }
    res.json(page.files);
  } catch (error) {
    console.error("\u83B7\u53D6\u6587\u4EF6\u5217\u8868\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u6587\u4EF6\u5217\u8868\u5931\u8D25" });
  }
});
router2.post("/folders", async (req, res) => {
  try {
    const { folderName } = req.body;
    if (!folderName || typeof folderName !== "string" || folderName.trim().length === 0) {
      return res.status(400).json({ error: "\u6587\u4EF6\u5939\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    const trimmedName = folderName.trim();
    if (/[\/\\:*?"<>|]/.test(trimmedName)) {
      return res.status(400).json({ error: "\u6587\u4EF6\u5939\u540D\u5305\u542B\u975E\u6CD5\u5B57\u7B26" });
    }
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const activeAccountId = storageManager2.getActiveAccountId();
    const provider = storageManager2.getProvider();
    let checkQuery = "";
    let checkParams = [];
    if (provider.name === "local") {
      checkQuery = "SELECT COUNT(*)::int as cnt FROM files WHERE source = 'local' AND folder = $1";
      checkParams = [trimmedName];
    } else {
      checkQuery = "SELECT COUNT(*)::int as cnt FROM files WHERE storage_account_id = $1 AND folder = $2";
      checkParams = [activeAccountId, trimmedName];
    }
    const checkResult = await query(checkQuery, checkParams);
    if (checkResult.rows[0].cnt > 0) {
      return res.status(400).json({ error: "\u8BE5\u6587\u4EF6\u5939\u5DF2\u5B58\u5728" });
    }
    const insertQuery = `
            INSERT INTO files (
                name, stored_name, type, mime_type, size,
                path, source, folder, storage_account_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `;
    const source = provider.name === "local" ? "local" : provider.name;
    const accountId = provider.name === "local" ? null : activeAccountId;
    await query(insertQuery, [
      ".folder",
      // name
      ".folder",
      // stored_name
      "other",
      // type
      "application/x-directory",
      // mime_type
      0,
      // size
      ".folder",
      // path
      source,
      // source
      trimmedName,
      // folder
      accountId
      // storage_account_id
    ]);
    res.json({ success: true, folder: trimmedName });
  } catch (error) {
    console.error("\u521B\u5EFA\u7A7A\u6587\u4EF6\u5939\u5931\u8D25:", error);
    res.status(500).json({ error: "\u521B\u5EFA\u7A7A\u6587\u4EF6\u5939\u5931\u8D25" });
  }
});
router2.post("/folders/favorite", async (req, res) => {
  try {
    const { folderName } = req.body;
    if (!folderName || typeof folderName !== "string") {
      return res.status(400).json({ error: "\u53C2\u6570\u9519\u8BEF" });
    }
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const activeAccountId = storageManager2.getActiveAccountId();
    const provider = storageManager2.getProvider();
    let selectQuery = "";
    let updateQuery = "";
    let params = [];
    if (provider.name === "local") {
      selectQuery = "SELECT COUNT(*)::int as cnt, BOOL_AND(is_favorite)::boolean as all_fav FROM files WHERE source = 'local' AND folder = $1";
      updateQuery = "UPDATE files SET is_favorite = $1, updated_at = NOW() WHERE source = 'local' AND folder = $2";
      params = [folderName];
    } else {
      selectQuery = "SELECT COUNT(*)::int as cnt, BOOL_AND(is_favorite)::boolean as all_fav FROM files WHERE storage_account_id = $1 AND folder = $2";
      updateQuery = "UPDATE files SET is_favorite = $1, updated_at = NOW() WHERE storage_account_id = $2 AND folder = $3";
      params = [activeAccountId, folderName];
    }
    const selectResult = await query(selectQuery, params);
    const count = selectResult.rows[0]?.cnt ?? 0;
    if (!count) {
      return res.status(404).json({ error: "\u6587\u4EF6\u5939\u4E0D\u5B58\u5728\u6216\u4E3A\u7A7A" });
    }
    const allFav = !!selectResult.rows[0]?.all_fav;
    const newFavorite = !allFav;
    if (provider.name === "local") {
      await query(updateQuery, [newFavorite, folderName]);
    } else {
      await query(updateQuery, [newFavorite, activeAccountId, folderName]);
    }
    res.json({ success: true, isFavorite: newFavorite });
  } catch (error) {
    console.error("\u5207\u6362\u6587\u4EF6\u5939\u6536\u85CF\u72B6\u6001\u5931\u8D25:", error);
    res.status(500).json({ error: "\u5207\u6362\u6587\u4EF6\u5939\u6536\u85CF\u72B6\u6001\u5931\u8D25" });
  }
});
router2.get("/:id([0-9a-fA-F-]{36})", async (req, res) => {
  try {
    const { id } = req.params;
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    res.json({
      ...file,
      size: formatFileSize(file.size),
      date: formatRelativeTime(file.created_at),
      thumbnailUrl: file.thumbnail_path ? getSignedUrl(file.id, "thumbnail") : void 0,
      previewUrl: getSignedUrl(file.id, "preview")
    });
  } catch (error) {
    console.error("\u83B7\u53D6\u6587\u4EF6\u4FE1\u606F\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u6587\u4EF6\u4FE1\u606F\u5931\u8D25" });
  }
});
router2.get("/:id([0-9a-fA-F-]{36})/preview", async (req, res) => {
  try {
    const { id } = req.params;
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    if (file.source === "onedrive" || file.source === "aliyun_oss" || file.source === "s3" || file.source === "webdav" || file.source === "google_drive") {
      try {
        const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
        const provider = storageManager2.getProvider(`${file.source}:${file.storage_account_id}`);
        const url = await provider.getPreviewUrl(file.path);
        if (url) {
          res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
          return res.redirect(url);
        } else {
          const stream = await provider.getFileStream(file.path);
          res.set({
            "Content-Type": file.mime_type || "application/octet-stream",
            "Cache-Control": "public, max-age=86400"
          });
          stream.pipe(res);
          return;
        }
      } catch (err) {
        console.error(`\u83B7\u53D6 ${file.source} \u9884\u89C8\u94FE\u63A5/\u6D41\u5931\u8D25:`, err);
        return res.status(500).json({ error: "\u83B7\u53D6\u9884\u89C8\u5931\u8D25" });
      }
    }
    const filePath = await getSafeLocalFilePath(file);
    if (!fs12.existsSync(filePath)) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728\u4E8E\u670D\u52A1\u5668" });
    }
    let previewPath = file.preview_path;
    let preferredPreviewPath = previewPath && (file.type === "image" || file.type === "video") ? path16.join(PREVIEW_DIR3, path16.basename(previewPath)) : null;
    if (file.type === "image" && (!preferredPreviewPath || !fs12.existsSync(preferredPreviewPath))) {
      try {
        const generatedPreview = await generateMediaPreview(filePath, file.stored_name || file.name, file.mime_type || "application/octet-stream");
        if (generatedPreview) {
          previewPath = path16.basename(generatedPreview);
          preferredPreviewPath = path16.join(PREVIEW_DIR3, previewPath);
          await query("UPDATE files SET preview_path = $1, updated_at = NOW() WHERE id = $2", [previewPath, file.id]);
        }
      } catch (previewError) {
        console.error("\u61D2\u751F\u6210\u56FE\u7247\u9884\u89C8\u5931\u8D25:", previewError);
      }
    } else if (file.type === "video" && (!preferredPreviewPath || !fs12.existsSync(preferredPreviewPath))) {
      void generateMediaPreview(filePath, file.stored_name || file.name, file.mime_type || "application/octet-stream").then(async (generatedPreview) => {
        if (!generatedPreview) return;
        const generatedPreviewName = path16.basename(generatedPreview);
        await query("UPDATE files SET preview_path = $1, updated_at = NOW() WHERE id = $2", [generatedPreviewName, file.id]);
        console.log(`[Preview] \u{1F39E}\uFE0F Lazy video preview cached for ${file.id}: ${generatedPreviewName}`);
      }).catch((previewError) => console.error("\u61D2\u751F\u6210\u89C6\u9891\u9884\u89C8\u5931\u8D25:", previewError));
    }
    const servedPath = preferredPreviewPath && fs12.existsSync(preferredPreviewPath) ? preferredPreviewPath : filePath;
    const servedMime = preferredPreviewPath && servedPath === preferredPreviewPath ? file.type === "video" ? "video/mp4" : "image/webp" : file.mime_type || "application/octet-stream";
    await serveLocalPathWithRange(
      req,
      res,
      servedPath,
      servedMime,
      "public, max-age=86400",
      `"${file.id}-${file.updated_at}-${previewPath || "original"}"`
    );
  } catch (error) {
    console.error("\u9884\u89C8\u6587\u4EF6\u5931\u8D25:", error);
    res.status(500).json({ error: "\u9884\u89C8\u6587\u4EF6\u5931\u8D25" });
  }
});
router2.get("/:id([0-9a-fA-F-]{36})/original", async (req, res) => {
  try {
    const { id } = req.params;
    const file = await getScopedFileById(id);
    if (!file) return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    if (file.source === "onedrive" || file.source === "aliyun_oss" || file.source === "s3" || file.source === "webdav" || file.source === "google_drive") {
      const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
      const provider = storageManager2.getProvider(`${file.source}:${file.storage_account_id}`);
      const url = await provider.getPreviewUrl(file.path);
      if (url) {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
        return res.redirect(url);
      }
      const stream = await provider.getFileStream(file.path);
      res.set({
        "Content-Type": file.mime_type || "application/octet-stream",
        "Cache-Control": "public, max-age=86400"
      });
      stream.pipe(res);
      return;
    }
    const filePath = await getSafeLocalFilePath(file);
    if (!fs12.existsSync(filePath)) return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728\u4E8E\u670D\u52A1\u5668" });
    await serveLocalPathWithRange(req, res, filePath, file.mime_type || "application/octet-stream", "public, max-age=86400", `"${file.id}-${file.updated_at}-original"`);
  } catch (error) {
    console.error("\u83B7\u53D6\u539F\u59CB\u6587\u4EF6\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u539F\u59CB\u6587\u4EF6\u5931\u8D25" });
  }
});
router2.get("/:id([0-9a-fA-F-]{36})/download-url", async (req, res) => {
  try {
    const { id } = req.params;
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    if (file.source === "onedrive" || file.source === "aliyun_oss" || file.source === "s3" || file.source === "webdav" || file.source === "google_drive") {
      try {
        const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
        const provider = storageManager2.getProvider(`${file.source}:${file.storage_account_id}`);
        const url = await provider.getPreviewUrl(file.path);
        if (url) {
          return res.json({ url });
        } else {
          const signedUrl2 = getSignedUrl(file.id, "download", 3600);
          return res.json({ url: signedUrl2, isRelative: true });
        }
      } catch (err) {
        console.error(`\u83B7\u53D6 ${file.source} \u4E0B\u8F7D\u94FE\u63A5\u5931\u8D25:`, err);
        return res.status(500).json({ error: `\u65E0\u6CD5\u83B7\u53D6 ${file.source} \u4E0B\u8F7D\u94FE\u63A5` });
      }
    }
    const signedUrl = getSignedUrl(file.id, "download", 3600);
    return res.json({ url: signedUrl, isRelative: true });
  } catch (error) {
    console.error("\u83B7\u53D6\u4E0B\u8F7D\u94FE\u63A5\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u4E0B\u8F7D\u94FE\u63A5\u5931\u8D25" });
  }
});
router2.get("/:id([0-9a-fA-F-]{36})/download", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`[Download] Starting download for ID: ${id}`);
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    if (file.source === "onedrive" || file.source === "aliyun_oss" || file.source === "s3" || file.source === "webdav" || file.source === "google_drive") {
      try {
        const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
        const provider = storageManager2.getProvider(`${file.source}:${file.storage_account_id}`);
        const url = await provider.getPreviewUrl(file.path);
        if (url) {
          res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
          return res.redirect(url);
        } else {
          const stream = await provider.getFileStream(file.path);
          res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name)}"`);
          stream.pipe(res);
          return;
        }
      } catch (err) {
        console.error(`\u83B7\u53D6 ${file.source} \u4E0B\u8F7D\u94FE\u63A5/\u6D41\u5931\u8D25:`, err);
        return res.status(500).json({ error: "\u65E0\u6CD5\u4E0B\u8F7D\u6587\u4EF6" });
      }
    }
    const filePath = await getSafeLocalFilePath(file);
    console.log(`[Download] Serving local file: ${filePath}`);
    if (!fs12.existsSync(filePath)) {
      console.log(`[Download] File system path not found: ${filePath}`);
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728\u4E8E\u670D\u52A1\u5668" });
    }
    res.download(filePath, file.name, (err) => {
      if (err) {
        console.error("[Download] Send file error:", err);
      }
    });
  } catch (error) {
    console.error("\u4E0B\u8F7D\u6587\u4EF6\u5931\u8D25:", error);
    res.status(500).json({ error: "\u4E0B\u8F7D\u6587\u4EF6\u5931\u8D25" });
  }
});
router2.get("/:id([0-9a-fA-F-]{36})/thumbnail", async (req, res) => {
  try {
    const { id } = req.params;
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    if (!file.thumbnail_path) {
      return res.status(404).json({ error: "\u65E0\u7F29\u7565\u56FE" });
    }
    const thumbPath = path16.join(THUMBNAIL_DIR5, path16.basename(file.thumbnail_path));
    if (!fs12.existsSync(thumbPath)) {
      return res.status(404).json({ error: "\u7F29\u7565\u56FE\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    res.set({
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=604800"
    });
    const stream = fs12.createReadStream(thumbPath);
    stream.pipe(res);
  } catch (error) {
    console.error("\u83B7\u53D6\u7F29\u7565\u56FE\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u7F29\u7565\u56FE\u5931\u8D25" });
  }
});
router2.delete("/:id([0-9a-fA-F-]{36})", async (req, res) => {
  try {
    const { id } = req.params;
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    try {
      await removePhysicalFile(file);
    } catch (err) {
      console.error(`\u7269\u7406\u6587\u4EF6\u5220\u9664\u5931\u8D25 (\u53EF\u80FD\u5DF2\u4E0D\u5B58\u5728):`, err);
    }
    await query("DELETE FROM files WHERE id = $1", [id]);
    res.json({ success: true, message: "\u6587\u4EF6\u5DF2\u5220\u9664" });
  } catch (error) {
    console.error("\u5220\u9664\u6587\u4EF6\u5931\u8D25:", error);
    res.status(500).json({ error: "\u5220\u9664\u6587\u4EF6\u5931\u8D25" });
  }
});
function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
function formatRelativeTime(date) {
  const now = /* @__PURE__ */ new Date();
  const diff = now.getTime() - new Date(date).getTime();
  const seconds = Math.floor(diff / 1e3);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return "\u521A\u521A";
  if (minutes < 60) return `${minutes} \u5206\u949F\u524D`;
  if (hours < 24) return `${hours} \u5C0F\u65F6\u524D`;
  if (days < 7) return `${days} \u5929\u524D`;
  return new Date(date).toLocaleDateString("zh-CN");
}
router2.patch("/:id([0-9a-fA-F-]{36})/rename", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "\u6587\u4EF6\u540D\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    const trimmedName = name.trim();
    if (/[\/\\:*?"<>|]/.test(trimmedName)) {
      return res.status(400).json({ error: "\u6587\u4EF6\u540D\u5305\u542B\u975E\u6CD5\u5B57\u7B26" });
    }
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    const getExt = (n) => {
      const dotIndex = n.lastIndexOf(".");
      return dotIndex > 0 ? n.slice(dotIndex).toLowerCase() : "";
    };
    const oldExt = getExt(file.name);
    const newExt = getExt(trimmedName);
    if (oldExt !== newExt) {
      return res.status(400).json({ error: "\u4E0D\u5141\u8BB8\u4FEE\u6539\u6587\u4EF6\u540E\u7F00" });
    }
    await updateScopedFileById(id, "name = $1", [trimmedName]);
    res.json({ success: true, name: trimmedName });
  } catch (error) {
    console.error("\u91CD\u547D\u540D\u6587\u4EF6\u5931\u8D25:", error);
    res.status(500).json({ error: "\u91CD\u547D\u540D\u6587\u4EF6\u5931\u8D25" });
  }
});
router2.patch("/:id([0-9a-fA-F-]{36})/move", async (req, res) => {
  try {
    const { id } = req.params;
    const { folder } = req.body;
    if (folder !== null && typeof folder !== "string") {
      return res.status(400).json({ error: "\u6587\u4EF6\u5939\u540D\u79F0\u683C\u5F0F\u9519\u8BEF" });
    }
    const trimmedFolder = folder ? folder.trim() : null;
    if (trimmedFolder && /[\/\\:*?"<>|]/.test(trimmedFolder)) {
      return res.status(400).json({ error: "\u6587\u4EF6\u5939\u540D\u5305\u542B\u975E\u6CD5\u5B57\u7B26" });
    }
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    await updateScopedFileById(id, "folder = $1, updated_at = NOW()", [trimmedFolder]);
    res.json({ success: true, folder: trimmedFolder });
  } catch (error) {
    console.error("\u79FB\u52A8\u6587\u4EF6\u5931\u8D25:", error);
    res.status(500).json({ error: "\u79FB\u52A8\u6587\u4EF6\u5931\u8D25" });
  }
});
router2.post("/:id([0-9a-fA-F-]{36})/share", async (req, res) => {
  try {
    const { id } = req.params;
    const { password, expiration } = req.body;
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    const supportedSources = ["onedrive", "google_drive"];
    if (!supportedSources.includes(file.source)) {
      return res.status(400).json({ error: "\u5F53\u524D\u5B58\u50A8\u6E90\u6682\u4E0D\u652F\u6301\u6587\u4EF6\u5206\u4EAB" });
    }
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const provider = storageManager2.getProvider(`${file.source}:${file.storage_account_id}`);
    if (!provider || !provider.createShareLink) {
      return res.status(400).json({ error: "\u5F53\u524D\u5B58\u50A8\u63D0\u4F9B\u5546\u4E0D\u652F\u6301\u5206\u4EAB" });
    }
    const resultLink = await provider.createShareLink(file.path, password, expiration);
    if (resultLink.error) {
      return res.status(400).json({ error: resultLink.error });
    }
    res.json({ link: resultLink.link });
  } catch (error) {
    console.error("\u521B\u5EFA\u5206\u4EAB\u94FE\u63A5\u5931\u8D25:", error);
    res.status(500).json({ error: "\u521B\u5EFA\u5206\u4EAB\u94FE\u63A5\u5931\u8D25" });
  }
});
router2.get("/favorites", async (req, res) => {
  try {
    const page = await queryFilesPage({ favoriteOnly: true, cursor: req.query.cursor, limit: req.query.limit });
    if (shouldReturnPagedEnvelope(req)) {
      return res.json(page);
    }
    res.json(page.files);
  } catch (error) {
    console.error("\u83B7\u53D6\u6536\u85CF\u6587\u4EF6\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u6536\u85CF\u6587\u4EF6\u5931\u8D25" });
  }
});
router2.post("/:id([0-9a-fA-F-]{36})/favorite", async (req, res) => {
  try {
    const { id } = req.params;
    const file = await getScopedFileById(id);
    if (!file) {
      return res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    const currentFavorite = file.is_favorite;
    const newFavorite = !currentFavorite;
    await updateScopedFileById(id, "is_favorite = $1, updated_at = NOW()", [newFavorite]);
    res.json({ success: true, isFavorite: newFavorite });
  } catch (error) {
    console.error("\u5207\u6362\u6536\u85CF\u72B6\u6001\u5931\u8D25:", error);
    res.status(500).json({ error: "\u5207\u6362\u6536\u85CF\u72B6\u6001\u5931\u8D25" });
  }
});
var files_default = router2;

// src/routes/folderOperations.ts
init_db();
init_localPath();
import { Router as Router3 } from "express";
import path17 from "path";
var router3 = Router3({ strict: true });
var UPLOAD_DIR6 = path17.resolve(process.env.UPLOAD_DIR || "./data/uploads");
var THUMBNAIL_DIR6 = path17.resolve(process.env.THUMBNAIL_DIR || "./data/thumbnails");
var CLOUD_SOURCES2 = /* @__PURE__ */ new Set(["onedrive", "aliyun_oss", "s3", "webdav", "google_drive"]);
async function getCurrentStorageScope2() {
  const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
  const provider = storageManager2.getProvider();
  if (provider.name === "local") {
    return { clause: "source = 'local'", params: [] };
  }
  return { clause: "storage_account_id = $1", params: [storageManager2.getActiveAccountId()] };
}
function nextParam2(scope, offset) {
  return `$${scope.params.length + offset}`;
}
async function removePhysicalFile2(file) {
  if (CLOUD_SOURCES2.has(file.source)) {
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const provider = storageManager2.getProvider(`${file.source}:${file.storage_account_id}`);
    await provider.deleteFile(file.path);
  } else {
    const filePath = file.path || path17.join(UPLOAD_DIR6, file.stored_name);
    await safeUnlink(filePath, UPLOAD_DIR6);
  }
  if (file.thumbnail_path) {
    const thumbPath = path17.join(THUMBNAIL_DIR6, path17.basename(file.thumbnail_path));
    await safeUnlink(thumbPath, THUMBNAIL_DIR6);
  }
}
router3.post("/batch-delete", requireAuth, async (req, res) => {
  try {
    const { fileIds = [], folderNames = [] } = req.body;
    if (!Array.isArray(fileIds) || !Array.isArray(folderNames)) {
      return res.status(400).json({ error: "\u53C2\u6570\u683C\u5F0F\u9519\u8BEF" });
    }
    if (fileIds.length === 0 && folderNames.length === 0) {
      return res.status(400).json({ error: "\u8BF7\u63D0\u4F9B\u8981\u5220\u9664\u7684\u6587\u4EF6\u6216\u6587\u4EF6\u5939" });
    }
    const scope = await getCurrentStorageScope2();
    let filesToDelete = [];
    if (fileIds.length > 0) {
      const result = await query(
        `SELECT * FROM files WHERE ${scope.clause} AND id = ANY(${nextParam2(scope, 1)})`,
        [...scope.params, fileIds]
      );
      filesToDelete = [...filesToDelete, ...result.rows];
    }
    if (folderNames.length > 0) {
      const result = await query(
        `SELECT * FROM files WHERE ${scope.clause} AND folder = ANY(${nextParam2(scope, 1)})`,
        [...scope.params, folderNames]
      );
      filesToDelete = [...filesToDelete, ...result.rows];
    }
    const uniqueFiles = Array.from(new Map(filesToDelete.map((file) => [file.id, file])).values());
    if (uniqueFiles.length === 0) {
      return res.json({ success: true, message: "\u6CA1\u6709\u53D1\u73B0\u5F85\u5220\u9664\u7684\u9879\u76EE" });
    }
    await Promise.all(uniqueFiles.map(async (file) => {
      try {
        await removePhysicalFile2(file);
      } catch (err) {
        console.error(`\u5220\u9664\u7269\u7406\u6587\u4EF6\u5931\u8D25 (ID: ${file.id}):`, err);
      }
    }));
    const idsToDelete = uniqueFiles.map((file) => file.id);
    await query("DELETE FROM files WHERE id = ANY($1)", [idsToDelete]);
    res.json({ success: true, message: `\u6210\u529F\u5220\u9664 ${uniqueFiles.length} \u4E2A\u6587\u4EF6` });
  } catch (error) {
    console.error("\u6279\u91CF\u5220\u9664\u5931\u8D25:", error);
    res.status(500).json({ error: "\u6279\u91CF\u5220\u9664\u5931\u8D25" });
  }
});
router3.patch("/rename-folder", requireAuth, async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName || typeof oldName !== "string" || typeof newName !== "string") {
      return res.status(400).json({ error: "\u53C2\u6570\u9519\u8BEF" });
    }
    const trimmedNew = newName.trim();
    if (trimmedNew.length === 0) {
      return res.status(400).json({ error: "\u6587\u4EF6\u5939\u540D\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    if (/[\/\\:*?"<>|]/.test(trimmedNew)) {
      return res.status(400).json({ error: "\u6587\u4EF6\u5939\u540D\u5305\u542B\u975E\u6CD5\u5B57\u7B26" });
    }
    const scope = await getCurrentStorageScope2();
    const checkResult = await query(
      `SELECT COUNT(*) as cnt FROM files WHERE ${scope.clause} AND folder = ${nextParam2(scope, 1)}`,
      [...scope.params, oldName]
    );
    if (parseInt(checkResult.rows[0].cnt) === 0) {
      return res.status(404).json({ error: "\u6587\u4EF6\u5939\u4E0D\u5B58\u5728" });
    }
    if (trimmedNew !== oldName) {
      const existResult = await query(
        `SELECT COUNT(*) as cnt FROM files WHERE ${scope.clause} AND folder = ${nextParam2(scope, 1)}`,
        [...scope.params, trimmedNew]
      );
      if (parseInt(existResult.rows[0].cnt) > 0) {
        return res.status(400).json({ error: "\u8BE5\u6587\u4EF6\u5939\u540D\u5DF2\u5B58\u5728" });
      }
    }
    await query(
      `UPDATE files SET folder = ${nextParam2(scope, 1)} WHERE ${scope.clause} AND folder = ${nextParam2(scope, 2)}`,
      [...scope.params, trimmedNew, oldName]
    );
    res.json({ success: true, name: trimmedNew });
  } catch (error) {
    console.error("\u91CD\u547D\u540D\u6587\u4EF6\u5939\u5931\u8D25:", error);
    res.status(500).json({ error: "\u91CD\u547D\u540D\u6587\u4EF6\u5939\u5931\u8D25" });
  }
});
router3.patch("/move-folder", requireAuth, async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || typeof oldName !== "string") {
      return res.status(400).json({ error: "\u539F\u6587\u4EF6\u5939\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    if (newName !== null && typeof newName !== "string") {
      return res.status(400).json({ error: "\u76EE\u6807\u6587\u4EF6\u5939\u540D\u79F0\u683C\u5F0F\u9519\u8BEF" });
    }
    const trimmedOld = oldName.trim();
    const trimmedNew = newName ? newName.trim() : null;
    if (trimmedNew && /[\/\\:*?"<>|]/.test(trimmedNew)) {
      return res.status(400).json({ error: "\u76EE\u6807\u6587\u4EF6\u5939\u540D\u5305\u542B\u975E\u6CD5\u5B57\u7B26" });
    }
    const scope = await getCurrentStorageScope2();
    const checkResult = await query(
      `SELECT COUNT(*) as cnt FROM files WHERE ${scope.clause} AND folder = ${nextParam2(scope, 1)}`,
      [...scope.params, trimmedOld]
    );
    if (parseInt(checkResult.rows[0].cnt) === 0) {
      return res.status(404).json({ error: "\u539F\u6587\u4EF6\u5939\u4E0D\u5B58\u5728" });
    }
    await query(
      `UPDATE files SET folder = ${nextParam2(scope, 1)}, updated_at = NOW() WHERE ${scope.clause} AND folder = ${nextParam2(scope, 2)}`,
      [...scope.params, trimmedNew, trimmedOld]
    );
    res.json({ success: true, folder: trimmedNew });
  } catch (error) {
    console.error("\u79FB\u52A8\u6587\u4EF6\u5939\u5931\u8D25:", error);
    res.status(500).json({ error: "\u79FB\u52A8\u6587\u4EF6\u5939\u5931\u8D25" });
  }
});
var folderOperations_default = router3;

// src/routes/upload.ts
init_db();
import { Router as Router4 } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import path18 from "path";
import fs13 from "fs";

// src/middleware/apiKey.ts
init_db();
import { createHash, randomBytes, timingSafeEqual } from "crypto";
function hashApiKey(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex");
}
function safeEqualHex(a, b) {
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}
var validateApiKey = async (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return res.status(401).json({
      error: "API Key \u5FC5\u9700",
      message: "\u8BF7\u5728\u8BF7\u6C42\u5934\u4E2D\u6DFB\u52A0 X-API-Key"
    });
  }
  try {
    const apiKeyHash = hashApiKey(apiKey);
    const result = await query(
      "SELECT id, name, permissions, key, key_hash FROM api_keys WHERE (key_hash = $1 OR key = $2) AND enabled = true",
      [apiKeyHash, apiKey]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({
        error: "\u65E0\u6548\u7684 API Key",
        message: "API Key \u4E0D\u5B58\u5728\u6216\u5DF2\u7981\u7528"
      });
    }
    const keyInfo = result.rows[0];
    if (keyInfo.key_hash && !safeEqualHex(keyInfo.key_hash, apiKeyHash)) {
      return res.status(403).json({ error: "\u65E0\u6548\u7684 API Key", message: "API Key \u4E0D\u5B58\u5728\u6216\u5DF2\u7981\u7528" });
    }
    if (!keyInfo.key_hash && keyInfo.key === apiKey) {
      await query("UPDATE api_keys SET key_hash = $1, key = $2 WHERE id = $3", [apiKeyHash, `legacy:${keyInfo.id}`, keyInfo.id]).catch(() => void 0);
    }
    req.apiKeyInfo = {
      id: keyInfo.id,
      name: keyInfo.name,
      permissions: keyInfo.permissions || ["upload"]
    };
    next();
  } catch (error) {
    console.error("\u9A8C\u8BC1 API Key \u5931\u8D25:", error);
    res.status(500).json({ error: "\u9A8C\u8BC1 API Key \u5931\u8D25" });
  }
};

// src/routes/upload.ts
init_storage();
import { rateLimit as rateLimit2 } from "express-rate-limit";
var router4 = Router4();
var uploadLimiter = rateLimit2({
  windowMs: 15 * 60 * 1e3,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "\u4E0A\u4F20\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5" }
});
function decodeFilename(filename) {
  try {
    const urlDecoded = decodeURIComponent(filename);
    if (urlDecoded !== filename) {
      return urlDecoded;
    }
  } catch {
  }
  try {
    const bytes = Buffer.from(filename, "binary");
    const decoded = bytes.toString("utf8");
    if (!decoded.includes("\uFFFD") && decoded !== filename) {
      return decoded;
    }
  } catch {
  }
  return filename;
}
var TEMP_DIR = path18.join(process.cwd(), "data", "temp");
if (!fs13.existsSync(TEMP_DIR)) {
  fs13.mkdirSync(TEMP_DIR, { recursive: true });
}
var storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path18.extname(file.originalname);
    const storedName = `${uuidv4()}${ext}`;
    cb(null, storedName);
  }
});
var upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
    // 2GB limit
  }
});
var handleUpload = async (req, res, source = "web") => {
  if (!req.file) {
    return res.status(400).json({ error: "\u6CA1\u6709\u4E0A\u4F20\u6587\u4EF6" });
  }
  const file = req.file;
  const { folder } = req.body;
  const originalName = decodeFilename(file.originalname);
  const mimeType = file.mimetype;
  const size = file.size;
  const tempPath = path18.resolve(file.path);
  const activeAccountId = storageManager.getActiveAccountId();
  const storageRules = await getStoragePathRules();
  const storageFolder = buildStorageFolderWithRules({ source, folder: folder || null, mimeType, fileName: originalName }, storageRules);
  const storedName = await getUniqueStoredName(originalName, storageFolder, activeAccountId);
  console.log(`[Upload] \u{1F4C1} Received file: ${originalName} (${mimeType}, ${size} bytes)`);
  console.log(`[Upload] \u{1F3E0} Local temp path: ${tempPath}`);
  try {
    const provider = storageManager.getProvider();
    console.log(`[Upload] \u{1F6E0}\uFE0F  Current storage provider: ${provider.name}, activeAccountId: ${activeAccountId || "none (local)"}`);
    let thumbnailPath = null;
    let previewPath = null;
    let width = null;
    let height = null;
    const duplicateMode = await getDuplicateMode();
    if (duplicateMode === "skip") {
      const duplicate = await findDuplicateFile(originalName, storageFolder, size, activeAccountId);
      if (duplicate) {
        if (fs13.existsSync(tempPath)) fs13.unlinkSync(tempPath);
        return res.json({
          success: true,
          skipped: true,
          reason: "duplicate",
          file: {
            id: duplicate.id,
            name: duplicate.name,
            size: duplicate.size,
            folder: duplicate.folder,
            date: duplicate.created_at
          }
        });
      }
    }
    if (provider.name === "local" && (mimeType.startsWith("image/") || mimeType.startsWith("video/"))) {
      try {
        const thumbResult = await generateThumbnail(tempPath, storedName, mimeType);
        if (thumbResult) {
          thumbnailPath = path18.basename(thumbResult);
          console.log(`[Upload] \u2728 Thumbnail generated: ${thumbnailPath}`);
          const dims = await getImageDimensions(tempPath, mimeType);
          width = dims.width;
          height = dims.height;
        } else {
          console.log(`[Upload] \u26A0\uFE0F  No thumbnail generated for: ${mimeType}`);
        }
      } catch (error) {
        console.error("\u751F\u6210\u7F29\u7565\u56FE\u5931\u8D25:", error);
      }
    }
    if (provider.name === "local" && mimeType.startsWith("image/")) {
      try {
        const previewResult = await generateMediaPreview(tempPath, storedName, mimeType);
        if (previewResult) {
          previewPath = path18.basename(previewResult);
          console.log(`[Upload] \u{1F39E}\uFE0F Image preview generated: ${previewPath}`);
        }
      } catch (error) {
        console.error("\u751F\u6210\u56FE\u7247\u9884\u89C8\u5931\u8D25:", error);
      }
    }
    let storedPath = "";
    try {
      storedPath = await provider.saveFile(tempPath, storedName, mimeType, storageFolder);
    } catch (err) {
      if (fs13.existsSync(tempPath)) fs13.unlinkSync(tempPath);
      throw err;
    }
    if (fs13.existsSync(tempPath)) {
      try {
        fs13.unlinkSync(tempPath);
      } catch (e) {
        console.warn("Failed to clean up temp file:", e);
      }
    }
    let type = "other";
    if (mimeType.startsWith("image/")) type = "image";
    else if (mimeType.startsWith("video/")) type = "video";
    else if (mimeType.startsWith("audio/")) type = "audio";
    else if (mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("text") || mimeType.includes("word") || mimeType.includes("excel") || mimeType.includes("spreadsheet") || mimeType.includes("powerpoint") || mimeType.includes("presentation") || mimeType.includes("markdown") || mimeType.includes("json") || mimeType.includes("xml") || mimeType.includes("sql")) type = "document";
    const result = await query(
      `INSERT INTO files
            (name, stored_name, type, mime_type, size, path, thumbnail_path, preview_path, width, height, source, folder, storage_account_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id, created_at, name, type, size`,
      [originalName, storedName, type, mimeType, size, storedPath, thumbnailPath, previewPath, width, height, provider.name, storageFolder, activeAccountId]
    );
    const newFile = result.rows[0];
    if (provider.name === "local" && type === "video") {
      void generateMediaPreview(storedPath, storedName, mimeType).then(async (previewResult) => {
        if (!previewResult) return;
        const generatedPreviewName = path18.basename(previewResult);
        await query("UPDATE files SET preview_path = $1, updated_at = NOW() WHERE id = $2", [generatedPreviewName, newFile.id]);
        console.log(`[Upload] \u{1F39E}\uFE0F Video preview generated async: ${generatedPreviewName}`);
      }).catch((error) => console.error("\u5F02\u6B65\u751F\u6210\u89C6\u9891\u9884\u89C8\u5931\u8D25:", error));
    }
    res.json({
      success: true,
      file: {
        id: newFile.id,
        name: newFile.name,
        type: newFile.type,
        size: newFile.size,
        thumbnailUrl: thumbnailPath ? getSignedUrl(newFile.id, "thumbnail") : void 0,
        previewUrl: getSignedUrl(newFile.id, "preview"),
        date: newFile.created_at,
        source: provider.name
      }
    });
  } catch (error) {
    console.error("\u4E0A\u4F20\u5904\u7406\u5931\u8D25:", error);
    if (fs13.existsSync(tempPath)) fs13.unlinkSync(tempPath);
    res.status(500).json({ error: "\u6587\u4EF6\u4E0A\u4F20\u5931\u8D25" });
  }
};
router4.post("/", uploadLimiter, upload.single("file"), async (req, res) => {
  await handleUpload(req, res, "web");
});
router4.post("/api", uploadLimiter, validateApiKey, upload.single("file"), async (req, res) => {
  await handleUpload(req, res, "api");
});
var upload_default = router4;

// src/routes/storage.ts
init_db();
import { Router as Router5 } from "express";
import checkDiskSpaceModule2 from "check-disk-space";
import os3 from "os";
import path19 from "path";
import fs14 from "fs";
import axios3 from "axios";
import crypto9 from "crypto";
var checkDiskSpace2 = checkDiskSpaceModule2.default || checkDiskSpaceModule2;
var router5 = Router5();
var UPLOAD_DIR7 = process.env.UPLOAD_DIR || "./data/uploads";
function sendOAuthSuccessPage(res, providerName, messageType) {
  const nonce = crypto9.randomBytes(16).toString("base64");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "script-src-attr 'none'",
    "base-uri 'none'",
    "object-src 'none'"
  ].join("; "));
  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
  res.type("html").send(`
            <!doctype html>
            <html lang="zh-CN">
                <head>
                    <meta charset="utf-8" />
                    <title>${providerName} \u6388\u6743\u6210\u529F</title>
                </head>
                <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                    <div style="text-align: center; padding: 40px; border-radius: 20px; background: #f0fdf4; border: 1px solid #bbf7d0;">
                        <h2 style="color: #16a34a; margin-bottom: 10px;">\u{1F389} \u6388\u6743\u6210\u529F\uFF01</h2>
                        <p style="color: #15803d; margin-bottom: 8px;">${providerName} \u5DF2\u6210\u529F\u8FDE\u63A5\u5E76\u542F\u7528\u3002</p>
                        <p style="color: #166534; font-size: 14px; margin-bottom: 20px;">\u7A97\u53E3\u5C06\u81EA\u52A8\u5173\u95ED\u3002\u5982\u679C\u672A\u5173\u95ED\uFF0C\u8BF7\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u5173\u95ED\uFF0C\u4E3B\u9875\u9762\u4F1A\u81EA\u52A8\u5237\u65B0\u8D26\u6237\u5217\u8868\u3002</p>
                        <button id="close-window" type="button" style="padding: 10px 20px; background: #16a34a; color: white; border: none; border-radius: 8px; cursor: pointer;">\u5173\u95ED\u6B64\u7A97\u53E3</button>
                        <script nonce="${nonce}">
                            const notifyParent = () => {
                                if (window.opener && !window.opener.closed) {
                                    window.opener.postMessage('${messageType}', '*');
                                }
                            };
                            const closeWindow = () => {
                                notifyParent();
                                window.close();
                            };
                            document.getElementById('close-window')?.addEventListener('click', closeWindow);
                            notifyParent();
                            setTimeout(closeWindow, 1200);
                        </script>
                    </div>
                </body>
            </html>
        `);
}
function getOneDriveRedirectUri(req) {
  const apiBase = process.env.VITE_API_URL;
  if (apiBase) {
    return `${apiBase.replace(/\/$/, "")}/api/storage/onedrive/callback`;
  }
  const protocol = req.protocol;
  const host = req.get("host");
  return `${protocol}://${host}/api/storage/onedrive/callback`;
}
function getGoogleDriveRedirectUri(req) {
  const apiBase = process.env.VITE_API_URL;
  if (apiBase) {
    return `${apiBase.replace(/\/$/, "")}/api/storage/google-drive/callback`;
  }
  const protocol = req.protocol;
  const host = req.get("host");
  return `${protocol}://${host}/api/storage/google-drive/callback`;
}
router5.get("/stats", requireAuth, async (_req, res) => {
  try {
    const diskPath = os3.platform() === "win32" ? "C:" : path19.resolve(UPLOAD_DIR7);
    const diskSpace = await checkDiskSpace2(diskPath);
    const scope = await getCurrentStorageScope();
    const result = await query(`
            SELECT
                COUNT(*) as file_count,
                COALESCE(SUM(size), 0) as total_size
            FROM files
            WHERE ${scope.clause}
        `, scope.params);
    const tgVaultStats = result.rows[0];
    res.json({
      server: {
        total: formatBytes3(diskSpace.size),
        totalBytes: diskSpace.size,
        used: formatBytes3(diskSpace.size - diskSpace.free),
        usedBytes: diskSpace.size - diskSpace.free,
        free: formatBytes3(diskSpace.free),
        freeBytes: diskSpace.free,
        usedPercent: Math.round((diskSpace.size - diskSpace.free) / diskSpace.size * 100)
      },
      tgvault: {
        used: formatBytes3(parseInt(tgVaultStats.total_size)),
        usedBytes: parseInt(tgVaultStats.total_size),
        fileCount: parseInt(tgVaultStats.file_count),
        usedPercent: Math.round(parseInt(tgVaultStats.total_size) / diskSpace.size * 100)
      }
    });
  } catch (error) {
    console.error("\u83B7\u53D6\u5B58\u50A8\u7EDF\u8BA1\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u5B58\u50A8\u7EDF\u8BA1\u5931\u8D25" });
  }
});
router5.get("/stats/types", requireAuth, async (_req, res) => {
  try {
    const scope = await getCurrentStorageScope();
    const result = await query(`
            SELECT
                type,
                COUNT(*) as count,
                COALESCE(SUM(size), 0) as total_size
            FROM files
            WHERE ${scope.clause}
            GROUP BY type
            ORDER BY total_size DESC
        `, scope.params);
    const stats = result.rows.map((row) => ({
      type: row.type,
      count: parseInt(row.count),
      size: formatBytes3(parseInt(row.total_size)),
      sizeBytes: parseInt(row.total_size)
    }));
    res.json(stats);
  } catch (error) {
    console.error("\u83B7\u53D6\u7C7B\u578B\u7EDF\u8BA1\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u7C7B\u578B\u7EDF\u8BA1\u5931\u8D25" });
  }
});
function formatBytes3(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
router5.get("/config", requireAuth, async (req, res) => {
  try {
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const provider = storageManager2.getProvider();
    const activeAccountId = storageManager2.getActiveAccountId();
    const accounts = await storageManager2.getAccounts();
    const telegramUserDownloadEnabled = await getSetting("telegram_user_download_enabled", "false");
    const telegramUserSessionFilePath = getTelegramUserSessionFilePath();
    const telegramUserSessionReady = fs14.existsSync(telegramUserSessionFilePath) && isTelegramUserClientReady();
    const redirectUri = getOneDriveRedirectUri(req);
    res.json({
      provider: provider.name,
      activeAccountId,
      accounts,
      redirectUri,
      googleDriveRedirectUri: getGoogleDriveRedirectUri(req),
      telegramUserDownloadEnabled: telegramUserDownloadEnabled === "true",
      telegramUserSessionReady
    });
  } catch (error) {
    console.error("\u83B7\u53D6\u5B58\u50A8\u914D\u7F6E\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u5B58\u50A8\u914D\u7F6E\u5931\u8D25" });
  }
});
router5.post("/config/telegram-user-download", requireAuth, async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    if (enabled && !isTelegramUserClientReady()) {
      return res.status(400).json({ error: "Telegram \u7528\u6237 session \u672A\u5C31\u7EEA\uFF0C\u8BF7\u5148\u751F\u6210 session \u5E76\u91CD\u542F\u540E\u7AEF" });
    }
    await setSetting("telegram_user_download_enabled", enabled ? "true" : "false");
    res.json({ success: true, enabled });
  } catch (error) {
    console.error("\u66F4\u65B0 Telegram \u7528\u6237\u4E0B\u8F7D\u8BBE\u7F6E\u5931\u8D25:", error);
    res.status(500).json({ error: "\u66F4\u65B0 Telegram \u7528\u6237\u4E0B\u8F7D\u8BBE\u7F6E\u5931\u8D25" });
  }
});
router5.post("/maintenance/download-items/cleanup", requireAuth, async (req, res) => {
  try {
    const retentionDays = Math.min(365, Math.max(1, parseInt(String(req.body?.retentionDays ?? "7"), 10) || 7));
    const result = await query(
      `DELETE FROM telegram_download_items
             WHERE status = 'completed'
               AND COALESCE(completed_at, updated_at, created_at) < NOW() - ($1::int * INTERVAL '1 day')`,
      [retentionDays]
    );
    res.json({
      success: true,
      deletedCount: result.rowCount || 0,
      retentionDays
    });
  } catch (error) {
    console.error("\u6E05\u7406\u4E0B\u8F7D\u4EFB\u52A1\u660E\u7EC6\u5931\u8D25:", error);
    res.status(500).json({ error: "\u6E05\u7406\u4E0B\u8F7D\u4EFB\u52A1\u660E\u7EC6\u5931\u8D25" });
  }
});
router5.post("/config/onedrive/auth-url", requireAuth, async (req, res) => {
  try {
    const { clientId, tenantId, redirectUri, clientSecret, name } = req.body;
    if (!clientId || !redirectUri) {
      return res.status(400).json({ error: "\u7F3A\u5C11 Client ID \u6216 Redirect URI" });
    }
    const { OneDriveStorageProvider: OneDriveStorageProvider2, StorageManager: StorageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const oauthState = crypto9.randomBytes(24).toString("base64url");
    const authUrl = OneDriveStorageProvider2.generateAuthUrl(clientId, tenantId || "common", redirectUri, oauthState);
    if (clientSecret) {
      await StorageManager2.updateSetting("onedrive_client_secret", clientSecret);
    } else {
      await StorageManager2.updateSetting("onedrive_client_secret", "");
    }
    await StorageManager2.updateSetting("onedrive_client_id", clientId);
    await StorageManager2.updateSetting("onedrive_tenant_id", tenantId || "common");
    await StorageManager2.updateSetting("onedrive_oauth_state", oauthState);
    if (name) {
      await StorageManager2.updateSetting("onedrive_pending_name", name);
    }
    res.json({ authUrl });
  } catch (error) {
    console.error("\u83B7\u53D6\u6388\u6743 URL \u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u6388\u6743 URL \u5931\u8D25" });
  }
});
router5.get("/onedrive/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      return res.type("text/plain").send(`\u6388\u6743\u5931\u8D25: ${String(error_description || error)}`);
    }
    if (!code) {
      return res.send("\u7F3A\u5C11\u6388\u6743\u7801 (code)");
    }
    const expectedState = await (await Promise.resolve().then(() => (init_storage(), storage_exports))).storageManager.getSetting("onedrive_oauth_state");
    if (!state || !expectedState || state !== expectedState) {
      return res.status(400).send("OAuth state \u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u8FD4\u56DE\u8BBE\u7F6E\u9875\u9762\u91CD\u65B0\u53D1\u8D77\u6388\u6743\u3002");
    }
    const { storageManager: storageManager2, OneDriveStorageProvider: OneDriveStorageProvider2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const clientId = await storageManager2.getSetting("onedrive_client_id");
    const clientSecret = await storageManager2.getSetting("onedrive_client_secret") || "";
    const tenantId = await storageManager2.getSetting("onedrive_tenant_id") || "common";
    const redirectUri = getOneDriveRedirectUri(req);
    console.log(`[OneDrive] OAuth Callback, using redirectUri: ${redirectUri}`);
    if (!clientId) {
      console.error("[OneDrive] OAuth Callback failed: Client ID not found in settings");
      return res.send("\u914D\u7F6E\u4FE1\u606F\u4E22\u5931\uFF08Client ID \u672A\u627E\u5230\uFF09\uFF0C\u8BF7\u8FD4\u56DE\u8BBE\u7F6E\u9875\u9762\u91CD\u8BD5\u3002");
    }
    let tokens;
    try {
      tokens = await OneDriveStorageProvider2.exchangeCodeForToken(clientId, clientSecret, tenantId, redirectUri, code);
    } catch (err) {
      const msError = err.response?.data;
      const errorCode = Array.isArray(msError?.error_codes) ? msError.error_codes[0] : void 0;
      const errorDescription = msError?.error_description || err.message || "\u672A\u77E5\u9519\u8BEF";
      console.error("[OneDrive] exchangeCodeForToken failed:", {
        error: msError?.error,
        errorCode,
        errorDescription,
        traceId: msError?.trace_id,
        correlationId: msError?.correlation_id,
        clientId: clientId.substring(0, 8) + "...",
        redirectUri,
        tenantId
      });
      if (errorCode === 7000215 || /invalid client secret|AADSTS7000215/i.test(errorDescription)) {
        return res.status(400).send("\u6388\u6743\u5931\u8D25\uFF1AMicrosoft \u8FD4\u56DE AADSTS7000215\uFF0CClient Secret \u65E0\u6548\u3002\u8BF7\u5728 Azure/Entra\u300C\u8BC1\u4E66\u548C\u5BC6\u7801\u300D\u4E2D\u65B0\u5EFA\u5BA2\u6237\u7AEF\u5BC6\u7801\uFF0C\u5E76\u590D\u5236\u201C\u503C Value\u201D\uFF08\u4E0D\u662F\u201C\u673A\u5BC6 ID/Secret ID\u201D\uFF09\u540E\u91CD\u65B0\u6388\u6743\u3002");
      }
      return res.status(err.response?.status || 400).type("text/plain").send(`\u6388\u6743\u5931\u8D25\uFF1A${String(errorDescription)}`);
    }
    let accountName = "OneDrive Account";
    try {
      const profileRes = await axios3.get("https://graph.microsoft.com/v1.0/me", {
        headers: { "Authorization": `Bearer ${tokens.access_token}` }
      });
      accountName = profileRes.data.mail || profileRes.data.userPrincipalName || "OneDrive Account";
    } catch (profileError) {
      console.log("[OneDrive] Could not fetch user profile (likely User.Read scope missing), using default name.");
    }
    const pendingName = await storageManager2.getSetting("onedrive_pending_name");
    const finalName = pendingName || accountName;
    await storageManager2.updateOneDriveConfig(clientId, clientSecret, tokens.refresh_token, tenantId);
    const activeId = storageManager2.getActiveAccountId();
    if (activeId) {
      await query("UPDATE storage_accounts SET name = $1 WHERE id = $2", [finalName, activeId]);
    }
    sendOAuthSuccessPage(res, "OneDrive", "onedrive_auth_success");
  } catch (error) {
    console.error("OneDrive \u56DE\u8C03\u5904\u7406\u5931\u8D25:", error);
    res.status(500).send("\u6388\u6743\u5904\u7406\u51FA\u9519\uFF0C\u8BF7\u68C0\u67E5\u540E\u7AEF\u65E5\u5FD7\u3002");
  }
});
router5.post("/config/google-drive/auth-url", requireAuth, async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri, name, sharedDriveId } = req.body;
    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(400).json({ error: "\u7F3A\u5C11\u5FC5\u8981\u53C2\u6570 (Client ID, Client Secret \u6216 Redirect URI)" });
    }
    const { GoogleDriveStorageProvider: GoogleDriveStorageProvider2, StorageManager: StorageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const oauthState = crypto9.randomBytes(24).toString("base64url");
    const authUrl = GoogleDriveStorageProvider2.generateAuthUrl(clientId, clientSecret, redirectUri, oauthState);
    await StorageManager2.updateSetting("google_drive_client_id", clientId);
    await StorageManager2.updateSetting("google_drive_client_secret", clientSecret);
    await StorageManager2.updateSetting("google_drive_redirect_uri", redirectUri);
    await StorageManager2.updateSetting("google_drive_oauth_state", oauthState);
    await StorageManager2.updateSetting("google_drive_shared_drive_id", sharedDriveId?.trim() || "");
    if (name) {
      await StorageManager2.updateSetting("google_drive_pending_name", name);
    }
    res.json({ authUrl });
  } catch (error) {
    console.error("\u83B7\u53D6 Google Drive \u6388\u6743 URL \u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u6388\u6743 URL \u5931\u8D25" });
  }
});
router5.get("/google-drive/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) {
      return res.type("text/plain").send(`\u6388\u6743\u5931\u8D25: ${String(error)}`);
    }
    if (!code) {
      return res.send("\u7F3A\u5C11\u6388\u6743\u7801 (code)");
    }
    const { storageManager: storageManager2, GoogleDriveStorageProvider: GoogleDriveStorageProvider2, StorageManager: StorageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const expectedState = await storageManager2.getSetting("google_drive_oauth_state");
    if (!state || !expectedState || state !== expectedState) {
      return res.status(400).send("OAuth state \u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u8FD4\u56DE\u8BBE\u7F6E\u9875\u9762\u91CD\u65B0\u53D1\u8D77\u6388\u6743\u3002");
    }
    const clientId = await storageManager2.getSetting("google_drive_client_id");
    const clientSecret = await storageManager2.getSetting("google_drive_client_secret") || "";
    const redirectUri = await storageManager2.getSetting("google_drive_redirect_uri") || getGoogleDriveRedirectUri(req);
    const sharedDriveId = await storageManager2.getSetting("google_drive_shared_drive_id") || "";
    if (!clientId || !clientSecret) {
      return res.send("\u914D\u7F6E\u4FE1\u606F\u4E22\u5931\uFF0C\u8BF7\u8FD4\u56DE\u8BBE\u7F6E\u9875\u9762\u91CD\u8BD5\u3002");
    }
    const tokens = await GoogleDriveStorageProvider2.exchangeCodeForToken(clientId, clientSecret, redirectUri, code);
    if (!tokens.refresh_token) {
      return res.send("\u6388\u6743\u5931\u8D25\uFF1A\u672A\u83B7\u5F97 Refresh Token\u3002\u8BF7\u786E\u4FDD\u662F\u9996\u6B21\u6388\u6743\uFF0C\u6216\u5728 Google \u63A7\u5236\u53F0\u4E2D\u64A4\u9500\u6743\u9650\u540E\u91CD\u8BD5\u3002");
    }
    const pendingName = await storageManager2.getSetting("google_drive_pending_name");
    await StorageManager2.updateSetting("google_drive_pending_name", "");
    await StorageManager2.updateSetting("google_drive_oauth_state", "");
    await StorageManager2.updateSetting("google_drive_shared_drive_id", "");
    await storageManager2.addGoogleDriveAccount(pendingName || "Google Drive Account", clientId, clientSecret, tokens.refresh_token, redirectUri, sharedDriveId);
    const accounts = await storageManager2.getAccounts();
    const newAccount = accounts.filter((a) => a.type === "google_drive").sort((a, b) => b.created_at - a.created_at)[0];
    if (newAccount) {
      await storageManager2.switchAccount(newAccount.id);
    }
    sendOAuthSuccessPage(res, "Google Drive", "google_drive_auth_success");
  } catch (error) {
    console.error("Google Drive \u56DE\u8C03\u5904\u7406\u5931\u8D25:", error);
    res.status(500).send("\u6388\u6743\u5904\u7406\u51FA\u9519\uFF0C\u8BF7\u68C0\u67E5\u540E\u7AEF\u65E5\u5FD7\u3002");
  }
});
router5.put("/config/onedrive", requireAuth, async (req, res) => {
  try {
    const { clientId, clientSecret, refreshToken, tenantId, name } = req.body;
    if (!clientId || !refreshToken) {
      return res.status(400).json({ error: "\u7F3A\u5C11\u5FC5\u8981\u53C2\u6570 (Client ID \u548C Refresh Token)" });
    }
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    await storageManager2.updateOneDriveConfig(clientId, clientSecret || "", refreshToken, tenantId || "common", name);
    res.json({ success: true, message: "OneDrive \u914D\u7F6E\u5DF2\u66F4\u65B0\u5E76\u5207\u6362" });
  } catch (error) {
    console.error("\u66F4\u65B0 OneDrive \u914D\u7F6E\u5931\u8D25:", error);
    res.status(500).json({ error: "\u66F4\u65B0 OneDrive \u914D\u7F6E\u5931\u8D25" });
  }
});
router5.post("/config/aliyun-oss", requireAuth, async (req, res) => {
  try {
    const { name, region, accessKeyId, accessKeySecret, bucket } = req.body;
    if (!name || !region || !accessKeyId || !accessKeySecret || !bucket) {
      return res.status(400).json({ error: "\u7F3A\u5C11\u5FC5\u8981\u53C2\u6570" });
    }
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const accountId = await storageManager2.addAliyunOSSAccount(name, region, accessKeyId, accessKeySecret, bucket);
    res.json({ success: true, message: "Aliyun OSS \u8D26\u6237\u5DF2\u6DFB\u52A0", accountId });
  } catch (error) {
    console.error("\u6DFB\u52A0 Aliyun OSS \u914D\u7F6E\u5931\u8D25:", error);
    res.status(500).json({ error: "\u6DFB\u52A0 Aliyun OSS \u914D\u7F6E\u5931\u8D25" });
  }
});
router5.post("/config/s3", requireAuth, async (req, res) => {
  try {
    const { name, endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle } = req.body;
    if (!name || !endpoint || !region || !accessKeyId || !accessKeySecret || !bucket) {
      return res.status(400).json({ error: "\u7F3A\u5C11\u5FC5\u8981\u53C2\u6570" });
    }
    await assertPublicStorageEndpoint(endpoint);
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const accountId = await storageManager2.addS3Account(name, endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle || false);
    res.json({ success: true, message: "S3 \u5B58\u50A8\u8D26\u6237\u5DF2\u6DFB\u52A0", accountId });
  } catch (error) {
    console.error("\u6DFB\u52A0 S3 \u914D\u7F6E\u5931\u8D25:", error);
    res.status(500).json({ error: "\u6DFB\u52A0 S3 \u914D\u7F6E\u5931\u8D25" });
  }
});
router5.post("/config/webdav", requireAuth, async (req, res) => {
  try {
    const { name, url, username, password } = req.body;
    if (!name || !url) {
      return res.status(400).json({ error: "\u7F3A\u5C11\u5FC5\u8981\u53C2\u6570 (\u540D\u79F0\u548C URL)" });
    }
    await assertPublicStorageEndpoint(url);
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const accountId = await storageManager2.addWebDAVAccount(name, url, username, password);
    res.json({ success: true, message: "WebDAV \u5B58\u50A8\u8D26\u6237\u5DF2\u6DFB\u52A0", accountId });
  } catch (error) {
    console.error("\u6DFB\u52A0 WebDAV \u914D\u7F6E\u5931\u8D25:", error);
    res.status(500).json({ error: "\u6DFB\u52A0 WebDAV \u914D\u7F6E\u5931\u8D25" });
  }
});
router5.post("/switch", requireAuth, async (req, res) => {
  try {
    const { provider, accountId } = req.body;
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    if (provider === "local") {
      await storageManager2.switchToLocal();
      return res.json({ success: true, message: "\u5DF2\u5207\u6362\u5230\u672C\u5730\u5B58\u50A8" });
    } else if (provider === "onedrive" || provider === "aliyun_oss" || provider === "s3" || provider === "webdav" || provider === "google_drive") {
      if (accountId) {
        await storageManager2.switchAccount(accountId);
        return res.json({ success: true, message: `\u5DF2\u5207\u6362 ${provider} \u8D26\u6237` });
      } else {
        const accounts = await storageManager2.getAccounts();
        const account = accounts.find((a) => a.type === provider);
        if (!account) {
          return res.status(400).json({ error: `\u672A\u914D\u7F6E\u4EFB\u4F55 ${provider} \u8D26\u6237` });
        }
        await storageManager2.switchAccount(account.id);
        return res.json({ success: true, message: `\u5DF2\u5207\u6362\u5230 ${provider}` });
      }
    } else {
      return res.status(400).json({ error: "\u65E0\u6548\u7684\u5B58\u50A8\u63D0\u4F9B\u5546" });
    }
  } catch (error) {
    console.error("\u5207\u6362\u5B58\u50A8\u5931\u8D25:", error);
    res.status(500).json({ error: "\u5207\u6362\u5B58\u50A8\u5931\u8D25" });
  }
});
router5.get("/accounts", requireAuth, async (req, res) => {
  try {
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    const accounts = await storageManager2.getAccounts();
    res.json(accounts);
  } catch (error) {
    console.error("\u83B7\u53D6\u8D26\u6237\u5217\u8868\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u8D26\u6237\u5217\u8868\u5931\u8D25" });
  }
});
router5.delete("/accounts/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    if (storageManager2.getActiveAccountId() === id) {
      return res.status(400).json({ error: "\u65E0\u6CD5\u5220\u9664\u5F53\u524D\u6B63\u5728\u4F7F\u7528\u7684\u8D26\u6237\uFF0C\u8BF7\u5148\u5207\u6362\u5230\u5176\u4ED6\u8D26\u6237\u6216\u672C\u5730\u5B58\u50A8\u3002" });
    }
    const accountRes = await query("SELECT id, name FROM storage_accounts WHERE id = $1", [id]);
    if (accountRes.rows.length === 0) {
      return res.status(404).json({ error: "\u8D26\u6237\u4E0D\u5B58\u5728" });
    }
    const accountName = accountRes.rows[0].name;
    const accountType = accountRes.rows[0].type;
    const fileRes = await query("DELETE FROM files WHERE storage_account_id = $1", [id]);
    await query("DELETE FROM storage_accounts WHERE id = $1", [id]);
    storageManager2.removeProvider(`${accountType}:${id}`);
    console.log(`[Storage] Account deleted: ${accountName} (${id})`);
    res.json({ success: true, message: `\u5DF2\u5220\u9664\u8D26\u6237: ${accountName}\uFF0C\u5DF2\u6E05\u7406 ${fileRes.rowCount || 0} \u6761\u5173\u8054\u6587\u4EF6\u7D22\u5F15` });
  } catch (error) {
    console.error("\u5220\u9664\u8D26\u6237\u5931\u8D25:", error);
    res.status(500).json({ error: "\u5220\u9664\u8D26\u6237\u5931\u8D25" });
  }
});
var storage_default = router5;

// src/routes/chunkedUpload.ts
init_db();
import { Router as Router6 } from "express";
import { v4 as uuidv42 } from "uuid";
import path20 from "path";
import fs15 from "fs";
import { pipeline } from "stream/promises";
init_storage();
import { rateLimit as rateLimit3 } from "express-rate-limit";
var router6 = Router6();
var chunkedUploadLimiter = rateLimit3({
  windowMs: 15 * 60 * 1e3,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "\u5206\u5757\u4E0A\u4F20\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5" }
});
var MAX_CHUNK_BYTES = Math.max(1024 * 1024, parseInt(process.env.MAX_UPLOAD_CHUNK_MB || "64", 10) * 1024 * 1024);
var MAX_UPLOAD_SESSIONS = Math.max(10, parseInt(process.env.MAX_UPLOAD_SESSIONS || "200", 10) || 200);
var MAX_TOTAL_CHUNKS = Math.max(1, parseInt(process.env.MAX_TOTAL_CHUNKS || "50000", 10) || 5e4);
router6.use(chunkedUploadLimiter);
var UPLOAD_DIR8 = process.env.UPLOAD_DIR || "./data/uploads";
var THUMBNAIL_DIR7 = process.env.THUMBNAIL_DIR || "./data/thumbnails";
var CHUNK_DIR = process.env.CHUNK_DIR || "./data/chunks";
[UPLOAD_DIR8, THUMBNAIL_DIR7, CHUNK_DIR].forEach((dir) => {
  if (!fs15.existsSync(dir)) {
    fs15.mkdirSync(dir, { recursive: true });
  }
});
var uploadSessions = /* @__PURE__ */ new Map();
setInterval(() => {
  const now = /* @__PURE__ */ new Date();
  uploadSessions.forEach((session, uploadId) => {
    if (now.getTime() - session.createdAt.getTime() > 24 * 60 * 60 * 1e3) {
      const chunkDir = path20.join(CHUNK_DIR, uploadId);
      if (fs15.existsSync(chunkDir)) {
        fs15.rmSync(chunkDir, { recursive: true });
      }
      uploadSessions.delete(uploadId);
    }
  });
}, 60 * 60 * 1e3);
function decodeFilename2(filename) {
  try {
    const urlDecoded = decodeURIComponent(filename);
    if (urlDecoded !== filename) {
      return urlDecoded;
    }
  } catch {
  }
  try {
    const bytes = Buffer.from(filename, "binary");
    const decoded = bytes.toString("utf8");
    if (!decoded.includes("\uFFFD") && decoded !== filename) {
      return decoded;
    }
  } catch {
  }
  return filename;
}
router6.post("/init", (req, res) => {
  try {
    const { filename, totalChunks, mimeType, totalSize, folder } = req.body;
    if (!filename || !totalChunks || !mimeType || !totalSize) {
      return res.status(400).json({ error: "\u7F3A\u5C11\u5FC5\u8981\u53C2\u6570" });
    }
    const normalizedTotalChunks = Number(totalChunks);
    const normalizedTotalSize = Number(totalSize);
    if (!Number.isInteger(normalizedTotalChunks) || normalizedTotalChunks < 1 || normalizedTotalChunks > MAX_TOTAL_CHUNKS || !Number.isFinite(normalizedTotalSize) || normalizedTotalSize < 1) {
      return res.status(400).json({ error: "\u4E0A\u4F20\u53C2\u6570\u65E0\u6548" });
    }
    if (uploadSessions.size >= MAX_UPLOAD_SESSIONS) {
      return res.status(429).json({ error: "\u5F53\u524D\u4E0A\u4F20\u4F1A\u8BDD\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5" });
    }
    const uploadId = uuidv42();
    const chunkDir = path20.join(CHUNK_DIR, uploadId);
    fs15.mkdirSync(chunkDir, { recursive: true });
    uploadSessions.set(uploadId, {
      uploadId,
      filename: decodeFilename2(filename),
      totalChunks: normalizedTotalChunks,
      uploadedChunks: /* @__PURE__ */ new Set(),
      mimeType,
      totalSize: normalizedTotalSize,
      folder,
      createdAt: /* @__PURE__ */ new Date()
    });
    res.json({
      success: true,
      uploadId,
      message: "\u4E0A\u4F20\u4F1A\u8BDD\u5DF2\u521B\u5EFA"
    });
  } catch (error) {
    console.error("\u521D\u59CB\u5316\u5206\u5757\u4E0A\u4F20\u5931\u8D25:", error);
    res.status(500).json({ error: "\u521D\u59CB\u5316\u4E0A\u4F20\u5931\u8D25" });
  }
});
router6.post("/chunk", async (req, res) => {
  try {
    const uploadIdHeader = req.headers["x-upload-id"];
    const chunkIndexHeader = req.headers["x-chunk-index"];
    const uploadId = Array.isArray(uploadIdHeader) ? uploadIdHeader[0] : uploadIdHeader;
    const chunkIndex = parseInt(Array.isArray(chunkIndexHeader) ? chunkIndexHeader[0] : chunkIndexHeader || "", 10);
    if (!uploadId || isNaN(chunkIndex)) {
      return res.status(400).json({ error: "\u7F3A\u5C11\u4E0A\u4F20 ID \u6216\u5206\u5757\u7D22\u5F15" });
    }
    const session = uploadSessions.get(uploadId);
    if (!session) {
      return res.status(404).json({ error: "\u4E0A\u4F20\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F" });
    }
    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      return res.status(400).json({ error: "\u5206\u5757\u7D22\u5F15\u8D85\u51FA\u8303\u56F4" });
    }
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (declaredLength > MAX_CHUNK_BYTES) {
      return res.status(413).json({ error: "\u5355\u4E2A\u5206\u5757\u8FC7\u5927" });
    }
    const chunkPath = path20.join(CHUNK_DIR, uploadId, `chunk_${chunkIndex}`);
    const writeStream = fs15.createWriteStream(chunkPath);
    await new Promise((resolve, reject) => {
      let receivedBytes = 0;
      req.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_CHUNK_BYTES) {
          req.destroy(new Error("\u5355\u4E2A\u5206\u5757\u8FC7\u5927"));
        }
      });
      req.pipe(writeStream);
      req.on("end", () => {
        session.uploadedChunks.add(chunkIndex);
        resolve();
      });
      req.on("error", reject);
      writeStream.on("error", reject);
    });
    const progress = Math.round(session.uploadedChunks.size / session.totalChunks * 100);
    res.json({
      success: true,
      chunkIndex,
      uploadedChunks: session.uploadedChunks.size,
      totalChunks: session.totalChunks,
      progress
    });
  } catch (error) {
    console.error("\u4E0A\u4F20\u5206\u5757\u5931\u8D25:", error);
    res.status(500).json({ error: "\u4E0A\u4F20\u5206\u5757\u5931\u8D25" });
  }
});
router6.post("/complete", async (req, res) => {
  try {
    const { uploadId } = req.body;
    if (!uploadId) {
      return res.status(400).json({ error: "\u7F3A\u5C11\u4E0A\u4F20 ID" });
    }
    const session = uploadSessions.get(uploadId);
    if (!session) {
      return res.status(404).json({ error: "\u4E0A\u4F20\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F" });
    }
    if (session.uploadedChunks.size !== session.totalChunks) {
      return res.status(400).json({
        error: "\u5206\u5757\u4E0D\u5B8C\u6574",
        uploadedChunks: session.uploadedChunks.size,
        totalChunks: session.totalChunks
      });
    }
    const activeAccountId = storageManager.getActiveAccountId();
    const storageRules = await getStoragePathRules();
    const storageFolder = buildStorageFolderWithRules({
      source: "web",
      folder: session.folder || null,
      mimeType: session.mimeType,
      fileName: session.filename
    }, storageRules);
    const storedName = await getUniqueStoredName(session.filename, storageFolder, activeAccountId);
    const tempMergedPath = path20.resolve(path20.join(UPLOAD_DIR8, `${uploadId}-${storedName}`));
    const writeStream = fs15.createWriteStream(tempMergedPath);
    console.log(`[ChunkedComplete] \u{1F9E9} Merging ${session.totalChunks} chunks for: ${session.filename}`);
    console.log(`[ChunkedComplete] \u{1F3E0} Final temp path: ${tempMergedPath}`);
    try {
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path20.join(CHUNK_DIR, uploadId, `chunk_${i}`);
        if (!fs15.existsSync(chunkPath)) {
          throw new Error(`\u7F3A\u5C11\u5206\u5757 ${i}`);
        }
        const chunkStat = fs15.statSync(chunkPath);
        if (chunkStat.size <= 0 || chunkStat.size > MAX_CHUNK_BYTES) {
          throw new Error(`\u5206\u5757 ${i} \u5927\u5C0F\u65E0\u6548`);
        }
        await pipeline(fs15.createReadStream(chunkPath), writeStream, { end: false });
      }
      await new Promise((resolve, reject) => {
        writeStream.end();
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
    } catch (mergeError) {
      writeStream.destroy();
      if (fs15.existsSync(tempMergedPath)) fs15.unlinkSync(tempMergedPath);
      const chunkDir2 = path20.join(CHUNK_DIR, uploadId);
      if (fs15.existsSync(chunkDir2)) fs15.rmSync(chunkDir2, { recursive: true });
      uploadSessions.delete(uploadId);
      return res.status(400).json({ error: mergeError instanceof Error ? mergeError.message : "\u5408\u5E76\u5206\u5757\u5931\u8D25" });
    }
    const mergedStat = fs15.statSync(tempMergedPath);
    if (mergedStat.size !== session.totalSize) {
      if (fs15.existsSync(tempMergedPath)) fs15.unlinkSync(tempMergedPath);
      const chunkDir2 = path20.join(CHUNK_DIR, uploadId);
      if (fs15.existsSync(chunkDir2)) fs15.rmSync(chunkDir2, { recursive: true });
      uploadSessions.delete(uploadId);
      return res.status(400).json({
        error: "\u5408\u5E76\u540E\u6587\u4EF6\u5927\u5C0F\u4E0E\u58F0\u660E\u5927\u5C0F\u4E0D\u4E00\u81F4",
        expectedSize: session.totalSize,
        actualSize: mergedStat.size
      });
    }
    const chunkDir = path20.join(CHUNK_DIR, uploadId);
    fs15.rmSync(chunkDir, { recursive: true });
    uploadSessions.delete(uploadId);
    const duplicateMode = await getDuplicateMode();
    if (duplicateMode === "skip") {
      const duplicate = await findDuplicateFile(session.filename, storageFolder, session.totalSize, activeAccountId);
      if (duplicate) {
        if (fs15.existsSync(tempMergedPath)) fs15.unlinkSync(tempMergedPath);
        return res.json({
          success: true,
          skipped: true,
          reason: "duplicate",
          file: {
            id: duplicate.id,
            name: duplicate.name,
            size: duplicate.size,
            folder: duplicate.folder,
            date: duplicate.created_at
          }
        });
      }
    }
    let thumbnailPath = null;
    let previewPath = null;
    let width = null;
    let height = null;
    const provider = storageManager.getProvider();
    if (provider.name === "local" && (session.mimeType.startsWith("image/") || session.mimeType.startsWith("video/"))) {
      try {
        console.log(`[ChunkedComplete] \u{1F5BC}\uFE0F  MIME: ${session.mimeType}, starting generation...`);
        const thumbResult = await generateThumbnail(tempMergedPath, storedName, session.mimeType);
        if (thumbResult) {
          thumbnailPath = path20.basename(thumbResult);
          console.log(`[ChunkedComplete] \u2728 Thumbnail generated: ${thumbnailPath}`);
          const dims = await getImageDimensions(tempMergedPath, session.mimeType);
          width = dims.width;
          height = dims.height;
        } else {
          console.log(`[ChunkedComplete] \u26A0\uFE0F  No thumbnail generated for: ${session.mimeType}`);
        }
      } catch (error) {
        console.error("\u751F\u6210\u7F29\u7565\u56FE\u5931\u8D25:", error);
      }
    }
    if (provider.name === "local" && session.mimeType.startsWith("image/")) {
      try {
        const previewResult = await generateMediaPreview(tempMergedPath, storedName, session.mimeType);
        if (previewResult) {
          previewPath = path20.basename(previewResult);
          console.log(`[ChunkedComplete] \u{1F39E}\uFE0F Image preview generated: ${previewPath}`);
        }
      } catch (error) {
        console.error("\u751F\u6210\u56FE\u7247\u9884\u89C8\u5931\u8D25:", error);
      }
    }
    let storedPath = "";
    console.log(`[ChunkedComplete] \u{1F6E0}\uFE0F  Provider: ${provider.name}, accountId: ${activeAccountId || "none (local)"}`);
    try {
      storedPath = await provider.saveFile(tempMergedPath, storedName, session.mimeType, storageFolder);
    } catch (err) {
      if (fs15.existsSync(tempMergedPath)) fs15.unlinkSync(tempMergedPath);
      throw err;
    }
    if (fs15.existsSync(tempMergedPath)) {
      try {
        fs15.unlinkSync(tempMergedPath);
      } catch (e) {
      }
    }
    const type = session.mimeType.startsWith("image/") ? "image" : session.mimeType.startsWith("video/") ? "video" : session.mimeType.startsWith("audio/") ? "audio" : "other";
    const result = await query(
      `INSERT INTO files
            (name, stored_name, type, mime_type, size, path, thumbnail_path, preview_path, width, height, source, folder, storage_account_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id, created_at, name, type, size`,
      [session.filename, storedName, type, session.mimeType, session.totalSize, storedPath, thumbnailPath, previewPath, width, height, provider.name, storageFolder, activeAccountId]
    );
    const newFile = result.rows[0];
    if (provider.name === "local" && type === "video") {
      void generateMediaPreview(storedPath, storedName, session.mimeType).then(async (previewResult) => {
        if (!previewResult) return;
        const generatedPreviewName = path20.basename(previewResult);
        await query("UPDATE files SET preview_path = $1, updated_at = NOW() WHERE id = $2", [generatedPreviewName, newFile.id]);
        console.log(`[ChunkedComplete] \u{1F39E}\uFE0F Video preview generated async: ${generatedPreviewName}`);
      }).catch((error) => console.error("\u5F02\u6B65\u751F\u6210\u89C6\u9891\u9884\u89C8\u5931\u8D25:", error));
    }
    res.json({
      success: true,
      file: {
        id: newFile.id,
        name: newFile.name,
        type: newFile.type,
        size: newFile.size,
        thumbnailUrl: thumbnailPath ? getSignedUrl(newFile.id, "thumbnail") : void 0,
        previewUrl: getSignedUrl(newFile.id, "preview"),
        date: newFile.created_at,
        source: provider.name
      }
    });
  } catch (error) {
    console.error("\u5B8C\u6210\u4E0A\u4F20\u5931\u8D25:", error);
    res.status(500).json({ error: "\u5B8C\u6210\u4E0A\u4F20\u5931\u8D25" });
  }
});
router6.delete("/:uploadId", (req, res) => {
  try {
    const uploadId = req.params.uploadId;
    const session = uploadSessions.get(uploadId);
    if (session) {
      const chunkDir = path20.join(CHUNK_DIR, uploadId);
      if (fs15.existsSync(chunkDir)) {
        fs15.rmSync(chunkDir, { recursive: true });
      }
      uploadSessions.delete(uploadId);
    }
    res.json({ success: true, message: "\u4E0A\u4F20\u5DF2\u53D6\u6D88" });
  } catch (error) {
    console.error("\u53D6\u6D88\u4E0A\u4F20\u5931\u8D25:", error);
    res.status(500).json({ error: "\u53D6\u6D88\u4E0A\u4F20\u5931\u8D25" });
  }
});
router6.get("/:uploadId/status", (req, res) => {
  try {
    const uploadId = req.params.uploadId;
    const session = uploadSessions.get(uploadId);
    if (!session) {
      return res.status(404).json({ error: "\u4E0A\u4F20\u4F1A\u8BDD\u4E0D\u5B58\u5728" });
    }
    res.json({
      uploadId: session.uploadId,
      filename: session.filename,
      totalChunks: session.totalChunks,
      uploadedChunks: session.uploadedChunks.size,
      progress: Math.round(session.uploadedChunks.size / session.totalChunks * 100)
    });
  } catch (error) {
    console.error("\u83B7\u53D6\u4E0A\u4F20\u72B6\u6001\u5931\u8D25:", error);
    res.status(500).json({ error: "\u83B7\u53D6\u4E0A\u4F20\u72B6\u6001\u5931\u8D25" });
  }
});
var chunkedUpload_default = router6;

// src/index.ts
import helmet from "helmet";
dotenv3.config();
var app = express();
app.set("trust proxy", process.env.TRUST_PROXY || "loopback");
var PORT = process.env.PORT || 51947;
var UPLOAD_DIR9 = process.env.UPLOAD_DIR || "./data/uploads";
var THUMBNAIL_DIR8 = process.env.THUMBNAIL_DIR || "./data/thumbnails";
var PREVIEW_DIR4 = process.env.PREVIEW_DIR || "./data/previews";
var CHUNK_DIR2 = process.env.CHUNK_DIR || "./data/chunks";
if (!fs16.existsSync(UPLOAD_DIR9)) {
  fs16.mkdirSync(UPLOAD_DIR9, { recursive: true });
  console.log(`\u{1F4C1} \u521B\u5EFA\u4E0A\u4F20\u76EE\u5F55: ${UPLOAD_DIR9}`);
}
if (!fs16.existsSync(THUMBNAIL_DIR8)) {
  fs16.mkdirSync(THUMBNAIL_DIR8, { recursive: true });
  console.log(`\u{1F4C1} \u521B\u5EFA\u7F29\u7565\u56FE\u76EE\u5F55: ${THUMBNAIL_DIR8}`);
}
if (!fs16.existsSync(PREVIEW_DIR4)) {
  fs16.mkdirSync(PREVIEW_DIR4, { recursive: true });
  console.log(`\u{1F39E}\uFE0F \u521B\u5EFA\u9884\u89C8\u76EE\u5F55: ${PREVIEW_DIR4}`);
}
if (!fs16.existsSync(CHUNK_DIR2)) {
  fs16.mkdirSync(CHUNK_DIR2, { recursive: true });
  console.log(`\u{1F4C1} \u521B\u5EFA\u5206\u5757\u76EE\u5F55: ${CHUNK_DIR2}`);
}
var configuredCorsOrigin = process.env.CORS_ORIGIN || "";
var allowedOrigins = configuredCorsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean);
var allowAnyOrigin = allowedOrigins.includes("*");
app.use(cors({
  origin: allowAnyOrigin ? true : (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: !allowAnyOrigin,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "X-API-Key", "X-Upload-Id", "X-Chunk-Index", "Authorization"]
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "2mb" }));
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!allowAnyOrigin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "media-src": ["'self'", "blob:", "https:"],
      "connect-src": ["'self'", "https:"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "script-src": ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: { maxAge: 31536e3, includeSubDomains: true }
}));
app.use("/api/auth", auth_default);
app.use("/uploads", requireAuth, express.static(UPLOAD_DIR9, {
  maxAge: "1d",
  etag: true
}));
app.use("/thumbnails", requireAuth, express.static(THUMBNAIL_DIR8, {
  maxAge: "7d",
  etag: true
}));
app.use("/api/files", folderOperations_default);
app.use("/api/files", requireAuthOrSignedUrl, files_default);
app.use("/api/upload", requireAuth, upload_default);
app.use("/api/v1/upload", requireAuth, upload_default);
app.use("/api/chunked", requireAuth, chunkedUpload_default);
app.use("/api/storage", storage_default);
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
});
app.use((err, _req, res, _next) => {
  console.error("\u274C \u9519\u8BEF:", err);
  res.status(500).json({ error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF" });
});
app.listen(PORT, async () => {
  const telegramEnabled = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_API_ID && !!process.env.TELEGRAM_API_HASH;
  try {
    const { storageManager: storageManager2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
    await storageManager2.init();
  } catch (e) {
    console.error("\u5B58\u50A8\u7BA1\u7406\u5668\u521D\u59CB\u5316\u5931\u8D25:", e);
  }
  if (telegramEnabled) {
    await initTelegramUserClient();
    await initTelegramBot();
  }
  const initialSetupRequired = await isInitialSetupRequired();
  console.log(`
\u{1F680} TG Vault \u540E\u7AEF\u670D\u52A1\u5DF2\u542F\u52A8
\u{1F4CD} \u7AEF\u53E3: ${PORT}
\u{1F4C1} \u4E0A\u4F20\u76EE\u5F55: ${path21.resolve(UPLOAD_DIR9)}
\u{1F5BC}\uFE0F  \u7F29\u7565\u56FE\u76EE\u5F55: ${path21.resolve(THUMBNAIL_DIR8)}
\u{1F39E}\uFE0F  \u9884\u89C8\u76EE\u5F55: ${path21.resolve(PREVIEW_DIR4)}
\u{1F510} \u5BC6\u7801\u4FDD\u62A4: ${initialSetupRequired ? "\u5F85\u9996\u6B21\u521D\u59CB\u5316" : "\u5DF2\u542F\u7528"}
\u{1F916} Telegram Bot: ${telegramEnabled ? "\u5DF2\u542F\u7528 (\u6700\u5927 2GB\uFF0C\u8D26\u53F7\u7EA7\u4E0B\u8F7D\u5668\u4E0D\u53D7\u6B64\u9650\u5236)" : "\u672A\u542F\u7528"}
\u{1F464} Telegram User Download: ${isTelegramUserClientReady() ? "\u5DF2\u542F\u7528" : "\u672A\u542F\u7528"}
    `);
});
var index_default = app;
export {
  index_default as default
};
