/** Serializable XML values. Unknown source fields are preserved as data, never interpreted as code. */
export type XmlValue = string | number | boolean | XmlNode | XmlValue[];
export interface XmlNode { [name: string]: XmlValue }
export interface XmlStringId { id: number; str: string; data: string }
export const XML_REFERENCE_FIELDS = ['releaseTagName', 'netOpenName', 'worksName', 'labelName', 'stageName'] as const;
export type XmlReferenceField = typeof XML_REFERENCE_FIELDS[number];
export interface MusicXmlSettings {
  /** Null derives the sort name from the current title. */
  sortName: string | null;
  /** Null inherits the compatible local template; otherwise YYYYMMDD (or native unset value 0). */
  releaseDate: string | null;
  priority: number;
  disableFlag: boolean;
  firstLock: boolean;
  isGiftMusic: boolean;
  releaseTagName: XmlStringId | null;
  netOpenName: XmlStringId | null;
  genreNames: XmlStringId[] | null;
  worksName: XmlStringId | null;
  labelName: XmlStringId | null;
  /** Null derives the default stage from the current difficulty. */
  stageName: XmlStringId | null;
}
export interface XmlMetadata {
  version: 1;
  music: MusicXmlSettings;
  /** Full parsed roots retain fields and attributes unknown to this editor. Resource references are regenerated on export. */
  sourceMusic?: XmlNode;
  sourceCue?: XmlNode;
}
const invalid = (): XmlStringId => ({ id: -1, str: 'Invalid', data: '' });
export function createXmlMetadata(): XmlMetadata {
  return { version: 1, music: { sortName: null, releaseDate: null, priority: 0, disableFlag: false, firstLock: false, isGiftMusic: false,
    releaseTagName: null, netOpenName: null, genreNames: [{ id: 6, str: 'VARIETY', data: '' }], worksName: invalid(), labelName: invalid(), stageName: null } };
}
/** Also migrates version-1 projects created before XML settings existed. */
export function getXmlMetadata(project: { xmlMetadata?: XmlMetadata }): XmlMetadata {
  return project.xmlMetadata ??= createXmlMetadata();
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function text(value: unknown, label: string, limit = 4096): asserts value is string {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) throw new Error(`XML ${label} 必须是有效文本（最多 ${limit} 字符）。`);
}
function integer(value: unknown, label: string, min = -2147483648): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 2147483647) throw new Error(`XML ${label} 必须是 ${min}–2147483647 的整数。`);
}
function stringId(value: unknown, label: string): asserts value is XmlStringId {
  if (!object(value)) throw new Error(`XML ${label} 引用格式无效。`);
  integer(value.id, `${label}.id`, -1); text(value.str, `${label}.str`); text(value.data, `${label}.data`);
}
export function validateXmlNode(value: unknown, label = '源字段'): asserts value is XmlNode {
  if (!object(value)) throw new Error(`XML ${label} 根节点无效。`);
  let count = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++count > 20000 || depth > 24) throw new Error(`XML ${label} 结构过大。`);
    if (typeof node === 'string') { text(node, label, 65536); return; }
    if (typeof node === 'boolean' || (typeof node === 'number' && Number.isFinite(node))) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (!object(node)) throw new Error(`XML ${label} 包含无效节点。`);
    for (const [key, item] of Object.entries(node)) {
      const name = key.startsWith('@_') ? key.slice(2) : key;
      if (['__proto__', 'prototype', 'constructor'].includes(key) || (key !== '#text' && !/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name))) throw new Error(`XML ${label} 包含无效字段名。`);
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}
export function validateXmlMetadata(value: unknown): asserts value is XmlMetadata {
  if (!object(value) || value.version !== 1 || !object(value.music)) throw new Error('XML 元数据设置版本或结构无效。');
  const m = value.music;
  if (m.sortName !== null) text(m.sortName, 'sortName');
  if (m.releaseDate !== null) {
    text(m.releaseDate, 'releaseDate', 8);
    if (m.releaseDate !== '0') {
      if (!/^\d{8}$/.test(m.releaseDate)) throw new Error('XML releaseDate 必须是 YYYYMMDD 日期或 0。');
      const year = Number(m.releaseDate.slice(0, 4)), month = Number(m.releaseDate.slice(4, 6)), day = Number(m.releaseDate.slice(6, 8));
      const date = new Date(0); date.setUTCFullYear(year, month - 1, day);
      if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('XML releaseDate 不是有效日期。');
    }
  }
  integer(m.priority, 'priority');
  for (const key of ['disableFlag', 'firstLock', 'isGiftMusic']) if (typeof m[key] !== 'boolean') throw new Error(`XML ${key} 必须是布尔值。`);
  for (const key of XML_REFERENCE_FIELDS) if (m[key] !== null) stringId(m[key], key);
  if (m.genreNames !== null) {
    if (!Array.isArray(m.genreNames) || m.genreNames.length < 1 || m.genreNames.length > 32) throw new Error('XML genreNames 需要 1–32 个分类引用。');
    for (const genre of m.genreNames) stringId(genre, 'genreNames');
    if (new Set(m.genreNames.map(genre => genre.id)).size !== m.genreNames.length) throw new Error('XML genreNames 包含重复分类 ID。');
  }
  if (value.sourceMusic !== undefined) validateXmlNode(value.sourceMusic, 'MusicData');
  if (value.sourceCue !== undefined) validateXmlNode(value.sourceCue, 'CueFileData');
}
function readReference(value: XmlValue | undefined): XmlStringId | null {
  if (!object(value)) return null;
  const result = { id: Number(value.id), str: String(value.str ?? ''), data: String(value.data ?? '') };
  stringId(result, 'StringID'); return result;
}
/** Read editable values while keeping a complete source snapshot for future-compatible export. */
export function xmlMetadataFromSource(music: XmlNode, cue?: XmlNode): XmlMetadata {
  validateXmlNode(music, 'MusicData'); if (cue) validateXmlNode(cue, 'CueFileData');
  const metadata = createXmlMetadata(), settings = metadata.music;
  metadata.sourceMusic = structuredClone(music); if (cue) metadata.sourceCue = structuredClone(cue);
  if (music.sortName !== undefined) settings.sortName = String(music.sortName);
  if (music.releaseDate !== undefined) settings.releaseDate = String(music.releaseDate);
  if (music.priority !== undefined) settings.priority = Number(music.priority);
  for (const key of ['disableFlag', 'firstLock', 'isGiftMusic'] as const) {
    if (music[key] === undefined) continue;
    if (!['true', 'false'].includes(String(music[key]).toLowerCase())) throw new Error(`XML ${key} 不是有效布尔值。`);
    settings[key] = String(music[key]).toLowerCase() === 'true';
  }
  for (const key of XML_REFERENCE_FIELDS) if (music[key] !== undefined) settings[key] = readReference(music[key]);
  const genre = music.genreNames;
  if (object(genre) && object(genre.list) && genre.list.StringID !== undefined) {
    const values = Array.isArray(genre.list.StringID) ? genre.list.StringID : [genre.list.StringID];
    settings.genreNames = values.map(item => { const ref = readReference(item as XmlValue); if (!ref) throw new Error('XML genreNames 引用无效。'); return ref; });
  }
  validateXmlMetadata(metadata); return metadata;
}
/** Overlay source values without losing newer template fields; arrays keep their source ordering. */
export function mergeXmlNodes(base: XmlNode, overlay: XmlNode): XmlNode {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = object(merged[key]) && object(value) ? mergeXmlNodes(merged[key] as XmlNode, value as XmlNode) : structuredClone(value);
  }
  return merged;
}
export function xmlStringId(value: XmlStringId): XmlNode { return { id: String(value.id), str: value.str, data: value.data }; }

/** Resource identity, chart metadata, and actual filenames are applied separately by the exporter. */
export function applyMusicXmlSettings(template: XmlNode, metadata: XmlMetadata, derivedSortName: string, defaultStage: XmlStringId): XmlNode {
  validateXmlMetadata(metadata);
  const music = mergeXmlNodes(template, metadata.sourceMusic ?? {}), settings = metadata.music;
  music.sortName = settings.sortName ?? derivedSortName;
  if (settings.releaseDate !== null) music.releaseDate = settings.releaseDate;
  music.priority = String(settings.priority);
  for (const key of ['disableFlag', 'firstLock', 'isGiftMusic'] as const) music[key] = String(settings[key]);
  for (const key of XML_REFERENCE_FIELDS) {
    const value = settings[key] ?? (key === 'stageName' ? defaultStage : null);
    if (value) music[key] = mergeXmlNodes(object(music[key]) ? music[key] as XmlNode : {}, xmlStringId(value));
  }
  if (settings.genreNames !== null) {
    const current = object(music.genreNames) ? music.genreNames as XmlNode : {};
    const oldList = object(current.list) ? current.list as XmlNode : {};
    const oldItems = Array.isArray(oldList.StringID) ? oldList.StringID : oldList.StringID === undefined ? [] : [oldList.StringID];
    music.genreNames = mergeXmlNodes(current, { list: { StringID: settings.genreNames.map(reference => {
      const original = oldItems.find(item => object(item) && Number(item.id) === reference.id);
      return mergeXmlNodes(object(original) ? original as XmlNode : {}, xmlStringId(reference));
    }) } });
  }
  return music;
}
