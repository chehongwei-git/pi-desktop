import { mount } from 'svelte';
import NavigatorFixture from './NavigatorFixture.svelte';
import '../../src/styles.css';
mount(NavigatorFixture, { target: document.querySelector('main')! });
