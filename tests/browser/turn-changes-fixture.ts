/** 浏览器真实组件入口。 */
import { mount } from 'svelte';
import Fixture from './TurnChangesFixture.svelte';
import '../../src/styles.css';
mount(Fixture, { target: document.querySelector('main')! });
