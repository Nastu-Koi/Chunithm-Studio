import { ICON } from '../icons';
import type { AppContext } from '../app-context';
import { $, escape } from '../dom';

export async function showLibrary(ctx: AppContext): Promise<void> {
  const { bridge, modal, showModal, message, run, load, discardAllowed } = ctx;
  showModal('本地曲库', `<div class="library-controls"><input id="game-path" value="${escape(ctx.gamePath)}" aria-label="游戏目录"><button id="game-choose">选择目录</button><button class="primary" id="game-scan">扫描曲库</button><button id="game-rescan" title="忽略上次扫描结果，重新读取全部曲目">强制重扫</button></div><input id="library-search" class="library-search" placeholder="搜索曲名、曲目 ID、难度或资源包…"><div id="library-results" class="library-results"></div>`);
  const results = $('#library-results');
  const render = () => {
    const query = $<HTMLInputElement>('#library-search').value.toLowerCase(); const matches = ctx.library.filter(e => `${e.title} ${e.musicId} ${e.difficulty} ${e.pack}`.toLowerCase().includes(query));
    results.innerHTML = `<p class="modal-description">${ctx.library.length ? `${matches.length} 张谱面 · 载入后可另存为独立工程` : '选择游戏目录后扫描，包含基础资源与追加包。'}</p>${matches.slice(0, 160).map(e => `<button class="library-song" data-library="${escape(e.key)}"><span class="song-id">${e.musicId}</span><span class="song-name">${escape(e.title)}<small>${escape(e.artist)} · ${escape(e.pack)}</small></span><span class="difficulty difficulty-${e.difficulty === 'WORLD’S END' ? 'we' : e.difficulty.toLowerCase()}">${escape(e.difficulty)} ${escape(e.level)}</span><span>${ICON.open}</span></button>`).join('')}${matches.length > 160 ? '<p class="modal-description">继续搜索以缩小范围。</p>' : ''}`;
    results.querySelectorAll<HTMLElement>('[data-library]').forEach(button => button.onclick = () => void run(async () => { if (!discardAllowed()) return; const entry = ctx.library.find(e => e.key === button.dataset.library)!; message('正在载入谱面和音乐…'); const loaded = await bridge.loadLibraryChart(entry); await load(loaded); modal.close(); message(loaded.warnings?.join(' ') || '已导入本地谱面', !!loaded.warnings?.length); }));
  };
  $('#game-choose').onclick = () => void run(async () => { const selected = await bridge.chooseGamePath(); if (selected) $<HTMLInputElement>('#game-path').value = selected; });
  const scan = (force: boolean) => void run(async () => { ctx.gamePath = $<HTMLInputElement>('#game-path').value.trim(); localStorage.setItem('chuni-game-path', ctx.gamePath); results.textContent = '正在扫描…'; results.dataset.scanning = 'true'; try { ctx.library = await bridge.scanLibrary(ctx.gamePath, force); } finally { delete results.dataset.scanning; } render(); });
  $('#game-scan').onclick = () => scan(false); $('#game-rescan').onclick = () => scan(true);
  $<HTMLInputElement>('#library-search').oninput = render; render();
}
