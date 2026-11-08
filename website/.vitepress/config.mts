import { defineConfig } from 'vitepress';
import { tokenize } from './search';

const siteUrl = (process.env.SITE_URL || 'https://tgvault.pages.dev').replace(/\/$/, '');
if (siteUrl && new URL(siteUrl).origin !== siteUrl) throw new Error('SITE_URL must be an origin without a path.');

export default defineConfig({
  lang: 'zh-CN',
  title: 'TG Vault',
  description: 'TG Vault：多 Telegram 账号调度、频道下载与订阅、Web 文件管理和多存储归档。',
  srcDir: './src',
  cleanUrls: true,
  lastUpdated: false,
  markdown: { toc: { level: [2] } },
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png?v=logo15-482cd86d' }],
    ['link', { rel: 'shortcut icon', href: '/favicon.ico?v=logo15-482cd86d' }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png?v=logo15-482cd86d' }],
    ['meta', { name: 'theme-color', content: '#f8faff' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'zh_CN' }],
  ],
  sitemap: siteUrl ? { hostname: siteUrl } : undefined,
  transformHead({ pageData }) {
    if (!siteUrl) return [];
    const url = new URL(pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, ''), `${siteUrl}/`).href;
    return [['link', { rel: 'canonical', href: url }], ['meta', { property: 'og:url', content: url }]];
  },
  themeConfig: {
    logo: { src: '/logo.webp?v=logo15-482cd86d', alt: 'TG Vault' },
    siteTitle: 'TG Vault',
    nav: [
      { text: '指南', link: '/guide/introduction', activeMatch: '^/(guide/introduction|guide/concepts|deploy/|storage/|usage/|operations/)' },
      { text: '多账号调度', link: '/usage/multi-account', activeMatch: '^/usage/multi-account' },
      { text: '从零部署', link: '/guide/quick-start', activeMatch: '^/guide/(prerequisites|quick-start)' },
      { text: '常见问题', link: '/troubleshooting/', activeMatch: '^/troubleshooting/' },
      { text: '更新日志', link: '/reference/changelog', activeMatch: '^/reference/changelog' },
    ],
    sidebar: [
      { text: '开始使用', items: [
        { text: '认识 TG Vault', link: '/guide/introduction' },
        { text: '部署前准备', link: '/guide/prerequisites' },
        { text: '从零开始', link: '/guide/quick-start' },
        { text: '工作原理与完成边界', link: '/guide/concepts' },
      ] },
      { text: '部署与配置', items: [
        { text: '完整服务器部署', link: '/deploy/installation' },
        { text: '域名、HTTPS 与登录', link: '/deploy/https' },
        { text: 'Telegram 连接与授权', link: '/deploy/telegram' },
        { text: '多账号调度', link: '/usage/multi-account' },
        { text: '磁盘、资源与并发', link: '/deploy/resources' },
        { text: '部署验收清单', link: '/deploy/verification' },
      ] },
      { text: '存储接入', items: [
        { text: '选择与添加存储', link: '/storage/' },
        { text: '本地磁盘与挂载', link: '/storage/local' },
        { text: 'OneDrive', link: '/storage/onedrive' },
        { text: 'Google Drive', link: '/storage/google-drive' },
        { text: 'S3 与 Cloudflare R2', link: '/storage/s3' },
        { text: '阿里云 OSS', link: '/storage/oss' },
        { text: 'WebDAV 与 NAS', link: '/storage/webdav' },
        { text: 'OpenList 原生接入', link: '/storage/openlist' },
      ] },
      { text: '日常使用', items: [
        { text: '第一次转存', link: '/usage/first-transfer' },
        { text: 'Web 上传与文件管理', link: '/usage/files' },
        { text: '频道下载与订阅', link: '/usage/subscriptions' },
        { text: '任务、进度与重试', link: '/usage/tasks' },
        { text: 'Bot 命令速查', link: '/usage/commands' },
      ] },
      { text: '可选扩展', items: [
        { text: 'MCP 连接 AI Agent', link: '/usage/mcp' },
        { text: 'qBittorrent 下载转存', link: '/usage/qbittorrent' },
      ] },
      { text: '运维与参考', items: [
        { text: '更新、备份与恢复', link: '/operations/maintenance' },
        { text: '问题排查与 FAQ', link: '/troubleshooting/' },
        { text: '安全与隐私', link: '/reference/security' },
        { text: '完整配置参考', link: '/reference/configuration' },
        { text: '开发与发布', link: '/reference/development' },
        { text: '更新日志', link: '/reference/changelog' },
        { text: '文档来源与维护', link: '/reference/sources' },
      ] },
    ],
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    sidebarMenuLabel: '文档导航',
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '切换主题',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    skipToContentLabel: '跳到正文',
    search: { provider: 'local', options: {
      _render(src, env, md) {
        const tokens = md.parse(src, env);
        // Segment search text at build time; keep client config free of eval.
        if (env.frontmatter?.search === false) return '';
        const words = (text: string) => tokenize(text).join(' ');
        for (let index = 0; index < tokens.length; index++) {
          const token = tokens[index];
          if (token.type === 'inline' && tokens[index - 1]?.type !== 'heading_open') {
            for (const child of token.children || []) {
              if (child.type === 'text') child.content = words(child.content);
            }
          }
          if (token.type === 'heading_close') {
            const title = tokens[index - 1].content;
            token.type = 'html_block';
            token.content = `</${token.tag}><p>${md.utils.escapeHtml(words(title))}</p>`;
          }
        }
        return md.renderer.render(tokens, md.options, env);
      },
      translations: {
        button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
        modal: {
          displayDetails: '显示详细结果', resetButtonTitle: '清空搜索', backButtonTitle: '关闭搜索', noResultsText: '没有找到相关内容',
          footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
        },
      },
    } },
    socialLinks: [{ icon: 'github', link: 'https://github.com/hicocos/tg-vault', ariaLabel: 'TG Vault GitHub 仓库' }],
  },
});
