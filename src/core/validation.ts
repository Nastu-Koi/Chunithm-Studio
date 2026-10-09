import { LANES, NOTE_TYPES, type Chart, type Note, type Project, type ValidationIssue } from './model';
import { analyzeC2SQuantization } from './quantization';
function issue(code: string, message: string, entity?: { id: string; tick: number }, severity: 'error' | 'warning' = 'error'): ValidationIssue {
  return { code, message, severity, ...(entity ? { entityId: entity.id, tick: entity.tick } : {}) };
}
export function validateChart(chart: Chart): ValidationIssue[] {
  const result: ValidationIssue[] = [];
  if (!Number.isFinite(chart.resolution) || chart.resolution <= 0 || !Number.isInteger(chart.resolution)) result.push(issue('resolution', '谱面分辨率必须是正整数。'));
  if (!Number.isFinite(chart.defaultBpm) || chart.defaultBpm <= 0) result.push(issue('bpm-default', '基础 BPM 必须大于 0。'));
  const ids = new Set<string>();
  for (const note of chart.notes) {
    if (ids.has(note.id)) result.push(issue('duplicate-id', '音符 ID 重复。', note)); ids.add(note.id);
    if (!NOTE_TYPES.includes(note.type)) result.push(issue('note-type', '不支持的音符类型。', note));
    if (!Number.isFinite(note.tick) || note.tick < 0) result.push(issue('tick', '音符时间必须是非负有限 tick，可使用分数。', note));
    const laneValid = Number.isInteger(note.lane) && Number.isInteger(note.width) && note.width >= 1 && (chart.allowOutOfLane ? note.lane >= -64 && note.lane <= 64 && note.width <= 128 : note.lane >= 0 && note.lane + note.width <= LANES);
    if (!laneValid) result.push(issue('lane', chart.allowOutOfLane ? '轨道外演出模式：位置须在 -64 到 64，宽度须在 1 到 128，均为整数。' : '音符必须位于 16 轨内，宽度至少为 1；轨道外演出需显式开启高级模式。', note));
    if (['HOLD', 'SLIDE', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH'].includes(note.type)) {
      const zeroAllowed = note.type === 'AIR_HOLD' || (note.type === 'AIR_SLIDE' && note.attributes.visible === false);
      if (!Number.isFinite(note.duration) || note.duration! < 0 || (!zeroAllowed && note.duration === 0)) result.push(issue('duration', '长音符时长需为正数；AIR-HOLD 端点和 AIR SLIDE 控制点允许 0 tick。', note));
    }
    if (note.endLane !== undefined || note.endWidth !== undefined) {
      const lane = note.endLane ?? note.lane; const width = note.endWidth ?? note.width;
      const endpointValid = Number.isInteger(lane) && Number.isInteger(width) && width >= 1 && (chart.allowOutOfLane ? lane >= -64 && lane <= 64 && width <= 128 : lane >= 0 && lane + width <= LANES);
      if (!endpointValid) result.push(issue('end-lane', chart.allowOutOfLane ? '轨道外演出终点：位置须在 -64 到 64，宽度须在 1 到 128。' : '长音符终点超出 16 轨范围。', note));
    }
    if ((note.height !== undefined && !Number.isFinite(note.height)) || (note.endHeight !== undefined && !Number.isFinite(note.endHeight))) result.push(issue('air-height', 'AIR 高度必须是有限数值。', note));
    if (note.type === 'AIR_CRUSH' && (!Number.isFinite(Number(note.attributes.interval ?? 24)) || Number(note.attributes.interval ?? 24) < 0)) result.push(issue('crush-interval', 'AIR-CRUSH 判定间隔必须是非负数，0 表示装饰段。', note));
    if (note.type === 'AIR' && note.attributes.direction && !['IR', 'UL', 'UR', 'DW', 'DL', 'DR'].includes(String(note.attributes.direction))) result.push(issue('air-direction', 'AIR 方向无效。', note));
  }
  for (const event of chart.events) {
    if (ids.has(event.id)) result.push(issue('duplicate-id', '事件 ID 重复。', event)); ids.add(event.id);
    if (!Number.isFinite(event.tick) || event.tick < 0) result.push(issue('event-tick', '事件时间必须是非负有限 tick，可使用分数。', event));
    if (!Number.isFinite(event.value)) result.push(issue('event-value', '事件数值必须是有限数。', event));
    if (event.type === 'BPM' && event.value <= 0) result.push(issue('bpm', 'BPM 必须大于 0；停止请使用滚速事件。', event));
    if (event.type === 'METER' && (!Number.isInteger(event.numerator) || event.numerator! < 0 || !Number.isInteger(event.denominator) || event.denominator! < 0)) result.push(issue('meter', '拍号分子、分母必须是非负整数；0 表示不显示小节线。', event));
    if (event.duration !== undefined && (!Number.isFinite(event.duration) || event.duration < 0)) result.push(issue('event-duration', '事件时长必须是非负有限 tick。', event));
    if (['GROUP_SCROLL', 'SCROLL_ASSIGNMENT'].includes(event.type) && (!Number.isInteger(event.group ?? 0) || (event.group ?? 0) < 0)) result.push(issue('scroll-group', '滚速组 ID 必须是非负整数。', event));
    if (event.type === 'SCROLL_ASSIGNMENT' && (!Number.isInteger(event.lane) || !Number.isInteger(event.width) || event.width! < 1 || (chart.allowOutOfLane ? event.lane! < -64 || event.lane! > 64 || event.width! > 128 : event.lane! < 0 || event.lane! + event.width! > LANES))) result.push(issue('assignment-lane', '滚速分配起点须位于当前轨道模式的有效范围内。', event));
    if (event.type === 'NOTE_SPEED' && event.value === 0) result.push(issue('zero-note-speed', '原游戏音符速度 DCM 不接受 0。停止请使用全谱滚速 SFL=0，或设置非零音符速度。', event));
  }
  if (chart.allowOutOfLane && chart.notes.some(note => note.lane < 0 || note.lane + note.width > LANES || (note.endLane ?? note.lane) < 0 || (note.endLane ?? note.lane) + (note.endWidth ?? note.width) > LANES)) result.push(issue('out-of-lane-visuals', '已启用轨道外演出：保留超出 16 轨的视觉坐标，原游戏具体显示仍需实机确认。', undefined, 'warning'));
  if (chart.events.some(event => event.type === 'METER' && event.denominator === 0 && event.numerator !== 0)) result.push(issue('native-zero-meter', '含原生分母为 0 的曲末拍号：原文保留，预览不绘制后续小节线。', undefined, 'warning'));
  if (chart.events.some(event => event.type === 'STOP')) result.push(issue('legacy-stop-preview', '含旧版 STP 停止事件：原文保留，预览按区间滚动停止计算；精确旧版行为尚待原游戏对照。', undefined, 'warning'));
  const meaningful = chart.unknownRecords.filter(row => row.raw.trim() && !row.tag.startsWith('//') && !row.tag.startsWith('#'));
  if (meaningful.length) result.push(issue('unknown-records', `保留了 ${meaningful.length} 条尚未解释的原生记录（${[...new Set(meaningful.map(row => row.tag))].join('、')}），预览可能不覆盖其行为。`, undefined, 'warning'));
  if (!result.some(item => item.severity === 'error')) {
    const report = analyzeC2SQuantization(chart);
    if (report.required) result.push(issue('native-quantization', `工程保留分数 tick；原生 C2S 导出需量化 ${report.roundedEntityCount} 项，预计最大时间误差 ${report.maxErrorMs.toFixed(3)} ms。`, undefined, 'warning'));
  }
  return result;
}
export function validateProject(project: Project): ValidationIssue[] {
  const result = validateChart(project.chart);
  if (!project.metadata.title.trim()) result.push(issue('title', '请填写乐曲名称。'));
  if (!/^A[A-Z0-9]{3}$/.test(project.exportSettings.optId)) result.push(issue('opt-id', 'OPT ID 需为 A 开头的 4 位大写字母或数字，例如 AZ01。'));
  if (!Number.isInteger(project.exportSettings.musicId) || project.exportSettings.musicId < 1 || project.exportSettings.musicId > 9999) result.push(issue('music-id', 'Music ID 必须是 1 到 9999 的整数。'));
  if (!Number.isInteger(project.exportSettings.cueId) || project.exportSettings.cueId < 1 || project.exportSettings.cueId > 9999) result.push(issue('cue-id', 'cueFile ID 必须是 1 到 9999 的整数。'));
  if (![project.audio.offset, project.audio.previewStart, project.audio.previewEnd].every(Number.isFinite)) result.push(issue('audio-timing', '音频偏移和试听时间必须是有限数值。'));
  if (project.audio.previewStart < 0 || project.audio.previewEnd <= project.audio.previewStart) result.push(issue('preview-range', '试听终点必须晚于起点，且起点不能为负数。'));
  if (project.metadata.difficulty === 'WORLD’S END') {
    if (!project.exportSettings.weTag.trim()) result.push(issue('we-tag', '请填写 WORLD’S END 属性。'));
    if (!Number.isInteger(project.exportSettings.stars) || project.exportSettings.stars < 1 || project.exportSettings.stars > 5) result.push(issue('we-stars', 'WORLD’S END 星级需为 1–5。'));
  }
  return result;
}
export function noteNativeKind(note: Note): string {
  if (note.type === 'HOLD') return note.attributes.ex ? 'HXD' : 'HLD';
  if (note.type === 'SLIDE') return note.attributes.ex ? 'SXD' : 'SLD';
  return ({ TAP: 'TAP', EXTAP: 'CHR', FLICK: 'FLK', AIR: 'AIR', AIR_HOLD: 'AHD', AIR_SLIDE: 'ASD', AIR_CRUSH: 'ALD', DAMAGE: 'MNE' } as Partial<Record<Note['type'], string>>)[note.type] ?? 'TAP';
}
