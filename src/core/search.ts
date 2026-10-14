/** Binary search over items sorted by `key`. Returns the first index whose key is greater than `value`. */
export function upperBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (key(items[middle]) <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Binary search over items sorted by `key`. Returns the first index whose key is at least `value`. */
export function lowerBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (key(items[middle]) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
