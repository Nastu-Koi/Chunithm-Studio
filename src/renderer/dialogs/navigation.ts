import { secondsToTick, tickToSeconds, getMeasureStartTick, getMeasureNumberAtTick, MAX_MEASURE_NUMBER } from '../../core/timing';
import type { AppContext } from '../app-context';
import { $, formatTime } from '../dom';

export function showMeasureNavigation(ctx: AppContext): void {
  const { transport, modal, showModal, message, run, switchView, playbackDuration } = ctx;
  const current = getMeasureNumberAtTick(ctx.project.chart, secondsToTick(ctx.project.chart, transport.seconds)) ?? 1;
  showModal('按小节定位与播放', `<form id="measure-form"><p class="modal-description">小节从 1 开始，与编辑器小节线旁的编号一致；变拍号会改变小节长度。输入当前谱面或音乐范围内的小节号。</p><label>起始小节<input id="start-measure" name="measure" type="number" min="1" max="${MAX_MEASURE_NUMBER}" step="1" value="${current}" required></label><p id="measure-preview" class="modal-description" aria-live="polite"></p><div class="form-footer"><button type="button" id="measure-locate">定位到此</button><button type="submit" id="measure-play" class="primary">从此播放</button></div></form>`);
  const input = $<HTMLInputElement>('#start-measure'), form = $<HTMLFormElement>('#measure-form');
  const destination = (): { tick: number; seconds: number } | null => {
    const tick = getMeasureStartTick(ctx.project.chart, input.valueAsNumber);
    return tick === null ? null : { tick, seconds: tickToSeconds(ctx.project.chart, tick) };
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
    ctx.seekTick(target.tick); modal.close();
    if (play) { switchView('player'); await transport.play(); }
    message(`${play ? '从' : '已定位到'}第 ${input.valueAsNumber} 小节${play ? `播放 · ${transport.rate}×` : ''}`);
  };
  input.oninput = preview;
  $('#measure-locate').onclick = () => void run(() => navigate(false));
  form.onsubmit = event => { event.preventDefault(); void run(() => navigate(true)); };
  preview(); input.focus(); input.select();
}
export function showLoop(ctx: AppContext): void {
  const { transport, modal, showModal, message } = ctx;
  const start = transport.loop?.start ?? transport.seconds, end = transport.loop?.end ?? start + 8;
  showModal('片段循环', `<form id="loop-form"><p class="modal-description">循环起点与终点使用歌曲时间轴的秒数。</p><div class="form-row"><label>起点 / 秒<input name="start" type="number" min="0" step="0.001" value="${start.toFixed(3)}"></label><label>终点 / 秒<input name="end" type="number" min="0" step="0.001" value="${end.toFixed(3)}"></label></div><div class="form-footer"><button type="button" id="loop-clear">取消循环</button><button class="primary">启用循环</button></div></form>`);
  $('#loop-clear').onclick = () => { transport.loop = null; $('#loop-button').classList.remove('active'); modal.close(); };
  $<HTMLFormElement>('#loop-form').onsubmit = event => { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const start = Number(data.get('start')), end = Number(data.get('end')); if (!(end > start)) { message('循环终点必须晚于起点', true); return; } transport.loop = { start, end }; $('#loop-button').classList.add('active'); transport.seek(start); modal.close(); };
}
