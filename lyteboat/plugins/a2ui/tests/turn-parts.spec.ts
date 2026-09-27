/**
 * One finished turn laid out from its answer and the cards its results
 * prepared: marker placement, emission modes, and the punctuation a placed card
 * takes with it.
 */
import { describe, expect, it } from 'vitest'
import type { LyteboatCard, LyteboatCardEmission } from '@lyteboat/contracts'
import { LyteboatTurnComposer, cardMarker, type LyteboatTurnPart } from '../src/turn-parts.ts'

function card(area: string, emission: LyteboatCardEmission, n = 1): LyteboatCard {
  return { callId: `call-${area}`, surfaceId: `${area}-${String(n)}`, area, emission, payload: {} }
}

/** One whole turn through the composer: its answer written at once, then ended. */
function composeTurnParts(text: string, cards: readonly LyteboatCard[], completed: boolean): LyteboatTurnPart[] {
  const composer = new LyteboatTurnComposer()
  composer.prepare(cards)
  composer.write(text, 1)
  composer.end(completed)
  return composer.parts()
}

/** Parts as `text` strings and `<surfaceId>` markers, for compact expectations. */
const shape = (parts: readonly LyteboatTurnPart[]): string[] => parts.map(part => part.kind === 'text' ? part.text : `<${part.card.surfaceId}>`)

describe('composeTurnParts', () => {
  it('places deferred cards at their markers and drops the markers', () => {
    const parts = composeTurnParts('总览如下：\n[[card:overview]]\n配置如下：\n[[card:plan]]\n以上。', [card('overview', 'deferred'), card('plan', 'deferred')], true)

    expect(shape(parts)).toEqual(['总览如下：\n', '<overview-1>', '配置如下：\n', '<plan-1>', '以上。'])
  })

  it('shows immediate cards first, as their results arrived, and drops a marker that names one', () => {
    const parts = composeTurnParts('看这里 [[card:overview]] 就好', [card('overview', 'immediate')], true)

    expect(shape(parts)).toEqual(['<overview-1>', '看这里  就好'])
  })

  it('places every unplaced card of an area at its marker, and a second marker for the area finds none', () => {
    const parts = composeTurnParts('[[card:detail]]\n再看一次 [[card:detail]]', [card('detail', 'deferred', 1), card('detail', 'deferred', 2)], true)

    expect(shape(parts)).toEqual(['<detail-1>', '<detail-2>', '再看一次 '])
  })

  it('drops a marker no prepared card answers', () => {
    expect(shape(composeTurnParts('前 [[card:missing]] 后', [], true))).toEqual(['前  后'])
  })

  it('lets a completed turn append an unplaced deferred card and drop an unplaced deferred_discard one', () => {
    const parts = composeTurnParts('没有写标记。', [card('plan', 'deferred_discard'), card('next', 'deferred')], true)

    expect(shape(parts)).toEqual(['没有写标记。', '<next-1>'])
  })

  it('shows no unplaced card when the turn did not complete', () => {
    const parts = composeTurnParts('写到一半 [[card:overview]]', [card('overview', 'deferred'), card('next', 'deferred')], false)

    expect(shape(parts)).toEqual(['写到一半 ', '<overview-1>'])
  })

  it('takes the whitespace and closing punctuation stranded after a placed card with it', () => {
    const parts = composeTurnParts('您的资产[[card:overview]]。\n接下来', [card('overview', 'deferred')], true)

    expect(shape(parts)).toEqual(['您的资产', '<overview-1>', '接下来'])
  })

  it('leaves text after a dropped marker as written', () => {
    expect(shape(composeTurnParts('A[[card:none]]。B', [], true))).toEqual(['A。B'])
  })
})

/** Compose one step's text written in the given pieces, after the cards, and end the turn. */
function streamed(pieces: readonly string[], cards: readonly LyteboatCard[], completed: boolean): LyteboatTurnPart[] {
  const composer = new LyteboatTurnComposer()
  composer.prepare(cards)
  for (const piece of pieces) composer.write(piece, 1)
  composer.end(completed)
  return composer.parts()
}

describe('LyteboatTurnComposer', () => {
  const answers: readonly (readonly [string, readonly LyteboatCard[]])[] = [
    ['总览如下：\n[[card:overview]]\n配置如下：\n[[card:plan]]\n以上。', [card('overview', 'deferred'), card('plan', 'deferred')]],
    ['您的资产[[card:overview]]。\n接下来', [card('overview', 'deferred')]],
    ['[[[card:overview]]] 与 [[card:none]] 和 [[car [x] [[card:overview', [card('overview', 'deferred')]],
    ['看这里 [[card:overview]] 就好', [card('overview', 'immediate')]],
  ]

  it('shows the same parts whatever pieces the text arrives in', () => {
    for (const [text, cards] of answers) {
      const whole = shape(streamed([text], cards, true))
      expect(shape(streamed([...text], cards, true)), text).toEqual(whole)
      for (let at = 0; at <= text.length; at++) {
        expect(shape(streamed([text.slice(0, at), text.slice(at)], cards, true)), `${text} @${String(at)}`).toEqual(whole)
      }
    }
  })

  it('shows an immediate card where its result arrived, between the texts of two steps', () => {
    const composer = new LyteboatTurnComposer()
    composer.prepare([card('plan', 'deferred')])
    composer.write('我来查一下。', 1)
    composer.prepare([card('overview', 'immediate')])
    composer.write('您的配置如下[[card:plan]]', 2)
    composer.end(true)

    expect(shape(composer.parts())).toEqual(['我来查一下。', '<overview-1>', '您的配置如下', '<plan-1>'])
  })

  it('starts a new paragraph for a later step\'s text, and a step without text adds nothing', () => {
    const composer = new LyteboatTurnComposer()
    composer.write('先看看。', 1)
    composer.write('', 2)
    composer.write('结果如下。', 3)
    composer.end(true)

    expect(shape(composer.parts())).toEqual(['先看看。\n\n结果如下。'])
  })

  it('shows a marker left unfinished at the end of the turn as the text it is', () => {
    expect(shape(streamed(['价格是 [[card:', 'overview'], [card('overview', 'deferred')], false))).toEqual(['价格是 [[card:overview'])
  })
})

describe('cardMarker', () => {
  it('writes the marker at which the answer places the cards of an area', () => {
    const marker = cardMarker('资产_overview-2')

    expect(marker).toBe('[[card:资产_overview-2]]')
    expect(shape(composeTurnParts(`前${marker}后`, [card('资产_overview-2', 'deferred')], true))).toEqual(['前', '<资产_overview-2-1>', '后'])
  })

  it('rejects an area a marker cannot carry, whose cards could never be placed', () => {
    for (const area of ['asset overview', '', 'x'.repeat(65), 'a]]b']) {
      expect(() => cardMarker(area)).toThrow(/cannot be written as a marker/u)
    }
  })
})
