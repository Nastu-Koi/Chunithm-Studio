import { createProject, createNote, makeId, type Project } from '../core/model';

/** Small original chart used by the "打开示例谱面" footer button. */
export function createDemoProject(): Project {
  const p = createProject(); p.metadata = { title: '星轨 / First Steps', artist: 'Chuni Studio', designer: 'You', difficulty: 'MASTER', level: '10' };
  for (let i = 0; i < 32; i++) p.chart.notes.push(createNote(i % 7 === 0 ? 'EXTAP' : i % 5 === 0 ? 'FLICK' : 'TAP', 384 + i * 96, (i * 3) % 13, 3));
  p.chart.notes.push({ ...createNote('HOLD', 768, 1, 3), duration: 384 }, { ...createNote('SLIDE', 1536, 0, 3), duration: 384, endLane: 11 }, { ...createNote('SLIDE', 1920, 11, 3), duration: 384, endLane: 3 });
  p.chart.notes.push({ ...createNote('AIR', 2304, 0, 4), attributes: { direction: 'IR', parent: 'TAP' } }, { ...createNote('AIR_HOLD', 2304, 0, 4), duration: 384, attributes: { parent: 'TAP' } });
  p.chart.events.push({ id: makeId('event'), type: 'BPM', tick: 0, value: 120 }); return p;
}
