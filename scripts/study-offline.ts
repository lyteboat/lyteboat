/**
 * Pack the study book (the `/learn` pages, kept outside the repository) into one zip
 * that reads offline. The book directory holds `manifest.json`, a list of
 * `{ num, url, file }` with one entry per page and the table of contents as
 * `num: "目录"`, plus each page's HTML. Every `https://claude.ai/artifact/<id>` link
 * whose id the manifest lists becomes a relative link to that page's file, its
 * `#anchor` kept; links the manifest does not list stay online and are printed. The
 * zip holds `lyteboat-study/<file>` for every page and an `index.html` that opens the
 * table of contents. Source pages are never modified. Fails when the manifest names
 * a file that does not exist.
 *
 *   node --import tsx scripts/study-offline.ts <book dir> [out.zip]
 * The zip defaults to `<book dir>/导出/lyteboat-study-offline.zip`.
 * @module scripts/study-offline
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

interface StudyManifestEntry { num: string, url: string, file: string }
interface ZipEntry { name: string, content: Buffer }

const ZIP_ROOT = 'lyteboat-study'
const TOC_NUM = '目录'
const ARTIFACT_LINK = /https:\/\/claude\.ai\/artifact\/([A-Za-z0-9]+)((?:#[^"'\s<>]*)?)/g

function readStudyManifest(bookDir: string): StudyManifestEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(join(bookDir, 'manifest.json'), 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('manifest.json: expected an array of pages')
  return parsed.map((entry: Record<string, unknown>, index) => {
    const { num, url, file } = entry
    if (typeof num !== 'string' || typeof url !== 'string' || typeof file !== 'string') {
      throw new Error(`manifest.json[${index}]: num, url, and file must be strings`)
    }
    return { num, url, file }
  })
}

/** Writes a zip with deflated entries and UTF-8 names (general-purpose flag bit 11). */
function encodeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const { name, content } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const deflated = deflateRawSync(content)
    const crc = crc32(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(deflated.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, deflated)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + deflated.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function main(): void {
  const [bookDir, outArg] = process.argv.slice(2)
  if (bookDir === undefined) throw new Error('usage: study-offline.ts <book dir> [out.zip]')
  const outPath = outArg ?? join(bookDir, '导出', 'lyteboat-study-offline.zip')
  const pages = readStudyManifest(bookDir)
  const fileOfArtifactId = new Map(pages.map(page => [page.url.slice(page.url.lastIndexOf('/') + 1), page.file]))
  const toc = pages.find(page => page.num === TOC_NUM)
  if (toc === undefined) throw new Error(`manifest.json: no page with num "${TOC_NUM}"`)

  const onlineLinks = new Map<string, Set<string>>()
  const entries: ZipEntry[] = pages.map(page => {
    const html = readFileSync(join(bookDir, page.file), 'utf8').replace(ARTIFACT_LINK, (link, id: string, anchor: string) => {
      const target = fileOfArtifactId.get(id)
      if (target !== undefined) return encodeURIComponent(target) + anchor
      onlineLinks.set(link, (onlineLinks.get(link) ?? new Set()).add(page.file))
      return link
    })
    return { name: `${ZIP_ROOT}/${page.file}`, content: Buffer.from(html, 'utf8') }
  })
  const tocHref = encodeURIComponent(toc.file)
  const index = `<!doctype html><html><head><meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=${tocHref}">\n<title>lyteboat · study</title></head>\n<body><a href="${tocHref}">打开学习目录</a></body></html>\n`
  entries.push({ name: `${ZIP_ROOT}/index.html`, content: Buffer.from(index, 'utf8') })

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(`${outPath}.tmp`, encodeZip(entries))
  renameSync(`${outPath}.tmp`, outPath)
  // A command-line script: its report goes to stdout on purpose.
  console.log(`wrote ${outPath} (${pages.length} pages + index.html)`)
  for (const [link, files] of onlineLinks) console.log(`kept online (not in manifest): ${link} <- ${[...files].join(', ')}`)
}

main()
