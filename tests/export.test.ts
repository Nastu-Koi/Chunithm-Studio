import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { exportOpt, encodeDdsBc1 } from '../src/backend/export';
import { createProject, createNote } from '../src/core/model';
import { parseC2S } from '../src/core/c2s';
import { sineWav } from './audio-fixture';
import { getXmlMetadata } from '../src/core/xml-metadata';
const game = process.env.CHUNITHM_GAME_PATH ?? '/mnt/d/chunithm';
let available = true;
try {
  await access(path.join(game, 'data/A000'));
} catch {
  available = false;
}

test('DDS encoder emits the same 300×300 DXT1 layout used by the game', () => {
  const dds = encodeDdsBc1(new Uint8Array(300 * 300 * 4).fill(255), 300, 300);
  assert.equal(dds.toString('ascii', 0, 4), 'DDS ');
  assert.equal(dds.toString('ascii', 84, 88), 'DXT1');
  assert.equal(dds.length, 45128);
  assert.equal(dds.readUInt32LE(12), 300);
  assert.equal(dds.readUInt32LE(16), 300);
});
test('rejects invalid charts before reading game templates or creating an output directory', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'chuni-invalid-export-'));
  try {
    const project = createProject();
    project.chart.notes = [createNote('TAP', 96, 15, 4)];
    const outputDirectory = path.join(temp, 'out');
    await assert.rejects(
      exportOpt(project, { gamePath: path.join(temp, 'missing-game'), outputDirectory }),
      /谱面包含 1 项错误.*\n.*16 轨/,
    );
    await assert.rejects(access(outputDirectory), { code: 'ENOENT' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('rejects invalid XML settings before accessing local templates or creating output', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'chuni-invalid-xml-export-'));
  try {
    const project = createProject();
    getXmlMetadata(project).music.priority = 1.25;
    const outputDirectory = path.join(temp, 'out');
    await assert.rejects(
      exportOpt(project, { gamePath: path.join(temp, 'missing-game'), outputDirectory }),
      /XML priority/,
    );
    await assert.rejects(access(outputDirectory), { code: 'ENOENT' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test(
  'exports an independent new-song OPT from synthetic media using local metadata templates',
  { skip: !available, timeout: 120000 },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'chuni-export-'));
    try {
      const project = createProject();
      project.metadata.title = '测试曲 <&> 日本語';
      project.metadata.artist = 'Synth';
      project.metadata.designer = 'Test';
      project.audio.path = path.join(temp, 'test.wav');
      project.audio.previewStart = 0.25;
      project.audio.previewEnd = 1.25;
      project.exportSettings.optId = 'AZ01';
      project.exportSettings.musicId = 7000;
      project.exportSettings.cueId = 7001;
      project.metadata.level = '15.2';
      project.chart.defaultBpm = 150;
      const xmlMetadata = getXmlMetadata(project);
      Object.assign(xmlMetadata.music, {
        sortName: 'CUSTOM & SORT',
        releaseDate: '20261009',
        priority: 7,
        disableFlag: true,
        firstLock: true,
        isGiftMusic: true,
        releaseTagName: { id: 19, str: 'v2 2.40.00', data: '' },
        netOpenName: { id: 2900, str: 'v2_50 00_0', data: '' },
        worksName: { id: 25, str: 'Custom work', data: '' },
        labelName: { id: 26, str: 'Custom label', data: '' },
        stageName: { id: 11, str: 'CHUNITHM VERSE', data: '' },
        genreNames: [
          { id: 6, str: 'VARIETY', data: '' },
          { id: 7, str: 'イロドリミドリ', data: '' },
        ],
      });
      xmlMetadata.sourceMusic = {
        dataName: 'music0265',
        name: { id: '265', str: 'Old title' },
        cueFileName: { id: '265', str: 'music0265' },
        jaketFile: { path: '../old.dds' },
        futureMusic: { '@_revision': '2', preserved: 'yes' },
        fumens: {
          MusicFumenData: Array.from({ length: 6 }, (_, i) => ({
            type: { id: String(i) },
            file: { path: '../old.c2s' },
            futureDifficultyField: `preserved-${i}`,
          })),
        },
      };
      xmlMetadata.sourceCue = {
        dataName: 'cueFile000265',
        name: { id: '265', str: 'music0265' },
        acbFile: { path: '../old.acb' },
        awbFile: { path: '../old.awb' },
        futureCue: { retained: 'yes' },
      };
      project.chart.notes = [createNote('TAP', 96, 0, 4), createNote('HOLD', 192, 4, 4)];
      await writeFile(project.audio.path, sineWav(2));
      const cover = { width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(255) };
      const result = await exportOpt(project, { gamePath: game, outputDirectory: path.join(temp, 'out'), cover });
      assert.equal(result.structuralVerified, true);
      assert.equal(result.files.length, 7);
      for (const file of result.files) await access(path.join(result.optPath, file));
      const instructions = await readFile(path.join(temp, 'out', 'AZ01-安装说明.txt'), 'utf8');
      assert.match(instructions, /结构校验通过不等于已经通过原游戏验证/);
      assert.match(instructions, /bin[\\/]option/);
      assert.match(instructions, /不要覆盖或合并任何已有同名包/);
      assert.match(instructions, /只移除本次复制进去的 AZ01 文件夹/);
      assert.ok(result.files.every(file => !file.endsWith('.txt')));
      const parser = new XMLParser({ ignoreAttributes: false });
      const music = parser.parse(
        await readFile(path.join(result.optPath, 'music/music7000/Music.xml'), 'utf8'),
      ).MusicData;
      assert.equal(music.name.str, project.metadata.title);
      assert.equal(music.name.id, 7000);
      assert.equal(music.cueFileName.id, 7001);
      assert.equal(music.exType, 0);
      assert.equal(music.dataName, 'music7000');
      assert.equal(music.jaketFile.path, 'CHU_UI_Jacket_7000.dds');
      assert.equal(music.sortName, 'CUSTOM & SORT');
      assert.equal(music.releaseDate, 20261009);
      assert.equal(music.priority, 7);
      assert.equal(music.disableFlag, true);
      assert.equal(music.firstLock, true);
      assert.equal(music.isGiftMusic, true);
      assert.equal(music.releaseTagName.id, 19);
      assert.equal(music.netOpenName.id, 2900);
      assert.equal(music.worksName.id, 25);
      assert.equal(music.labelName.id, 26);
      assert.equal(music.stageName.id, 11);
      assert.deepEqual(
        music.genreNames.list.StringID.map((v: { id: number }) => v.id),
        [6, 7],
      );
      assert.deepEqual(music.futureMusic, { preserved: 'yes', '@_revision': '2' });
      const master = music.fumens.MusicFumenData[3];
      assert.equal(master.file.path, '7000_03.c2s');
      assert.equal(master.level, 15);
      assert.equal(master.levelDecimal, 20);
      assert.equal(master.notesDesigner, 'Test');
      assert.equal(master.defaultBpm, 150);
      assert.equal(master.futureDifficultyField, 'preserved-3');
      assert.ok(
        music.fumens.MusicFumenData.every(
          (f: { enable: boolean; file: { path: string } }, i: number) => i === 3 || (!f.enable && f.file.path === ''),
        ),
      );
      const cue = parser.parse(
        await readFile(path.join(result.optPath, 'cueFile/cueFile007001/CueFile.xml'), 'utf8'),
      ).CueFileData;
      assert.equal(cue.dataName, 'cueFile007001');
      assert.equal(cue.name.id, 7001);
      assert.equal(cue.name.str, 'music7001');
      assert.equal(cue.acbFile.path, 'music7001.acb');
      assert.equal(cue.awbFile.path, 'music7001.awb');
      assert.deepEqual(cue.futureCue, { retained: 'yes' });
      assert.equal(cue['@_xmlns:xsi'], 'http://www.w3.org/2001/XMLSchema-instance');
      assert.equal(cue['@_xmlns:xsd'], 'http://www.w3.org/2001/XMLSchema');
      assert.equal(
        parseC2S(await readFile(path.join(result.optPath, 'music/music7000/7000_03.c2s'), 'utf8')).notes.length,
        2,
      );
      await assert.rejects(
        exportOpt(project, { gamePath: game, outputDirectory: path.join(temp, 'out'), cover }),
        /已经存在/,
      );
      await assert.rejects(
        exportOpt(project, { gamePath: game, outputDirectory: path.join(game, 'bin/option'), cover }),
        /不会直接修改/,
      );
      project.metadata.difficulty = 'WORLD’S END';
      project.exportSettings.weTag = '止';
      project.exportSettings.stars = 3;
      const we = await exportOpt(project, { gamePath: game, outputDirectory: path.join(temp, 'we'), cover });
      const weMusic = parser.parse(
        await readFile(path.join(we.optPath, 'music/music7000/Music.xml'), 'utf8'),
      ).MusicData;
      assert.equal(weMusic.exType, 2);
      assert.equal(weMusic.worldsEndTagName.id, 3);
      assert.equal(weMusic.worldsEndTagName.str, '止');
      assert.equal(weMusic.starDifType, 5);
      const weEventFile = we.files.find(p => p.endsWith('/Event.xml'));
      assert.ok(weEventFile);
      const event = parser.parse(await readFile(path.join(we.optPath, weEventFile), 'utf8')).EventData;
      assert.equal(event.substances.music.musicType, 1);
      assert.equal(event.substances.music.musicNames.list.StringID.id, 7000);
      assert.equal(event.alwaysOpen, true);
      assert.equal(event.netOpenName.id, 2900);
      assert.equal(weMusic.fumens.MusicFumenData[5].notesDesigner, 'Test');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
