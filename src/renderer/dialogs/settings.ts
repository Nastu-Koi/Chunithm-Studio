import { ICON } from '../icons';
import type { Difficulty } from '../../core/model';
import type { AppContext } from '../app-context';
import { $, escape } from '../dom';

export function openSettings(ctx: AppContext): void {
  const { bridge, modal, showModal, message, run, commit, loadCover } = ctx;
  const m = ctx.project.metadata,
    a = ctx.project.audio,
    e = ctx.project.exportSettings;
  showModal(
    '乐曲与工程设置',
    `<form id="settings-form"><div class="settings-layout"><div><h3>乐曲信息</h3><label>曲名<input name="title" required value="${escape(m.title)}"></label><div class="form-row"><label>音乐作者<input name="artist" value="${escape(m.artist)}"></label><label>谱师<input name="designer" value="${escape(m.designer)}"></label></div><div class="form-row"><label>难度<select name="difficulty">${['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'ULTIMA', 'WORLD’S END'].map(d => `<option ${m.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label><label>等级<input name="level" value="${escape(m.level)}"></label><label>初始 BPM<input name="bpm" type="number" min="1" step="0.001" value="${ctx.project.chart.defaultBpm}" required></label></div><h3>音乐同步</h3><label>音乐时间偏移（秒，正数表示延迟音乐）<input name="offset" type="number" step="0.001" value="${a.offset}"></label><div class="form-row"><label>选曲试听起点 / 秒<input name="previewStart" type="number" min="0" step="0.01" value="${a.previewStart}"></label><label>试听终点 / 秒<input name="previewEnd" type="number" min="0" step="0.01" value="${a.previewEnd}"></label></div></div><div><h3>封面</h3><button type="button" id="choose-cover" class="cover-picker">${ctx.coverUrl ? `<img src="${escape(ctx.coverUrl)}" alt="当前封面">` : `<span>${ICON.image}<small>选择封面图片</small></span>`}</button><h3>WORLD’S END</h3><div class="form-row"><label>属性<input name="weTag" value="${escape(e.weTag)}"></label><label>星级<input name="stars" type="number" min="1" max="5" step="1" value="${e.stars}"></label></div></div></div><div class="form-footer"><span>变 BPM 与变拍号可在编辑页中添加事件。</span><button class="primary" type="submit">应用设置</button></div></form>`,
  );
  $('#choose-cover').onclick = () =>
    void run(async () => {
      const file = await bridge.pickCover();
      if (!file) return;
      commit({ ...ctx.project, coverPath: file }, '更新封面');
      await loadCover();
      const button = $('#choose-cover');
      const img = document.createElement('img');
      img.src = ctx.coverUrl;
      img.alt = '当前封面';
      button.replaceChildren(img);
    });
  $<HTMLFormElement>('#settings-form').onsubmit = event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const value = (key: string) => String(data.get(key) ?? '');
    const bpm = Number(value('bpm')),
      prevStart = Number(value('previewStart')),
      prevEnd = Number(value('previewEnd'));
    if (!(bpm > 0) || prevEnd <= prevStart) {
      message('BPM 必须大于零，试听终点必须晚于起点。', true);
      return;
    }
    const events = ctx.project.chart.events.map(event =>
      event.type === 'BPM' && event.tick === 0 ? { ...event, value: bpm } : event,
    );
    commit(
      {
        ...ctx.project,
        metadata: {
          title: value('title'),
          artist: value('artist'),
          designer: value('designer'),
          difficulty: value('difficulty') as Difficulty,
          level: value('level'),
        },
        audio: { ...ctx.project.audio, offset: Number(value('offset')), previewStart: prevStart, previewEnd: prevEnd },
        exportSettings: { ...ctx.project.exportSettings, weTag: value('weTag'), stars: Number(value('stars')) },
        chart: { ...ctx.project.chart, defaultBpm: bpm, events },
      },
      '更新乐曲设置',
    );
    modal.close();
  };
}
