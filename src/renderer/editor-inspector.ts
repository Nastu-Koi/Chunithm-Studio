import { AIR_NOTE_TYPES, NOTE_TYPES, type Chart, type ChartEvent, type EventType, type Note } from '../core/model';
import { getNativeNoteTag } from '../core/c2s';
import { boundEditorParent, endLane, endTick, endWidth, formatTick, long, nextEditorSegment } from '../core/editing';
import { EVENT_LABEL, LABEL, noteColor } from './editor-template';
import { ICON } from './icons';
import { escape } from './dom';

/** A whole-note count as the shortest exact fraction, e.g. 1/7, for the fraction fields. */
export function fractionLabel(value: number): string {
  for (let denominator = 1; denominator <= 4096; denominator++) {
    const numerator = Math.round(value * denominator);
    if (Math.abs(numerator / denominator - value) < 1e-9)
      return denominator === 1 ? String(numerator) : `${numerator}/${denominator}`;
  }
  return formatTick(value);
}

const input = (label: string, property: string, value: unknown, options = '') =>
  `<label class="editor-field"><span>${label}</span><input data-property="${property}" type="number" value="${escape(value)}" ${options}></label>`;
const textInput = (label: string, property: string, value: unknown, list = '') =>
  `<label class="editor-field"><span>${label}</span><input data-property="${property}" type="text" value="${escape(value)}" ${list ? `list="editor-${list}"` : ''}></label>`;
const checkbox = (label: string, property: string, value: boolean) =>
  `<label class="editor-checkbox"><input type="checkbox" data-property="${property}" ${value ? 'checked' : ''}><span>${label}</span></label>`;

/** What the inspector shows: it is rebuilt only when this changes, so typing in a field is not interrupted. */
export function inspectorKey(chart: Chart, selection: ReadonlySet<string>, node: Note | undefined): string {
  const selected = [...chart.notes, ...chart.events].filter(item => selection.has(item.id));
  return selected.map(item => JSON.stringify(item)).join('|') + chart.events.length + (node ? 'node' : '');
}

/**
 * The inspector markup for the selection. `node` is set when a long note's end node was picked rather than its body;
 * `placeWidth` is the toolbar width, shown for an assignment event without its own.
 */
export function inspectorHtml(
  chart: Chart,
  selection: ReadonlySet<string>,
  node: Note | undefined,
  placeWidth: number,
): string {
  const advanced = Boolean(chart.allowOutOfLane),
    laneOffset = advanced ? 0 : 1;
  const laneOptions = advanced ? 'min="-64" max="64"' : 'min="1" max="16"';
  const widthOptions = `min="1" max="${advanced ? 128 : 16}"`;
  const selected = [...chart.notes, ...chart.events].filter(item => selection.has(item.id));
  let content = `<div class="editor-inspector-title"><span>属性</span><small>${selected.length ? `已选 ${selected.length} 项` : 'INSPECTOR'}</small></div>`;
  if (node) {
    const normal =
      node.type === 'SLIDE'
        ? `${node.attributes.ex ? 'SXD' : 'SLD'} · 普通连接点`
        : node.type === 'AIR_HOLD'
          ? 'AHD · AIR 动作节点'
          : 'ASD · AIR 动作节点';
    const control =
      node.type === 'SLIDE'
        ? `${node.attributes.ex ? 'SXC' : 'SLC'} · 轨迹控制点`
        : node.type === 'AIR_HOLD'
          ? 'AHX · 无动作节点'
          : 'ASC · 轨迹控制点';
    const following = nextEditorSegment(chart, node);
    content += `<div class="editor-selection-heading" style="--note-color:${noteColor(node)}"><i></i><strong>${LABEL[node.type]} 节点</strong><code>${getNativeNoteTag(node)}</code></div><label class="editor-field editor-node-property"><span>节点类型</span><select data-property="nodeKind"><option value="normal" ${node.attributes.visible !== false ? 'selected' : ''}>${normal}</option><option value="control" ${node.attributes.visible === false ? 'selected' : ''}>${control}</option></select></label><p class="editor-help">${node.type === 'SLIDE' ? 'SLD 显示蓝色分隔条；SLC 只改变轨迹，演示中不显示分隔。两者都须持续按住，无须重新拍键。' : '动作节点在此处产生 AIR ACTION；控制 / 无动作节点不新增这次动作，持续段仍保留。'} 实心横条为普通 / 动作节点，空心菱形为控制点。</p>`;
    content +=
      textInput('位置（全音符，可填 1/7）', 'nodePositionFraction', fractionLabel(endTick(node) / chart.resolution)) +
      input('节点 tick', 'nodeTick', endTick(node), 'min="0" step="any"');
    if (node.type !== 'AIR_HOLD')
      content += `<div class="editor-field-pair">${input(advanced ? '坐标（0 基）' : '轨道', 'endLane', endLane(node) + laneOffset, laneOptions)}${input('宽度', 'endWidth', endWidth(node), widthOptions)}</div>`;
    if (node.type === 'AIR_SLIDE')
      content += input('高度', 'endHeight', node.endHeight ?? node.height ?? 1, 'min="0" step="0.1"');
    content += `<p class="editor-help">${following ? '节点前后两段共用这里的位置与宽度，修改时一起跟随。点击带体可选中整段。' : '这是长条的终点。点击带体可选中整段。'}</p><div class="editor-inspector-actions">${following ? '<button class="editor-danger" data-action="delete">删除节点</button>' : `<button data-action="connect">${ICON.connect} 接续节点</button>`}</div>`;
  } else if (selected.length === 1 && 'attributes' in selected[0]) {
    content += noteFields(chart, selected[0], laneOffset, laneOptions, widthOptions);
  } else if (selected.length === 1) {
    content += eventFields(chart, selected[0] as ChartEvent, laneOffset, laneOptions, widthOptions, placeWidth);
  } else if (selected.length > 1) {
    content += `<div class="editor-multi-count">${selected.length}<span>个项目已选中</span></div><p class="editor-help">拖动整组选区。方向键微调轨道与时间；Shift + 方向键按一拍移动。工具栏的“镜像”与“翻转”作用于整组选区。</p><div class="editor-inspector-actions"><button data-action="copy">复制</button><button data-action="mirror">镜像</button><button data-action="flip">翻转</button><button class="editor-danger" data-action="delete">删除</button></div>`;
  } else {
    content += `<div class="editor-empty-selection"><div>${ICON.node}</div><strong>音符属性</strong><p>点击音符编辑属性；点击 SLIDE / AIR 长条的节点编辑该节点。拖动空白区域框选，Shift 保留原有选择。</p></div><div class="editor-shortcuts"><p><kbd>S / W / E</kbd><span>选择 / 笔 / 橡皮</span></p><p><kbd>1 — 0 · T Y U</kbd><span>切换音符</span></p><p><kbd>H / V</kbd><span>镜像 / 翻转</span></p><p><kbd>B N D M</kbd><span>BPM / 滚速 / 音符速度 / 拍号</span></p><p><kbd>K · J · R</kbd><span>插入节点 · 结合 · 曲线</span></p><p><kbd>[ ]</kbd><span>调整放置宽度</span></p><p><kbd>Shift + 滚轮</kbd><span>音符间隔</span></p><p><kbd>Ctrl + 滚轮</kbd><span>时间轴缩放</span></p><p><kbd>中键拖动</kbd><span>平移时间轴</span></p><p><kbd>双击长条</kbd><span>插入节点</span></p></div>`;
  }
  content += `<div class="editor-section-label editor-events-title">时间事件 <small>添加到光标位置</small></div><div class="editor-event-buttons">${(
    Object.keys(EVENT_LABEL) as EventType[]
  )
    .filter(type => type !== 'STOP')
    .map(type => `<button data-action="event" data-event="${type}">${ICON.add} ${EVENT_LABEL[type]}</button>`)
    .join('')}</div>`;
  const events = [...chart.events].sort((a, b) => a.tick - b.tick);
  if (events.length)
    content += `<div class="editor-event-list">${events
      .slice(0, 120)
      .map(
        item =>
          `<button data-select="${escape(item.id)}" class="${selection.has(item.id) ? 'editor-selected-event' : ''}"><span>${EVENT_LABEL[item.type]}</span><strong>${item.type === 'METER' ? `${item.numerator}/${item.denominator}` : item.value}</strong><small title="${item.tick} tick">${Number(item.tick.toFixed(3))}t</small></button>`,
      )
      .join(
        '',
      )}${events.length > 120 ? `<p class="editor-help">显示前 120 个事件；画布中可选择全部事件。</p>` : ''}</div>`;
  content += `<datalist id="editor-parent">${['TAP', 'CHR', 'FLK', 'HLD', 'SLD', 'AIR', 'AHD', 'ASD', 'MNE'].map(value => `<option value="${value}">`).join('')}</datalist><datalist id="editor-color">${['DEF', 'RED', 'ORN', 'YEL', 'GRN', 'CYN', 'BLU', 'PPL', 'PNK', 'VLT', 'GRY', 'BLK', 'NON'].map(value => `<option value="${value}">`).join('')}</datalist><datalist id="editor-effect"><option value="UP"><option value="DOWN"><option value="DEF"></datalist><datalist id="editor-direction"><option value="L"><option value="R"></datalist>`;
  return content;
}

function noteFields(chart: Chart, note: Note, laneOffset: number, laneOptions: string, widthOptions: string): string {
  const advanced = Boolean(chart.allowOutOfLane);
  let content = `<div class="editor-selection-heading" style="--note-color:${noteColor(note)}"><i></i><strong>${LABEL[note.type]}</strong><code>${getNativeNoteTag(note)}</code></div><label class="editor-field"><span>音符类型</span><select data-property="type">${NOTE_TYPES.map(type => `<option value="${type}" ${type === note.type ? 'selected' : ''}>${LABEL[type]}</option>`).join('')}</select></label>`;
  content +=
    textInput('位置（全音符，可填 1/7）', 'positionFraction', fractionLabel(note.tick / chart.resolution)) +
    input('起始 tick', 'tick', note.tick, 'min="0" step="any"') +
    `<div class="editor-field-pair">${input(advanced ? '起点坐标（0 基）' : '起始轨道', 'lane', note.lane + laneOffset, laneOptions)}${input('宽度', 'width', note.width, widthOptions)}</div>`;
  if (long(note))
    content += `<div class="editor-section-label">长条终点</div>${textInput('时长（全音符，可填 1/7）', 'durationFraction', fractionLabel((note.duration ?? 0) / chart.resolution))}${input('长度 tick', 'duration', note.duration, `min="${note.type === 'AIR_HOLD' || (note.type === 'AIR_SLIDE' && note.attributes.visible === false) ? 0 : 0.000001}" step="any"`)}<div class="editor-field-pair">${input(advanced ? '终点坐标（0 基）' : '终点轨道', 'endLane', endLane(note) + laneOffset, laneOptions)}${input('终点宽度', 'endWidth', endWidth(note), widthOptions)}</div><div class="editor-inspector-actions"><button data-action="connect">${ICON.connect} 接续节点</button><button data-action="split">${ICON.insertNode} 插入节点</button></div>`;
  if (note.type === 'AIR_SLIDE' || note.type === 'AIR_CRUSH')
    content += `<div class="editor-field-pair">${input('起始高度', 'height', note.height ?? 1, 'min="0" step="0.1"')}${input('终点高度', 'endHeight', note.endHeight ?? note.height ?? 1, 'min="0" step="0.1"')}</div>`;
  content += `<div class="editor-section-label">原生 / WORLD’S END 属性</div>`;
  if (note.type === 'AIR')
    content += `<label class="editor-field"><span>AIR 方向</span><select data-property="attr.direction">${[
      ['IR', '↑ 上'],
      ['UL', '↖ 左上'],
      ['UR', '↗ 右上'],
      ['DW', '↓ 下'],
      ['DL', '↙ 左下'],
      ['DR', '↘ 右下'],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}" ${value === (note.attributes.direction ?? 'IR') ? 'selected' : ''}>${label}</option>`,
      )
      .join('')}</select></label>`;
  if (note.type === 'FLICK')
    content += textInput('方向', 'attr.direction', note.attributes.direction ?? '', 'direction');
  if (AIR_NOTE_TYPES.has(note.type) || note.type === 'SLIDE')
    content += textInput(
      '关联音符',
      'attr.parent',
      note.attributes.parent ?? (note.type === 'SLIDE' ? 'SLD' : 'TAP'),
      'parent',
    );
  if (
    note.type !== 'AIR_CRUSH' &&
    AIR_NOTE_TYPES.has(note.type) &&
    !['AHD', 'AHX', 'ASD', 'ASC'].includes(String(note.attributes.parent))
  )
    content += `<p class="editor-help">${boundEditorParent(chart, note.id) ? '已绑定在地面音符的尾端：位置与宽度跟随父音符，移动或删除父音符时一并处理。' : '未绑定地面音符：原游戏读谱时找不到父音符会失败。请删除后在地面音符上重新放置。'}</p>`;
  if (AIR_NOTE_TYPES.has(note.type))
    content += textInput('颜色', 'attr.color', note.attributes.color ?? 'DEF', 'color');
  if (note.type === 'EXTAP' || note.type === 'HOLD' || note.type === 'SLIDE' || note.type === 'AIR_CRUSH')
    content += textInput(
      '特效',
      'attr.effect',
      note.attributes.effect ?? (note.type === 'AIR_CRUSH' ? 'DEF' : 'UP'),
      'effect',
    );
  if (note.type === 'HOLD' || note.type === 'SLIDE')
    content += checkbox('EX 音符', 'attr.ex', Boolean(note.attributes.ex));
  if (note.type === 'AIR_CRUSH')
    content +=
      input('CRUSH 间隔 tick', 'attr.interval', note.attributes.interval ?? 24, 'min="0"') +
      `<p class="editor-help">间隔 0 表示无判定装饰段。</p>`;
  content += `<details class="editor-raw"><summary>高级原生属性</summary><textarea data-raw-attributes spellcheck="false" aria-label="原生属性 JSON">${escape(JSON.stringify(note.attributes, null, 2))}</textarea><button data-action="applyRaw">应用属性</button><p>只编辑已知原生值；未识别的源行与额外列随谱面保留。</p></details><div class="editor-inspector-actions"><button data-action="copy">复制</button><button data-action="mirror">镜像</button><button class="editor-danger" data-action="delete">删除</button></div>`;
  return content;
}

function eventFields(
  chart: Chart,
  item: ChartEvent,
  laneOffset: number,
  laneOptions: string,
  widthOptions: string,
  placeWidth: number,
): string {
  const advanced = Boolean(chart.allowOutOfLane);
  let content = `<div class="editor-selection-heading editor-event-heading"><i></i><strong>${EVENT_LABEL[item.type]}</strong><code>EVENT</code></div>${textInput('位置（全音符，可填 1/7）', 'positionFraction', fractionLabel(item.tick / chart.resolution))}${input('起始 tick', 'tick', item.tick, 'min="0" step="any"')}`;
  if (item.type === 'METER')
    content += `<div class="editor-field-pair">${input('分子', 'numerator', item.numerator ?? 4, 'min="0"')}${input('分母', 'denominator', item.denominator ?? 4, 'min="0"')}</div><p class="editor-help">拍号改变小节线；原生 tick 的时间基准保持不变。分子或分母为 0 时隐藏小节线，用于特殊谱演出。</p>`;
  else if (item.type !== 'SCROLL_ASSIGNMENT' && item.type !== 'STOP')
    content += input(
      item.type === 'BPM' ? 'BPM' : '速度倍率',
      'value',
      item.value,
      `step="${item.type === 'BPM' ? '.1' : '.05'}" ${item.type === 'BPM' ? 'min="1"' : ''}`,
    );
  if (item.type === 'GROUP_SCROLL' || item.type === 'SCROLL_ASSIGNMENT')
    content += input(
      '分组编号',
      'group',
      item.group ?? (item.type === 'SCROLL_ASSIGNMENT' ? item.value : 0),
      'min="0" step="1"',
    );
  if (item.type === 'SCROLL_ASSIGNMENT')
    content += `<div class="editor-field-pair">${input(advanced ? '起点坐标（0 基）' : '起始轨道', 'lane', (item.lane ?? 0) + laneOffset, laneOptions)}${input('宽度', 'width', item.width ?? placeWidth, widthOptions)}</div>`;
  if (['SCROLL', 'NOTE_SPEED', 'GROUP_SCROLL', 'SCROLL_ASSIGNMENT'].includes(item.type))
    content +=
      textInput(
        '时长（全音符，可填 1/7）',
        'durationFraction',
        fractionLabel((item.duration ?? chart.resolution) / chart.resolution),
      ) +
      input('持续 tick', 'duration', item.duration ?? chart.resolution, 'min="0" step="any"') +
      `<p class="editor-help">${item.type === 'SCROLL_ASSIGNMENT' ? '精确匹配事件起点的时间、轨道、宽度；持续时间覆盖该长条链。编辑对应音符时，分组关联自动同步。' : item.type === 'GROUP_SCROLL' ? '控制指定分组的滚速。0 组为全局；其他分组配合滚速分组事件使用。' : item.type === 'SCROLL' ? '支持零速、负速与正速。' : '支持正负倍率，不能为零。'}持续区间以原生 tick 为单位。</p>`;
  if (item.type === 'STOP')
    content +=
      input('持续 tick', 'duration', item.duration ?? chart.resolution, 'min="0"') +
      `<p class="editor-help">保留导入谱面的旧版 STP。预览按区间停止显示，实际游戏行为待对照；新建停止可使用倍率 0 的谱面滚速事件。</p>`;
  content += `<div class="editor-inspector-actions"><button data-action="seek" data-tick="${item.tick}">定位光标</button><button class="editor-danger" data-action="delete">删除事件</button></div>`;
  return content;
}
