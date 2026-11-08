import DefaultTheme from 'vitepress/theme';
import { inBrowser, type Theme } from 'vitepress';
import { tokenize } from '../search';
import '@fontsource-variable/noto-sans-sc';
import './style.css';
import Layout from './Layout.vue';
import HomePage from './components/HomePage.vue';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app, siteData }) {
    app.component('HomePage', HomePage);
    if (!inBrowser) return;
    const search = siteData.value.themeConfig.search;
    if (search?.provider === 'local') {
      search.options.miniSearch = { options: { tokenize } };
    }
  },
} satisfies Theme;
