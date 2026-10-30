/** 启动只挂载单个 Svelte 根；Pi 按需由 Desktop 门面启动，无全局后台服务。 */
import { mount } from 'svelte';
import App from './App.svelte';
import './styles.css';
mount(App, { target: document.getElementById('app')! });
