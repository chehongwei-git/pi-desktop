import { mount } from 'svelte';
import '../../src/styles.css';
import SentFilesFixture from './SentFilesFixture.svelte';
mount(SentFilesFixture, { target: document.querySelector('main')! });
