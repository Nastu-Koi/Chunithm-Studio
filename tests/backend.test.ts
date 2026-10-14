import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanLibrary, readLibraryXmlMetadata, librarySignature, resourceRoots } from '../src/backend/library';
import {
  readProject,
  openProject,
  saveProject,
  createProjectFolder,
  projectFolderName,
  projectFile,
  listRecentProjects,
  rememberRecentProject,
  PROJECT_FILE,
} from '../src/backend/projects';
import { decodeDDS } from '../src/backend/dds-preview';
import { createProject, createNote } from '../src/core/model';
import { getXmlMetadata } from '../src/core/xml-metadata';

async function put(filename: string, contents: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}
function musicXml(id: number, title: string, cueId = id): string {
  return `<MusicData><name><id>${id}</id><str>${title}</str></name><artistName><str>Test artist</str></artistName><cueFileName><id>${cueId}</id></cueFileName><jaketFile><path>art\\jacket.dds</path></jaketFile><worldsEndTagName><str>改</str></worldsEndTagName><starDifType>5</starDifType><fumens><MusicFumenData><enable>true</enable><type><id>5</id></type><file><path>${id}_05.c2s</path></file><level>0</level><levelDecimal>0</levelDecimal></MusicFumenData></fumens></MusicData>`;
}

test('OPT metadata overlays inherit charts, covers, and missing cue files independently', async t => {
  const game = await mkdtemp(path.join(tmpdir(), 'chuni-library-'));
  t.after(() => rm(game, { recursive: true, force: true }));
  const base = path.join(game, 'data', 'A000');
  const overlay = path.join(game, 'bin', 'option', 'AZ01');
  const song = 'music7000';
  const lowerSong = path.join(base, 'music', song);
  const upperSong = path.join(overlay, 'music', song);
  await put(path.join(lowerSong, 'Music.xml'), musicXml(7000, 'Base title'));
  await put(path.join(lowerSong, '7000_05.c2s'), 'TAP\t0\t0\t0\t4\n');
  await put(path.join(lowerSong, 'art', 'jacket.dds'), 'synthetic cover');
  await put(path.join(upperSong, 'Music.xml'), musicXml(7000, 'Overlay title'));
  await put(path.join(base, 'cueFile', 'cueFile7000', 'music7000.acb'), 'lower acb');
  await put(path.join(base, 'cueFile', 'cueFile7000', 'music7000.awb'), 'lower awb');
  await put(path.join(overlay, 'cueFile', 'cueFile7000', 'music7000.AWB'), 'upper awb');
  await mkdir(path.join(overlay, 'cueFile', 'cueFile7000', 'fake.acb'), { recursive: true });
  const [entry] = await scanLibrary(game);
  assert.equal(entry.title, 'Overlay title');
  assert.equal(entry.pack, 'AZ01');
  assert.equal(entry.chartPath, path.join(lowerSong, '7000_05.c2s'));
  assert.equal(entry.coverPath, path.join(lowerSong, 'art', 'jacket.dds'));
  assert.equal(entry.acbPath, path.join(base, 'cueFile', 'cueFile7000', 'music7000.acb'));
  assert.equal(entry.awbPath, path.join(overlay, 'cueFile', 'cueFile7000', 'music7000.AWB'));
  assert.equal(entry.difficulty, 'WORLD’S END');
  assert.equal(entry.stars, 3);

  // A later pack can override assets without duplicating Music.xml.
  const assetsOnly = path.join(game, 'bin', 'option', 'AZ02', 'music', song);
  await put(path.join(assetsOnly, '7000_05.c2s'), 'TAP\t1\t0\t0\t4\n');
  await put(path.join(assetsOnly, 'art', 'jacket.dds'), 'new synthetic cover');
  const [overridden] = await scanLibrary(game);
  assert.equal(overridden.title, 'Overlay title');
  assert.equal(overridden.chartPath, path.join(assetsOnly, '7000_05.c2s'));
  assert.equal(overridden.coverPath, path.join(assetsOnly, 'art', 'jacket.dds'));
});

test('empty cue directories and directories with audio suffixes never become audio file paths', async t => {
  const game = await mkdtemp(path.join(tmpdir(), 'chuni-library-empty-'));
  t.after(() => rm(game, { recursive: true, force: true }));
  const pack = path.join(game, 'data', 'A000');
  await put(path.join(pack, 'music', 'music7001', 'Music.xml'), musicXml(7001, 'No assets'));
  await put(path.join(pack, 'music', 'music7001', '7001_05.c2s'), 'TAP\t0\t0\t0\t4\n');
  await mkdir(path.join(pack, 'cueFile', 'cueFile7001', 'fake.acb'), { recursive: true });
  await mkdir(path.join(pack, 'cueFile', 'cueFile7001', 'fake.awb'), { recursive: true });
  const [entry] = await scanLibrary(game);
  assert.equal(entry.acbPath, '');
  assert.equal(entry.awbPath, '');
  assert.equal(entry.coverPath, '');
});

test('XML import uses winning metadata files, exact cue filenames, and keeps native difficulty decimals', async t => {
  const game = await mkdtemp(path.join(tmpdir(), 'chuni-library-xml-'));
  t.after(() => rm(game, { recursive: true, force: true }));
  const base = path.join(game, 'data/A000'),
    overlay = path.join(game, 'bin/option/AZ01');
  const lowerSong = path.join(base, 'music/music7000'),
    upperSong = path.join(overlay, 'music/music7000');
  const song = musicXml(7000, 'XML title', 265)
    .replace(
      '<level>0</level><levelDecimal>0</levelDecimal>',
      '<level>15</level><levelDecimal>20</levelDecimal><notesDesigner>XML designer</notesDesigner>',
    )
    .replace(
      '</MusicData>',
      '<sortName>CUSTOMSORT</sortName><releaseDate>20240229</releaseDate><priority>3</priority><futureMusic><flag>retained</flag></futureMusic></MusicData>',
    );
  await put(path.join(upperSong, 'Music.xml'), song);
  await put(path.join(lowerSong, '7000_05.c2s'), 'TAP\t0\t0\t0\t4\n');
  const cueFolder = path.join(base, 'cueFile/cueFile000265');
  await put(
    path.join(cueFolder, 'CueFile.xml'),
    '<CueFileData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><name><id>265</id><str>music0265</str></name><acbFile><path>registered.acb</path></acbFile><awbFile><path>registered.awb</path></awbFile><futureCue>retained</futureCue></CueFileData>',
  );
  for (const name of ['aaa-wrong.acb', 'aaa-wrong.awb', 'registered.acb', 'registered.awb'])
    await put(path.join(cueFolder, name), 'synthetic');
  const [entry] = await scanLibrary(game);
  assert.equal(entry.level, '15.2');
  assert.equal(entry.notesDesigner, 'XML designer');
  assert.equal(entry.musicXmlPath, path.join(upperSong, 'Music.xml'));
  assert.equal(entry.cueXmlPath, path.join(cueFolder, 'CueFile.xml'));
  assert.equal(entry.acbPath, path.join(cueFolder, 'registered.acb'));
  assert.equal(entry.awbPath, path.join(cueFolder, 'registered.awb'));
  const metadata = await readLibraryXmlMetadata(entry);
  assert.equal(metadata.music.sortName, 'CUSTOMSORT');
  assert.equal(metadata.music.releaseDate, '20240229');
  assert.equal(metadata.music.priority, 3);
  assert.deepEqual(metadata.sourceMusic?.futureMusic, { flag: 'retained' });
  assert.equal(metadata.sourceCue?.futureCue, 'retained');
  assert.equal(metadata.sourceCue?.['@_xmlns:xsi'], 'http://www.w3.org/2001/XMLSchema-instance');
  for (const [decimal, expected] of [
    [5, '15.05'],
    [50, '15+'],
    [75, '15.75'],
  ] as const) {
    await put(
      path.join(upperSong, 'Music.xml'),
      song.replace('<levelDecimal>20</levelDecimal>', `<levelDecimal>${decimal}</levelDecimal>`),
    );
    assert.equal((await scanLibrary(game))[0].level, expected);
  }
});

test('project saves bundle relative assets, preserve fractional chart data, and reload after moving with a previous-save backup', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'chuni-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audio = path.join(root, 'inputs', 'original.wav');
  const cover = path.join(root, 'inputs', 'original.png');
  const audioBytes = Buffer.from([0, 1, 2, 255]);
  const coverBytes = Buffer.from([3, 4, 5, 254]);
  await put(audio, audioBytes);
  await put(cover, coverBytes);
  const project = createProject();
  project.audio.path = audio;
  project.coverPath = cover;
  project.metadata.title = 'First save';
  project.chart.allowOutOfLane = true;
  getXmlMetadata(project).music.releaseDate = '20260228';
  getXmlMetadata(project).music.priority = 7;
  getXmlMetadata(project).sourceMusic = { futureField: { '@_version': '2', enabled: 'true' } };
  getXmlMetadata(project).sourceCue = { futureCue: 'retained' };
  project.chart.notes = [createNote('TAP', 384 / 7)];
  const original = structuredClone(project);
  const directory = path.join(root, 'bundle'),
    filename = projectFile(directory);
  const { project: saved, removed: none } = await saveProject(directory, project);
  assert.deepEqual(project, original);
  assert.deepEqual(none, []);
  assert.equal(saved.audio.path, path.join(directory, 'audio.wav'));
  const disk = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(disk.audio.path, 'audio.wav');
  assert.equal(disk.coverPath, 'cover.png');
  assert.deepEqual(await readFile(saved.audio.path), audioBytes);
  assert.deepEqual(await readFile(saved.coverPath), coverBytes);
  saved.metadata.title = 'Second save';
  await saveProject(directory, saved);
  const backup = JSON.parse(await readFile(`${filename}.bak`, 'utf8'));
  assert.equal(backup.metadata.title, 'First save');
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.tmp')));
  const moved = path.join(root, 'moved bundle');
  await rename(directory, moved);
  const { project: loaded, warnings } = await openProject(moved);
  assert.deepEqual(warnings, []);
  assert.equal(loaded.metadata.title, 'Second save');
  assert.equal(loaded.chart.notes[0].tick, 384 / 7);
  assert.equal(loaded.chart.allowOutOfLane, true);
  assert.deepEqual(loaded.xmlMetadata, project.xmlMetadata);
  assert.equal(loaded.audio.path, path.join(moved, 'audio.wav'));
  assert.deepEqual(await readFile(loaded.audio.path), audioBytes);
  assert.deepEqual(await readFile(loaded.coverPath), coverBytes);
});

test('replacing music is copied in on save, the old asset is removed, and a missing asset still opens', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'chuni-project-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'in', 'a.OGG'),
    second = path.join(root, 'in', 'b.mp3'),
    cover = path.join(root, 'in', 'c.png');
  await put(first, Buffer.from([1]));
  await put(second, Buffer.from([2]));
  await put(cover, Buffer.from([3]));
  const project = createProject();
  project.metadata.title = 'A: B?';
  project.audio.path = first;
  project.coverPath = cover;
  assert.equal(projectFolderName(project.metadata.title), 'A_ B_');
  assert.equal(projectFolderName(' ..'), '未命名项目');
  const created = await createProjectFolder(root, project),
    directory = created.directory;
  assert.equal(directory, path.join(root, 'A_ B_'));
  assert.equal(created.project.audio.path, path.join(directory, 'audio.ogg'));
  await assert.rejects(createProjectFolder(root, project), /已存在/);
  assert.deepEqual(await readFile(path.join(directory, 'audio.ogg')), Buffer.from([1]));
  // Importing new music only changes the path; the folder is untouched until the save.
  const edited = structuredClone(created.project);
  edited.audio.path = second;
  assert.deepEqual((await readdir(directory)).sort(), ['audio.ogg', 'cover.png', PROJECT_FILE]);
  const { project: saved, removed } = await saveProject(directory, edited);
  assert.deepEqual(removed, [path.join(directory, 'audio.ogg')]);
  assert.deepEqual((await readdir(directory)).sort(), ['audio.mp3', 'cover.png', PROJECT_FILE, `${PROJECT_FILE}.bak`]);
  assert.deepEqual(await readFile(saved.audio.path), Buffer.from([2]));
  // Save As writes a complete new folder without the backup and leaves the original alone.
  const copyParent = path.join(root, 'elsewhere');
  await mkdir(copyParent);
  const copy = await createProjectFolder(copyParent, saved);
  assert.deepEqual((await readdir(copy.directory)).sort(), ['audio.mp3', 'cover.png', PROJECT_FILE]);
  assert.deepEqual((await readdir(directory)).sort(), ['audio.mp3', 'cover.png', PROJECT_FILE, `${PROJECT_FILE}.bak`]);
  await rm(path.join(directory, 'audio.mp3'));
  const reopened = await openProject(directory);
  assert.equal(reopened.project.audio.path, '');
  assert.equal(reopened.project.coverPath, path.join(directory, 'cover.png'));
  assert.match(reopened.warnings.join(), /音乐文件 audio\.mp3 已丢失/);
  await assert.rejects(openProject(path.join(root, 'in')), /不是 Chuni Studio 项目文件夹/);
  // A failed first save leaves no half-made folder behind.
  const broken = structuredClone(saved);
  broken.metadata.title = 'Broken';
  broken.audio.path = path.join(root, 'gone.wav');
  await assert.rejects(createProjectFolder(root, broken));
  await assert.rejects(readdir(path.join(root, 'Broken')), { code: 'ENOENT' });
});

test('recent projects are newest first, deduplicated and drop folders that no longer exist', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'chuni-recent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const list = path.join(root, 'data', 'recent.json'),
    make = async (title: string) => {
      const p = createProject();
      p.metadata.title = title;
      return await createProjectFolder(root, p);
    };
  assert.deepEqual(await listRecentProjects(list), []);
  const a = await make('A'),
    b = await make('B');
  await rememberRecentProject(list, a.directory, a.project);
  await rememberRecentProject(list, b.directory, b.project);
  await rememberRecentProject(list, a.directory, a.project);
  const recent = await listRecentProjects(list);
  assert.deepEqual(
    recent.map(item => [item.path, item.title]),
    [
      [a.directory, 'A'],
      [b.directory, 'B'],
    ],
  );
  assert.ok(recent[0].modified > 0);
  await rm(a.directory, { recursive: true });
  assert.deepEqual(
    (await listRecentProjects(list)).map(item => item.title),
    ['B'],
  );
  for (let index = 0; index < 12; index++) {
    const p = await make(`N${index}`);
    await rememberRecentProject(list, p.directory, p.project);
  }
  assert.equal((await listRecentProjects(list)).length, 10);
});

test('reading an old project migrates XML defaults and invalid XML edits cannot be saved', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'chuni-project-xml-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = createProject();
  delete project.xmlMetadata;
  await writeFile(projectFile(root), JSON.stringify(project));
  const loaded = await readProject(root);
  assert.equal(loaded.xmlMetadata?.version, 1);
  getXmlMetadata(loaded).music.releaseDate = '20250230';
  const invalid = path.join(root, 'invalid');
  await assert.rejects(saveProject(invalid, loaded), /releaseDate/);
  await assert.rejects(readdir(invalid), { code: 'ENOENT' });
});

function dxt1(width = 4, height = 4): Buffer {
  const buffer = Buffer.alloc(136);
  buffer.write('DDS ', 0, 'ascii');
  buffer.writeUInt32LE(124, 4);
  buffer.writeUInt32LE(height, 12);
  buffer.writeUInt32LE(width, 16);
  buffer.writeUInt32LE(32, 76);
  buffer.write('DXT1', 84, 'ascii');
  buffer.writeUInt16LE(0xf800, 128);
  buffer.writeUInt16LE(0x07e0, 130);
  buffer.writeUInt32LE(0xe4e4e4e4, 132);
  return buffer;
}
test('DDS preview decodes DXT1 color interpolation and clips partial four-pixel blocks', () => {
  const image = decodeDDS(dxt1(3, 2));
  assert.equal(image.width, 3);
  assert.equal(image.height, 2);
  assert.deepEqual(
    [...image.data],
    [255, 0, 0, 255, 0, 255, 0, 255, 170, 85, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 170, 85, 0, 255],
  );
  const transparent = dxt1();
  transparent.writeUInt16LE(0, 128);
  transparent.writeUInt16LE(0xffff, 130);
  transparent.writeUInt32LE(0xffffffff, 132);
  assert.ok(decodeDDS(transparent).data.every(channel => channel === 0));
});

test('DDS preview rejects truncated headers and truncated DXT1 payloads with clear errors', () => {
  assert.throws(() => decodeDDS(dxt1().subarray(0, 20)), /DDS 文件头无效/);
  assert.throws(() => decodeDDS(dxt1().subarray(0, 135)), /DDS 像素数据不完整/);
});

test('library scans are cached by folder fingerprint and refreshed when a song folder appears or a rescan is forced', async t => {
  const game = await mkdtemp(path.join(tmpdir(), 'chuni-library-cache-'));
  t.after(() => rm(game, { recursive: true, force: true }));
  const base = path.join(game, 'data', 'A000');
  await put(path.join(base, 'music', 'music7000', 'Music.xml'), musicXml(7000, 'Cached title'));
  await put(path.join(base, 'music', 'music7000', '7000_05.c2s'), 'TAP\t0\t0\t0\t4\n');
  const cacheFile = path.join(game, 'cache', 'library.json'),
    messages: string[] = [];
  const first = await scanLibrary(game, { cacheFile, onProgress: m => messages.push(m) });
  assert.equal(first.length, 1);
  assert.ok(messages.some(m => m.includes('正在读取曲目信息')));
  const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(cached.signature, await librarySignature(await resourceRoots(game)));
  messages.length = 0;
  const second = await scanLibrary(game, { cacheFile, onProgress: m => messages.push(m) });
  assert.deepEqual(second, first);
  assert.ok(
    messages.some(m => m.includes('使用上次扫描')),
    messages.join(' | '),
  );
  messages.length = 0;
  const forced = await scanLibrary(game, { cacheFile, force: true, onProgress: m => messages.push(m) });
  assert.deepEqual(forced, first);
  assert.ok(!messages.some(m => m.includes('使用上次扫描')));
  // A new song folder changes the fingerprint, so the next default scan sees it without --force.
  await put(path.join(base, 'music', 'music7001', 'Music.xml'), musicXml(7001, 'Second title'));
  await put(path.join(base, 'music', 'music7001', '7001_05.c2s'), 'TAP\t0\t0\t0\t4\n');
  const third = await scanLibrary(game, { cacheFile });
  assert.deepEqual(
    third.map(e => e.title),
    ['Cached title', 'Second title'],
  );
  // Without a cache file nothing is written or read.
  assert.equal((await scanLibrary(game)).length, 2);
});
