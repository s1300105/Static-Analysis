import { slugify } from './vendor-lib';

// 名前つき・名前なしの非同期チャンク（webpack のチャンクマップに載る）
export const openAdmin = () => import(/* webpackChunkName: "admin" */ './admin').then((m) => m.default());
export const openReports = () => import('./reports').then((m) => m.run());
export const openSettings = () => import(/* webpackChunkName: "settings" */ './settings').then((m) => m.default());
// webpack が触らない、ブラウザの動的 import（第三者のホスト）
export const widget = () => import(/* webpackIgnore: true */ 'https://widgets.thirdparty.example/w.js');

window.App = { openAdmin, openReports, openSettings, widget, slugify };
