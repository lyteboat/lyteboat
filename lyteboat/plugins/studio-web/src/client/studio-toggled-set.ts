/**
 * A key flipped in a set the pages keep as state (the rows expanded, the runs
 * checked, the groups collapsed): a new set, so React sees the change.
 * @module @lyteboat/studio-web/client/studio-toggled-set
 */

/**
 * @param set - the current set.
 * @param key - the key to flip.
 * @returns a copy of `set` without `key` when it held it, with it otherwise.
 */
export function toggledStudioSet<T>(set: ReadonlySet<T>, key: T): ReadonlySet<T> {
  const next = new Set(set)
  if (!next.delete(key)) next.add(key)
  return next
}
