import { useTranslation } from 'react-i18next';
import { normalizeLocale } from '../../i18n/registry';
import { ArrowRight, BookOpen, Cloud, Download, ExternalLink, FileText, Folder, Globe, RefreshCw, Share2 } from '../ui/icons';
import './about.css';

export const aboutCopy = {
    'zh-CN': {
        title: '关于',
        eyebrow: '关于项目',
        tagline: '让 Telegram 文件，有序归档。',
        description: '连接 Telegram 与你的存储空间。从文件转存、频道订阅到 Web 管理，在一个地方完成收集、整理与访问。',
        selfHosted: '自托管',
        openSource: '开源项目',
        docs: '使用文档',
        docsTitle: '从第一次转存，到日常归档',
        docsDescription: '部署配置、存储接入和使用教程，都在文档站。',
        openDocs: '打开文档站',
        guides: ['快速上手', '存储接入', 'Bot 命令速查', '常见问题'],
        featuresTitle: '围绕文件归档，做好每一步',
        features: [
            { title: 'Telegram 文件转存', description: '通过 Bot 接收文件，按日期或标签批量下载频道与群组内容。' },
            { title: '订阅与多账号调度', description: '订阅来源，持续同步新内容；支持多个 Telegram 用户账号协同处理。' },
            { title: '存储由你选择', description: '支持本地磁盘、OneDrive、Google Drive、S3、OSS、WebDAV 与 OpenList。' },
            { title: 'Web 与 Bot 协同', description: '上传、搜索、整理和预览文件，查看任务进度，随时暂停、继续或重试。' },
        ],
        resourcesTitle: '项目与社区',
        source: '开源地址',
        sourceDescription: '浏览源码、提交 Issue，或参与项目贡献。',
        releases: '版本与更新',
        releasesDescription: '查看已发布版本、更新内容与下载资源。',
        community: 'TG 交流反馈群',
        communityDescription: '交流使用经验，反馈问题与功能建议。',
        license: '基于 MIT 协议开源',
        thanks: '感谢每一位使用者与贡献者。',
    },
    en: {
        title: 'About',
        eyebrow: 'About the project',
        tagline: 'A home for your Telegram files.',
        description: 'Connect Telegram to your storage. Collect, organize, and access your files with transfers, channel subscriptions, and a web file manager in one place.',
        selfHosted: 'Self-hosted',
        openSource: 'Open source',
        docs: 'Documentation',
        docsTitle: 'From your first transfer to everyday archiving',
        docsDescription: 'Find deployment instructions, storage setup, and practical guides in the docs.',
        openDocs: 'Explore the docs',
        guides: ['Quick start', 'Storage setup', 'Bot commands', 'Troubleshooting'],
        featuresTitle: 'Everything you need to keep files organized',
        features: [
            { title: 'Telegram file transfers', description: 'Send files to the Bot or download channel and group content in batches by date or tag.' },
            { title: 'Subscriptions & multiple accounts', description: 'Keep up with new content through subscriptions and process tasks with multiple Telegram user accounts.' },
            { title: 'Your choice of storage', description: 'Use local disk, OneDrive, Google Drive, S3, OSS, WebDAV, or OpenList.' },
            { title: 'Web & Bot together', description: 'Upload, search, organize, and preview files. Track tasks and pause, resume, or retry them.' },
        ],
        resourcesTitle: 'Project & community',
        source: 'Source code',
        sourceDescription: 'Explore the code, open an issue, or contribute to the project.',
        releases: 'Releases & updates',
        releasesDescription: 'Browse published versions, release notes, and downloads.',
        community: 'Telegram community & feedback',
        communityDescription: 'Share tips, report problems, and suggest improvements.',
        license: 'Open source under the MIT License',
        thanks: 'Thank you to everyone who uses and contributes to TG Vault.',
    },
    ru: {
        title: 'О проекте',
        eyebrow: 'О проекте',
        tagline: 'Ваши файлы из Telegram — в порядке.',
        description: 'Свяжите Telegram со своим хранилищем. Переносите файлы, подписывайтесь на каналы и управляйте архивом через веб-интерфейс.',
        selfHosted: 'На вашем сервере',
        openSource: 'Открытый код',
        docs: 'Документация',
        docsTitle: 'От первого переноса до работы с архивом',
        docsDescription: 'Развёртывание, подключение хранилищ и инструкции по работе — в документации.',
        openDocs: 'Открыть документацию',
        guides: ['Быстрый старт', 'Хранилища', 'Команды бота', 'Решение проблем'],
        featuresTitle: 'Всё для удобной работы с архивом',
        features: [
            { title: 'Перенос файлов из Telegram', description: 'Отправляйте файлы боту или скачивайте содержимое каналов и групп по дате или тегу.' },
            { title: 'Подписки и несколько аккаунтов', description: 'Синхронизируйте новые публикации и распределяйте задачи между аккаунтами Telegram.' },
            { title: 'Хранилище на ваш выбор', description: 'Локальный диск, OneDrive, Google Drive, S3, OSS, WebDAV и OpenList.' },
            { title: 'Веб-интерфейс и бот', description: 'Загружайте, ищите и просматривайте файлы. Следите за задачами, приостанавливайте, продолжайте и повторяйте их.' },
        ],
        resourcesTitle: 'Проект и сообщество',
        source: 'Исходный код',
        sourceDescription: 'Изучайте код, сообщайте об ошибках и участвуйте в разработке.',
        releases: 'Версии и обновления',
        releasesDescription: 'Опубликованные версии, список изменений и файлы для скачивания.',
        community: 'Общение и обратная связь в Telegram',
        communityDescription: 'Делитесь опытом, сообщайте о проблемах и предлагайте улучшения.',
        license: 'Открытый код под лицензией MIT',
        thanks: 'Спасибо всем пользователям и участникам проекта.',
    },
};

export function AboutPage() {
    const { i18n } = useTranslation();
    const copy = aboutCopy[normalizeLocale(i18n.resolvedLanguage || i18n.language)];
    const featureIcons = [Download, RefreshCw, Cloud, Folder];
    const guidePaths = ['/guide/quick-start', '/storage/', '/usage/commands', '/troubleshooting/'];
    const resources = [
        { icon: Globe, title: copy.source, description: copy.sourceDescription, label: 'GitHub · hicocos/tg-vault', url: 'https://github.com/hicocos/tg-vault' },
        { icon: FileText, title: copy.releases, description: copy.releasesDescription, label: 'GitHub Releases', url: 'https://github.com/hicocos/tg-vault/releases' },
        { icon: Share2, title: copy.community, description: copy.communityDescription, label: 'Telegram', url: 'https://t.me/+TBm6l0nI5bpiOGU1' },
    ];

    return <div className="about-page">
        <div className="about-intro">
            <section className="tv-panel about-hero" aria-labelledby="about-title">
                <div className="about-brand">
                    <img src="/logo-160.webp?v=logo15-482cd86d" alt="" width="64" height="64" />
                    <div><p className="about-eyebrow">{copy.eyebrow}</p><h1 id="about-title">TG Vault</h1></div>
                </div>
                <p className="about-tagline">{copy.tagline}</p>
                <p className="about-description">{copy.description}</p>
                <div className="about-tags"><span>Telegram + Web</span><span>{copy.selfHosted}</span><span>{copy.openSource}</span></div>
            </section>

            <section className="tv-panel about-docs" aria-labelledby="about-docs-title">
                <div className="about-docs-label"><BookOpen size={20} aria-hidden="true" /><span>{copy.docs}</span></div>
                <h2 id="about-docs-title">{copy.docsTitle}</h2>
                <p>{copy.docsDescription}</p>
                <a className="tv-btn tv-btn-primary about-docs-button" href="https://tgvault.pages.dev/" target="_blank" rel="noopener noreferrer">{copy.openDocs}<ExternalLink size={16} aria-hidden="true" /></a>
                <span className="about-docs-domain">tgvault.pages.dev</span>
                <nav className="about-guides" aria-label={copy.docs}>
                    {copy.guides.map((label, index) => <a key={guidePaths[index]} href={`https://tgvault.pages.dev${guidePaths[index]}`} target="_blank" rel="noopener noreferrer"><span>{label}</span><ArrowRight size={15} aria-hidden="true" /></a>)}
                </nav>
            </section>
        </div>

        <section className="tv-panel about-features" aria-labelledby="about-features-title">
            <h2 id="about-features-title">{copy.featuresTitle}</h2>
            <div className="about-feature-grid">
                {copy.features.map((feature, index) => {
                    const Icon = featureIcons[index];
                    return <div className="about-feature" key={feature.title}><Icon size={24} aria-hidden="true" /><h3>{feature.title}</h3><p>{feature.description}</p></div>;
                })}
            </div>
        </section>

        <section className="about-resources" aria-labelledby="about-resources-title">
            <h2 id="about-resources-title">{copy.resourcesTitle}</h2>
            <div className="about-resource-grid">
                {resources.map(({ icon: Icon, title, description, label, url }) => <a key={url} className="tv-panel about-resource" href={url} target="_blank" rel="noopener noreferrer">
                    <div className="about-resource-heading"><Icon size={21} aria-hidden="true" /><h3>{title}</h3><ExternalLink size={15} aria-hidden="true" /></div>
                    <p>{description}</p><span className="about-resource-label">{label}<ArrowRight size={15} aria-hidden="true" /></span>
                </a>)}
            </div>
        </section>

        <footer className="about-footer"><a href="https://github.com/hicocos/tg-vault/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">{copy.license}<ExternalLink size={13} aria-hidden="true" /></a><span>{copy.thanks}</span></footer>
    </div>;
}
