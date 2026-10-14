/**
 * Display and monitoring preferences of this machine: volumes, track speed, toolbar options. They are kept in
 * localStorage and never in the project. A missing, damaged or out-of-range value reads as its default, and the
 * controls go on working when storage is unavailable.
 */
const PREFIX = 'chuni-';
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
export function readSetting(key: string): string | null {
  try {
    return storage()?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
}
export function writeSetting(key: string, value: string | number | boolean): void {
  try {
    storage()?.setItem(PREFIX + key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  } catch {
    /* The setting lasts for this session only. */
  }
}
export function readNumber(key: string, fallback: number, min = -Infinity, max = Infinity): number {
  const text = readSetting(key),
    value = text === null || text.trim() === '' ? NaN : Number(text);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
export function readBoolean(key: string, fallback: boolean): boolean {
  const text = readSetting(key);
  return text === '1' ? true : text === '0' ? false : fallback;
}
export function readChoice<T extends string | number>(key: string, choices: readonly T[], fallback: T): T {
  const text = readSetting(key);
  return choices.find(choice => String(choice) === text) ?? fallback;
}
