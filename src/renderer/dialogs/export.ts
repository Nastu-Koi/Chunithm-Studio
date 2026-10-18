import { ICON } from '../icons';
import { analyzeC2SQuantization } from '../../core/quantization';
import type { AppContext } from '../app-context';
import { $, escape } from '../dom';
import { chartImagePng, renderChartImage } from '../chart-image';

/** The cover as an image element for the canvas, or null when there is none or it fails to load. */
function loadCover(url: string): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

export function showExport(ctx: AppContext): void {
  const { bridge, showModal, message, run, commit } = ctx;
  const e = ctx.project.exportSettings;
  showModal(
    '导出完整 OPT 追加包',
    `<form id="export-form"><p class="modal-description">生成谱面、音乐、试听片段、封面与曲目登记文件。输出到你选择的独立目录。</p><label>游戏资源目录<input name="ctx.gamePath" value="${escape(ctx.gamePath)}" required></label><div class="form-row"><label>OPT 包名<input name="optId" value="${escape(e.optId)}" pattern="A[A-Z0-9]{3}" required></label><label>Music ID<input name="musicId" type="number" min="1" max="9999" value="${e.musicId}" required></label><label>Cue ID<input name="cueId" type="number" min="1" max="9999" value="${e.cueId}" required></label></div><p class="modal-description">导出时会检查既有 ID、资源引用及音频结构。完成后按输出目录内的安装说明安装并验证。</p><div id="export-progress" class="export-progress" role="status"></div><div class="form-footer"><button type="button" id="export-image" title="按 sdvx.in 谱面页的版式把谱面画成一张 PNG">导出俯视图片</button><button type="button" id="export-c2s">仅导出 C2S</button><button type="submit" class="primary" id="export-go">选择位置并导出</button></div></form>`,
  );
  const quantization = analyzeC2SQuantization(ctx.project.chart);
  if (quantization.required) {
    const section = document.createElement('section');
    section.className = 'quantization-report';
    section.innerHTML = `<h3>非常规节奏的原生精度对齐</h3><p class="modal-description">工程保留原始节奏。C2S 按每全音符 ${quantization.resolution} 格输出，此次 ${quantization.affectedCount} 个对象受影响，最大时间误差 ${quantization.maxErrorMs.toFixed(4)} 毫秒。</p><details><summary>查看位置与误差</summary><table><thead><tr><th>位置 / 小节</th><th>类型</th><th>时间误差 / 毫秒</th></tr></thead><tbody>${quantization.entries
      .slice(0, 80)
      .map(
        entry =>
          `<tr><td>${(entry.tick / ctx.project.chart.resolution + 1).toFixed(5)}</td><td>${escape(entry.type)}</td><td>${entry.maxErrorMs.toFixed(4)}</td></tr>`,
      )
      .join(
        '',
      )}</tbody></table>${quantization.entries.length > 80 ? '<p>这里只显示前 80 项。</p>' : ''}</details><label class="quantization-consent"><input type="checkbox" id="accept-quantization">按上述误差对齐原生格式，保留工程中的原始节奏</label>`;
    if (quantization.entries.some(entry => entry.judgementCountChanged)) {
      const warning = document.createElement('p');
      warning.className = 'notice';
      warning.textContent = '部分 AIR-CRUSH 内部判定点数量会变化，请检查导出结果。';
      section.querySelector('details')!.before(warning);
    }
    $('#export-progress').before(section);
  }
  const canQuantize = (): boolean =>
    !quantization.required || !!document.querySelector<HTMLInputElement>('#accept-quantization')?.checked;
  $('#export-c2s').onclick = () =>
    void run(async () => {
      if (!canQuantize()) {
        message('请先查看并接受原生格式的时间精度对齐。', true);
        return;
      }
      const filename = await bridge.exportC2s(ctx.project, quantization.required);
      if (filename) message('C2S 已导出，工程节奏保持不变');
    });
  $('#export-image').onclick = () =>
    void run(async () => {
      if (!ctx.gameTextures) throw new Error('俯视图片用原版资源副本绘制，当前没有载入资源副本。');
      const cover = await loadCover(ctx.coverUrl);
      const { canvas, missing } = await renderChartImage(ctx.project, ctx.gameTextures, { cover });
      const png = await chartImagePng(canvas);
      const { title, difficulty } = ctx.project.metadata;
      const filename = await bridge.saveImage(`${title || '谱面'} ${difficulty}.png`, png);
      if (filename)
        message(
          missing.length
            ? `俯视图片已导出：${filename}；资源副本缺少 ${missing.length} 种贴图（${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}），对应音符未画出`
            : `俯视图片已导出：${filename}`,
        );
    });
  $<HTMLFormElement>('#export-form').onsubmit = event => {
    event.preventDefault();
    if (!canQuantize()) {
      message('请先查看并接受原生格式的时间精度对齐。', true);
      return;
    }
    const data = new FormData(event.currentTarget as HTMLFormElement);
    ctx.gamePath = String(data.get('ctx.gamePath')).trim();
    localStorage.setItem('chuni-game-path', ctx.gamePath);
    commit(
      {
        ...ctx.project,
        exportSettings: {
          ...ctx.project.exportSettings,
          optId: String(data.get('optId')),
          musicId: Number(data.get('musicId')),
          cueId: Number(data.get('cueId')),
        },
      },
      '更新导出设置',
    );
    void run(async () => {
      const button = $<HTMLButtonElement>('#export-go');
      button.disabled = true;
      $('#export-progress').textContent = '正在准备导出…';
      try {
        const result = await bridge.exportOpt(ctx.project, ctx.gamePath, quantization.required);
        if (result) {
          showModal(
            'OPT 追加包已生成',
            `<div class="export-success">${ICON.done}</div><p>${escape(result.optPath)}</p><p class="modal-description">已生成 ${result.files.length} 个文件并完成结构回读检查。下一步：按输出目录内的安装说明安装到游戏，检查选曲、音乐同步和特殊谱面效果。</p>${result.warnings.map(w => `<p class="notice">${escape(w)}</p>`).join('')}<div class="form-footer"><span></span><button id="reveal-export" class="primary">打开输出位置</button></div>`,
          );
          $('#reveal-export').onclick = () => void bridge.revealPath(result.optPath);
        } else $('#export-progress').textContent = '已取消导出';
      } finally {
        if (document.contains(button)) button.disabled = false;
      }
    });
  };
}
