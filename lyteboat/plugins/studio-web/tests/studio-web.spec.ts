/**
 * The pages' host face on the unit host, over a real listener and a fixture
 * build: a page path answers the app's index, a built asset is served and
 * cached for good, a missing asset or a path out of the build is 404 (never the
 * page), other methods are refused, `/` redirects to the Studio, every answer
 * carries the CSP, and a Studio without a build refuses to start.
 */
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import StudioWebPages from '@lyteboat/studio-web'
import { MockAdapter, createLyteboatUnitHost } from '@lyteboat/testing'

const WEB = fileURLToPath(new URL('./fixtures/web', import.meta.url))

async function pagesHost(webDir = WEB): Promise<(method: string, path: string) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>> {
  const ctx = await createLyteboatUnitHost(new MockAdapter([]))
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(StudioWebPages, { webDir })
  return (method, path) => new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: ctx.webServer.port, method, path }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    request.on('error', reject)
    request.end()
  })
}

describe('the Studio pages', () => {
  it('answer every page path with the app, uncached, under a CSP that admits only their own files', async () => {
    const get = await pagesHost()

    const pages = await Promise.all(['/studio', '/studio/', '/studio/users', '/studio/agents/finance/skills'].map(path => get('GET', path)))

    for (const page of pages) {
      expect(page).toMatchObject({ status: 200, body: expect.stringContaining('fixture page') })
      expect(page.headers).toMatchObject({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': expect.stringContaining('script-src \'self\'; style-src \'self\''),
      })
    }
  })

  it('serve a built asset for good, and answer 404 for a missing one or a path out of the build', async () => {
    const get = await pagesHost()

    const asset = await get('GET', '/studio/assets/app-0f1e2d.js')
    const missing = await get('GET', '/studio/assets/app-000000.js')
    const escaped = await get('GET', '/studio/assets/..%2F..%2Foutside.txt')
    const dotted = await get('GET', '/studio/..%2Foutside.txt')

    expect(asset).toMatchObject({ status: 200, body: 'export const fixture = 1\n', headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' } })
    expect(missing.status).toBe(404)
    expect(escaped.status).toBe(404)
    expect(dotted.body).not.toContain('secret-outside-the-pages')
  })

  it('refuse a method other than GET or HEAD, and send / to the Studio', async () => {
    const get = await pagesHost()

    const posted = await get('POST', '/studio/')
    const root = await get('GET', '/')

    expect(posted).toMatchObject({ status: 405, headers: { allow: 'GET, HEAD' } })
    expect(root).toMatchObject({ status: 302, headers: { location: '/studio/' } })
  })

  it('refuse to start without a build', async () => {
    await expect(pagesHost(fileURLToPath(new URL('./fixtures', import.meta.url)))).rejects.toThrow('studio-web: the pages are not built')
  })
})
