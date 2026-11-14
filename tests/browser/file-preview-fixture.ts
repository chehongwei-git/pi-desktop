import { mount } from 'svelte';
import FilePreviewFixture from './FilePreviewFixture.svelte';
import '../../src/styles.css';
mount(FilePreviewFixture, { target: document.querySelector('main')! });
