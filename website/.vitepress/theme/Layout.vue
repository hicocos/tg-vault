<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { onContentUpdated, useData, useRoute } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import DocIcon from './components/DocIcon.vue';

const { page, theme, frontmatter, isDark } = useData();
const route = useRoute();

const generatedSourceMap: Record<string, string> = {
  'deploy/installation.md': 'deploy/DEPLOY.md',
  'reference/configuration.md': 'docs/configuration.md',
  'storage/local.md': 'docs/local-storage.md',
  'reference/development.md': 'docs/development.md',
  'usage/mcp.md': 'docs/mcp.md',
  'reference/changelog.md': 'CHANGELOG.md',
};

const currentPath = computed(() => `/${page.value.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '')}`);

const category = computed(() => {
  return theme.value.sidebar?.find((group: { items?: { link?: string }[] }) =>
    group.items?.some(item => item.link === currentPath.value)
  )?.text || '使用文档';
});

const currentItemTitle = computed(() => {
  for (const group of theme.value.sidebar || []) {
    const found = group.items?.find((item: { link?: string; text?: string }) => item.link === currentPath.value);
    if (found?.text) return found.text;
  }
  return page.value.title || '';
});

const sourceUrl = computed(() => {
  const rel = page.value.relativePath;
  const repoPath = generatedSourceMap[rel] || `website/src/${rel}`;
  return `https://github.com/hicocos/tg-vault/blob/main/${repoPath}`;
});

const versionMenuRef = ref<HTMLDetailsElement | null>(null);
const mobileTocRef = ref<HTMLDetailsElement | null>(null);
const mobileHeaders = ref<{ level: number; title: string; link: string }[]>([]);
const showBackToTop = ref(false);
const toastMessage = ref('');
const toastVisible = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string) {
  toastMessage.value = message;
  toastVisible.value = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastVisible.value = false;
  }, 2200);
}
provide('vaultToast', showToast);

function closeVersionMenu() {
  if (versionMenuRef.value?.open) versionMenuRef.value.open = false;
}

function closeMobileToc() {
  if (mobileTocRef.value?.open) mobileTocRef.value.open = false;
}

function refreshMobileHeaders() {
  if (typeof document === 'undefined' || frontmatter.value.layout === 'home') {
    mobileHeaders.value = [];
    return;
  }
  const nodes = Array.from(document.querySelectorAll('.vp-doc h2[id], .vp-doc h3[id]'));
  const maxLevel = page.value.relativePath === 'reference/changelog.md' ? 2 : 3;
  mobileHeaders.value = nodes
    .map(node => {
      const level = node.tagName === 'H2' ? 2 : 3;
      const clone = node.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.header-anchor').forEach(a => a.remove());
      const title = (clone.textContent || '').trim();
      return { level, title, link: `#${node.id}` };
    })
    .filter(item => item.title && item.level <= maxLevel);
}

function scrollActiveSidebarIntoView() {
  if (typeof document === 'undefined') return;
  const sidebar = document.querySelector('.VPSidebar');
  const active = document.querySelector('.VPSidebar .VPSidebarItem.is-active > .item');
  if (sidebar instanceof HTMLElement && active instanceof HTMLElement) {
    const relative = active.getBoundingClientRect().top - sidebar.getBoundingClientRect().top;
    if (relative > sidebar.clientHeight - 90 || relative < 40) {
      sidebar.scrollTop = Math.max(0, sidebar.scrollTop + relative - sidebar.clientHeight / 2);
    }
  }
}

function onWindowScroll() {
  if (typeof window === 'undefined') return;
  showBackToTop.value = window.scrollY > 460;
}

function scrollToTop() {
  if (typeof window === 'undefined') return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'instant' : 'smooth' });
}

function onDocumentClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (versionMenuRef.value?.open && target && !versionMenuRef.value.contains(target)) {
    versionMenuRef.value.open = false;
  }
  const copyBtn = target?.closest('.vp-doc [class*="language-"] > button.copy');
  if (copyBtn) {
    showToast('代码已复制');
  }
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && versionMenuRef.value?.open) {
    versionMenuRef.value.open = false;
    versionMenuRef.value.querySelector('summary')?.focus();
    return;
  }
  const target = event.target as HTMLElement | null;
  const editable = target && (target.matches('input,textarea,select') || target.isContentEditable);
  if (event.key === '/' && !editable && !document.querySelector('.DocSearch-Modal')) {
    const searchBtn = document.querySelector('.VPNavBarSearch button.DocSearch-Button') as HTMLButtonElement | null;
    if (searchBtn) {
      event.preventDefault();
      searchBtn.click();
    }
  }
}

watch(
  isDark,
  dark => {
    if (typeof document === 'undefined') return;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111824' : '#f8faff');
  },
  { immediate: true }
);

watch(
  () => route.path,
  async () => {
    closeVersionMenu();
    closeMobileToc();
    await nextTick();
    refreshMobileHeaders();
    scrollActiveSidebarIntoView();
  }
);

onContentUpdated(() => {
  refreshMobileHeaders();
});

onMounted(() => {
  refreshMobileHeaders();
  scrollActiveSidebarIntoView();
  onWindowScroll();
  window.addEventListener('scroll', onWindowScroll, { passive: true });
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('scroll', onWindowScroll);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onDocumentKeydown);
  }
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-title-after>
      <span class="brand-divider" aria-hidden="true" />
      <span class="nav-docs-label">Docs</span>
    </template>

    <template #nav-bar-content-before>
      <details ref="versionMenuRef" class="version-menu">
        <summary aria-label="版本与发布记录">
          <span>v3.0.0</span>
          <DocIcon name="chevron-down" :size="13" />
        </summary>
        <div class="version-popover">
          <span class="menu-caption">本文档对应版本</span>
          <a href="/reference/changelog#v3-0-0" @click="closeVersionMenu">
            <span>v3.0.0</span>
            <span class="badge">当前</span>
          </a>
          <a href="https://github.com/hicocos/tg-vault/releases/latest" target="_blank" rel="noopener noreferrer" @click="closeVersionMenu">
            <span>GitHub 最新 Release</span>
            <span class="ext-mark">↗</span>
          </a>
          <div class="menu-line" />
          <span class="menu-caption">历史更新记录 · 版本演进</span>
          <a href="/reference/changelog#v2-6-0" @click="closeVersionMenu">v2.6.0 更新记录</a>
          <a href="/reference/changelog#v2-5-0" @click="closeVersionMenu">v2.5.0 更新记录</a>
          <a href="/reference/changelog#v2-4-9" @click="closeVersionMenu">v2.4.9 更新记录</a>
          <a href="/reference/changelog#v2-4-8" @click="closeVersionMenu">v2.4.8 更新记录</a>
          <a href="/reference/changelog" @click="closeVersionMenu">完整版本记录</a>
          <a href="https://github.com/hicocos/tg-vault/releases" target="_blank" rel="noopener noreferrer" @click="closeVersionMenu">
            <span>全部 Releases</span>
            <span class="ext-mark">↗</span>
          </a>
        </div>
      </details>
    </template>

    <template #sidebar-nav-before>
      <a class="sidebar-heading" href="/">
        <DocIcon name="book" :size="16" />
        <span>文档中心</span>
      </a>
    </template>

    <template #sidebar-nav-after>
      <div class="sidebar-bottom">
        <div class="sidebar-bottom-status">
          <span class="status-dot" />
          <span>v3.0.0 文档</span>
        </div>
        <small>对应当前仓库源码 · 开源自托管</small>
      </div>
    </template>

    <template #doc-before>
      <div class="docs-breadcrumb" aria-label="面包屑导航">
        <a href="/">文档</a>
        <span>/</span>
        <span>{{ category }}</span>
        <template v-if="currentItemTitle">
          <span>/</span>
          <span class="crumb-current">{{ currentItemTitle }}</span>
        </template>
      </div>
      <details v-if="mobileHeaders.length" ref="mobileTocRef" class="mobile-toc">
        <summary>
          <span>本页目录</span>
          <DocIcon name="chevron-down" :size="14" />
        </summary>
        <nav aria-label="本页章节">
          <a
            v-for="item in mobileHeaders"
            :key="item.link"
            :class="`toc-h${item.level}`"
            :href="item.link"
            @click="closeMobileToc"
          >
            {{ item.title }}
          </a>
        </nav>
      </details>
    </template>

    <template #doc-footer-before>
      <div class="article-meta">
        <span>内容核对：v3.0.0 · TG Vault 中文文档</span>
        <div class="article-source-links">
          <a class="article-source" :href="sourceUrl" target="_blank" rel="noopener noreferrer">查看本页源码 ↗</a>
          <a class="reference-source" href="/reference/sources">文档来源与维护</a>
        </div>
      </div>
    </template>

    <template #doc-after>
      <div class="feedback-note">
        发现文档与实际行为不同？<a href="https://github.com/hicocos/tg-vault/issues" target="_blank" rel="noopener noreferrer">反馈前先脱敏 ↗</a>
      </div>
    </template>

    <template #aside-outline-after>
      <a class="aside-help" href="/troubleshooting/">
        <DocIcon name="info" :size="13" />
        <span>遇到问题？查看 FAQ</span>
        <DocIcon name="arrow" :size="12" />
      </a>
    </template>

    <template #layout-bottom>
      <footer class="site-footer" :class="{ compact: frontmatter.layout !== 'home' }">
        <div class="footer-inner">
          <div class="footer-brand-line">
            <a class="footer-brand" href="/">
              <img src="/logo.webp?v=logo15-482cd86d" alt="" width="22" height="22">
              <strong>TG Vault</strong>
            </a>
            <span>From Telegram to Your Storage Vault.</span>
          </div>
          <nav aria-label="页脚导航">
            <a href="/reference/sources">文档来源与维护</a>
            <a href="/reference/security">安全与隐私</a>
            <a href="/reference/changelog">更新日志</a>
            <a href="https://github.com/hicocos/tg-vault" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
          </nav>
        </div>
        <p>开源自托管 Telegram 文件转存与多存储归档工具 · <a href="/LICENSE.txt">MIT License</a> · 与 Telegram、OneDrive、Google Drive、OpenList 及各云存储运营方无官方隶属关系。</p>
      </footer>
      <button class="back-to-top" type="button" :hidden="!showBackToTop" aria-label="回到顶部" @click="scrollToTop">↑</button>
      <div id="toast" class="vault-toast" :class="{ visible: toastVisible }" role="status" aria-live="polite">{{ toastMessage }}</div>
    </template>
  </DefaultTheme.Layout>
</template>
