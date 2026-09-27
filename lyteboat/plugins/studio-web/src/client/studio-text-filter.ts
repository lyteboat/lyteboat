/**
 * The Studio's text filter, as every searchable list applies it: the query,
 * trimmed and case-folded, found in any of an item's fields; an empty query
 * lets every item through.
 * @module @lyteboat/studio-web/client/studio-text-filter
 */

/**
 * @param query - what the search box holds.
 * @param fields - the item's searchable texts.
 * @returns whether the item passes the filter.
 */
export function studioTextMatches(query: string, fields: readonly string[]): boolean {
  const text = query.trim().toLowerCase()
  return text === '' || fields.some(field => field.toLowerCase().includes(text))
}
