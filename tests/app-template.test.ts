import test from 'node:test';
import assert from 'node:assert/strict';
import { appTemplate } from '../src/renderer/app-template';
import { editorTemplate } from '../src/renderer/editor-template';

test('the status bar holds only the status text and the shortcut hints', () => {
  const footer = appTemplate.slice(appTemplate.indexOf('<footer class="status-bar">'), appTemplate.indexOf('</footer>'));
  assert.ok(footer.includes('id="status"'));
  assert.deepEqual(footer.match(/<kbd>[^<]*<\/kbd>/g), ['<kbd>Tab 切换视图</kbd>', '<kbd>Space 播放</kbd>']);
  assert.ok(!appTemplate.includes('data-action="demo"'), 'no built-in sample chart');
  assert.ok(!footer.includes('<button'), 'the status bar holds no buttons');
  assert.ok(!appTemplate.includes('runtime-label'), 'no runtime environment label');
});

test('undo and redo are offered once, next to save in the header', () => {
  const header = appTemplate.slice(0, appTemplate.indexOf('</header>')), shell = appTemplate + editorTemplate({ zoom: 1, trackScale: 1 });
  assert.ok(header.indexOf('data-action="save"') < header.indexOf('data-action="undo"') && header.indexOf('data-action="undo"') < header.indexOf('data-action="redo"'));
  assert.equal(shell.match(/aria-label="撤销"|title="撤销/g)?.length, 1);
  assert.equal(shell.match(/aria-label="重做"|title="重做/g)?.length, 1);
  assert.ok(!shell.includes('editor-undo') && !shell.includes('editor-redo'));
});

test('the loop button sits directly to the right of measure navigation', () => {
  const options = appTemplate.slice(appTemplate.indexOf('<div class="transport-options">'), appTemplate.indexOf('</section>', appTemplate.indexOf('<div class="transport-options">')));
  assert.deepEqual([...options.matchAll(/<(?:button|select|input) id="([^"]+)"/g)].map(match => match[1]),
    ['measure-button', 'loop-button', 'playback-rate', 'sfx', 'sfx-volume', 'metronome', 'metronome-volume', 'volume']);
});
