import { fileURLToPath } from 'node:url'
import { lyteboatLauncher } from '@lyteboat/testkit/process'

/** The built launcher entry: tests exercise the published artifact under plain Node. */
const LYTEBOAT_BIN = fileURLToPath(new URL('../../lib/bin.js', import.meta.url))

export const { startLyteboat, runLyteboat } = lyteboatLauncher(LYTEBOAT_BIN)
