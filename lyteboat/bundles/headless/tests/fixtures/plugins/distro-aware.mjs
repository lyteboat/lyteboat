// A plugin written the way a third party would use a lyteboat extension: it
// declares `inject: ['lyteboatDistro']`, so it loads only on lyteboat, and answers every
// task through the `lyteboat/intake` extension with the extension ids it found.
export const name = 'example-distro-aware'
export const inject = ['lyteboatDistro']

export function apply(ctx) {
  ctx.on('lyteboat/intake', async () => ({
    kind: 'reply',
    plugin: name,
    content: [{ type: 'text', text: `lyteboat on dsh ${ctx.lyteboatDistro.dsh}: ${ctx.lyteboatDistro.extensions.map(extension => extension.id).join(', ')}` }],
  }))
}
