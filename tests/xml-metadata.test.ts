import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMusicXmlSettings, createXmlMetadata, getXmlMetadata, validateXmlMetadata, xmlMetadataFromSource, type XmlNode } from '../src/core/xml-metadata';
import { createProject } from '../src/core/model';
const ref = (id: number, str: string) => ({ id: String(id), str, data: '' });

test('source metadata keeps unknown attributes and nested fields while editable references override their values', () => {
  const source: XmlNode = { '@_xmlns:xsd': 'http://www.w3.org/2001/XMLSchema', sortName: 'ORIGINAL', releaseDate: '20240229', priority: '12', disableFlag: 'true', firstLock: 'true', isGiftMusic: 'true', releaseTagName: { ...ref(19, 'v2 2.40.00'), revisionHint: 'retain' }, netOpenName: ref(2900, 'v2_50 00_0'), worksName: ref(-1, 'Invalid'), labelName: ref(-1, 'Invalid'), stageName: ref(11, 'CHUNITHM VERSE'), genreNames: { list: { StringID: [{ ...ref(6, 'VARIETY'), futureGenreFlag: 'true' }, ref(7, 'イロドリミドリ')] } }, futureMusic: { '@_version': '2', items: [{ value: 'α' }, { value: 'β' }] } };
  const cue: XmlNode = { dataName: 'cueFile000265', name: ref(265, 'music0265'), futureAudio: { decoder: 'native' } };
  const metadata = xmlMetadataFromSource(source, cue);
  assert.equal(metadata.music.releaseDate, '20240229'); assert.equal(metadata.music.priority, 12);
  assert.equal(metadata.music.firstLock, true); assert.deepEqual(metadata.music.genreNames?.map(v => v.id), [6, 7]);
  metadata.music.sortName = 'EDITED'; metadata.music.disableFlag = false; metadata.music.releaseTagName = { id: 20, str: 'v2 2.45.00', data: '' };
  const result = applyMusicXmlSettings({ templateOnly: 'keep' }, metadata, 'AUTO', { id: 1, str: 'CHUNITHM', data: '' });
  assert.equal(result.sortName, 'EDITED'); assert.equal(result.disableFlag, 'false');
  assert.deepEqual(result.releaseTagName, { ...ref(20, 'v2 2.45.00'), revisionHint: 'retain' });
  assert.equal(result.templateOnly, 'keep'); assert.deepEqual(result.futureMusic, source.futureMusic);
  assert.deepEqual(result.genreNames, source.genreNames);
  assert.deepEqual(metadata.sourceMusic, source); assert.deepEqual(metadata.sourceCue, cue);
});

test('unset sort and stage derive from the current project while other null fields retain original metadata', () => {
  const source = { sortName: 'OLD', releaseDate: '20250101', stageName: ref(11, 'CHUNITHM VERSE'), releaseTagName: ref(19, 'VERSION') };
  const metadata = xmlMetadataFromSource(source);
  metadata.music.sortName = null; metadata.music.stageName = null; metadata.music.releaseDate = null; metadata.music.releaseTagName = null;
  const music = applyMusicXmlSettings({ releaseDate: '20240101' }, metadata, 'NEWTITLE', { id: 0, str: "WORLD'S END", data: '' });
  assert.equal(music.sortName, 'NEWTITLE'); assert.deepEqual(music.stageName, ref(0, "WORLD'S END"));
  assert.equal(music.releaseDate, '20250101'); assert.deepEqual(music.releaseTagName, ref(19, 'VERSION'));
});

test('old projects receive independent XML defaults without replacing their canonical metadata', () => {
  const first = createProject(), second = createProject(); delete first.xmlMetadata; first.metadata.title = 'Existing title';
  const settings = getXmlMetadata(first); settings.music.priority = 8;
  assert.equal(first.metadata.title, 'Existing title'); assert.equal(getXmlMetadata(second).music.priority, 0);
  assert.equal(getXmlMetadata(first), settings); validateXmlMetadata(settings);
});

test('invalid dates, references, booleans and XML source nodes are rejected before saving or exporting', () => {
  for (const date of ['20250229', '20241301', '2024-01-01', '00000101', '20240431']) {
    const metadata = createXmlMetadata(); metadata.music.releaseDate = date;
    assert.throws(() => validateXmlMetadata(metadata), /releaseDate/);
  }
  const valid = createXmlMetadata(); valid.music.releaseDate = '20240229'; validateXmlMetadata(valid);
  valid.music.releaseDate = '0'; validateXmlMetadata(valid);
  assert.throws(() => validateXmlMetadata({ ...valid, music: { ...valid.music, disableFlag: 'false' } }), /disableFlag/);
  assert.throws(() => validateXmlMetadata({ ...valid, music: { ...valid.music, priority: 0.25 } }), /priority/);
  assert.throws(() => validateXmlMetadata({ ...valid, music: { ...valid.music, stageName: { id: -2, str: 'x', data: '' } } }), /stageName/);
  assert.throws(() => validateXmlMetadata({ ...valid, music: { ...valid.music, genreNames: [{ id: 6, str: 'a', data: '' }, { id: 6, str: 'b', data: '' }] } }), /重复分类/);
  assert.throws(() => validateXmlMetadata({ ...valid, sourceCue: { '../file': 'bad' } }), /字段名/);
  assert.throws(() => validateXmlMetadata({ ...valid, sourceMusic: JSON.parse('{"__proto__":{"path":"bad"}}') }), /字段名/);
  assert.throws(() => validateXmlMetadata({ ...valid, sourceMusic: { value: '\u0000' } }), /有效文本/);
});
