import './style.css';
import './editor.css';
import { createProject, createNote, makeId, type Project, type Chart, type Difficulty } from '../core/model';
import { chartDuration, secondsToTick, tickToSeconds, bpmAtTick, getMeasureStartTick, getMeasureNumberAtTick, MAX_MEASURE_NUMBER } from '../core/timing';
import { validateProject } from '../core/validation';
import { analyzeC2SQuantization } from '../core/quantization';
import { ChartEditor } from './editor';
import { ChartPlayer } from './player';
import { Transport } from './transport';
import { browserBridge } from './browser-bridge';
import { openXmlSettings } from './xml-settings';
import type { LibraryEntry, LoadedProject } from '../bridge';

const bridge = window.studio ?? browserBridge;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="app-header"><div class="brand"><span class="brand-mark">C<span>↗</span></span><div><strong>CHUNI<span>STUDIO</span></strong><small>CHART EDITOR & PREVIEW</small></div></div>
  <nav class="file-actions" aria-label="文件操作"><button data-action="new" title="新建 Ctrl+N">新建</button><button data-action="open" title="打开 Ctrl+O">打开</button><button data-action="import">导入 C2S</button><button data-action="save" title="保存 Ctrl+S">保存<span class="shortcut">Ctrl S</span></button><button data-action="undo" title="撤销 Ctrl+Z">↶</button><button data-action="redo" title="重做 Ctrl+Y">↷</button></nav>
  <div class="header-right"><button data-action="library" class="quiet">本地曲库</button><button data-action="settings" class="quiet">乐曲设置</button><button data-action="xml" class="quiet">XML 信息</button><button data-action="export" class="primary">导出 OPT <span>↗</span></button></div></header>
  <section class="project-bar"><div class="project-identity"><div class="jacket-mini" id="jacket-mini">♫</div><div><h1 id="project-title"></h1><p><span id="project-artist">未设置作者</span><span class="dot">·</span><span id="project-details"></span><span id="dirty-indicator"></span></p></div></div>
  <div class="view-tabs" role="tablist" aria-label="视图"><button role="tab" id="edit-tab" aria-selected="true" data-action="edit">▥ <span>俯视编辑</span></button><button role="tab" id="play-tab" aria-selected="false" data-action="player">▷ <span>播放预览</span></button></div>
  <div class="project-actions"><button data-action="audio">♫ 导入音乐</button><button data-action="validate" id="validation-button">✓ 检查谱面</button></div></section>
  <main class="workspace"><section id="editor-view" aria-label="俯视编辑器"></section><section id="player-view" aria-label="透视播放器" hidden><div class="player-tools"><label>轨道流速 <input id="scroll-speed" type="range" min="1" max="15" step="0.5" value="6"><output id="scroll-speed-label">6.0</output></label><button data-action="judgements" id="judgement-status">判定统计</button><button data-action="resources" id="resource-status">正在读取资源副本…</button><button data-action="fullscreen">⛶ 大画面</button></div><div id="player-canvas-host"></div></section></main>
  <section class="transport" aria-label="播放控制"><div class="transport-primary"><button id="restart" data-action="restart" aria-label="回到开头">|◀</button><button id="play-button" class="play-button" data-action="toggle" title="空格播放 / 暂停">▶</button><button data-action="stop" aria-label="停止">■</button><div class="time-display"><strong id="time-current">00:00.000</strong><span id="time-total">/ 00:00.000</span></div></div>
  <div class="seek-region"><input id="seek" type="range" min="0" max="60" step="0.001" value="0" aria-label="播放位置"><div class="seek-labels"><span id="position-label">小节 001 · BPM 120</span><span id="audio-label">尚未载入音乐</span></div></div>
  <div class="transport-options"><button id="measure-button" data-action="measure" title="按小节定位或播放 Ctrl+G">小节定位</button><label title="音乐与谱面一起变速">速度 <select id="playback-rate" aria-label="演示播放速度"><option value="0.25">0.25×</option><option value="0.5">0.50×</option><option value="0.75">0.75×</option><option value="1" selected>1.00×</option><option value="1.25">1.25×</option><option value="1.5">1.50×</option><option value="2">2.00×</option></select></label><label class="check"><input id="sfx" type="checkbox" checked>打击音</label><button id="loop-button" data-action="loop" title="设置片段循环">↻ 循环</button><label class="volume-control" title="音乐音量">♫ <input id="volume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="音乐音量"></label></div></section>
  <footer class="status-bar"><span class="status-dot"></span><span id="status">就绪</span><span class="status-spacer"></span><button data-action="demo">打开示例谱面</button><span id="runtime-label"></span><kbd>Tab 切换视图</kbd><kbd>Space 播放</kbd></footer>
  <dialog id="modal"><div class="modal-header"><h2 id="modal-title"></h2><button id="modal-close" aria-label="关闭">×</button></div><div id="modal-content"></div></dialog><div id="toast" role="status"></div>`;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const transport = new Transport();
let project = createProject(), projectPath: string | null = null, dirty = false, busy = false;
let view: 'edit' | 'player' = 'edit', cursor = 0, gamePath = localStorage.getItem('chuni-game-path') || (bridge.platform === 'win32' ? 'D:\\chunithm' : '/mnt/d/chunithm');
let history: Project[] = [], future: Project[] = [], autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let library: LibraryEntry[] = [], audioGeneration = 0, peaks: Float32Array = new Float32Array(), coverUrl = '';
const editor = new ChartEditor($('#editor-view'), { onChange: (chart, label) => commit({ ...project, chart }, label), onCursor: tick => { cursor = tick; transport.seek(tickToSeconds(project.chart, tick)); }, onUndo: undo, onRedo: redo });
const player = new ChartPlayer($('#player-canvas-host'));
let resourceDescription = '正在读取随程序保存的资源副本。', resourceWarnings: string[] = [];
async function loadGameResources(): Promise<void> {
  const status = $('#resource-status');
  if (bridge.platform === 'browser') { status.textContent = '开发预览资源'; resourceDescription = '浏览器开发预览采用简化资源；Windows 桌面程序使用项目内的原版资源副本。'; return; }
  try {
    const assets = await bridge.loadGameResources();
    const [visuals, sounds] = await Promise.all([player.setGameTextures(assets.textures), transport.setGameSounds(assets.sounds, file => bridge.readAudio(file))]);
    resourceWarnings = [...assets.textures.warnings, ...(assets.textures.scene?.warnings ?? []), ...assets.sounds.warnings, ...visuals.failed, ...sounds.failed];
    status.textContent = '原版资源副本'; status.dataset.loaded = 'true';
    status.dataset.textures = String(visuals.loaded); status.dataset.sounds = String(sounds.loaded);
    resourceDescription = `已从程序目录载入 ${Object.keys(assets.textures.models).length} 个原始音符模型、${visuals.loaded} 项贴图映射、${sounds.loaded} 类打击音。音符、AIR、CRUSH 与打击效果使用原始模型、材质和动画数据；游玩文字使用复制的游戏字体。演示背景为纯黑，分数和 COMBO 按判定时间表计算。`;
  } catch (error) {
    player.clearGameTextures(); transport.clearGameSounds();
    status.textContent = '简化资源 · 副本未载入'; status.dataset.loaded = 'false';
    resourceDescription = '资源副本未能载入，当前使用简化贴图与合成打击音。请检查程序目录中的 assets/game 文件是否完整。';
    resourceWarnings = [error instanceof Error ? error.message : String(error)];
  }
}
function showResources(): void {
  const warnings = [...resourceWarnings, ...player.getResourceDiagnostics()];
  showModal('播放资源', `<p class="modal-description">${escape(resourceDescription)}</p>${warnings.length ? `<details><summary>兼容性说明（${warnings.length}）</summary>${warnings.map(warning => `<p class="notice">${escape(warning)}</p>`).join('')}</details>` : ''}`);

}
function showJudgements(): void {
  const result = player.getJudgements();
  const labels = { TAP: 'TAP / EX / 长条起头', HLD: 'HOLD 持续', SLD: 'SLIDE', AIR: 'AIR 系列', FLK: 'FLICK', ALL: '总判定' };
  const checked = result.header.matches === true ? '与已有原谱统计一致' : result.header.matches === false ? '与原谱统计有差异' : result.header.available ? '工程已修改，旧统计仅供参考' : '该谱没有原生统计可对照';
  const rule = result.status === 'native' ? '按已支持的判定规则计算' : result.status === 'estimated' ? '部分规则仍在核查，当前为估算' : '含未支持记录，判定尚不完整';
  const rows = Object.entries({ ...result.counts, ALL: result.total }).map(([category, count]) => {
    const key = category as keyof typeof labels, expected = result.header.expected[key];
    return `<tr><th scope="row">${labels[key]}</th><td>${count}</td><td>${expected ?? '—'}</td></tr>`;
  }).join('');
  showModal('自动播放判定统计', `<p class="modal-description">${rule}。${checked}。</p><table class="judgement-table"><thead><tr><th>分类</th><th>当前计算</th><th>原谱记录</th></tr></thead><tbody>${rows}</tbody></table><p class="modal-description">全 JUSTICE CRITICAL 上限为 1,010,000。分数和 COMBO 由当前播放位置计算；从中途播放时包含此前判定，回退或循环不会重复累计。</p>${result.diagnostics.map(warning => `<p class="notice">${escape(warning)}</p>`).join('')}`);
}
const modal = $<HTMLDialogElement>('#modal');
$('#modal-close').onclick = () => modal.close();
modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });
function showModal(title: string, content: string): void { $('#modal-title').textContent = title; $('#modal-content').innerHTML = content; if (!modal.open) modal.showModal(); }
function message(text: string, error = false): void { $('#status').textContent = text; const t = $('#toast'); t.textContent = text; t.className = error ? 'show error' : 'show'; setTimeout(() => t.classList.remove('show'), error ? 7000 : 3500); }
async function run(action: () => Promise<void>): Promise<void> { if (busy) return; busy = true; document.body.classList.add('busy'); try { await action(); } catch (e) { message(e instanceof Error ? e.message : String(e), true); } finally { busy = false; document.body.classList.remove('busy'); } }
function sync(): void {
  editor.setChart(project.chart); editor.setCursor(cursor); editor.setWaveform(peaks, transport.duration, project.audio.offset);
  player.setChart(project.chart);
  const judgements = player.getJudgements();
  $('#judgement-status').textContent = `${judgements.total} 判定`;
  player.title = project.metadata.title; player.difficulty = project.metadata.difficulty;
  player.artist = project.metadata.artist; player.level = project.metadata.level;
  player.weTag = project.exportSettings.weTag; player.stars = project.exportSettings.stars;
  transport.setChart(project.chart); transport.setOffset(project.audio.offset);
  $('#project-title').textContent = project.metadata.title; $('#project-artist').textContent = project.metadata.artist || '未设置作者';
  $('#project-details').textContent = `${project.metadata.difficulty} ${project.metadata.difficulty === 'WORLD’S END' ? `${project.exportSettings.weTag} ${'★'.repeat(Math.max(1, Math.min(5, Math.ceil(project.exportSettings.stars))))}` : project.metadata.level} · ${project.chart.notes.length} 音符`;
  $('#dirty-indicator').textContent = dirty ? '· 未保存' : '';
  document.title = `${dirty ? '● ' : ''}${project.metadata.title} — Chuni Studio`;
  const issues = validateProject(project), errors = issues.filter(i => i.severity === 'error').length;
  $('#validation-button').textContent = errors ? `! ${errors} 项待修正` : issues.length ? `△ ${issues.length} 项提示` : '✓ 检查谱面';
  $('#validation-button').classList.toggle('has-error', errors > 0);
  $<HTMLButtonElement>('[data-action="undo"]').disabled = history.length === 0;
  $<HTMLButtonElement>('[data-action="redo"]').disabled = future.length === 0;
}
function scheduleAutosave(): void { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(() => { void bridge.autosave(project, projectPath).catch(e => message(`自动保存失败：${e.message}`, true)); }, 1500); }
function commit(next: Project, label = '编辑谱面'): void { history.push(project); if (history.length > 80) history.shift(); future = []; project = next; dirty = true; sync(); $('#status').textContent = label; scheduleAutosave(); }
function restoreHistory(next: Project): void {
  const audioChanged = next.audio.path !== project.audio.path, coverChanged = next.coverPath !== project.coverPath;
  project = next; dirty = true; sync(); scheduleAutosave();
  if (audioChanged) void loadAudio(); if (coverChanged) void loadCover();
}
function undo(): void { const previous = history.pop(); if (!previous) return; future.push(project); restoreHistory(previous); }
function redo(): void { const next = future.pop(); if (!next) return; history.push(project); restoreHistory(next); }
function discardAllowed(): boolean { return !dirty || window.confirm('当前工程尚未保存。继续会关闭当前工程，是否继续？'); }
async function load(p: LoadedProject): Promise<void> {
  transport.pause(); transport.loop = null; $('#loop-button').classList.remove('active'); project = p.project; projectPath = p.path; cursor = 0; history = []; future = []; dirty = false; peaks = new Float32Array();
  transport.clearAudio(); transport.seek(0); player.resetStagePosition(); sync(); await Promise.all([loadAudio(), loadCover()]);
}
async function loadAudio(): Promise<void> {
  const generation = ++audioGeneration;
  if (!project.audio.path) { transport.clearAudio(); peaks = new Float32Array(); $('#audio-label').textContent = '尚未载入音乐'; return; }
  $('#audio-label').textContent = '正在读取音乐…';
  try {
    const bytes = await bridge.readAudio(project.audio.path); if (generation !== audioGeneration) return;
    const result = await transport.load(new Uint8Array(bytes).buffer); if (generation !== audioGeneration) return;
    peaks = result.peaks; transport.setOffset(project.audio.offset); editor.setWaveform(peaks, result.duration, project.audio.offset);
    $('#audio-label').textContent = project.audio.path.split(/[\\/]/).pop() || '音乐已载入';
  } catch (e) { transport.clearAudio(); $('#audio-label').textContent = '音乐未载入'; message(`读取音乐失败：${e instanceof Error ? e.message : e}`, true); }
}
let coverGeneration = 0;
async function loadCover(): Promise<void> {
  const generation = ++coverGeneration;
  $('#jacket-mini').textContent = '♫'; coverUrl = ''; void player.setCover('');
  if (!project.coverPath) return;
  try {
    const url = await bridge.readCover(project.coverPath); if (generation !== coverGeneration) return;
    coverUrl = url; const img = document.createElement('img'); img.src = coverUrl; img.alt = '乐曲封面'; $('#jacket-mini').replaceChildren(img);
    await player.setCover(url);
  } catch (e) { if (generation === coverGeneration) message(`封面读取失败：${e instanceof Error ? e.message : e}`, true); }
}
function switchView(next: 'edit' | 'player'): void { view = next; $('#editor-view').hidden = view !== 'edit'; $('#player-view').hidden = view !== 'player'; $('#edit-tab').setAttribute('aria-selected', String(view === 'edit')); $('#play-tab').setAttribute('aria-selected', String(view === 'player')); if (view === 'edit') { editor.resize(); editor.setCursor(cursor, true); } else player.resize(); }
async function save(saveAs = false): Promise<void> { const result = await bridge.saveProject(project, projectPath, saveAs); if (!result) return; project = result.project; projectPath = result.path; dirty = false; clearTimeout(autosaveTimer); sync(); message('工程已保存'); }
function settings(): void {
  const m = project.metadata, a = project.audio, e = project.exportSettings;
  showModal('乐曲与工程设置', `<form id="settings-form"><div class="settings-layout"><div><h3>乐曲信息</h3><label>曲名<input name="title" required value="${escape(m.title)}"></label><div class="form-row"><label>音乐作者<input name="artist" value="${escape(m.artist)}"></label><label>谱师<input name="designer" value="${escape(m.designer)}"></label></div><div class="form-row"><label>难度<select name="difficulty">${['BASIC','ADVANCED','EXPERT','MASTER','ULTIMA','WORLD’S END'].map(d => `<option ${m.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label><label>等级<input name="level" value="${escape(m.level)}"></label><label>初始 BPM<input name="bpm" type="number" min="1" step="0.001" value="${project.chart.defaultBpm}" required></label></div><h3>音乐同步</h3><label>音乐时间偏移（秒，正数表示延迟音乐）<input name="offset" type="number" step="0.001" value="${a.offset}"></label><div class="form-row"><label>选曲试听起点 / 秒<input name="previewStart" type="number" min="0" step="0.01" value="${a.previewStart}"></label><label>试听终点 / 秒<input name="previewEnd" type="number" min="0" step="0.01" value="${a.previewEnd}"></label></div></div><div><h3>封面</h3><button type="button" id="choose-cover" class="cover-picker">${coverUrl ? `<img src="${escape(coverUrl)}" alt="当前封面">` : '<span>＋<small>选择封面图片</small></span>'}</button><h3>WORLD’S END</h3><div class="form-row"><label>属性<input name="weTag" value="${escape(e.weTag)}"></label><label>星级<input name="stars" type="number" min="1" max="5" step="1" value="${e.stars}"></label></div></div></div><div class="form-footer"><span>变 BPM 与变拍号可在编辑页中添加事件。</span><button class="primary" type="submit">应用设置</button></div></form>`);
  $('#choose-cover').onclick = () => void run(async () => { const file = await bridge.pickCover(); if (!file) return; commit({ ...project, coverPath: file }, '更新封面'); await loadCover(); const button = $('#choose-cover'); const img = document.createElement('img'); img.src = coverUrl; img.alt = '当前封面'; button.replaceChildren(img); });
  $<HTMLFormElement>('#settings-form').onsubmit = event => {
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const value = (key: string) => String(data.get(key) ?? '');
    const bpm = Number(value('bpm')), prevStart = Number(value('previewStart')), prevEnd = Number(value('previewEnd'));
    if (!(bpm > 0) || prevEnd <= prevStart) { message('BPM 必须大于零，试听终点必须晚于起点。', true); return; }
    const events = project.chart.events.map(event => event.type === 'BPM' && event.tick === 0 ? { ...event, value: bpm } : event);
    commit({ ...project, metadata: { title: value('title'), artist: value('artist'), designer: value('designer'), difficulty: value('difficulty') as Difficulty, level: value('level') }, audio: { ...project.audio, offset: Number(value('offset')), previewStart: prevStart, previewEnd: prevEnd }, exportSettings: { ...project.exportSettings, weTag: value('weTag'), stars: Number(value('stars')) }, chart: { ...project.chart, defaultBpm: bpm, events } }, '更新乐曲设置'); modal.close();
  };
}
function showValidation(): void {
  const issues = validateProject(project);
  showModal('谱面检查', `<p class="modal-description">${issues.length ? `共 ${issues.length} 项。点击带位置的条目可回到编辑处。` : '没有发现谱面结构错误。原游戏兼容性还需通过导出包的实际加载验证。'}</p><div class="issue-list">${issues.map((i, index) => `<button class="issue ${i.severity}" data-issue="${index}"><b>${i.severity === 'error' ? '错误' : '提示'}</b><span>${escape(i.message)}</span>${i.tick !== undefined ? `<small>${(i.tick / project.chart.resolution + 1).toFixed(2)} 小节 ↗</small>` : ''}</button>`).join('')}</div>`);
  document.querySelectorAll<HTMLElement>('[data-issue]').forEach(button => button.onclick = () => { const issue = issues[Number(button.dataset.issue)]; if (issue.tick !== undefined) { cursor = issue.tick; transport.seek(tickToSeconds(project.chart, cursor)); switchView('edit'); editor.setCursor(cursor, true); modal.close(); } });
}
function playbackDuration(): number { return Math.max(8, chartDuration(project.chart) + 2, transport.duration + project.audio.offset); }
function showMeasureNavigation(): void {
  const current = getMeasureNumberAtTick(project.chart, secondsToTick(project.chart, transport.seconds)) ?? 1;
  showModal('按小节定位与播放', `<form id="measure-form"><p class="modal-description">小节从 1 开始，与编辑器小节线旁的编号一致；变拍号会改变小节长度。输入当前谱面或音乐范围内的小节号。</p><label>起始小节<input id="start-measure" name="measure" type="number" min="1" max="${MAX_MEASURE_NUMBER}" step="1" value="${current}" required></label><p id="measure-preview" class="modal-description" aria-live="polite"></p><div class="form-footer"><button type="button" id="measure-locate">定位到此</button><button type="submit" id="measure-play" class="primary">从此播放</button></div></form>`);
  const input = $<HTMLInputElement>('#start-measure'), form = $<HTMLFormElement>('#measure-form');
  const destination = (): { tick: number; seconds: number } | null => {
    const tick = getMeasureStartTick(project.chart, input.valueAsNumber);
    return tick === null ? null : { tick, seconds: tickToSeconds(project.chart, tick) };
  };
  const preview = (): void => {
    const target = destination();
    $('#measure-preview').textContent = target ? `第 ${input.valueAsNumber} 小节 · ${formatTime(target.seconds)}` : '请输入有效小节号；隐藏小节线的区间没有可定位的编号。';
  };
  const navigate = async (play: boolean): Promise<void> => {
    if (!form.reportValidity()) return;
    const target = destination();
    if (!target) { message('找不到该编号的小节线，请检查小节号或拍号事件。', true); return; }
    if (target.seconds >= playbackDuration()) { message('该小节超出当前谱面或音乐的播放范围。', true); return; }
    transport.pause();
    if (transport.loop && (target.seconds < transport.loop.start || target.seconds >= transport.loop.end)) { transport.loop = null; $('#loop-button').classList.remove('active'); }
    transport.seek(target.seconds); cursor = target.tick; editor.setCursor(cursor, true); modal.close();
    if (play) { switchView('player'); await transport.play(); }
    message(`${play ? '从' : '已定位到'}第 ${input.valueAsNumber} 小节${play ? `播放 · ${transport.rate}×` : ''}`);
  };
  input.oninput = preview;
  $('#measure-locate').onclick = () => void run(() => navigate(false));
  form.onsubmit = event => { event.preventDefault(); void run(() => navigate(true)); };
  preview(); input.focus(); input.select();
}
function showLoop(): void {
  const start = transport.loop?.start ?? transport.seconds, end = transport.loop?.end ?? start + 8;
  showModal('片段循环', `<form id="loop-form"><p class="modal-description">循环起点与终点使用歌曲时间轴的秒数。</p><div class="form-row"><label>起点 / 秒<input name="start" type="number" min="0" step="0.001" value="${start.toFixed(3)}"></label><label>终点 / 秒<input name="end" type="number" min="0" step="0.001" value="${end.toFixed(3)}"></label></div><div class="form-footer"><button type="button" id="loop-clear">取消循环</button><button class="primary">启用循环</button></div></form>`);
  $('#loop-clear').onclick = () => { transport.loop = null; $('#loop-button').classList.remove('active'); modal.close(); };
  $<HTMLFormElement>('#loop-form').onsubmit = event => { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const start = Number(data.get('start')), end = Number(data.get('end')); if (!(end > start)) { message('循环终点必须晚于起点', true); return; } transport.loop = { start, end }; $('#loop-button').classList.add('active'); transport.seek(start); modal.close(); };
}
async function showLibrary(): Promise<void> {
  showModal('本地曲库', `<div class="library-controls"><input id="game-path" value="${escape(gamePath)}" aria-label="游戏目录"><button id="game-choose">选择目录</button><button class="primary" id="game-scan">扫描曲库</button></div><input id="library-search" class="library-search" placeholder="搜索曲名、曲目 ID、难度或资源包…"><div id="library-results" class="library-results"></div>`);
  const results = $('#library-results');
  const render = () => {
    const query = $<HTMLInputElement>('#library-search').value.toLowerCase(); const matches = library.filter(e => `${e.title} ${e.musicId} ${e.difficulty} ${e.pack}`.toLowerCase().includes(query));
    results.innerHTML = `<p class="modal-description">${library.length ? `${matches.length} 张谱面 · 载入后可另存为独立工程` : '选择游戏目录后扫描，包含基础资源与追加包。'}</p>${matches.slice(0, 160).map(e => `<button class="library-song" data-library="${escape(e.key)}"><span class="song-id">${e.musicId}</span><span class="song-name">${escape(e.title)}<small>${escape(e.artist)} · ${escape(e.pack)}</small></span><span class="difficulty difficulty-${e.difficulty === 'WORLD’S END' ? 'we' : e.difficulty.toLowerCase()}">${escape(e.difficulty)} ${escape(e.level)}</span><span>↗</span></button>`).join('')}${matches.length > 160 ? '<p class="modal-description">继续搜索以缩小范围。</p>' : ''}`;
    results.querySelectorAll<HTMLElement>('[data-library]').forEach(button => button.onclick = () => void run(async () => { if (!discardAllowed()) return; const entry = library.find(e => e.key === button.dataset.library)!; message('正在载入谱面和音乐…'); const loaded = await bridge.loadLibraryChart(entry); await load(loaded); modal.close(); message(loaded.warnings?.join(' ') || '已导入本地谱面', !!loaded.warnings?.length); }));
  };
  $('#game-choose').onclick = () => void run(async () => { const selected = await bridge.chooseGamePath(); if (selected) $<HTMLInputElement>('#game-path').value = selected; });
  $('#game-scan').onclick = () => void run(async () => { gamePath = $<HTMLInputElement>('#game-path').value.trim(); localStorage.setItem('chuni-game-path', gamePath); results.textContent = '正在扫描…'; library = await bridge.scanLibrary(gamePath); render(); });
  $<HTMLInputElement>('#library-search').oninput = render; render();
}
function showExport(): void {
  const e = project.exportSettings;
  showModal('导出完整 OPT 追加包', `<form id="export-form"><p class="modal-description">生成谱面、音乐、试听片段、封面与曲目登记文件。输出到你选择的独立目录。</p><label>游戏资源目录<input name="gamePath" value="${escape(gamePath)}" required></label><div class="form-row"><label>OPT 包名<input name="optId" value="${escape(e.optId)}" pattern="A[A-Z0-9]{3}" required></label><label>Music ID<input name="musicId" type="number" min="1" max="9999" value="${e.musicId}" required></label><label>Cue ID<input name="cueId" type="number" min="1" max="9999" value="${e.cueId}" required></label></div><p class="modal-description">导出时会检查既有 ID、资源引用及音频结构。完成后按输出目录内的安装说明安装并验证。</p><div id="export-progress" class="export-progress" role="status"></div><div class="form-footer"><button type="button" id="export-c2s">仅导出 C2S</button><button type="submit" class="primary" id="export-go">选择位置并导出</button></div></form>`);
  const quantization = analyzeC2SQuantization(project.chart);
  if (quantization.required) {
    const section = document.createElement('section'); section.className = 'quantization-report';
    section.innerHTML = `<h3>非常规节奏的原生精度对齐</h3><p class="modal-description">工程保留原始节奏。C2S 按每全音符 ${quantization.resolution} 格输出，此次 ${quantization.affectedCount} 个对象受影响，最大时间误差 ${quantization.maxErrorMs.toFixed(4)} 毫秒。</p><details><summary>查看位置与误差</summary><table><thead><tr><th>位置 / 小节</th><th>类型</th><th>时间误差 / 毫秒</th></tr></thead><tbody>${quantization.entries.slice(0, 80).map(entry => `<tr><td>${(entry.tick / project.chart.resolution + 1).toFixed(5)}</td><td>${escape(entry.type)}</td><td>${entry.maxErrorMs.toFixed(4)}</td></tr>`).join('')}</tbody></table>${quantization.entries.length > 80 ? '<p>这里只显示前 80 项。</p>' : ''}</details><label class="quantization-consent"><input type="checkbox" id="accept-quantization">按上述误差对齐原生格式，保留工程中的原始节奏</label>`;
    if (quantization.entries.some(entry => entry.judgementCountChanged)) {
      const warning = document.createElement('p'); warning.className = 'notice'; warning.textContent = '部分 AIR-CRUSH 内部判定点数量会变化，请检查导出结果。'; section.querySelector('details')!.before(warning);
    }
    $('#export-progress').before(section);
  }
  const canQuantize = (): boolean => !quantization.required || !!document.querySelector<HTMLInputElement>('#accept-quantization')?.checked;
  $('#export-c2s').onclick = () => void run(async () => { if (!canQuantize()) { message('请先查看并接受原生格式的时间精度对齐。', true); return; } const filename = await bridge.exportC2s(project, quantization.required); if (filename) message('C2S 已导出，工程节奏保持不变'); });
  $<HTMLFormElement>('#export-form').onsubmit = event => {
    event.preventDefault(); if (!canQuantize()) { message('请先查看并接受原生格式的时间精度对齐。', true); return; } const data = new FormData(event.currentTarget as HTMLFormElement); gamePath = String(data.get('gamePath')).trim(); localStorage.setItem('chuni-game-path', gamePath);
    commit({ ...project, exportSettings: { ...project.exportSettings, optId: String(data.get('optId')), musicId: Number(data.get('musicId')), cueId: Number(data.get('cueId')) } }, '更新导出设置');
    void run(async () => { const button = $<HTMLButtonElement>('#export-go'); button.disabled = true; $('#export-progress').textContent = '正在准备导出…';
      try { const result = await bridge.exportOpt(project, gamePath, quantization.required); if (result) { showModal('OPT 追加包已生成', `<div class="export-success">✓</div><p>${escape(result.optPath)}</p><p class="modal-description">已生成 ${result.files.length} 个文件并完成结构回读检查。下一步：按输出目录内的安装说明安装到游戏，检查选曲、音乐同步和特殊谱面效果。</p>${result.warnings.map(w => `<p class="notice">${escape(w)}</p>`).join('')}<div class="form-footer"><span></span><button id="reveal-export" class="primary">打开输出位置</button></div>`); $('#reveal-export').onclick = () => void bridge.revealPath(result.optPath); } else $('#export-progress').textContent = '已取消导出'; }
      finally { if (document.contains(button)) button.disabled = false; }
    });
  };
}
function demo(): Project {
  const p = createProject(); p.metadata = { title: '星轨 / First Steps', artist: 'Chuni Studio', designer: 'You', difficulty: 'MASTER', level: '10' };
  for (let i = 0; i < 32; i++) p.chart.notes.push(createNote(i % 7 === 0 ? 'EXTAP' : i % 5 === 0 ? 'FLICK' : 'TAP', 384 + i * 96, (i * 3) % 13, 3));
  p.chart.notes.push({ ...createNote('HOLD', 768, 1, 3), duration: 384 }, { ...createNote('SLIDE', 1536, 0, 3), duration: 384, endLane: 11 }, { ...createNote('SLIDE', 1920, 11, 3), duration: 384, endLane: 3 });
  p.chart.notes.push({ ...createNote('AIR', 2304, 0, 4), attributes: { direction: 'IR', parent: 'TAP' } }, { ...createNote('AIR_HOLD', 2304, 0, 4), duration: 384, attributes: { parent: 'TAP' } });
  p.chart.events.push({ id: makeId('event'), type: 'BPM', tick: 0, value: 120 }); return p;
}
const actions: Record<string, () => void | Promise<void>> = {
  new: async () => { if (discardAllowed()) { await load({ project: createProject(), path: null }); settings(); } },
  open: async () => { if (!discardAllowed()) return; const loaded = await bridge.openProject(); if (loaded) await load(loaded); },
  import: async () => { if (!discardAllowed()) return; const loaded = await bridge.importC2s(); if (loaded) await load(loaded); },
  save: () => save(), undo, redo, settings, xml: () => openXmlSettings(project, { showModal, commit, close: () => modal.close(), error: text => message(text, true) }), edit: () => switchView('edit'), player: () => switchView('player'),
  audio: async () => { const file = await bridge.pickAudio(); if (file) { commit({ ...project, audio: { ...project.audio, path: file } }, '导入音乐'); await loadAudio(); } },
  toggle: async () => { if (transport.playing) transport.pause(); else await transport.play(); },
  restart: () => { player.resetStagePosition(); transport.seek(0); cursor = 0; editor.setCursor(0, true); },
  stop: () => { transport.pause(); player.resetStagePosition(); transport.seek(0); cursor = 0; editor.setCursor(0, true); },
  loop: showLoop, validate: showValidation, library: showLibrary, export: showExport, resources: showResources, judgements: showJudgements, measure: showMeasureNavigation,
  fullscreen: async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#player-view').requestFullscreen(); },
  demo: async () => { if (discardAllowed()) { await load({ project: demo(), path: null }); dirty = true; sync(); message('示例谱面已载入，可以编辑并播放打击音。'); } },
};
document.querySelectorAll<HTMLElement>('[data-action]').forEach(button => button.onclick = () => { const action = actions[button.dataset.action!]; void run(async () => { await action?.(); }); });
$<HTMLInputElement>('#seek').oninput = event => { transport.seek(Number((event.target as HTMLInputElement).value)); cursor = secondsToTick(project.chart, transport.seconds); editor.setCursor(cursor, true); };
$<HTMLSelectElement>('#playback-rate').onchange = event => transport.setRate(Number((event.target as HTMLSelectElement).value));
$<HTMLInputElement>('#volume').oninput = event => transport.setVolume(Number((event.target as HTMLInputElement).value));
$<HTMLInputElement>('#sfx').onchange = event => { transport.effects = (event.target as HTMLInputElement).checked; };
$<HTMLInputElement>('#scroll-speed').oninput = event => { player.speed = Number((event.target as HTMLInputElement).value); $('#scroll-speed-label').textContent = player.speed.toFixed(1); };
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || modal.open || (event.target as HTMLElement)?.closest('input,select,textarea,[contenteditable="true"]')) return;
  const mod = event.ctrlKey || event.metaKey;
  if (event.code === 'Space') { event.preventDefault(); void actions.toggle(); }
  else if (mod && event.key.toLowerCase() === 'g') { event.preventDefault(); showMeasureNavigation(); }
  else if (event.key === 'Tab') { event.preventDefault(); switchView(view === 'edit' ? 'player' : 'edit'); }
  else if (mod && ['s', 'o', 'n'].includes(event.key.toLowerCase())) { event.preventDefault(); const action = event.key.toLowerCase() === 's' ? () => save(event.shiftKey) : event.key.toLowerCase() === 'o' ? actions.open : actions.new; void run(async () => { await action(); }); }
  else if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
});
window.addEventListener('beforeunload', event => { if (dirty && bridge.platform !== 'browser') { event.preventDefault(); event.returnValue = ''; } });
bridge.onProgress(text => { $('#status').textContent = text; const output = document.querySelector('#export-progress'); if (output) output.textContent = text; });
$('#runtime-label').textContent = bridge.platform === 'browser' ? '浏览器开发预览' : '本地桌面 · 离线';
const formatTime = (time: number): string => { const ms = Math.max(0, Math.floor(time * 1000)); return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
function frame(): void {
  const seconds = transport.seconds, duration = playbackDuration();
  if (transport.playing && seconds > duration && !transport.loop) transport.pause();
  cursor = secondsToTick(project.chart, seconds);
  if (view === 'edit') editor.setCursor(cursor, transport.playing); else player.render(seconds, transport.playing);
  $('#time-current').textContent = formatTime(seconds); $('#time-total').textContent = `/ ${formatTime(duration)}`;
  $('#play-button').textContent = transport.playing ? 'Ⅱ' : '▶';
  const seek = $<HTMLInputElement>('#seek'); seek.max = String(duration); seek.value = String(seconds);
  seek.style.setProperty('--progress', `${Math.min(100, seconds / duration * 100)}%`);
  const measure = getMeasureNumberAtTick(project.chart, cursor);
  $('#position-label').textContent = `${measure === null ? '小节线隐藏' : `第 ${String(measure).padStart(3, '0')} 小节`} · BPM ${bpmAtTick(project.chart, cursor).toFixed(1)}`;
  requestAnimationFrame(frame);
}
sync(); requestAnimationFrame(frame);
void loadGameResources();
void bridge.getRecovery().then(recovery => { if (!recovery) return; showModal('发现自动保存的工程', `<p>上次未保存的工程：<strong>${escape(recovery.project.metadata.title)}</strong></p><div class="form-footer"><button id="recovery-discard">放弃恢复</button><button id="recovery-restore" class="primary">恢复工程</button></div>`); $('#recovery-discard').onclick = () => { void bridge.autosave(null, null); modal.close(); }; $('#recovery-restore').onclick = () => void run(async () => { await load(recovery); dirty = true; sync(); modal.close(); }); }).catch(e => message(e.message, true));
