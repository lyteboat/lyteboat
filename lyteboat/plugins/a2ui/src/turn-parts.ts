/**
 * What one turn shows, in order (the reference implementation's output
 * composer, applied to a whole turn): the answer text as it was written, each
 * `[[card:<area>]]` marker replaced by that area's deferred cards not yet
 * shown, in the order they were prepared, and a marker with none left dropped;
 * an immediate card where its result arrived; and, when the turn completed, a
 * deferred card the answer never placed after the text, a `deferred_discard`
 * one dropped. A turn that did not complete shows no card it did not place.
 *
 * {@link LyteboatTurnComposer} takes the turn as it happens, text in any
 * pieces, so a stream and a replay of the finished log show the same parts.
 * @module @lyteboat/a2ui/turn-parts
 */

import type { LyteboatCard } from '@lyteboat/contracts'

/** One piece of a turn as a client shows it. */
export type LyteboatTurnPart = { kind: 'text'; text: string } | { kind: 'card'; card: LyteboatCard }

/** `[[card:<area>]]`: an area of ASCII letters, digits, `_`, `-`, or CJK, at most 64 characters. */
const CARD_MARKER = /\[\[card:([A-Za-z0-9_\-\u4e00-\u9fff]{1,64})\]\]/gu

/**
 * The marker an answer writes where the cards of `area` should appear, for a
 * digest that tells the model where to put them.
 * @param area - the cards' area (a card's template name).
 * @returns `[[card:<area>]]`.
 * @throws when {@link CARD_MARKER} cannot read the area back, so its cards could never be placed.
 */
export function cardMarker(area: string): string {
  const marker = `[[card:${area}]]`
  if (marker.match(CARD_MARKER)?.[0] !== marker) throw new Error(`a2ui: card area ${JSON.stringify(area)} cannot be written as a marker: 1 to 64 ASCII letters, digits, _, - or CJK characters`)
  return marker
}

/**
 * Whitespace and closing punctuation a card leaves stranded when the answer put
 * its marker before the end of a sentence; the card is a block, so they would
 * start the next line. No markdown line starters and no straight quotes, which
 * open the next sentence as often as they close one.
 */
const ORPHANED_AFTER_CARD = /^[\s\u00a0\u3000\uff0c\u3002\u3001\uff1b\uff1a\uff01\uff1f\u2026\uff5e\u301c\uff0e\uff61\u22ef,.;:!?~\u300d\u300f\u3011\u300b\u3009\uff09\u201d\u2019)\]\u3015\u3017\uff5d]+/u

/**
 * The longest tail of `text` that could still grow into a marker: `[`, `[[`,
 * `[[c` … `[[card:<area>]`. Text before it can be shown; the tail waits.
 */
const MARKER_PREFIX = /^\[(?:\[(?:c(?:a(?:r(?:d(?::[A-Za-z0-9_\-\u4e00-\u9fff]{0,64}(?:\])?)?)?)?)?)?)?$/u

/** The first marker in a string (a non-global copy of {@link CARD_MARKER}). */
const CARD_MARKER_ONCE = new RegExp(CARD_MARKER.source, 'u')

/** Where the tail that could still become a marker starts; `text.length` when none can. */
function markerTailStart(text: string): number {
  for (let at = text.indexOf('['); at !== -1; at = text.indexOf('[', at + 1)) {
    if (MARKER_PREFIX.test(text.slice(at))) return at
  }
  return text.length
}

/**
 * One turn laid out as it happens. Feed it in log order: the cards each
 * result (or an admission reply) prepared, the answer text of each step in
 * any pieces, then the end of the turn. Each call returns the parts it adds;
 * {@link parts} is everything so far, adjacent text merged.
 */
export class LyteboatTurnComposer {
  private readonly shown: LyteboatTurnPart[] = []
  private readonly deferred: LyteboatCard[] = []
  private readonly placed = new Set<LyteboatCard>()
  /** Text that could still be the start of a marker. */
  private held = ''
  private afterCard = false
  private step: number | undefined
  private wroteText = false

  /**
   * Cards one result prepared, in log order: an immediate card shows here,
   * a deferred one waits for its marker (or the end of a completed turn).
   */
  prepare(cards: readonly LyteboatCard[]): LyteboatTurnPart[] {
    const added = this.release()
    for (const card of cards) {
      if (card.emission === 'immediate') added.push(this.showCard(card))
      else this.deferred.push(card)
    }
    return added
  }

  /**
   * Answer text as it arrives. The first text of a later step starts a new
   * paragraph; a step that writes no text adds nothing.
   * @param text - the next piece of the step's text.
   * @param step - the step it belongs to.
   */
  write(text: string, step: number): LyteboatTurnPart[] {
    if (text === '') return []
    const added: LyteboatTurnPart[] = []
    if (step !== this.step) {
      added.push(...this.release())
      if (this.wroteText) added.push(...this.showText(paragraphBreak(this.textSoFar())))
      this.step = step
    }
    let pending = this.held + text
    this.held = ''
    for (let marker = CARD_MARKER_ONCE.exec(pending); marker !== null; marker = CARD_MARKER_ONCE.exec(pending)) {
      added.push(...this.showText(pending.slice(0, marker.index)))
      added.push(...this.placeMarker(marker[1] ?? ''))
      pending = pending.slice(marker.index + marker[0].length)
    }
    const tail = markerTailStart(pending)
    added.push(...this.showText(pending.slice(0, tail)))
    this.held = pending.slice(tail)
    return added
  }

  /**
   * The turn ended: held text shows as written, and a completed turn shows the
   * deferred cards no marker placed (a `deferred_discard` one is dropped).
   */
  end(completed: boolean): LyteboatTurnPart[] {
    const added = this.release()
    if (completed) {
      for (const card of this.deferred) if (!this.placed.has(card) && card.emission === 'deferred') added.push(this.showCard(card))
    }
    return added
  }

  /** Everything shown so far, adjacent text merged. */
  parts(): LyteboatTurnPart[] {
    const merged: LyteboatTurnPart[] = []
    for (const part of this.shown) {
      const last = merged.at(-1)
      if (part.kind === 'text' && last?.kind === 'text') merged[merged.length - 1] = { kind: 'text', text: last.text + part.text }
      else merged.push(part)
    }
    return merged
  }

  /** Show the held text: nothing more can turn it into a marker. */
  private release(): LyteboatTurnPart[] {
    const held = this.held
    this.held = ''
    return this.showText(held)
  }

  private placeMarker(area: string): LyteboatTurnPart[] {
    return this.deferred.filter(card => card.area === area && !this.placed.has(card)).map(card => this.showCard(card))
  }

  private showCard(card: LyteboatCard): LyteboatTurnPart {
    this.placed.add(card)
    this.afterCard = true
    const part: LyteboatTurnPart = { kind: 'card', card }
    this.shown.push(part)
    return part
  }

  private showText(segment: string): LyteboatTurnPart[] {
    const trimmed = this.afterCard ? segment.replace(ORPHANED_AFTER_CARD, '') : segment
    if (trimmed === '') return []
    this.afterCard = false
    this.wroteText = true
    const part: LyteboatTurnPart = { kind: 'text', text: trimmed }
    this.shown.push(part)
    return [part]
  }

  private textSoFar(): string {
    let text = ''
    for (let i = this.shown.length - 1; i >= 0 && this.shown[i]?.kind === 'text'; i--) {
      const part = this.shown[i]
      if (part?.kind === 'text') text = part.text + text
    }
    return text
  }
}

/** The newlines that start a new paragraph after `text`. */
function paragraphBreak(text: string): string {
  if (text === '' || text.endsWith('\n\n')) return ''
  return text.endsWith('\n') ? '\n' : '\n\n'
}
