/**
 * One A2UI card in the test window, drawn the way the reference
 * implementation's renderer (`static/a2ui-renderer.js`) draws the default
 * catalog's sixteen components: Row, Column, Card, List, CollapseList,
 * Table, Popup, Text, RichText, Image, Icon, Tag, Circle, Divider, Line, and
 * Button. Any other type is an agent's own component, which the Studio does
 * not have: it draws as a grey box named for it. The card's sizes and colours
 * are the agent's and stay as written; the reference's defaults (a button's
 * orange, a tag's amber) are ported with it. Differences: RichText shows its
 * text without markup (the Studio does not insert a model's HTML); an image
 * from another site does not load under the Studio's CSP, so only `data:` and
 * same-site images draw; of the actions, `query` sends its message and
 * `openPopup` / `closePopup` show and hide a popup of the card, and the rest
 * do nothing here. A card wider than the window is scaled down as a whole.
 * @module @lyteboat/studio-web/client/studio-a2ui-card
 */

import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { JsonValue } from '@lyteboat/contracts'
import {
  isStudioA2uiObject,
  studioA2uiChildIds,
  studioA2uiHidden,
  studioA2uiLength,
  studioA2uiListItems,
  studioA2uiRadius,
  studioA2uiRowScope,
  studioA2uiSurface,
  studioA2uiText,
  studioA2uiTextSize,
  studioA2uiValue,
  type StudioA2uiObject,
  type StudioA2uiSurface,
} from './studio-a2ui-binding.ts'

/** What every component of one card reads. */
interface StudioA2uiCardScope {
  surface: StudioA2uiSurface
  openPopups: ReadonlySet<string>
  setPopup(id: string, open: boolean): void
  onQuery(message: string): void
}

const StudioA2uiCardContext = createContext<StudioA2uiCardScope | null>(null)

function useCardScope(): StudioA2uiCardScope {
  const scope = useContext(StudioA2uiCardContext)
  if (scope === null) throw new Error('studio-a2ui-card: a component drawn outside its card')
  return scope
}

const BUTTON_STYLES: Readonly<Record<string, CSSProperties>> = {
  primary: { background: '#f0762b', color: '#fff', border: 'none' },
  secondary: { background: 'transparent', color: '#f0762b', border: '1.5px solid #f0762b' },
  soft: { background: '#fff0e6', color: '#f0762b', border: 'none' },
  normal: { background: 'transparent', color: '#666', border: '1.5px solid #ccc' },
  info: { background: 'transparent', color: '#f0762b', border: 'none', textDecoration: 'underline' },
}

const TEXT_HINTS: Readonly<Record<string, CSSProperties>> = {
  error: { color: '#FF0000' },
  warning: { color: '#FF6600' },
  tips: { color: '#A4A4A4' },
  info: { color: '#333333' },
  title: { color: '#222222', fontWeight: 600, fontSize: '16px' },
  link: { color: '#0066CC', textDecoration: 'underline' },
}

const TAG_SIZES: Readonly<Record<string, CSSProperties>> = {
  small: { padding: '1px 6px', fontSize: '11px' },
  middle: { padding: '2px 8px', fontSize: '12px' },
  large: { padding: '4px 12px', fontSize: '14px' },
}

const COLUMN_ALIGN: Readonly<Record<string, string>> = { left: 'flex-start', center: 'center', right: 'flex-end', start: 'flex-start', end: 'flex-end' }
const ROW_ALIGN: Readonly<Record<string, string>> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }
const DISTRIBUTION: Readonly<Record<string, string>> = { start: 'flex-start', center: 'center', end: 'flex-end', spaceBetween: 'space-between', spaceAround: 'space-around' }
const IMAGE_SIZES: Readonly<Record<string, string>> = { small: '32px', middle: '48px', large: '64px', xlarge: '72px', xxlarge: '88px', auto: 'auto' }
const ICON_SIZES: Readonly<Record<string, string>> = { xsmall: '10px', small: '12px', middle: '16px', large: '20px', xlarge: '24px', xxlarge: '32px' }
const CIRCLE_SIZES: Readonly<Record<string, string>> = { small: '6px', middle: '10px', big: '14px' }

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function spacing(value: JsonValue | undefined): string | undefined {
  if (Array.isArray(value) && value.length === 4) return value.map(side => studioA2uiLength(side) ?? '0').join(' ')
  return studioA2uiLength(value)
}

function borderOf(value: JsonValue | undefined): CSSProperties {
  const side = (border: JsonValue | undefined): string | undefined => {
    if (!isStudioA2uiObject(border)) return undefined
    const width = typeof border['width'] === 'number' ? border['width'] : 1
    const style = border['type'] === 'dash' ? 'dashed' : text(border['type']) ?? 'solid'
    return `${String(width)}px ${style} ${text(border['color']) ?? '#E5E5E5'}`
  }
  if (Array.isArray(value) && value.length === 4) {
    return { borderTop: side(value[0]), borderRight: side(value[1]), borderBottom: side(value[2]), borderLeft: side(value[3]) }
  }
  return isStudioA2uiObject(value) ? { border: side(value) } : {}
}

function shadowOf(value: JsonValue | undefined): string | undefined {
  const shadows = Array.isArray(value) ? value : value === undefined ? [] : [value]
  const parts = shadows.filter(isStudioA2uiObject).map(shadow => [shadow['hOffset'], shadow['vOffset'], shadow['blurRadius'], shadow['spreadRadius']]
    .map(length => `${String(typeof length === 'number' ? length : 0)}px`).join(' ') + ` ${text(shadow['color']) ?? 'rgba(0,0,0,0.1)'}`)
  return parts.length === 0 ? undefined : parts.join(', ')
}

/** The props every component takes: size, spacing, background, radius, flex, border, shadow, and `hide`. */
function commonStyle(props: StudioA2uiObject, scope: StudioA2uiObject | null, data: StudioA2uiObject): CSSProperties {
  const style: CSSProperties = {
    width: studioA2uiLength(props['width'], '%'),
    height: studioA2uiLength(props['height'], '%'),
    minWidth: studioA2uiLength(props['minWidth']),
    minHeight: studioA2uiLength(props['minHeight']),
    padding: spacing(props['padding']),
    margin: spacing(props['margin']),
    marginTop: studioA2uiLength(props['marginTop']),
    marginBottom: studioA2uiLength(props['marginBottom']),
    marginLeft: studioA2uiLength(props['marginLeft']),
    marginRight: studioA2uiLength(props['marginRight']),
    backgroundColor: text(props['backgroundColor']),
    borderRadius: studioA2uiRadius(props['borderRadius']),
    flex: props['flex'] === undefined || props['flex'] === null ? undefined : String(props['flex']),
    flexWrap: text(props['flexWrap']) as CSSProperties['flexWrap'],
    boxShadow: shadowOf(props['boxShadow']),
    ...borderOf(props['border']),
  }
  if (studioA2uiHidden(props['hide'], scope, data)) style.display = 'none'
  // Only the props the component sets, so they override a component's defaults and nothing else.
  return Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined))
}

function gapOf(props: StudioA2uiObject): string | undefined {
  return studioA2uiLength(props['gap'])
}

function runActions(action: JsonValue | undefined, card: StudioA2uiCardScope): void {
  for (const one of Array.isArray(action) ? action : [action]) {
    if (!isStudioA2uiObject(one)) continue
    const args = studioA2uiValue(one['args'], null, card.surface.data)
    switch (one['name']) {
      case 'query': {
        const message = typeof args === 'string' ? args : isStudioA2uiObject(args) ? text(args['queryMsg']) ?? '' : ''
        // `__detail__:` and `__channel_step__:` are one client's own commands, not messages.
        if (message !== '' && !message.startsWith('__')) card.onQuery(message)
        break
      }
      case 'openPopup':
      case 'closePopup':
        if (isStudioA2uiObject(args) && typeof args['popupComponentId'] === 'string') card.setPopup(args['popupComponentId'], one['name'] === 'openPopup')
        break
      default:
        break
    }
  }
}

function clickOf(props: StudioA2uiObject, card: StudioA2uiCardScope): (() => void) | undefined {
  const action = props['action']
  return action === undefined ? undefined : () => runActions(action, card)
}

function Children({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  return <>{studioA2uiChildIds(props).map(id => <StudioA2uiNode id={id} key={id} scope={scope} />)}</>
}

function FlexBox({ props, scope, direction }: { props: StudioA2uiObject; scope: StudioA2uiObject | null; direction: 'row' | 'column' }) {
  const card = useCardScope()
  const alignment = text(props['alignment'])
  const distribution = text(props['distribution'])
  const align = direction === 'row'
    ? alignment === undefined ? 'center' : ROW_ALIGN[alignment] ?? alignment
    : text(props['alignItems']) ?? (alignment === undefined ? undefined : COLUMN_ALIGN[alignment] ?? alignment)
  const onClick = clickOf(props, card)
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: direction,
    alignItems: align,
    justifyContent: distribution === undefined ? undefined : DISTRIBUTION[distribution] ?? distribution,
    gap: gapOf(props),
    cursor: onClick === undefined ? undefined : 'pointer',
    ...commonStyle(props, scope, card.surface.data),
  }
  return <div onClick={onClick} style={style}><Children props={props} scope={scope} /></div>
}

function CardBox({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const card = useCardScope()
  const onClick = clickOf(props, card)
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 1px 6px rgba(0,0,0,.08)',
    backgroundColor: '#FFFFFF',
    borderRadius: '8px',
    gap: gapOf(props),
    cursor: onClick === undefined ? undefined : 'pointer',
    ...commonStyle(props, scope, card.surface.data),
  }
  return <div onClick={onClick} style={style}><Children props={props} scope={scope} /></div>
}

function TextLeaf({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const { surface } = useCardScope()
  const hint = text(props['usageHint'])
  const lines = typeof props['numberOfLines'] === 'number' ? props['numberOfLines'] : undefined
  const style: CSSProperties = {
    ...hint === undefined ? {} : TEXT_HINTS[hint],
    fontSize: text(props['fontSize']) ?? studioA2uiTextSize(props['size']) ?? (hint === undefined ? undefined : TEXT_HINTS[hint]?.fontSize),
    color: text(props['color']) ?? (hint === undefined ? undefined : TEXT_HINTS[hint]?.color),
    fontWeight: props['bold'] === true ? 600 : typeof props['fontWeight'] === 'number' || typeof props['fontWeight'] === 'string' ? props['fontWeight'] : hint === undefined ? undefined : TEXT_HINTS[hint]?.fontWeight,
    fontStyle: props['italic'] === true ? 'italic' : undefined,
    textDecoration: props['underline'] === true ? 'underline' : undefined,
    lineHeight: text(props['lineHeight']) ?? '1.6',
    fontFamily: text(props['fontFamily']),
    textAlign: text(props['textAlign']) as CSSProperties['textAlign'],
    ...lines === undefined ? {} : { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
    ...commonStyle(props, scope, surface.data),
  }
  return <div style={style}>{studioA2uiText(props['text'], scope, surface.data)}</div>
}

function RichTextLeaf({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const { surface } = useCardScope()
  const plain = studioA2uiText(props['text'], scope, surface.data).replace(/<[^>]*>/gu, '')
  return <div style={{ fontSize: text(props['fontSize']), color: text(props['color']), whiteSpace: 'pre-wrap' }}>{plain}</div>
}

function GlyphOf({ name }: { name: string }) {
  switch (name) {
    case 'icon-info':
    case 'info':
      return <svg fill="none" height="100%" stroke="rgba(0,0,0,0.4)" viewBox="0 0 12 12" width="100%"><circle cx="6" cy="6" r="5" /><line x1="6" x2="6" y1="5.5" y2="8.5" /><circle cx="6" cy="3.6" fill="rgba(0,0,0,0.4)" r="0.6" stroke="none" /></svg>
    case 'arrow-link-icon':
    case 'arrow-right':
    case 'icon-arrow-right':
      return <svg fill="none" height="100%" stroke="rgba(0,0,0,0.35)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="100%"><polyline points="9 6 15 12 9 18" /></svg>
    case 'chevron-down':
      return <svg fill="none" height="100%" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="100%"><polyline points="6 9 12 15 18 9" /></svg>
    case 'chevron-up':
      return <svg fill="none" height="100%" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="100%"><polyline points="18 15 12 9 6 15" /></svg>
    default:
      return <>{name === '' ? '●' : name}</>
  }
}

function ButtonLeaf({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const card = useCardScope()
  const kind = text(props['type']) ?? 'primary'
  const [spent, setSpent] = useState(false)
  const disabled = props['disabled'] === true || spent
  const onClick = (): void => {
    if (props['once'] === true) setSpent(true)
    runActions(props['action'], card)
  }
  const overrides: CSSProperties = {
    color: text(props['color']),
    background: text(props['backgroundColor']),
    fontSize: text(props['fontSize']),
    fontWeight: typeof props['fontWeight'] === 'number' || typeof props['fontWeight'] === 'string' ? props['fontWeight'] : undefined,
    fontFamily: text(props['fontFamily']),
    border: text(props['border']) === 'none' ? undefined : text(props['border']),
    borderRadius: studioA2uiRadius(props['borderRadius']),
  }
  const defined = (style: CSSProperties): CSSProperties => Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined))
  if (kind === 'custom') {
    const style: CSSProperties = { background: 'transparent', border: 'none', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', ...defined(overrides), ...commonStyle(props, scope, card.surface.data) }
    const child = text(props['child'])
    const icon = props['icon']
    return (
      <button disabled={disabled} onClick={onClick} style={style} type="button">
        {child !== undefined
          ? <StudioA2uiNode id={child} scope={scope} />
          : icon !== undefined
            ? <span style={{ display: 'inline-flex', width: '100%', height: '100%', lineHeight: 1 }}><GlyphOf name={studioA2uiText(icon, scope, card.surface.data)} /></span>
            : studioA2uiText(props['text'], scope, card.surface.data)}
      </button>
    )
  }
  const size = text(props['size'])
  const style: CSSProperties = {
    padding: size === 'small' ? '6px 14px' : size === 'auto' ? '6px 12px' : size === 'large' ? '12px 24px' : '10px 20px',
    borderRadius: '20px',
    fontSize: size === 'small' ? '12px' : '14px',
    fontWeight: 500,
    display: props['block'] === true ? 'block' : 'inline-block',
    width: props['block'] === true ? '100%' : undefined,
    opacity: disabled ? 0.5 : undefined,
    cursor: disabled ? 'not-allowed' : 'pointer',
    ...BUTTON_STYLES[kind] ?? BUTTON_STYLES['primary'],
    ...defined(overrides),
    ...commonStyle(props, scope, card.surface.data),
  }
  return <button disabled={disabled} onClick={onClick} style={style} type="button">{studioA2uiText(props['text'], scope, card.surface.data)}</button>
}

function DividerLeaf({ props }: { props: StudioA2uiObject }) {
  const color = text(props['borderColor']) ?? '#E5E5E5'
  const weight = props['hairline'] === true ? '0.5px' : '1px'
  const line = `${weight} ${props['dashed'] === true ? 'dashed' : 'solid'} ${color}`
  if (props['vertical'] === true) {
    return <div style={{ display: 'inline-block', alignSelf: 'stretch', borderLeft: line, margin: typeof props['margin'] === 'number' ? `0 ${String(props['margin'])}px` : text(props['margin']) }} />
  }
  const margin = typeof props['margin'] === 'number' ? `${String(props['margin'])}px 0` : text(props['margin']) ?? '4px 0'
  const inset = text(props['inset'])
  const description = text(props['description'])
  if (description !== undefined) {
    const half: CSSProperties = { flex: 1, borderTop: line }
    return (
      <div style={{ display: 'flex', alignItems: 'center', margin, marginLeft: inset, marginRight: inset }}>
        <div style={half} />
        <span style={{ fontSize: '12px', color: text(props['color']) ?? '#999', padding: `0 ${studioA2uiLength(props['padding']) ?? '8px'}` }}>{description}</span>
        <div style={half} />
      </div>
    )
  }
  return <hr style={{ border: 'none', borderTop: line, margin, marginLeft: inset, marginRight: inset }} />
}

function TagLeaf({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const { surface } = useCardScope()
  const size = text(props['size']) ?? 'middle'
  const background = text(props['backgroundColor'])
  const style: CSSProperties = {
    display: 'inline-block',
    borderRadius: '10px',
    ...TAG_SIZES[size] ?? TAG_SIZES['middle'],
    ...size === 'custom' ? { fontSize: studioA2uiLength(props['fontSize']), borderRadius: studioA2uiRadius(props['borderRadius']) ?? '10px' } : {},
    backgroundColor: background ?? '#FFF3E0',
    color: text(props['color']) ?? (background === undefined ? '#FF6600' : undefined),
    border: text(props['borderColor']) === undefined ? undefined : `1px solid ${text(props['borderColor']) ?? ''}`,
  }
  return <span style={style}>{studioA2uiText(props['text'], scope, surface.data)}</span>
}

function ImageLeaf({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const { surface } = useCardScope()
  const url = studioA2uiText(props['url'], scope, surface.data)
  const size = text(props['size'])
  if (url !== '' && !/^(https?:|data:|\/)/u.test(url)) {
    const side = size === undefined ? '24px' : IMAGE_SIZES[size] ?? size
    return <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: side, height: side, ...commonStyle(props, scope, surface.data) }}><GlyphOf name={url} /></span>
  }
  // The Studio's CSP admits its own images and data: URIs; another site's would only fail to load.
  if (!/^(data:|\/)/u.test(url)) return null
  const avatar = props['type'] === 'avatar'
  const side = avatar ? (size === undefined ? '48px' : IMAGE_SIZES[size] ?? size) : size === undefined ? undefined : IMAGE_SIZES[size] ?? size
  const style: CSSProperties = {
    display: 'block',
    width: studioA2uiLength(props['imageWidth']) ?? side,
    height: studioA2uiLength(props['imageHeight']) ?? side,
    borderRadius: avatar ? '50%' : studioA2uiRadius(props['borderRadius']),
    objectFit: (text(props['fit']) ?? (avatar ? 'cover' : undefined)) as CSSProperties['objectFit'],
    ...commonStyle(props, scope, surface.data),
  }
  return <img alt="" src={url} style={style} />
}

function IconLeaf({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const { surface } = useCardScope()
  const size = text(props['size'])
  const side = size === undefined ? '16px' : ICON_SIZES[size] ?? size
  const style: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
    width: studioA2uiLength(props['iconWidth']) ?? side,
    height: studioA2uiLength(props['iconHeight']) ?? side,
    color: text(props['color']),
  }
  return <span style={style}><GlyphOf name={studioA2uiText(props['name'], scope, surface.data)} /></span>
}

function CircleLeaf({ props }: { props: StudioA2uiObject }) {
  const size = props['size']
  const side = typeof size === 'number' ? `${String(size)}px` : CIRCLE_SIZES[text(size) ?? ''] ?? '10px'
  return <div style={{ borderRadius: '50%', width: side, height: side, flexShrink: 0, backgroundColor: text(props['backgroundColor']) }} />
}

function LineLeaf({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const { surface } = useCardScope()
  return <div style={{ height: '2px', minHeight: '2px', ...commonStyle(props, scope, surface.data) }} />
}

function ListBox({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const { surface } = useCardScope()
  const items = studioA2uiListItems(props['dataSource'], surface.data)
  const alignment = text(props['alignment'])
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: props['direction'] === 'horizontal' ? 'row' : 'column',
    gap: gapOf(props),
    alignItems: alignment === undefined ? undefined : COLUMN_ALIGN[alignment] ?? alignment,
    ...commonStyle(props, scope, surface.data),
  }
  const child = text(props['child'])
  const empty = text(props['emptyChild'])
  return (
    <div style={style}>
      {items.length === 0 && empty !== undefined
        ? <StudioA2uiNode id={empty} scope={{ item: null }} />
        : child === undefined ? null : items.map((item, index) => <StudioA2uiNode id={child} key={index} scope={studioA2uiRowScope(item)} />)}
    </div>
  )
}

function CollapseListBox({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const { surface } = useCardScope()
  const prefanned = studioA2uiChildIds(props)
  const items = prefanned.length > 0 ? [] : studioA2uiListItems(props['dataSource'], surface.data)
  const rowCount = prefanned.length > 0 ? prefanned.length : items.length
  const limit = typeof props['limit'] === 'number' && props['limit'] > 0 ? props['limit'] : rowCount
  const [expanded, setExpanded] = useState(rowCount <= limit)
  const shown = expanded ? rowCount : Math.min(limit, rowCount)
  const child = text(props['child'])
  const labelStyle = isStudioA2uiObject(props['bottomButtonTextStyle'])
    ? { fontSize: text(props['bottomButtonTextStyle']['fontSize']), color: text(props['bottomButtonTextStyle']['color']) }
    : { fontSize: '12px', color: 'rgba(26, 26, 26, 0.4)' }
  const toggles = rowCount > limit && !(expanded && props['hideBottomButtonWhenExpand'] === true)
  const style: CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: gapOf(props),
    padding: spacing(props['padding']), backgroundColor: text(props['backgroundColor']), borderRadius: studioA2uiRadius(props['borderRadius']),
    width: studioA2uiLength(props['width'], '%'),
    ...borderOf(props['border']),
  }
  return (
    <div style={style}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: gapOf(props) }}>
        {Array.from({ length: shown }, (_unused, index) => prefanned.length > 0
          ? <StudioA2uiNode id={prefanned[index] ?? ''} key={index} scope={scope} />
          : child === undefined ? null : <StudioA2uiNode id={child} key={index} scope={studioA2uiRowScope(items[index] ?? null)} />)}
      </div>
      {toggles && (
        <button onClick={() => setExpanded(!expanded)} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', padding: '6px 0 0', background: 'none', border: 'none' }} type="button">
          <span style={labelStyle}>{expanded ? studioA2uiText(props['foldText'], scope, surface.data) || '收起' : studioA2uiText(props['expandText'], scope, surface.data) || '查看更多'}</span>
          <span style={{ display: 'inline-flex', width: '10px', height: '10px' }}><GlyphOf name={expanded ? 'chevron-up' : 'chevron-down'} /></span>
        </button>
      )}
    </div>
  )
}

function TableBox({ props, scope }: { props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const { surface } = useCardScope()
  const widths = Array.isArray(props['columnWidths']) ? props['columnWidths'].filter((width): width is string => typeof width === 'string') : []
  const columns = typeof props['columnCount'] === 'number' ? props['columnCount'] : 1
  const merges = new Map<string, StudioA2uiObject>()
  for (const merge of Array.isArray(props['mergeCells']) ? props['mergeCells'] : []) {
    if (isStudioA2uiObject(merge) && typeof merge['id'] === 'string') merges.set(merge['id'], merge)
  }
  const span = (range: JsonValue | undefined): string | undefined => isStudioA2uiObject(range) && typeof range['from'] === 'number' && typeof range['size'] === 'number'
    ? `${String(range['from'] + 1)} / span ${String(range['size'])}`
    : undefined
  const style: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: widths.length > 0 ? widths.join(' ') : Array.from({ length: columns }, () => '1fr').join(' '),
    gap: gapOf(props),
    justifyItems: text(props['justifyItems']),
    alignItems: text(props['alignItems']),
    ...commonStyle(props, scope, surface.data),
  }
  return (
    <div style={style}>
      {studioA2uiChildIds(props).map((id) => {
        const merge = merges.get(id)
        return merge === undefined
          ? <StudioA2uiNode id={id} key={id} scope={scope} />
          : <div key={id} style={{ gridRow: span(merge['row']), gridColumn: span(merge['column']) }}><StudioA2uiNode id={id} scope={scope} /></div>
      })}
    </div>
  )
}

const POPUP_PLACES: Readonly<Record<string, CSSProperties>> = {
  bottom: { alignItems: 'flex-end', justifyContent: 'center' },
  top: { alignItems: 'flex-start', justifyContent: 'center' },
  left: { alignItems: 'center', justifyContent: 'flex-start' },
  right: { alignItems: 'center', justifyContent: 'flex-end' },
  center: { alignItems: 'center', justifyContent: 'center' },
}

function PopupBox({ id, props, scope }: { id: string; props: StudioA2uiObject; scope: StudioA2uiObject | null }) {
  const card = useCardScope()
  if (!card.openPopups.has(id) && props['modelValue'] !== true) return null
  const place = text(props['position']) ?? 'bottom'
  const close = (): void => card.setPopup(id, false)
  const title = text(props['title'])
  return (
    <div
      className="chat-a2ui-popup"
      onClick={event => { if (event.target === event.currentTarget && props['closeOnOverlayClick'] === true) close() }}
      style={{ ...POPUP_PLACES[place] ?? POPUP_PLACES['bottom'], backgroundColor: props['overlay'] === true ? 'rgba(0,0,0,0.3)' : undefined }}
    >
      <div
        style={{
          display: 'flex', flexDirection: 'column', position: 'relative', maxHeight: '80%', overflow: 'auto',
          backgroundColor: text(props['backgroundColor']) ?? '#fff',
          borderRadius: studioA2uiRadius(props['borderRadius']),
          padding: spacing(props['padding']),
          width: studioA2uiLength(props['width'], '%') ?? (place === 'bottom' || place === 'top' ? '100%' : undefined),
          height: studioA2uiLength(props['height'], '%'),
        }}
      >
        {title !== undefined && <div style={{ fontWeight: 600, padding: '0 0 8px 0', fontSize: '16px' }}>{title}</div>}
        {props['closeable'] === true && <button aria-label="关闭" onClick={close} style={{ position: 'absolute', top: '8px', right: '8px', background: 'none', border: 'none', fontSize: '20px', color: '#999' }} type="button">×</button>}
        <Children props={props} scope={scope} />
      </div>
    </div>
  )
}

/** One component by id; an id the card does not have draws nothing. */
function StudioA2uiNode({ id, scope }: { id: string; scope: StudioA2uiObject | null }): ReactNode {
  const { surface } = useCardScope()
  const component = surface.components.get(id)
  if (component === undefined) return null
  const { type, props } = component
  switch (type) {
    case 'Column': return <FlexBox direction="column" props={props} scope={scope} />
    case 'Row': return <FlexBox direction="row" props={props} scope={scope} />
    case 'Card': return <CardBox props={props} scope={scope} />
    case 'Text': return <TextLeaf props={props} scope={scope} />
    case 'RichText': return <RichTextLeaf props={props} scope={scope} />
    case 'Button': return <ButtonLeaf props={props} scope={scope} />
    case 'Divider': return <DividerLeaf props={props} />
    case 'Tag': return <TagLeaf props={props} scope={scope} />
    case 'Image': return <ImageLeaf props={props} scope={scope} />
    case 'Icon': return <IconLeaf props={props} scope={scope} />
    case 'Circle': return <CircleLeaf props={props} />
    case 'Line': return <LineLeaf props={props} scope={scope} />
    case 'List': return <ListBox props={props} scope={scope} />
    case 'CollapseList': return <CollapseListBox props={props} scope={scope} />
    case 'Table': return <TableBox props={props} scope={scope} />
    case 'Popup': return <PopupBox id={id} props={props} scope={scope} />
    default:
      return <div className="chat-a2ui-placeholder" title="这是 agent 自带的组件，Studio 没有它的画法">{type}</div>
  }
}

/** Scale the card down to the window's width when it is wider; returns the scale and the drawn height. */
function useStudioCardFit(): { outer: RefObject<HTMLDivElement>; inner: RefObject<HTMLDivElement>; scale: number; height: number | undefined } {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<{ scale: number; height: number | undefined }>({ scale: 1, height: undefined })
  useLayoutEffect(() => {
    const measure = (): void => {
      if (outer.current === null || inner.current === null) return
      const available = outer.current.clientWidth
      const natural = inner.current.scrollWidth
      const scale = natural > available && available > 0 ? available / natural : 1
      setFit(scale === 1 ? { scale: 1, height: undefined } : { scale, height: inner.current.offsetHeight * scale })
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (outer.current !== null) observer.observe(outer.current)
    if (inner.current !== null) observer.observe(inner.current)
    return () => observer.disconnect()
  }, [])
  return { outer, inner, ...fit }
}

/**
 * One card of an answer.
 * @param payload - the `ui_data` of its A2UI frame.
 * @param onQuery - sends a message, for a card's `query` action.
 */
export function StudioA2uiCard({ payload, onQuery }: { payload: JsonValue; onQuery(message: string): void }) {
  const surface = studioA2uiSurface(payload)
  const [openPopups, setOpenPopups] = useState<ReadonlySet<string>>(() => new Set())
  const fit = useStudioCardFit()
  if (surface === null) return <div className="chat-a2ui-placeholder">无法显示的卡片</div>
  const scope: StudioA2uiCardScope = {
    surface,
    openPopups,
    setPopup: (id, open) => setOpenPopups((current) => {
      const next = new Set(current)
      if (open) next.add(id)
      else next.delete(id)
      return next
    }),
    onQuery,
  }
  return (
    <StudioA2uiCardContext.Provider value={scope}>
      <div className="chat-a2ui-card" data-surface-id={surface.surfaceId} ref={fit.outer} style={{ height: fit.height }}>
        <div ref={fit.inner} style={fit.scale === 1 ? undefined : { transform: `scale(${String(fit.scale)})`, transformOrigin: 'top left', width: `${String(100 / fit.scale)}%` }}>
          <StudioA2uiNode id={surface.rootId} scope={null} />
        </div>
      </div>
    </StudioA2uiCardContext.Provider>
  )
}
