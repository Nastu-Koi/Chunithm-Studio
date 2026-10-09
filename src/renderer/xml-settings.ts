import type { Project } from '../core/model';
import { getXmlMetadata, validateXmlMetadata } from '../core/xml-metadata';

interface XmlSettingsActions {
  showModal(title: string, content: string): void;
  commit(project: Project, label: string): void;
  close(): void;
  error(message: string): void;
}
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const references = [
  ['releaseTagName', '版本登记'], ['netOpenName', '开放批次'], ['worksName', '作品'],
  ['labelName', '版权标签'], ['stageName', '舞台'],
] as const;
type Reference = { id: number; str: string; data: string };
function referenceFields(prefix: string, value: Reference | null): string {
  return `<div class="xml-reference-fields"><label>ID<input name="${prefix}.id" type="number" min="-1" step="1" value="${escape(value?.id)}" placeholder="${prefix === 'stageName' ? '随难度设置' : '保留原值'}"></label><label>名称<input name="${prefix}.str" value="${escape(value?.str)}" placeholder="原库登记名称"></label><label>附加值<input name="${prefix}.data" value="${escape(value?.data)}"></label></div>`;
}

export function openXmlSettings(project: Project, actions: XmlSettingsActions): void {
  const metadata = structuredClone(getXmlMetadata(project)), music = metadata.music;
  actions.showModal('Music / CueFile XML 信息', `<form id="xml-settings-form">
    <p class="modal-description">修改内容随工程保存，并在导出 OPT 时写入 Music.xml 与 CueFile.xml。从本地曲库载入的其他 XML 字段也会保留。</p>
    <fieldset class="xml-section"><legend>乐曲登记 · Music.xml</legend>
      <label>曲名<input name="title" required value="${escape(project.metadata.title)}"></label>
      <div class="form-row"><label>音乐作者<input name="artist" value="${escape(project.metadata.artist)}"></label><label>谱师<input name="designer" value="${escape(project.metadata.designer)}"></label></div>
      <label>排序名 <small>sortName</small><input name="sortName" value="${escape(music.sortName)}" placeholder="留空时使用曲名"></label>
      <div class="form-row"><label>发布日期 <small>releaseDate · YYYYMMDD，0 表示未设置</small><input name="releaseDate" value="${escape(music.releaseDate)}" inputmode="numeric" pattern="0|[0-9]{8}" maxlength="8" placeholder="留空保留原值或模板日期"></label><label>显示优先级 <small>priority</small><input name="priority" type="number" step="1" required value="${music.priority}"></label></div>
      <div class="xml-flags">${([['disableFlag', '禁用乐曲'], ['firstLock', '初始锁定'], ['isGiftMusic', '礼物乐曲']] as const).map(([key, label]) => `<label><input name="${key}" type="checkbox" ${music[key] ? 'checked' : ''}><span>${label}<small>${key}</small></span></label>`).join('')}</div>
    </fieldset>
    <fieldset class="xml-section"><legend>分类与版本引用</legend>
      <p class="xml-help">ID 与名称对应游戏库中已登记的条目。引用留空时保留原曲值，没有原曲时沿用模板；舞台留空时随难度设置。填写 -1 / Invalid 表示无关联。</p>
      <div class="xml-reference"><strong>分类 <small>genreNames</small></strong><label class="xml-inline-check"><input id="xml-inherit-genres" type="checkbox" ${music.genreNames === null ? 'checked' : ''}>沿用原曲或模板分类</label><div id="xml-genres"></div><button id="xml-add-genre" type="button">＋ 添加分类</button></div>
      ${references.map(([key, label]) => `<div class="xml-reference"><strong>${label} <small>${key}</small></strong>${referenceFields(key, music[key])}</div>`).join('')}
    </fieldset>
    <fieldset class="xml-section"><legend>资源关联 · Music.xml / CueFile.xml</legend>
      <div class="form-row"><label>Music ID<input name="musicId" type="number" min="1" max="9999" step="1" required value="${project.exportSettings.musicId}"></label><label>CueFile ID<input name="cueId" type="number" min="1" max="9999" step="1" required value="${project.exportSettings.cueId}"></label></div>
      <p class="xml-help">两个 ID 可以不同。目录名、ACB/AWB 文件名和双方引用会同步生成；导出时检查与原游戏曲目的 ID 冲突。</p>
      <pre id="xml-resource-preview" aria-live="polite"></pre>
      <p class="xml-help">难度、等级、WORLD’S END 属性及试听区间使用「乐曲设置」；封面、谱面路径、谱师与初始 BPM 随当前工程更新。</p>
    </fieldset>
    <div class="form-footer"><span>${metadata.sourceMusic ? '已保留导入曲目的 XML 附加字段' : '未设置的引用沿用本地游戏模板'}</span><button class="primary" type="submit">应用 XML 信息</button></div>
  </form>`);
  const form = document.querySelector<HTMLFormElement>('#xml-settings-form')!;
  const genres = form.querySelector<HTMLDivElement>('#xml-genres')!;
  const inheritGenres = form.querySelector<HTMLInputElement>('#xml-inherit-genres')!;
  let genreSequence = 0;
  function addGenre(value: Reference = { id: 6, str: 'VARIETY', data: '' }): void {
    const row = document.createElement('div'); row.className = 'xml-genre-row';
    row.dataset.prefix = `genre-${genreSequence++}`;
    row.innerHTML = `${referenceFields(row.dataset.prefix, value)}<button type="button" aria-label="移除此分类">移除</button>`;
    row.querySelector('button')!.onclick = () => row.remove(); genres.append(row);
  }
  for (const value of music.genreNames ?? []) addGenre(value);
  function updateGenres(): void {
    genres.hidden = inheritGenres.checked;
    genres.querySelectorAll('input').forEach(input => { input.disabled = inheritGenres.checked; });
  }
  inheritGenres.onchange = updateGenres;
  form.querySelector<HTMLButtonElement>('#xml-add-genre')!.onclick = () => { inheritGenres.checked = false; addGenre(); updateGenres(); };
  updateGenres();
  const resourcePreview = (): void => {
    const data = new FormData(form), mid = String(data.get('musicId') ?? ''), cid = String(data.get('cueId') ?? '');
    const musicId = Number(mid), cueId = Number(cid);
    const preview = form.querySelector<HTMLElement>('#xml-resource-preview')!;
    if (![musicId, cueId].every(value => Number.isInteger(value) && value >= 1 && value <= 9999)) { preview.textContent = '请输入 1–9999 的整数 ID。'; return; }
    const musicName = `music${String(musicId).padStart(4, '0')}`, cueName = `music${String(cueId).padStart(4, '0')}`;
    preview.textContent = `music/${musicName}/Music.xml\n  name.id = ${musicId}\n  cueFileName.id = ${cueId}\ncueFile/cueFile${String(cueId).padStart(6, '0')}/CueFile.xml\n  name.id = ${cueId}\n  acbFile.path = ${cueName}.acb\n  awbFile.path = ${cueName}.awb`;
  };
  for (const name of ['musicId', 'cueId']) form.querySelector(`[name="${name}"]`)!.addEventListener('input', resourcePreview);
  resourcePreview();
  form.onsubmit = event => {
    event.preventDefault();
    try {
      const data = new FormData(form), value = (key: string): string => String(data.get(key) ?? '').trim();
      const reference = (prefix: string): Reference | null => {
        const id = value(`${prefix}.id`), str = value(`${prefix}.str`), extra = value(`${prefix}.data`);
        if (!id && !str && !extra) return null;
        if (!id || !str) throw new Error('引用条目需要同时填写 ID 与名称；沿用模板时请全部留空。');
        return { id: Number(id), str, data: extra };
      };
      const nextXml = structuredClone(metadata);
      nextXml.music = { ...music, sortName: value('sortName') || null, releaseDate: value('releaseDate') || null, priority: Number(value('priority')),
        disableFlag: data.has('disableFlag'), firstLock: data.has('firstLock'), isGiftMusic: data.has('isGiftMusic'),
        genreNames: inheritGenres.checked ? null : [...genres.querySelectorAll<HTMLElement>('.xml-genre-row')].map(row => {
          const result = reference(row.dataset.prefix!); if (!result) throw new Error('分类不能为空；请填写分类或勾选沿用模板。'); return result;
        }),
      };
      for (const [key] of references) nextXml.music[key] = reference(key);
      validateXmlMetadata(nextXml);
      const musicId = Number(value('musicId')), cueId = Number(value('cueId'));
      if (![musicId, cueId].every(id => Number.isInteger(id) && id >= 1 && id <= 9999)) throw new Error('Music ID 与 CueFile ID 必须是 1–9999 的整数。');
      const title = value('title'); if (!title) throw new Error('请填写曲名。');
      actions.commit({ ...project, metadata: { ...project.metadata, title, artist: value('artist'), designer: value('designer') }, xmlMetadata: nextXml,
        exportSettings: { ...project.exportSettings, musicId, cueId } }, '更新 Music / CueFile XML 信息');
      actions.close();
    } catch (error) { actions.error(error instanceof Error ? error.message : String(error)); }
  };
}
