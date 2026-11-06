/**
 * Binary search helpers over arrays sorted ascending by `key(x)`.
 * Used to slice the time-ordered record log by [from, to) in O(log n).
 */

/** First index i where key(arr[i]) >= target. */
export function lowerBound(arr, target, key = (x) => x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(arr[mid]) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i where key(arr[i]) > target. */
export function upperBound(arr, target, key = (x) => x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(arr[mid]) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Mean and population standard deviation in one pass (Welford). */
export function meanStd(values) {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (const x of values) {
    n++;
    const d = x - mean;
    mean += d / n;
    m2 += d * (x - mean);
  }
  return { n, mean, std: n ? Math.sqrt(m2 / n) : 0 };
}
