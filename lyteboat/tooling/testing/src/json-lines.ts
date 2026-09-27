/**
 * Read the JSON Lines files a run writes beside its sessions (an eval run's
 * results, the Studio's audit log, a run-metrics day file) as parsed values.
 * Session logs go through `@lyteboat/testing/session-log`, which also decodes
 * their Zstandard form.
 * @module @lyteboat/testing/json-lines
 */

import { readFileSync } from 'node:fs'

/**
 * Parse every non-blank line of a JSON Lines file.
 * @param file - the file's path.
 * @returns the lines' values in file order, typed as the caller reads them.
 */
export function readJsonLines<T>(file: string): T[] {
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as T)
}
