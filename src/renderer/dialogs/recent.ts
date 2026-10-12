import type { RecentProject } from '../../bridge';
import type { AppContext } from '../app-context';
import { $, escape } from '../dom';

export function showRecentProjects(ctx: AppContext, recent: RecentProject[]): void {
  const { modal, showModal, run, openProject } = ctx;
  showModal('打开项目', `<p class="modal-description">最近打开的项目文件夹。</p><div class="recent-list">${recent.map((item, index) => `<button data-recent="${index}"><strong>${escape(item.title || '未命名')}${item.artist ? ` · ${escape(item.artist)}` : ''}</strong><small>${escape(item.path)} · ${escape(new Date(item.modified).toLocaleString())}</small></button>`).join('')}</div><div class="form-footer"><span>项目是一个包含 project.chuni.json、音乐和封面的文件夹。</span><button id="recent-browse" class="primary">浏览文件夹…</button></div>`);
  const open = (directory?: string) => void run(async () => { modal.close(); await openProject(directory); });
  modal.querySelectorAll<HTMLElement>('[data-recent]').forEach(button => button.onclick = () => open(recent[Number(button.dataset.recent)].path));
  $('#recent-browse').onclick = () => open();
}
