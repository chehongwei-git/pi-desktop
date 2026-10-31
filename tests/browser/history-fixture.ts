import { mount } from 'svelte';
import HistoryFixture from './HistoryFixture.svelte';
import '../../src/styles.css';
mount(HistoryFixture, { target: document.querySelector('main')! });
