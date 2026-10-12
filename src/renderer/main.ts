import './style.css';
import './editor.css';
import { createProject, createNote, makeId, type Project, type Chart, type Difficulty } from '../core/model';
import { chartDuration, secondsToTick, tickToSeconds, bpmAtTick, getMeasureStartTick, getMeasureNumberAtTick, MAX_MEASURE_NUMBER } from '../core/timing';
import { validateProject } from '../core/validation';
import { buildJudgementTimeline } from '../core/judgement';
import { analyzeC2SQuantization } from '../core/quantization';
import { ChartEditor } from './editor';
import { ChartPlayer } from './player';
import { Transport } from './transport';
import { browserBridge } from './browser-bridge';
import { openXmlSettings } from './xml-settings';
import type { LibraryEntry, LoadedProject } from '../bridge';
import { appTemplate } from './app-template';
import { $, escape, formatTime } from './dom';
import type { AppContext } from './app-context';
import { openSettings } from './dialogs/settings';
import { showResources, showJudgements, showValidation } from './dialogs/info';
import { showMeasureNavigation, showLoop } from './dialogs/navigation';
import { showLibrary } from './dialogs/library';
import { showRecentProjects } from './dialogs/recent';
import { showExport } from './dialogs/export';
import { createDemoProject } from './demo-project';

const bridge = window.studio ?? browserBridge;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = appTemplate;
const transport = new Transport();
let project = createProject(), projectPath: string | null = null, dirty = false, busy = false;
let view: 'edit' | 'player' = 'edit', cursor = 0, gamePath = localStorage.getItem('chuni-game-path') || (bridge.platform === 'win32' ? 'D:\\chunithm' : '/mnt/d/chunithm');
let history: Project[] = [], future: Project[] = [], autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let library: LibraryEntry[] = [], audioGeneration = 0, peaks: Float32Array = new Float32Array(), coverUrl = '';
const editor = new ChartEditor($('#editor-view'), { onChange: (chart, label) => commit({ ...project, chart }, label), onCursor: tick => { cursor = tick; transport.seek(tickToSeconds(project.chart, tick)); }, onUndo: undo, onRedo: redo, onOffset: (offset, label) => commit({ ...project, audio: { ...project.audio, offset } }, label) });
const player = new ChartPlayer($('#player-canvas-host'));
/** The player's per-chart indexes (sorted notes, UV spans, effect events) are rebuilt only when the player view is shown. */
let pendingPlayerChart: Chart | undefined;
function syncPlayerChart(): void { if (pendingPlayerChart) { player.setChart(pendingPlayerChart); pendingPlayerChart = undefined; } }
let resourceDescription = '正在读取随程序保存的资源副本。', resourceWarnings: string[] = [];
async function loadGameResources(): Promise<void> {
  const status = $('#resource-status');
  if (bridge.platform === 'browser') { status.textContent = '开发预览资源'; resourceDescription = '浏览器开发预览采用简化资源；Windows 桌面程序使用项目内的原版资源副本。'; return; }
  try {
    const assets = await bridge.loadGameResources();
    const [visuals, sounds] = await Promise.all([player.setGameTextures(assets.textures), transport.setGameSounds(assets.sounds, file => bridge.readAudio(file))]);
    editor.setBodyTextures(assets.textures.textures);
    resourceWarnings = [...assets.textures.warnings, ...(assets.textures.scene?.warnings ?? []), ...assets.sounds.warnings, ...visuals.failed, ...sounds.failed];
    status.textContent = '原版资源副本'; status.dataset.loaded = 'true';
    status.dataset.textures = String(visuals.loaded); status.dataset.sounds = String(sounds.loaded);
    resourceDescription = `已从程序目录载入 ${Object.keys(assets.textures.models).length} 个原始音符模型、${visuals.loaded} 项贴图映射、${sounds.loaded} 类打击音。音符、AIR、CRUSH 与打击效果使用原始模型、材质和动画数据；游玩文字使用复制的游戏字体，顶部 HUD 使用原判定条、默认 Frame 与名牌布局。演示背景为纯黑，分数和 COMBO 按判定时间表计算；技能槽按已判定比例填充，不模拟技能与槽数。`;
  } catch (error) {
    player.clearGameTextures(); transport.clearGameSounds(); editor.setBodyTextures(undefined);
    status.textContent = '简化资源 · 副本未载入'; status.dataset.loaded = 'false';
    resourceDescription = '资源副本未能载入，当前使用简化贴图与合成打击音。请检查程序目录中的 assets/game 文件是否完整。';
    resourceWarnings = [error instanceof Error ? error.message : String(error)];
  }
}
const modal = $<HTMLDialogElement>('#modal');
$('#modal-close').onclick = () => modal.close();
modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });
function showModal(title: string, content: string): void { $('#modal-title').textContent = title; $('#modal-content').innerHTML = content; if (!modal.open) modal.showModal(); }
function message(text: string, error = false): void { $('#status').textContent = text; const t = $('#toast'); t.textContent = text; t.className = error ? 'show error' : 'show'; setTimeout(() => t.classList.remove('show'), error ? 7000 : 3500); }
async function run(action: () => Promise<void>): Promise<void> { if (busy) return; busy = true; document.body.classList.add('busy'); try { await action(); } catch (e) { message(e instanceof Error ? e.message : String(e), true); } finally { busy = false; document.body.classList.remove('busy'); } }
function sync(): void {
  editor.setChart(project.chart); editor.setCursor(cursor); editor.setWaveform(peaks, transport.duration, project.audio.offset, transport.musicSamples);
  pendingPlayerChart = project.chart; if (view === 'player') syncPlayerChart();
  $('#judgement-status').textContent = `${buildJudgementTimeline(project.chart).total} 判定`;
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
  if (!project.audio.path) { transport.clearAudio(); peaks = new Float32Array(); editor.setWaveform(peaks, 0, project.audio.offset, null); $('#audio-label').textContent = '尚未载入音乐'; return; }
  $('#audio-label').textContent = '正在读取音乐…';
  try {
    const bytes = await bridge.readAudio(project.audio.path); if (generation !== audioGeneration) return;
    const result = await transport.load(new Uint8Array(bytes).buffer); if (generation !== audioGeneration) return;
    peaks = result.peaks; transport.setOffset(project.audio.offset); editor.setWaveform(peaks, result.duration, project.audio.offset, transport.musicSamples);
    $('#audio-label').textContent = project.audio.path.split(/[\\/]/).pop() || '音乐已载入';
  } catch (e) { transport.clearAudio(); peaks = new Float32Array(); editor.setWaveform(peaks, 0, project.audio.offset, null); $('#audio-label').textContent = '音乐未载入'; message(`读取音乐失败：${e instanceof Error ? e.message : e}`, true); }
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
function switchView(next: 'edit' | 'player'): void { view = next; $('#editor-view').hidden = view !== 'edit'; $('#player-view').hidden = view !== 'player'; $('#edit-tab').setAttribute('aria-selected', String(view === 'edit')); $('#play-tab').setAttribute('aria-selected', String(view === 'player')); if (view === 'edit') { editor.resize(); editor.setCursor(cursor, true); } else { syncPlayerChart(); player.resize(); } }
const ctx: AppContext = {
  bridge, transport, player, editor, modal,
  get project() { return project; },
  get gamePath() { return gamePath; }, set gamePath(value) { gamePath = value; },
  get library() { return library; }, set library(value) { library = value; },
  get coverUrl() { return coverUrl; },
  get resources() { return { description: resourceDescription, warnings: resourceWarnings }; },
  commit, showModal, message, run, load, loadCover, discardAllowed, openProject, switchView, playbackDuration, syncPlayerChart,
  seekTick(tick) { cursor = tick; transport.seek(tickToSeconds(project.chart, tick)); editor.setCursor(cursor, true); },
};
async function save(saveAs = false): Promise<void> {
  const before = project, result = await bridge.saveProject(project, projectPath, saveAs); if (!result) return;
  // Saving moves assets into the project folder and deletes replaced ones. Undo steps follow the saved copies,
  // so an undo neither reloads the same music from its old place nor points at a deleted file.
  const removed = new Set(result.removed ?? []), saved = result.project;
  const follow = (p: Project): Project => {
    const audioPath = p.audio.path === before.audio.path || removed.has(p.audio.path) ? saved.audio.path : p.audio.path;
    const coverPath = p.coverPath === before.coverPath || removed.has(p.coverPath) ? saved.coverPath : p.coverPath;
    return audioPath === p.audio.path && coverPath === p.coverPath ? p : { ...p, audio: { ...p.audio, path: audioPath }, coverPath };
  };
  history = history.map(follow); future = future.map(follow);
  project = saved; projectPath = result.path; dirty = false; clearTimeout(autosaveTimer); sync(); message(`项目已保存到 ${result.path}`);
}
async function openProject(directory?: string): Promise<void> {
  const loaded = await bridge.openProject(directory); if (!loaded) return;
  await load(loaded); if (loaded.warnings?.length) message(loaded.warnings.join(' '), true);
}
function playbackDuration(): number { return Math.max(8, chartDuration(project.chart) + 2, transport.duration + project.audio.offset); }
const actions: Record<string, () => void | Promise<void>> = {
  new: async () => { if (discardAllowed()) { await load({ project: createProject(), path: null }); openSettings(ctx); } },
  open: async () => { if (!discardAllowed()) return; const recent = await bridge.listRecentProjects(); if (recent.length) showRecentProjects(ctx, recent); else await openProject(); },
  import: async () => { if (!discardAllowed()) return; const loaded = await bridge.importC2s(); if (loaded) await load(loaded); },
  save: () => save(), undo, redo, settings: () => openSettings(ctx), xml: () => openXmlSettings(project, { showModal, commit, close: () => modal.close(), error: text => message(text, true) }), edit: () => switchView('edit'), player: () => switchView('player'),
  audio: async () => { const file = await bridge.pickAudio(); if (file) { commit({ ...project, audio: { ...project.audio, path: file } }, '导入音乐'); await loadAudio(); } },
  toggle: async () => { if (transport.playing) transport.pause(); else await transport.play(); },
  restart: () => { player.resetStagePosition(); transport.seek(0); cursor = 0; editor.setCursor(0, true); },
  stop: () => { transport.pause(); player.resetStagePosition(); transport.seek(0); cursor = 0; editor.setCursor(0, true); },
  loop: () => showLoop(ctx), validate: () => showValidation(ctx), library: () => showLibrary(ctx), export: () => showExport(ctx), resources: () => showResources(ctx), judgements: () => showJudgements(ctx), measure: () => showMeasureNavigation(ctx),
  fullscreen: async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#player-view').requestFullscreen(); },
  demo: async () => { if (discardAllowed()) { await load({ project: createDemoProject(), path: null }); dirty = true; sync(); message('示例谱面已载入，可以编辑并播放打击音。'); } },
};
document.querySelectorAll<HTMLElement>('[data-action]').forEach(button => button.onclick = () => { const action = actions[button.dataset.action!]; void run(async () => { await action?.(); }); });
$<HTMLInputElement>('#seek').oninput = event => { transport.seek(Number((event.target as HTMLInputElement).value)); cursor = secondsToTick(project.chart, transport.seconds); editor.setCursor(cursor, true); };
$<HTMLSelectElement>('#playback-rate').onchange = event => transport.setRate(Number((event.target as HTMLSelectElement).value));
$<HTMLInputElement>('#volume').oninput = event => transport.setVolume(Number((event.target as HTMLInputElement).value));
$<HTMLInputElement>('#sfx').onchange = event => { transport.effects = (event.target as HTMLInputElement).checked; };
// The metronome is a personal monitoring preference, so it lives with this machine's settings, not in the project.
const metronomeToggle = $<HTMLInputElement>('#metronome'), metronomeVolume = $<HTMLInputElement>('#metronome-volume'), storedMetronomeVolume = Number(localStorage.getItem('chuni-metronome-volume') ?? 0.5);
metronomeToggle.checked = transport.metronome = localStorage.getItem('chuni-metronome') === '1';
metronomeVolume.value = String(transport.metronomeVolume = Number.isFinite(storedMetronomeVolume) ? Math.max(0, Math.min(1, storedMetronomeVolume)) : 0.5);
metronomeToggle.onchange = () => { transport.metronome = metronomeToggle.checked; localStorage.setItem('chuni-metronome', metronomeToggle.checked ? '1' : '0'); };
metronomeVolume.oninput = () => { transport.metronomeVolume = Number(metronomeVolume.value); localStorage.setItem('chuni-metronome-volume', metronomeVolume.value); };
$<HTMLInputElement>('#scroll-speed').oninput = event => { player.speed = Number((event.target as HTMLInputElement).value); $('#scroll-speed-label').textContent = player.speed.toFixed(1); };
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || modal.open || (event.target as HTMLElement)?.closest('input,select,textarea,[contenteditable="true"]')) return;
  const mod = event.ctrlKey || event.metaKey;
  // Space, Ctrl+Space, P, F4 and F5 follow Margrete's default keys.
  if (event.code === 'Space') { event.preventDefault(); if (mod) void run(async () => { transport.pause(); await actions.restart(); await transport.play(); }); else void actions.toggle(); }
  else if (event.key === 'F4') { event.preventDefault(); showValidation(ctx); }
  else if (event.key === 'F5') { event.preventDefault(); showExport(ctx); }
  else if (!mod && !event.altKey && event.key.toLowerCase() === 'p') { event.preventDefault(); openSettings(ctx); }
  else if (mod && event.key.toLowerCase() === 'g') { event.preventDefault(); showMeasureNavigation(ctx); }
  else if (event.key === 'Tab') { event.preventDefault(); switchView(view === 'edit' ? 'player' : 'edit'); }
  else if (mod && ['s', 'o', 'n'].includes(event.key.toLowerCase())) { event.preventDefault(); const action = event.key.toLowerCase() === 's' ? () => save(event.shiftKey) : event.key.toLowerCase() === 'o' ? actions.open : actions.new; void run(async () => { await action(); }); }
  else if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
});
window.addEventListener('beforeunload', event => { if (dirty && bridge.platform !== 'browser') { event.preventDefault(); event.returnValue = ''; } });
bridge.onProgress(text => { $('#status').textContent = text; for (const output of document.querySelectorAll('#export-progress, #library-results[data-scanning]')) output.textContent = text; });
$('#runtime-label').textContent = bridge.platform === 'browser' ? '浏览器开发预览' : '本地桌面 · 离线';
const frameElements = { current: $('#time-current'), total: $('#time-total'), play: $('#play-button'), seek: $<HTMLInputElement>('#seek'), position: $('#position-label') };
const setText = (element: HTMLElement, text: string) => { if (element.textContent !== text) element.textContent = text; };
function frame(): void {
  const seconds = transport.seconds, duration = playbackDuration();
  if (transport.playing && seconds > duration && !transport.loop) transport.pause();
  cursor = secondsToTick(project.chart, seconds);
  if (view === 'edit') editor.setCursor(cursor, transport.playing); else player.render(seconds);
  setText(frameElements.current, formatTime(seconds)); setText(frameElements.total, `/ ${formatTime(duration)}`);
  setText(frameElements.play, transport.playing ? 'Ⅱ' : '▶');
  const seek = frameElements.seek, max = String(duration), value = String(seconds);
  if (seek.max !== max) seek.max = max;
  if (seek.value !== value) { seek.value = value; seek.style.setProperty('--progress', `${Math.min(100, seconds / duration * 100)}%`); }
  const measure = getMeasureNumberAtTick(project.chart, cursor);
  setText(frameElements.position, `${measure === null ? '小节线隐藏' : `第 ${String(measure).padStart(3, '0')} 小节`} · BPM ${bpmAtTick(project.chart, cursor).toFixed(1)}`);
  requestAnimationFrame(frame);
}
sync(); requestAnimationFrame(frame);
void loadGameResources();
void bridge.getRecovery().then(recovery => { if (!recovery) return; showModal('发现自动保存的工程', `<p>上次未保存的工程：<strong>${escape(recovery.project.metadata.title)}</strong></p><div class="form-footer"><button id="recovery-discard">放弃恢复</button><button id="recovery-restore" class="primary">恢复工程</button></div>`); $('#recovery-discard').onclick = () => { void bridge.autosave(null, null); modal.close(); }; $('#recovery-restore').onclick = () => void run(async () => { await load(recovery); dirty = true; sync(); modal.close(); }); }).catch(e => message(e.message, true));
