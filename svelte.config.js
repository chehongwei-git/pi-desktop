/** Vite 与编辑器共用的 Svelte 配置；不引入 SSR 或额外应用框架。 */
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
export default { preprocess: vitePreprocess() };
