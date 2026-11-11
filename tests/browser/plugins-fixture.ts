/** 插件异步与多项目状态的真实组件入口。 */
import { mount } from 'svelte';
import Fixture from './PluginsFixture.svelte';
import '../../src/styles.css';
mount(Fixture, { target: document.querySelector('main')! });
