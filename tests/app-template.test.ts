import test from 'node:test';
import assert from 'node:assert/strict';
import { appTemplate } from '../src/renderer/app-template';
import { editorTemplate } from '../src/renderer/editor-template';
import { ICON } from '../src/renderer/icons';

test('the status bar holds only the status text and the shortcut hints', () => {
  const footer = appTemplate.slice(
    appTemplate.indexOf('<footer class="status-bar">'),
    appTemplate.indexOf('</footer>'),
  );
  assert.ok(footer.includes('id="status"'));
  assert.deepEqual(footer.match(/<kbd>[^<]*<\/kbd>/g), ['<kbd>Tab 切换视图</kbd>', '<kbd>Space 播放</kbd>']);
  assert.ok(!appTemplate.includes('data-action="demo"'), 'no built-in sample chart');
  assert.ok(!footer.includes('<button'), 'the status bar holds no buttons');
  assert.ok(!appTemplate.includes('runtime-label'), 'no runtime environment label');
});

test('undo and redo are offered once, next to save in the header', () => {
  const header = appTemplate.slice(0, appTemplate.indexOf('</header>')),
    shell = appTemplate + editorTemplate({ zoom: 1 });
  assert.ok(
    header.indexOf('data-action="save"') < header.indexOf('data-action="undo"') &&
      header.indexOf('data-action="undo"') < header.indexOf('data-action="redo"'),
  );
  assert.equal(shell.match(/aria-label="撤销"|title="撤销/g)?.length, 1);
  assert.equal(shell.match(/aria-label="重做"|title="重做/g)?.length, 1);
  assert.ok(!shell.includes('editor-undo') && !shell.includes('editor-redo'));
});

test('the loop button sits directly to the right of measure navigation', () => {
  const options = appTemplate.slice(
    appTemplate.indexOf('<div class="transport-options">'),
    appTemplate.indexOf('</section>', appTemplate.indexOf('<div class="transport-options">')),
  );
  assert.deepEqual(
    [...options.matchAll(/<(?:button|select|input) id="([^"]+)"/g)].map(match => match[1]),
    [
      'measure-button',
      'loop-button',
      'playback-rate-down',
      'playback-rate',
      'playback-rate-up',
      'playback-rate-custom',
      'sfx',
      'sfx-volume',
      'metronome',
      'metronome-volume',
      'volume',
    ],
  );
});

test('the editor toolbar keeps one zoom control, a fixed track width and the shape button in the node row', () => {
  const editor = editorTemplate({ zoom: 1 }),
    row = editor.slice(editor.indexOf('<div class="editor-toolrow"'), editor.indexOf('<div class="editor-body">'));
  assert.equal(editor.match(/缩放 ?</g)?.length, 1, 'only the zoom slider is labelled 缩放');
  assert.ok(
    editor.includes('data-option="zoom"') &&
      !editor.includes('data-action="scale"') &&
      !editor.includes('data-option="scale"'),
    'time scaling is gone',
  );
  assert.ok(!editor.includes('data-action="delete"'), 'no delete button in the toolbar');
  assert.ok(!editor.includes('track-width') && !editor.includes('轨道宽度') && !editor.includes('track-pan'));
  assert.ok(editor.includes('音符间隔 1/') && !editor.includes('量化'));
  assert.ok(
    !editor.includes('snap-base') && !editor.includes('四分拍'),
    'the interval is always a fraction of a whole note',
  );
  assert.ok(!editor.includes('新节点'));
  const order = ['SLIDE 控制', 'data-action="shape"', 'data-action="connect"', 'data-action="split"'].map(text =>
    row.indexOf(text),
  );
  assert.ok(
    order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])),
    `node row order: ${order}`,
  );
});

test('buttons use Lucide icons instead of symbol characters', () => {
  const shell = appTemplate + editorTemplate({ zoom: 1 });
  assert.deepEqual(shell.match(/[↶↷↻■▥▶▷◀♫⛶✓↔↕↖↗↑∿⌁⌖⌫▣▱◇☷⧉＋]/g), null);
  assert.ok((shell.match(/<svg class="icon"/g)?.length ?? 0) >= 25);
});

test('the mirror icon reflects across a vertical axis and the flip icon across a horizontal one', () => {
  // Both icons draw their axis as a dashed centreline: x = 12 is vertical (left-right mirror), y = 12 horizontal (front-back flip).
  assert.ok(ICON.mirror.includes('d="M12 2v2"'), 'mirror axis is vertical');
  assert.ok(ICON.flip.includes('d="M4 12H2"'), 'flip axis is horizontal');
});

test('the header groups every action on the left so the right end stays free for the window controls', () => {
  const header = appTemplate.slice(0, appTemplate.indexOf('</header>'));
  const order = ['class="file-actions"', 'data-action="redo"', 'class="header-right"', 'data-action="export"'].map(
    text => header.indexOf(text),
  );
  assert.ok(
    order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])),
    `header order: ${order}`,
  );
  assert.ok(!header.includes('margin-left'), 'nothing is pushed to the right edge inline');
});
