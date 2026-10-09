import { getNoteScrollGroup } from './timing';
import { LANES, makeId, type Chart, type Note } from './model';
function keepGroup(chart: Chart, original: Note, edited: Note): Note {
  const group = getNoteScrollGroup(chart, original);
  return group || original.attributes.speedGroup !== undefined ? { ...edited, attributes: { ...edited.attributes, speedGroup: group } } : edited;
}
export function moveNotes(chart: Chart, ids: readonly string[], deltaTick: number, deltaLane: number): Chart {
  const selected = new Set(ids);
  const notes = chart.notes.filter(note => selected.has(note.id));
  if (!notes.length) return chart;
  const minTick = Math.min(...notes.map(note => note.tick));
  const minLane = Math.min(...notes.flatMap(note => [note.lane, note.endLane ?? note.lane]));
  const maxLane = Math.max(...notes.flatMap(note => [note.lane + note.width, (note.endLane ?? note.lane) + (note.endWidth ?? note.width)]));
  const dt = Math.max(-minTick, deltaTick);
  const maxStartLane = Math.max(...notes.flatMap(note => [note.lane, note.endLane ?? note.lane]));
  const dl = deltaLane === 0 ? 0 : chart.allowOutOfLane ? Math.min(64 - maxStartLane, Math.max(-64 - minLane, Math.round(deltaLane))) : Math.min(LANES - maxLane, Math.max(-minLane, Math.round(deltaLane)));
  return { ...chart, notes: chart.notes.map(note => selected.has(note.id) ? keepGroup(chart, note, { ...note, tick: note.tick + dt, lane: note.lane + dl, ...(note.endLane !== undefined ? { endLane: note.endLane + dl } : {}) }) : note) };
}
export function mirrorNotes(chart: Chart, ids: readonly string[]): Chart {
  const selected = new Set(ids);
  const direction: Record<string, string> = { UL: 'UR', UR: 'UL', DL: 'DR', DR: 'DL', L: 'R', R: 'L' };
  const effects: Record<string, string> = { LS: 'RS', RS: 'LS', LC: 'RC', RC: 'LC' };
  return { ...chart, notes: chart.notes.map(note => {
    if (!selected.has(note.id)) return note;
    const attributes = { ...note.attributes };
    if (attributes.direction && direction[String(attributes.direction)]) attributes.direction = direction[String(attributes.direction)];
    if (attributes.effect && effects[String(attributes.effect)]) attributes.effect = effects[String(attributes.effect)];
    return keepGroup(chart, note, { ...note, lane: LANES - note.lane - note.width, ...(note.endLane !== undefined ? { endLane: LANES - note.endLane - (note.endWidth ?? note.width) } : {}), attributes });
  }) };
}
export function cloneNotes(chart: Chart, ids: readonly string[], deltaTick = 0): Chart {
  const selected = new Set(ids);
  const copies = chart.notes.filter(note => selected.has(note.id)).map(note => keepGroup(chart, note, { ...note, id: makeId('note'), tick: Math.max(0, note.tick + deltaTick), attributes: { ...note.attributes }, native: undefined }));
  return { ...chart, notes: [...chart.notes, ...copies] };
}
export function deleteNotes(chart: Chart, ids: readonly string[]): Chart {
  const selected = new Set(ids); return { ...chart, notes: chart.notes.filter(note => !selected.has(note.id)) };
}
export function noteGeometryAtTick(note: Note, tick: number): { lane: number; width: number; height: number } {
  const fraction = note.duration ? Math.min(1, Math.max(0, (tick - note.tick) / note.duration)) : 0;
  return { lane: note.lane + ((note.endLane ?? note.lane) - note.lane) * fraction, width: note.width + ((note.endWidth ?? note.width) - note.width) * fraction, height: (note.height ?? 0) + ((note.endHeight ?? note.height ?? 0) - (note.height ?? 0)) * fraction };
}
