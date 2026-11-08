<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import DocIcon from './DocIcon.vue';

const showToast = inject<(msg: string) => void>('vaultToast', () => {});

interface FlowMode {
  id: string;
  tab: string;
  kicker: string;
  sourceIcon: string;
  sourceTitle: string;
  sourceSub: string;
  sourceTag: string;
  connector: string;
  coreName: string;
  coreSub: string;
  coreChip: string;
  steps: [string, string, string];
  gateways: [
    { icon: string; title: string; sub: string; link: string },
    { icon: string; title: string; sub: string; link: string }
  ];
  destIcon: string;
  destTitle: string;
  destSub: string;
  destTag: string;
  footNote: string;
}

const flowModes: FlowMode[] = [
  {
    id: 'schedule',
    tab: '多账号与订阅',
    kicker: '多账号调度',
    sourceIcon: 'telegram',
    sourceTitle: 'Telegram 频道 · 群组',
    sourceSub: '按日期 / 标签批量下载，或自动订阅新内容',
    sourceTag: '来源权限优先',
    connector: '扫描与文件任务',
    coreName: 'TG Vault',
    coreSub: 'on your server',
    coreChip: '加权最少连接',
    steps: ['权限与冷却过滤', '空闲与负载分配', '单账号完整拉取'],
    gateways: [
      { icon: 'users', title: '个人账号池', sub: 'MTProto · 独立连接恢复', link: '/usage/multi-account' },
      { icon: 'sync', title: '频道订阅中心', sub: '类型筛选 · 广告过滤', link: '/usage/subscriptions' },
    ],
    destIcon: 'cloud-upload',
    destTitle: 'Your Storage Vault',
    destSub: '本地磁盘与 6 类已授权云存储账户',
    destTag: '7 类存储目标',
    footNote: '一个文件由单个账号完整下载，不跨账号分片；存储确认并入库后才计为完成。',
  },
  {
    id: 'transfer',
    tab: 'Bot 与 Web 转存',
    kicker: '持久队列',
    sourceIcon: 'telegram',
    sourceTitle: '私人 Bot · Web 上传',
    sourceSub: '转发私聊媒体组，或在网页端分片续传',
    sourceTag: '允许列表鉴权',
    connector: '持久排队与暂存',
    coreName: 'TG Vault',
    coreSub: 'PostgreSQL 队列',
    coreChip: '重启可恢复',
    steps: ['持久队列记录', '本地暂存 / 分片上传', '入库建立索引'],
    gateways: [
      { icon: 'queue', title: '统一任务中心', sub: '进度 · 暂停 · 失败明细', link: '/usage/tasks' },
      { icon: 'folder', title: 'Web 文件管理', sub: '搜索 · 整理 · 在线预览', link: '/usage/files' },
    ],
    destIcon: 'disk',
    destTitle: 'Target Storage',
    destSub: '按默认账户或任务固定目标归档保存',
    destTag: '目标隔离',
    footNote: '切换默认存储不改变已创建任务的目标；远端存储上传仍需本地暂存空间。',
  },
  {
    id: 'extensions',
    tab: 'MCP 与 BT 扩展',
    kicker: '可选扩展',
    sourceIcon: 'cpu',
    sourceTitle: 'AI Agent (MCP) · qBittorrent',
    sourceSub: 'Streamable HTTP / stdio 接入，或磁力种子联动',
    sourceTag: '默认关闭',
    connector: '专用令牌 / 本机回环',
    coreName: 'TG Vault',
    coreSub: '统一后端边界',
    coreChip: '精细权限隔离',
    steps: ['dryRun 预览确认', '票据分块直传', '下载后转存 / 做种'],
    gateways: [
      { icon: 'cpu', title: 'MCP 连接 AI Agent', sub: 'Codex · Rikka · 读写归档', link: '/usage/mcp' },
      { icon: 'magnet', title: 'qBittorrent 扩展', sub: '文件选择 · 自动转存', link: '/usage/qbittorrent' },
    ],
    destIcon: 'layers',
    destTitle: 'Unified File Index',
    destSub: '按客户端授权范围访问指定存储与任务',
    destTag: '安全可控',
    footNote: 'MCP 使用独立 Bearer 令牌，qBittorrent 仅连接本机 127.0.0.1 下载器端口。',
  },
];

const activeFlowId = ref<string>('schedule');
const currentFlow = computed(() => flowModes.find(item => item.id === activeFlowId.value) || flowModes[0]);

interface StorageItem {
  id: string;
  name: string;
  badge: string;
  icon: string;
  link: string;
  summary: string;
  prep: string;
  mechanism: string;
  boundary: string;
  autoDefault: string;
}

const storages: StorageItem[] = [
  {
    id: 'local',
    name: '本地磁盘',
    badge: '默认内置 · 零外部依赖',
    icon: 'disk',
    link: '/storage/local',
    summary: '直接保存在服务器挂载的数据目录中，适合高速读写、大容量数据盘挂载与基础独立部署。',
    prep: '宿主机挂载目录、充足磁盘空间与读写权限，无需注册云平台账号。',
    mechanism: '文件下载或上传完成后直接写入受管数据目录并建立 PostgreSQL 索引。',
    boundary: '禁止使用 docker compose down -v；迁移或升级时须完整保留数据目录与权限。',
    autoDefault: '初始默认存储',
  },
  {
    id: 'onedrive',
    name: 'OneDrive',
    badge: 'OAuth 2.0 · 多账户支持',
    icon: 'cloud',
    link: '/storage/onedrive',
    summary: '通过 Microsoft Graph Web 应用接入国际版个人或商业 OneDrive，支持分片续传与多账户并存。',
    prep: 'Azure 应用 Client ID / Secret、精确匹配的 HTTPS 回调地址与网页登录授权。',
    mechanism: '创建上传会话后分块传输，中断后可根据已确认偏移恢复上传。',
    boundary: '授权成功后会自动设为当前默认存储；移除账户不会删除 OneDrive 远端已有文件。',
    autoDefault: '授权后自动设为默认',
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    badge: 'Drive API · 个人与共享盘',
    icon: 'cloud-upload',
    link: '/storage/google-drive',
    summary: '接入 Google Drive 个人云端硬盘或共享云端硬盘，支持大文件断点续传与回收站安全删除。',
    prep: '启用 Google Drive API、配置 Web OAuth 客户端凭据与授权回调 URL。',
    mechanism: '基于 Resumable Upload 会话传输大文件，删除操作将远端文件移入回收站并清理索引。',
    boundary: 'Google Drive 不等同于 Google Cloud Storage；测试阶段应用需将账号加入测试用户。',
    autoDefault: '授权后自动设为默认',
  },
  {
    id: 's3',
    name: 'S3 与 Cloudflare R2',
    badge: 'S3 兼容协议 · 分片直传',
    icon: 'server',
    link: '/storage/s3',
    summary: '兼容 AWS S3、Cloudflare R2、MinIO 等对象存储服务，适合低成本归档与高并发分块写入。',
    prep: 'HTTPS S3 Endpoint、Region、Bucket 名称及具备读写权限的 AccessKey / SecretKey。',
    mechanism: '采用标准 Multipart Upload 分片上传并校验，完成后写入对象键并建立本地元数据。',
    boundary: '添加成功后不会自动切换为默认存储；需要在存储列表按需手动设为默认。',
    autoDefault: '需手动设为默认',
  },
  {
    id: 'oss',
    name: '阿里云 OSS',
    badge: '对象存储 · RAM 最小权限',
    icon: 'cloud',
    link: '/storage/oss',
    summary: '原生对接阿里云对象存储 OSS，支持专用 RAM 子账号授权与同地域内网高速传输。',
    prep: 'OSS Bucket、所属 Region 标识以及仅授予该 Bucket 权限的 RAM AccessKey。',
    mechanism: '通过分片上传写入目标 Bucket 与前缀目录，完成后校验大小并入库。',
    boundary: '阿里云 OSS 是对象存储服务，不是“阿里云盘”；请勿填写个人云盘账号。',
    autoDefault: '需手动设为默认',
  },
  {
    id: 'webdav',
    name: 'WebDAV 与 NAS',
    badge: 'Basic / Digest 认证',
    icon: 'folder',
    link: '/storage/webdav',
    summary: '连接群晖 / 威联通 NAS、Nextcloud 或自建 DAV 服务，把 Telegram 文件直接归档到私有存储。',
    prep: 'WebDAV 完整服务地址、独立应用用户名与口令（支持 Basic 与 Digest 认证）。',
    mechanism: '按目标目录层级自动创建子目录并流式写入文件，核对响应状态与文件大小。',
    boundary: '经网关挂载网盘时，WebDAV 接收成功不代表上游云盘官方后台已完成秒传或同步。',
    autoDefault: '需手动设为默认',
  },
  {
    id: 'openlist',
    name: 'OpenList 原生接入',
    badge: '原生 API · 多网盘聚合',
    icon: 'layers',
    link: '/storage/openlist',
    summary: '直接对接已挂载存储的 OpenList 实例，无需经过传统 WebDAV 转译即可写入目标挂载路径。',
    prep: 'OpenList 站点地址、已挂载的虚拟目录路径以及具备写入权限的专用用户凭据。',
    mechanism: '通过 OpenList 原生接口验证目录并传输文件，实时反馈转存进度。',
    boundary: '当前 OpenList 驱动不支持远端删除与创建公开分享，实际可用操作以账户能力为准。',
    autoDefault: '需手动设为默认',
  },
];

const activeStorageId = ref<string>('local');
const currentStorage = computed(() => storages.find(item => item.id === activeStorageId.value) || storages[0]);

const installCmd = 'curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash';
const copiedCmd = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyInstallCmd() {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(installCmd);
    } else {
      const ta = document.createElement('textarea');
      ta.value = installCmd;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    copiedCmd.value = true;
    showToast('部署命令已复制');
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copiedCmd.value = false;
    }, 1800);
  } catch {
    showToast('请手动选中命令复制');
  }
}

const features = [
  {
    icon: 'terminal',
    title: 'Docker 一键部署',
    text: '安装向导收集域名与目录配置，自动生成密钥、准备镜像，完成独立数据库迁移后启动服务。',
    link: '/guide/quick-start',
    label: '阅读文档',
  },
  {
    icon: 'queue',
    title: '持久队列，重启可恢复',
    text: 'PostgreSQL 持久化保存任务与分片状态，在 Web 与 Bot 同步查看进度、暂停、继续或分页排查失败原因。',
    link: '/usage/tasks',
    label: '阅读文档',
  },
  {
    icon: 'folder',
    title: 'Web 文件管理与预览',
    text: '支持网页分片上传、关键词搜索、收藏标记、文件夹整理与音视频图片在线预览，不必回到终端操作。',
    link: '/usage/files',
    label: '阅读文档',
  },
  {
    icon: 'server',
    title: '资源预算与并发控制',
    text: '结合服务器 CPU、内存与本地暂存空间设置下载并发，单文件单账号完整读取，稳妥应对大文件转存。',
    link: '/deploy/resources',
    label: '阅读文档',
  },
  {
    icon: 'shield',
    title: '私人实例，明确权限',
    text: '管理员强密码、Bot 允许列表、TOTP 双重验证与加密存储凭据，保护你自己的服务器与归档文件。',
    link: '/reference/security',
    label: '阅读文档',
  },
  {
    icon: 'cpu',
    title: 'MCP 与 BT 可选扩展',
    text: '按需开启 MCP 让 AI Agent 安全读写归档，或连接本机 qBittorrent 将完成的种子下载自动转存。',
    link: '/usage/mcp',
    label: '阅读文档',
  },
];

const steps = [
  { num: '01', title: '准备服务器与域名', text: '确认 Linux、Docker、HTTPS 双入口与专用数据磁盘。', link: '/guide/prerequisites' },
  { num: '02', title: '运行安装向导', text: '运行一条命令，自动下载项目并启动安装向导。', link: '/guide/quick-start' },
  { num: '03', title: '连接 Telegram 与存储', text: '配置私人 Bot，按需登录个人账号并接入目标存储。', link: '/deploy/telegram' },
  { num: '04', title: '发送第一个小文件', text: '核对任务状态，在实际存储中检查位置与文件完整性。', link: '/usage/first-transfer' },
];
</script>

<template>
  <div class="vault-home">
    <!-- Hero Section -->
    <section class="hero-section" aria-labelledby="vault-home-title">
      <div class="hero-wrap">
        <div class="hero-copy">
          <a class="release-pill" href="/reference/changelog">
            <span class="dot" />
            <span>v3.0.0 文档</span>
            <span class="pill-divider" />
            <span>多账号 · 7 类存储 · MCP</span>
            <DocIcon name="arrow" :size="13" />
          </a>
          <h1 id="vault-home-title">
            <span class="hero-brand">TG Vault</span>
            <span>从 Telegram，</span>
            <span>到你的私有存储库。</span>
          </h1>
          <p class="hero-description">
            连接多个 Telegram 账号，按权限、冷却与负载分配任务。<br>
            订阅频道、批量归档或转发给私人 Bot，把文件有序存入<br class="desktop-break">
            本地磁盘与你自己授权的云端。
          </p>
          <div class="hero-actions">
            <a class="button primary" href="/guide/quick-start">
              <span>从零开始部署</span>
              <DocIcon name="arrow" :size="16" />
            </a>
            <a class="button secondary" href="/usage/multi-account">
              <DocIcon name="users" :size="16" />
              <span>了解多账号调度</span>
            </a>
          </div>
          <div class="hero-cmd" role="region" aria-label="快速部署命令">
            <span class="cmd-prompt" aria-hidden="true">$</span>
            <code>{{ installCmd }}</code>
            <span class="cmd-hint">自动下载并启动安装向导</span>
            <button type="button" class="cmd-copy" :aria-label="copiedCmd ? '命令已复制' : '复制一键安装命令'" @click="copyInstallCmd">
              <DocIcon :name="copiedCmd ? 'check' : 'copy'" :size="13" />
              <span>{{ copiedCmd ? '已复制' : '复制命令' }}</span>
            </button>
          </div>
          <div class="hero-tags">
            <span><DocIcon name="code" :size="14" /> 开源自托管</span>
            <span><DocIcon name="users" :size="14" /> 多账号协同</span>
            <span><DocIcon name="cloud" :size="14" /> 七类存储目标</span>
            <span><DocIcon name="cpu" :size="14" /> MCP AI 接入</span>
          </div>
        </div>

        <div class="hero-visual">
          <div class="route-card">
            <div class="route-header">
              <span class="route-title">
                <span class="mini-brand">
                  <img class="brand-mark" src="/logo.webp?v=logo15-482cd86d" width="27" height="27" alt="">
                </span>
                <span>你的文件，你的归档路径</span>
              </span>
              <div class="route-tabs" role="tablist" aria-label="切换工作原理视图">
                <button
                  v-for="mode in flowModes"
                  :key="mode.id"
                  type="button"
                  role="tab"
                  class="route-tab"
                  :class="{ active: activeFlowId === mode.id }"
                  :aria-selected="activeFlowId === mode.id"
                  @click="activeFlowId = mode.id"
                >
                  {{ mode.tab }}
                </button>
              </div>
            </div>

            <div class="route-source">
              <span class="route-source-icon">
                <DocIcon :name="currentFlow.sourceIcon" :size="22" />
              </span>
              <div>
                <strong>{{ currentFlow.sourceTitle }}</strong>
                <span>{{ currentFlow.sourceSub }}</span>
              </div>
              <span class="small-tag">{{ currentFlow.sourceTag }}</span>
            </div>

            <div class="route-connector">
              <span />
              <small>{{ currentFlow.connector }}</small>
            </div>

            <div class="route-core">
              <div class="core-top">
                <span>
                  <DocIcon name="server" :size="18" />
                  <span>{{ currentFlow.coreName }}</span>
                  <small>{{ currentFlow.coreSub }}</small>
                </span>
                <span class="core-chip">{{ currentFlow.coreChip }}</span>
              </div>
              <div class="core-steps">
                <span>{{ currentFlow.steps[0] }}</span>
                <b>→</b>
                <span>{{ currentFlow.steps[1] }}</span>
                <b>→</b>
                <span>{{ currentFlow.steps[2] }}</span>
              </div>
            </div>

            <div class="route-split" aria-hidden="true"><span /><span /></div>

            <div class="gateway-pair">
              <a v-for="gw in currentFlow.gateways" :key="gw.link" :href="gw.link" class="gateway">
                <DocIcon :name="gw.icon" :size="22" />
                <strong>{{ gw.title }}</strong>
                <span>{{ gw.sub }}</span>
              </a>
            </div>

            <div class="route-merge" aria-hidden="true"><span /><span /></div>

            <a class="route-destination" href="/storage/">
              <DocIcon :name="currentFlow.destIcon" :size="26" />
              <div>
                <strong>{{ currentFlow.destTitle }}</strong>
                <span>{{ currentFlow.destSub }}</span>
              </div>
              <span class="destination-tag">{{ currentFlow.destTag }}</span>
            </a>

            <div class="route-foot">
              <DocIcon name="info" :size="12" />
              <span>{{ currentFlow.footNote }}</span>
            </div>
          </div>
          <div class="hero-visual-caption">
            <span class="caption-line" />
            <span>FROM TELEGRAM TO YOUR STORAGE VAULT</span>
            <span class="caption-line" />
          </div>
        </div>
      </div>
    </section>

    <!-- Core Twin-Engine Section (tg2cloud edition-section layout) -->
    <section class="edition-section home-container" aria-labelledby="telegram-workflow-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">ONE CORE. TWO ENGINES.</span>
          <h2 id="telegram-workflow-title">多账号调度，频道持续同步。</h2>
        </div>
        <a class="text-link" href="/deploy/telegram">
          <span>配置 Telegram 连接</span>
          <DocIcon name="arrow" :size="15" />
        </a>
      </div>
      <div class="edition-grid">
        <a href="/usage/multi-account" class="edition-card">
          <div class="edition-icon cd2">
            <DocIcon name="users" :size="26" />
          </div>
          <div class="edition-copy">
            <span class="eyebrow">MULTI-ACCOUNT SCHEDULING</span>
            <h3>让合适的账号处理任务</h3>
            <p>来源权限优先，避开冷却与离线账号；同等条件先分配空闲账号，再按权重与连接负载选择。</p>
            <div class="edition-meta">
              <span>来源权限感知</span>
              <span>加权最少连接</span>
              <span>独立连接恢复</span>
            </div>
          </div>
          <span class="round-arrow"><DocIcon name="arrow" :size="13" /></span>
        </a>

        <a href="/usage/subscriptions" class="edition-card">
          <div class="edition-icon openlist">
            <DocIcon name="sync" :size="25" />
          </div>
          <div class="edition-copy">
            <span class="eyebrow">CHANNELS &amp; SUBSCRIPTIONS</span>
            <h3>历史下载与新内容订阅</h3>
            <p>按日期或标签批量归档历史文件，持续同步频道新内容；目标存储、目录和过滤规则分别配置。</p>
            <div class="edition-meta">
              <span>日期 / 标签归档</span>
              <span>自动增量订阅</span>
              <span>文件与广告过滤</span>
            </div>
          </div>
          <span class="round-arrow"><DocIcon name="arrow" :size="13" /></span>
        </a>
      </div>
    </section>

    <!-- Creative Interactive 7-Storage Explorer -->
    <section class="storage-section home-container" aria-labelledby="storage-explorer-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">SEVEN STORAGE TARGETS. ONE UNIFIED INDEX.</span>
          <h2 id="storage-explorer-title">七类存储接入，按你的资源自由组合。</h2>
        </div>
        <a class="text-link" href="/storage/">
          <span>存储接入总览</span>
          <DocIcon name="arrow" :size="15" />
        </a>
      </div>

      <div class="storage-explorer">
        <div class="storage-tabs" role="tablist" aria-label="选择存储类型查看接入详情">
          <button
            v-for="item in storages"
            :key="item.id"
            type="button"
            role="tab"
            class="storage-tab"
            :class="{ active: activeStorageId === item.id }"
            :aria-selected="activeStorageId === item.id"
            @click="activeStorageId = item.id"
          >
            <DocIcon :name="item.icon" :size="15" />
            <span>{{ item.name }}</span>
          </button>
        </div>

        <div class="storage-panel" role="tabpanel">
          <div class="storage-panel-main">
            <div class="storage-panel-head">
              <span class="storage-panel-icon">
                <DocIcon :name="currentStorage.icon" :size="22" />
              </span>
              <div>
                <div class="storage-title-row">
                  <h3>{{ currentStorage.name }}</h3>
                  <span class="storage-badge">{{ currentStorage.badge }}</span>
                </div>
                <span class="storage-default-note">{{ currentStorage.autoDefault }}</span>
              </div>
            </div>
            <p class="storage-summary">{{ currentStorage.summary }}</p>
            <div class="storage-actions">
              <a class="button primary compact-btn" :href="currentStorage.link">
                <span>查看 {{ currentStorage.name }} 教程</span>
                <DocIcon name="arrow" :size="14" />
              </a>
              <a class="text-link" href="/storage/">对比全部 7 类存储 →</a>
            </div>
          </div>

          <div class="storage-specs">
            <div class="storage-spec-item">
              <span class="spec-label">01 · 需要准备</span>
              <p>{{ currentStorage.prep }}</p>
            </div>
            <div class="storage-spec-item">
              <span class="spec-label">02 · 写入与入库</span>
              <p>{{ currentStorage.mechanism }}</p>
            </div>
            <div class="storage-spec-item">
              <span class="spec-label">03 · 核对与边界</span>
              <p>{{ currentStorage.boundary }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Built for Your Workflow (tg2cloud 6-card feature grid) -->
    <section class="features-section home-container" aria-labelledby="features-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">BUILT FOR YOUR WORKFLOW</span>
          <h2 id="features-title">不只传过去，也把全过程管起来。</h2>
        </div>
        <p class="section-side-note">
          部署、转存、管理、运维<br>
          一份文档，按步骤找到答案。
        </p>
      </div>
      <div class="feature-grid">
        <a v-for="feature in features" :key="feature.link" class="feature-card" :href="feature.link">
          <span class="feature-icon">
            <DocIcon :name="feature.icon" :size="20" />
          </span>
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.text }}</p>
          <span class="feature-link">
            <span>{{ feature.label }}</span>
            <DocIcon name="arrow" :size="12" />
          </span>
        </a>
      </div>
    </section>

    <!-- Start Here Reading Route (tg2cloud reading-section) -->
    <section class="reading-section home-container" aria-labelledby="getting-started-title">
      <div class="reading-copy">
        <span class="eyebrow">START HERE</span>
        <h2 id="getting-started-title">第一次使用？<br>沿这条路线就好。</h2>
        <p>
          不必一次读完整站。先让一个小文件<br>
          安全入库，再开启批量下载与自动订阅。
        </p>
        <a class="text-link" href="/guide/quick-start">
          <span>查看完整部署教程</span>
          <DocIcon name="arrow" :size="15" />
        </a>
      </div>
      <div class="reading-steps">
        <a v-for="step in steps" :key="step.link" :href="step.link" class="reading-step">
          <span>{{ step.num }}</span>
          <div>
            <h3>{{ step.title }}</h3>
            <p>{{ step.text }}</p>
          </div>
          <DocIcon name="arrow" :size="16" />
        </a>
      </div>
    </section>

    <!-- Release Banner & Notice (tg2cloud release-section) -->
    <section class="release-section home-container" aria-labelledby="release-title">
      <div class="release-banner">
        <div>
          <span class="eyebrow">DOCUMENTED VERSION</span>
          <h2 id="release-title">v3.0.0 文档，对应当前仓库源码。</h2>
          <p>了解 MCP AI 接入、文件写入保护与新版外观；升级前请先备份数据库与数据目录，并核对迁移和兼容性说明。</p>
        </div>
        <div class="release-actions">
          <a class="button primary" href="/reference/changelog">
            <DocIcon name="file" :size="16" />
            <span>查看更新日志</span>
          </a>
          <a class="release-secondary" href="https://github.com/hicocos/tg-vault/releases/latest" target="_blank" rel="noopener noreferrer">
            前往 GitHub 最新 Release ↗
          </a>
        </div>
      </div>
      <div class="home-notice">
        <DocIcon name="info" :size="15" />
        <p>
          <strong>使用前请注意：</strong>频道历史下载与自动订阅需要拥有来源访问权限的 Telegram 个人账号，不绕过私有权限、受保护内容或服务端限流。只保存你有权访问和归档的内容；各类凭据仅填写在你自己的管理后台。可选扩展见 <a href="/usage/mcp">MCP AI 接入</a> 与 <a href="/usage/qbittorrent">qBittorrent 下载转存</a>。
        </p>
      </div>
    </section>
  </div>
</template>
