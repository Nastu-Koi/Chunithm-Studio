import { validateProject } from '../../core/validation';
import type { AppContext } from '../app-context';
import { escape } from '../dom';

export function showResources(ctx: AppContext): void {
  const { player, showModal } = ctx;
  const warnings = [...ctx.resources.warnings, ...player.getResourceDiagnostics()];
  showModal('播放资源', `<p class="modal-description">${escape(ctx.resources.description)}</p>${warnings.length ? `<details><summary>兼容性说明（${warnings.length}）</summary>${warnings.map(warning => `<p class="notice">${escape(warning)}</p>`).join('')}</details>` : ''}`);

}
export function showJudgements(ctx: AppContext): void {
  const { player, modal, showModal, syncPlayerChart } = ctx;
  syncPlayerChart();
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
export function showValidation(ctx: AppContext): void {
  const { modal, showModal, switchView } = ctx;
  const issues = validateProject(ctx.project);
  showModal('谱面检查', `<p class="modal-description">${issues.length ? `共 ${issues.length} 项。点击带位置的条目可回到编辑处。` : '没有发现谱面结构错误。原游戏兼容性还需通过导出包的实际加载验证。'}</p><div class="issue-list">${issues.map((i, index) => `<button class="issue ${i.severity}" data-issue="${index}"><b>${i.severity === 'error' ? '错误' : '提示'}</b><span>${escape(i.message)}</span>${i.tick !== undefined ? `<small>${(i.tick / ctx.project.chart.resolution + 1).toFixed(2)} 小节 ↗</small>` : ''}</button>`).join('')}</div>`);
  document.querySelectorAll<HTMLElement>('[data-issue]').forEach(button => button.onclick = () => { const issue = issues[Number(button.dataset.issue)]; if (issue.tick !== undefined) { ctx.seekTick(issue.tick); switchView('edit'); modal.close(); } });
}
