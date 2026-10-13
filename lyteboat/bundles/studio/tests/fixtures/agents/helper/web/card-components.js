// The helper's own card component, which the Studio's test window draws.
export default {
  Badge(props, card) {
    const badge = document.createElement('span')
    badge.textContent = card.text(props.text)
    card.applyCommonProps(badge, props)
    return badge
  },
}
