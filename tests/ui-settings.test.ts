import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoolean, readChoice, readNumber, readSetting, writeSetting } from '../src/renderer/ui-settings';

function withStorage(storage: unknown, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => {
      if (storage instanceof Error) throw storage;
      return storage;
    },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

test('interface settings survive a restart and fall back when missing, damaged or out of range', () => {
  const storage = memoryStorage({ 'chuni-sfx-volume': '0.35', 'chuni-metronome': '1' });
  withStorage(storage, () => {
    // Keys written by earlier versions keep their names and values.
    assert.equal(readNumber('sfx-volume', 0.6, 0, 1), 0.35);
    assert.equal(readBoolean('metronome', false), true);
    writeSetting('volume', 0.25);
    writeSetting('sfx', false);
    writeSetting('scroll-speed', 9.25);
    writeSetting('view', 'player');
    assert.deepEqual([...storage.items].slice(2), [
      ['chuni-volume', '0.25'],
      ['chuni-sfx', '0'],
      ['chuni-scroll-speed', '9.25'],
      ['chuni-view', 'player'],
    ]);
  });
  // A new session reads what the last one wrote.
  withStorage(memoryStorage(Object.fromEntries(storage.items)), () => {
    assert.equal(readNumber('volume', 0.8, 0, 1), 0.25);
    assert.equal(readBoolean('sfx', true), false);
    assert.equal(readChoice('scroll-speed', [6, 9.25, 20], 6), 9.25);
    assert.equal(readChoice('view', ['edit', 'player'] as const, 'edit'), 'player');
    assert.equal(readNumber('field-wall', 0, 0, 16), 0, 'never written');
  });
  withStorage(
    memoryStorage({
      'chuni-volume': 'loud',
      'chuni-field-wall': '99',
      'chuni-sfx': 'yes',
      'chuni-view': 'nowhere',
      'chuni-zoom': '',
    }),
    () => {
      assert.equal(readNumber('volume', 0.8, 0, 1), 0.8);
      assert.equal(readNumber('field-wall', 0, 0, 16), 0);
      assert.equal(readNumber('zoom', 0.75, 0.2, 5), 0.75);
      assert.equal(readBoolean('sfx', true), true);
      assert.equal(readChoice('view', ['edit', 'player'] as const, 'edit'), 'edit');
    },
  );
});

test('interface settings do not throw when storage is missing or refuses access', () => {
  for (const storage of [
    undefined,
    new Error('denied'),
    {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('full');
      },
    },
  ])
    withStorage(storage, () => {
      assert.equal(readSetting('volume'), null);
      assert.equal(readNumber('volume', 0.8, 0, 1), 0.8);
      assert.doesNotThrow(() => writeSetting('volume', 0.5));
    });
});
