#!/usr/bin/env node
/**
 * Figma Node Analyzer -> Markdown
 *
 * - Token via env var: FIGMA_TOKEN
 * - Input: Figma node URL containing node-id
 * - Output: figma-report/figma-node-report.md + one section per top-level child
 *
 * Notes:
 * - Hidden nodes (visible=false) are skipped entirely.
 * - Vector geometry is intentionally omitted (vectorPaths/vectorNetwork/etc).
 * - Instances are described in resolved form (what exists in the instance subtree).
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const FIGMA_API = 'https://api.figma.com/v1'

function usage(exitCode = 0) {
    const msg = `
Usage:
  FIGMA_TOKEN=... node figma-node-report.mjs <figma-node-url> [options]

Required:
  - FIGMA_TOKEN env var
  - <figma-node-url> must contain /file/<FILEKEY>/ or /design/<FILEKEY>/ and ?node-id=...

Options:
  --out-dir <dir>        Output directory (default: figma-report)
  --section-dir <dir>    Section directory under out-dir (default: sections)
  --batch-size <n>       Node ids per API request (default: 50)
  --concurrency <n>      Concurrent API requests (default: 3)
  --verbose              Log progress
  --help                 Show help

Examples:
  FIGMA_TOKEN=... node figma-node-report.mjs "https://www.figma.com/file/ABC123/Design?node-id=123%3A456"
  FIGMA_TOKEN=... node figma-node-report.mjs "..." --out-dir out --concurrency 2 --batch-size 40
`.trim()
    // eslint-disable-next-line no-console
    console.log(msg)
    process.exit(exitCode)
}

function parseArgs(argv) {
    const args = {
        url: null,
        outDir: 'figma-report',
        sectionDir: 'sections',
        batchSize: 50,
        concurrency: 3,
        verbose: false,
    }

    const positionals = []
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--help' || a === '-h') usage(0)
        if (a === '--verbose') {
            args.verbose = true
            continue
        }

        if (a.startsWith('--')) {
            const key = a.slice(2)
            const v = argv[i + 1]
            if (!v || v.startsWith('--')) {
                // eslint-disable-next-line no-console
                console.error(`Missing value for --${key}`)
                usage(1)
            }
            i++
            if (key === 'out-dir') args.outDir = v
            else if (key === 'section-dir') args.sectionDir = v
            else if (key === 'batch-size') args.batchSize = Number(v)
            else if (key === 'concurrency') args.concurrency = Number(v)
            else {
                // eslint-disable-next-line no-console
                console.error(`Unknown flag: --${key}`)
                usage(1)
            }
            continue
        }

        positionals.push(a)
    }

    if (positionals.length !== 1) usage(1)
    args.url = positionals[0]

    if (!Number.isFinite(args.batchSize) || args.batchSize <= 0) {
        // eslint-disable-next-line no-console
        console.error(`Invalid --batch-size: ${args.batchSize}`)
        process.exit(1)
    }
    if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) {
        // eslint-disable-next-line no-console
        console.error(`Invalid --concurrency: ${args.concurrency}`)
        process.exit(1)
    }

    return args
}

function log(verbose, ...parts) {
    if (!verbose) return
    // eslint-disable-next-line no-console
    console.log(...parts)
}

function sanitizeFileName(input) {
    const s = String(input || 'unnamed')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9._-]+/g, '')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')

    return s.length ? s.slice(0, 80) : 'unnamed'
}

function parseFigmaNodeUrl(urlStr) {
    let url
    try {
        url = new URL(urlStr)
    } catch {
        throw new Error(`Invalid URL: ${urlStr}`)
    }

  const m = url.pathname.match(/\/(?:file|design)\/([^/]+)/)
  if (!m) throw new Error(`Could not find file key in URL path: ${url.pathname}`)
  const fileKey = m[1]

  const nodeIdParam = url.searchParams.get('node-id') || url.searchParams.get('node_id')
  if (!nodeIdParam) throw new Error('URL missing required query param: node-id')

  // node-id may be urlencoded (e.g. 123%3A456) or dash-separated (e.g. 123-456)
  let nodeId = decodeURIComponent(nodeIdParam)
  if (!nodeId.includes(':') && /^\d+-\d+$/.test(nodeId)) nodeId = nodeId.replace('-', ':')

  return { fileKey, nodeId }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
}

function shouldRetry(status) {
    if (status === 429) return true
    if (status >= 500 && status <= 599) return true
    return false
}

async function figmaFetchJson({ token, url, verbose }) {
    const maxAttempts = 6
    let attempt = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await fetch(url, {
            headers: {
                'X-Figma-Token': token,
            },
        })

        if (res.ok) return await res.json()

        const text = await res.text().catch(() => '')

        if (attempt < maxAttempts - 1 && shouldRetry(res.status)) {
            const base = 500
            const backoff = base * Math.pow(2, attempt)
            const jitter = Math.floor(Math.random() * 250)
            const waitMs = backoff + jitter
            log(verbose, `Retrying (${res.status}) in ${waitMs}ms: ${url}`)
            attempt++
            await sleep(waitMs)
            continue
        }

        throw new Error(
            `Figma API error ${res.status} ${res.statusText}\nURL: ${url}\nBody: ${text.slice(0, 2000)}`,
        )
    }
}

async function fetchNodes({ token, fileKey, ids, depth = 1, verbose }) {
    const params = new URLSearchParams()
    params.set('ids', ids.join(','))
    params.set('depth', String(depth))

    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/nodes?${params}`
    return await figmaFetchJson({ token, url, verbose })
}

function isVisibleNode(node) {
    // Per Figma, visible defaults to true when omitted
    return node?.visible !== false
}

function isVectorLikeType(type) {
    return (
        type === 'VECTOR' ||
        type === 'BOOLEAN_OPERATION' ||
        type === 'LINE' ||
        type === 'ELLIPSE' ||
        type === 'REGULAR_POLYGON' ||
        type === 'STAR'
    )
}

function pick(obj, keys) {
    const out = {}
    for (const k of keys) if (k in obj) out[k] = obj[k]
    return out
}

function omit(obj, keysToOmit) {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
        if (keysToOmit.has(k)) continue
        out[k] = v
    }
    return out
}

function stableStringify(value) {
    const seen = new WeakSet()

    function sortRec(v) {
        if (v === null) return v
        if (typeof v !== 'object') return v
        if (seen.has(v)) return '[Circular]'
        seen.add(v)

        if (Array.isArray(v)) return v.map(sortRec)

        const out = {}
        for (const k of Object.keys(v).sort()) out[k] = sortRec(v[k])
        return out
    }

    return JSON.stringify(sortRec(value), null, 2)
}

function fenceForText(s) {
    const text = String(s)
    if (!text.includes('```')) return '```'
    if (!text.includes('````')) return '````'
    // Extremely unlikely; fall back to 5
    return '`````'
}

function hexFromColor(color) {
    if (!color || typeof color !== 'object') return null
    const r = Math.round((color.r ?? 0) * 255)
    const g = Math.round((color.g ?? 0) * 255)
    const b = Math.round((color.b ?? 0) * 255)
    const a = color.a
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
    if (typeof a === 'number' && a >= 0 && a < 1) return `${hex} @ ${a.toFixed(3)}`
    return hex
}

function twSize(px) {
    if (!Number.isFinite(px)) return null
    return `${Math.round(px * 1000) / 1000}px`
}

function twArbitrary(prefix, px) {
    if (!Number.isFinite(px)) return null
    return `${prefix}-[${twSize(px)}]`
}

function inferTw(node) {
    const tw = []

    const lm = node.layoutMode
    if (lm === 'HORIZONTAL') tw.push('flex', 'flex-row')
    if (lm === 'VERTICAL') tw.push('flex', 'flex-col')

    if (Number.isFinite(node.itemSpacing)) {
        const cls = twArbitrary('gap', node.itemSpacing)
        if (cls) tw.push(cls)
    }

    const pads = {
        pt: node.paddingTop,
        pr: node.paddingRight,
        pb: node.paddingBottom,
        pl: node.paddingLeft,
    }
    const padVals = Object.values(pads).filter((v) => Number.isFinite(v))
    if (padVals.length === 4 && padVals.every((v) => v === padVals[0])) {
        const cls = twArbitrary('p', padVals[0])
        if (cls) tw.push(cls)
    } else {
        if (Number.isFinite(pads.pt)) tw.push(twArbitrary('pt', pads.pt))
        if (Number.isFinite(pads.pr)) tw.push(twArbitrary('pr', pads.pr))
        if (Number.isFinite(pads.pb)) tw.push(twArbitrary('pb', pads.pb))
        if (Number.isFinite(pads.pl)) tw.push(twArbitrary('pl', pads.pl))
    }

    // Basic color hint: first visible solid fill
    if (Array.isArray(node.fills)) {
        const solid = node.fills.find((f) => f?.visible !== false && f?.type === 'SOLID' && f?.color)
        if (solid) {
            const hex = hexFromColor(solid.color)
            if (hex) tw.push(`bg-[${hex.replace(' @ ', '/')} ]`.replace(/\s+/g, ''))
        }
    }

    // Corners
    if (typeof node.cornerRadius === 'number') {
        const cls = twArbitrary('rounded', node.cornerRadius)
        if (cls) tw.push(cls)
    }

    return [...new Set(tw.filter(Boolean))]
}

function inferElement(node) {
    const t = node.type
    if (t === 'TEXT') return 'p'
    if (t === 'FRAME' || t === 'GROUP' || t === 'SECTION') return 'div'
    if (t === 'RECTANGLE') return 'div'
    if (t === 'ELLIPSE') return 'div'
    if (t === 'INSTANCE') return 'div'
    if (t === 'COMPONENT') return 'div'
    if (t === 'COMPONENT_SET') return 'div'
    if (t === 'LINE') return 'div'
    if (t === 'VECTOR' || t === 'BOOLEAN_OPERATION' || t === 'STAR' || t === 'REGULAR_POLYGON') return 'svg'
    return 'div'
}

function nodeTitle(node) {
    const name = node.name ?? 'Unnamed'
    return `${node.type} "${name}"`
}

function bboxSummary(bb) {
    if (!bb) return null
    const parts = ['x', 'y', 'width', 'height']
    if (!parts.every((k) => Number.isFinite(bb[k]))) return null
    return `${bb.width}x${bb.height} at (${bb.x}, ${bb.y})`
}

function formatPaintArray(paints) {
    if (!Array.isArray(paints) || paints.length === 0) return 'none'
    const lines = []
    for (const p of paints) {
        if (!p || typeof p !== 'object') continue
        const base = `${p.visible === false ? '(hidden) ' : ''}${p.type || 'UNKNOWN'}`
        if (p.type === 'SOLID' && p.color) {
            const hex = hexFromColor(p.color)
            lines.push(`${base} ${hex || ''}`.trim())
        } else if (p.type && (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND')) {
            lines.push(`${base} (stops=${Array.isArray(p.gradientStops) ? p.gradientStops.length : 0})`)
        } else if (p.type === 'IMAGE') {
            lines.push(`${base} (imageRef=${p.imageRef ? String(p.imageRef).slice(0, 16) : 'n/a'}...)`)
        } else {
            lines.push(base)
        }
    }
    return lines.length ? lines.join('\n') : 'none'
}

function formatEffects(effects) {
    if (!Array.isArray(effects) || effects.length === 0) return 'none'
    const lines = []
    for (const e of effects) {
        if (!e || typeof e !== 'object') continue
        const base = `${e.visible === false ? '(hidden) ' : ''}${e.type || 'UNKNOWN'}`
        if ((e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') && e.color) {
            const hex = hexFromColor(e.color)
            const off = e.offset ? `offset(${e.offset.x},${e.offset.y})` : ''
            const r = Number.isFinite(e.radius) ? `blur(${e.radius})` : ''
            lines.push(`${base} ${hex || ''} ${off} ${r}`.trim())
        } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
            const r = Number.isFinite(e.radius) ? `radius(${e.radius})` : ''
            lines.push(`${base} ${r}`.trim())
        } else {
            lines.push(base)
        }
    }
    return lines.length ? lines.join('\n') : 'none'
}

function normalizeNode(doc) {
    // Store the exact document shape as returned (minus geometry), and compute some helpers.
    const raw = { ...doc }

    // Never store vector geometry fields.
    delete raw.vectorPaths
    delete raw.vectorNetwork
    delete raw.vectorData

    const childIds = Array.isArray(doc.children) ? doc.children.filter(isVisibleNode).map((c) => c.id).filter(Boolean) : []

    const knownKeys = [
        'id',
        'name',
        'type',
        'visible',
        'locked',
        'opacity',
        'blendMode',
        'isMask',
        'maskType',
        'clipsContent',
        'layoutMode',
        'layoutWrap',
        'primaryAxisSizingMode',
        'counterAxisSizingMode',
        'primaryAxisAlignItems',
        'counterAxisAlignItems',
        'primaryAxisAlignContent',
        'counterAxisAlignContent',
        'itemSpacing',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'layoutPositioning',
        'constraints',
        'absoluteBoundingBox',
        'absoluteRenderBounds',
        'size',
        'relativeTransform',
        'rotation',
        'cornerRadius',
        'rectangleCornerRadii',
        'fills',
        'strokes',
        'strokeWeight',
        'strokeAlign',
        'strokeCap',
        'strokeJoin',
        'strokeDashes',
        'effects',
        'styles',
        'characters',
        'style',
        'characterStyleOverrides',
        'styleOverrideTable',
        'componentId',
        'componentProperties',
        'variantProperties',
        'documentationLinks',
        'reactions',
        'transitionNodeID',
        'prototypeStartNodeID',
        'exportSettings',
    ]

    const known = pick(raw, knownKeys)
    const other = omit(raw, new Set([...knownKeys, 'children']))

    const tw = inferTw(known)

    return {
        id: doc.id,
        name: doc.name,
        type: doc.type,
        childIds,
        known,
        other,
        tw,
    }
}

function collectInventories(node, inventories) {
    // Typography
    if (node.type === 'TEXT' && node.known?.style) {
        const s = node.known.style
        const key = stableStringify({
            fontFamily: s.fontFamily,
            fontPostScriptName: s.fontPostScriptName,
            fontWeight: s.fontWeight,
            fontSize: s.fontSize,
            lineHeightPx: s.lineHeightPx,
            lineHeightPercent: s.lineHeightPercent,
            lineHeightPercentFontSize: s.lineHeightPercentFontSize,
            letterSpacing: s.letterSpacing,
            paragraphSpacing: s.paragraphSpacing,
            textCase: s.textCase,
            textDecoration: s.textDecoration,
        })
        inventories.typography.set(key, (inventories.typography.get(key) || 0) + 1)
    }

    // Colors: fills + strokes (SOLID only)
    for (const arr of [node.known?.fills, node.known?.strokes]) {
        if (!Array.isArray(arr)) continue
        for (const p of arr) {
            if (!p || p.visible === false) continue
            if (p.type !== 'SOLID' || !p.color) continue
            const hex = hexFromColor(p.color)
            if (!hex) continue
            inventories.colors.set(hex, (inventories.colors.get(hex) || 0) + 1)
        }
    }

    // Effects
    if (Array.isArray(node.known?.effects)) {
        for (const e of node.known.effects) {
            if (!e || e.visible === false) continue
            const key = stableStringify({
                type: e.type,
                radius: e.radius,
                spread: e.spread,
                offset: e.offset,
                color: e.color,
                blendMode: e.blendMode,
                showShadowBehindNode: e.showShadowBehindNode,
            })
            inventories.effects.set(key, (inventories.effects.get(key) || 0) + 1)
        }
    }
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length)
    let idx = 0

    async function worker() {
        while (idx < items.length) {
            const current = idx++
            results[current] = await fn(items[current], current)
        }
    }

    const workers = []
    for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker())
    await Promise.all(workers)
    return results
}

async function crawlSubtree({ token, fileKey, rootId, batchSize, concurrency, verbose }) {
    const nodeMap = new Map()
    const toExpand = []
    const queued = new Set()

    function enqueue(id) {
        if (!id) return
        if (nodeMap.has(id)) return
        if (queued.has(id)) return
        queued.add(id)
        toExpand.push(id)
    }

    enqueue(rootId)

    let fetchedCount = 0
    let requestCount = 0

    while (toExpand.length > 0) {
        const batch = []
        while (batch.length < batchSize && toExpand.length > 0) batch.push(toExpand.shift())

        const batches = [batch]

        // If the queue is huge, pre-split into a few batches and fetch concurrently.
        while (toExpand.length > 0 && batches.length < concurrency) {
            const b = []
            while (b.length < batchSize && toExpand.length > 0) b.push(toExpand.shift())
            if (b.length) batches.push(b)
        }

        await mapLimit(batches, concurrency, async (ids) => {
            requestCount++
            log(verbose, `Fetching ${ids.length} nodes (req=${requestCount})`)
            const data = await fetchNodes({ token, fileKey, ids, depth: 1, verbose })

            const nodes = data?.nodes || {}
            for (const id of ids) {
                const entry = nodes[id]
                if (!entry || !entry.document) continue
                const doc = entry.document
                if (!isVisibleNode(doc)) continue

                const norm = normalizeNode(doc)
                nodeMap.set(norm.id, norm)
                fetchedCount++

                for (const childId of norm.childIds) enqueue(childId)
            }
        })
    }

    return { nodeMap }
}

function buildTreeLines({ nodeMap, rootId }) {
    const lines = []

    function walk(id, depth) {
        const n = nodeMap.get(id)
        if (!n) return

        const indent = '  '.repeat(depth)
        const bb = bboxSummary(n.known?.absoluteBoundingBox)
        const layoutBits = []
        if (n.known?.layoutMode === 'HORIZONTAL') layoutBits.push('auto-layout horizontal')
        if (n.known?.layoutMode === 'VERTICAL') layoutBits.push('auto-layout vertical')
        if (Number.isFinite(n.known?.itemSpacing)) layoutBits.push(`gap=${n.known.itemSpacing}`)
        const meta = [bb, layoutBits.length ? layoutBits.join(' ') : null].filter(Boolean).join(' | ')

        lines.push(`${indent}${n.type} "${n.name ?? 'Unnamed'}" (id: ${n.id})${meta ? ` — ${meta}` : ''}`)

        for (const childId of n.childIds) walk(childId, depth + 1)
    }

    walk(rootId, 0)
    return lines
}

function buildNodeDetailMarkdown({ nodeMap, rootId, fileKey }) {
    const parts = []

    function walk(id, pathParts) {
        const n = nodeMap.get(id)
        if (!n) return

        const currentPathParts = [...pathParts, `${n.name ?? 'Unnamed'} (${n.type})`]
        const nodePath = currentPathParts.join(' > ')

        parts.push(`## ${nodeTitle(n)} (id: ${n.id})`)
        parts.push('')
        parts.push(`- Path: ${nodePath}`)
        parts.push(`- File key: ${fileKey}`)

        if (n.type === 'INSTANCE') {
            parts.push(`- Instance: true${n.known?.componentId ? ` (componentId: ${n.known.componentId})` : ''}`)
        }

        const bb = n.known?.absoluteBoundingBox
        if (bb) parts.push(`- Bounds: ${bboxSummary(bb) || stableStringify(bb)}`)

        if (Number.isFinite(n.known?.rotation)) parts.push(`- Rotation: ${n.known.rotation}`)
        if (Number.isFinite(n.known?.opacity)) parts.push(`- Opacity: ${n.known.opacity}`)
        if (n.known?.blendMode) parts.push(`- Blend mode: ${n.known.blendMode}`)

        // Layout summary
        const layout = {
            layoutMode: n.known?.layoutMode,
            layoutWrap: n.known?.layoutWrap,
            primaryAxisSizingMode: n.known?.primaryAxisSizingMode,
            counterAxisSizingMode: n.known?.counterAxisSizingMode,
            primaryAxisAlignItems: n.known?.primaryAxisAlignItems,
            counterAxisAlignItems: n.known?.counterAxisAlignItems,
            itemSpacing: n.known?.itemSpacing,
            paddingTop: n.known?.paddingTop,
            paddingRight: n.known?.paddingRight,
            paddingBottom: n.known?.paddingBottom,
            paddingLeft: n.known?.paddingLeft,
            layoutPositioning: n.known?.layoutPositioning,
            constraints: n.known?.constraints,
        }

        const layoutJson = stableStringify(layout)
        parts.push('')
        parts.push('**Layout / Constraints**')
        parts.push('')
        parts.push('```json')
        parts.push(layoutJson)
        parts.push('```')

        // Paint summary
        parts.push('')
        parts.push('**Paint / Effects**')
        parts.push('')

        parts.push('- Fills:')
        parts.push('```text')
        parts.push(formatPaintArray(n.known?.fills))
        parts.push('```')

        parts.push('- Strokes:')
        parts.push('```text')
        parts.push(formatPaintArray(n.known?.strokes))
        parts.push('```')

        if (Number.isFinite(n.known?.strokeWeight)) parts.push(`- Stroke weight: ${n.known.strokeWeight}`)
        if (n.known?.strokeAlign) parts.push(`- Stroke align: ${n.known.strokeAlign}`)

        parts.push('- Effects:')
        parts.push('```text')
        parts.push(formatEffects(n.known?.effects))
        parts.push('```')

        // Corners
        if (typeof n.known?.cornerRadius === 'number' || Array.isArray(n.known?.rectangleCornerRadii)) {
            parts.push('')
            parts.push('**Corners**')
            parts.push('')
            parts.push('```json')
            parts.push(
                stableStringify({
                    cornerRadius: n.known?.cornerRadius,
                    rectangleCornerRadii: n.known?.rectangleCornerRadii,
                }),
            )
            parts.push('```')
        }

        // Text
        if (n.type === 'TEXT') {
            parts.push('')
            parts.push('**Text**')
            parts.push('')

            const chars = n.known?.characters ?? ''
            const fence = fenceForText(chars)
            parts.push(`${fence}text`)
            parts.push(String(chars))
            parts.push(fence)

            parts.push('')
            parts.push('```json')
            parts.push(
                stableStringify({
                    style: n.known?.style,
                    characterStyleOverrides: n.known?.characterStyleOverrides,
                    styleOverrideTable: n.known?.styleOverrideTable,
                }),
            )
            parts.push('```')
        }

        // Vector placeholder
        if (isVectorLikeType(n.type)) {
            parts.push('')
            parts.push('**Vector Geometry**')
            parts.push('')
            parts.push('- Vector geometry omitted (no path/network data emitted).')
        }

        // Children list
        parts.push('')
        parts.push('**Children**')
        parts.push('')
        parts.push('```json')
        parts.push(stableStringify({ childIds: n.childIds }))
        parts.push('```')

        // Implementation hints
        parts.push('')
        parts.push('**Implementation Hints (React + TS + twin.macro)**')
        parts.push('')
        const el = inferElement(n)
        parts.push(`- Suggested element: \`${el}\``)
        if (n.tw.length) {
            parts.push('- Suggested tw:')
            parts.push('```ts')
            parts.push(`tw\`${n.tw.join(' ')}\``)
            parts.push('```')
        } else {
            parts.push('- Suggested tw: (no strong guess)')
        }

        // Other fields
        const otherKeys = Object.keys(n.other || {})
        if (otherKeys.length) {
            parts.push('')
            parts.push('**Other Figma Fields (Unclassified)**')
            parts.push('')
            parts.push('```json')
            parts.push(stableStringify(n.other))
            parts.push('```')
        }

        parts.push('')

        for (const childId of n.childIds) walk(childId, currentPathParts)
    }

    walk(rootId, [])
    return parts.join('\n')
}

function inventoryMarkdown(inventories) {
    const out = []

    out.push('## Typography Inventory (Subtree)')
    out.push('')
    if (inventories.typography.size === 0) {
        out.push('- none')
    } else {
        const entries = [...inventories.typography.entries()].sort((a, b) => b[1] - a[1])
        out.push(`- Unique styles: ${entries.length}`)
        out.push('')
        out.push('```json')
        out.push(
            stableStringify(
                entries.map(([k, count]) => ({ count, style: JSON.parse(k) })),
            ),
        )
        out.push('```')
    }
    out.push('')

    out.push('## Color Inventory (Subtree, Solid Paints Only)')
    out.push('')
    if (inventories.colors.size === 0) {
        out.push('- none')
    } else {
        const entries = [...inventories.colors.entries()].sort((a, b) => b[1] - a[1])
        out.push(`- Unique colors: ${entries.length}`)
        out.push('')
        out.push('```json')
        out.push(stableStringify(entries.map(([hex, count]) => ({ hex, count }))))
        out.push('```')
    }
    out.push('')

    out.push('## Effects Inventory (Subtree)')
    out.push('')
    if (inventories.effects.size === 0) {
        out.push('- none')
    } else {
        const entries = [...inventories.effects.entries()].sort((a, b) => b[1] - a[1])
        out.push(`- Unique effects: ${entries.length}`)
        out.push('')
        out.push('```json')
        out.push(stableStringify(entries.map(([k, count]) => ({ count, effect: JSON.parse(k) }))))
        out.push('```')
    }
    out.push('')

    return out.join('\n')
}

async function main() {
    const args = parseArgs(process.argv)
    const token = process.env.FIGMA_TOKEN
    if (!token) {
        // eslint-disable-next-line no-console
        console.error('Missing FIGMA_TOKEN env var')
        process.exit(1)
    }

    const { fileKey, nodeId } = parseFigmaNodeUrl(args.url)

    const outDirAbs = path.resolve(process.cwd(), args.outDir)
    const sectionDirAbs = path.join(outDirAbs, args.sectionDir)

    await fs.mkdir(sectionDirAbs, { recursive: true })

    log(args.verbose, `Output dir: ${outDirAbs}`)
    log(args.verbose, `File key: ${fileKey}`)
    log(args.verbose, `Root node: ${nodeId}`)

    // Fetch root (depth=1) so we can determine top-level children (split points)
    const rootData = await fetchNodes({ token, fileKey, ids: [nodeId], depth: 1, verbose: args.verbose })
    const rootEntry = rootData?.nodes?.[nodeId]
    if (!rootEntry?.document) throw new Error(`Root node not found: ${nodeId}`)

    const rootDoc = rootEntry.document
    if (!isVisibleNode(rootDoc)) throw new Error('Root node is not visible; nothing to analyze.')

    const rootNorm = normalizeNode(rootDoc)

    const topLevelChildren = rootNorm.childIds
    if (topLevelChildren.length === 0) {
        // Degenerate case: the node has no children, still produce one section.
        topLevelChildren.push(rootNorm.id)
    }

    const inventories = {
        typography: new Map(),
        colors: new Map(),
        effects: new Map(),
    }

    const sectionLinks = []

    // Crawl each top-level child as its own section
    for (let i = 0; i < topLevelChildren.length; i++) {
        const childId = topLevelChildren[i]

        // Need the child name/type for filename; fetch it if it wasn't included.
        let childDoc = null
        const shallow = rootDoc.children?.find((c) => c?.id === childId)
        if (shallow && isVisibleNode(shallow)) childDoc = shallow

        if (!childDoc) {
            const d = await fetchNodes({ token, fileKey, ids: [childId], depth: 1, verbose: args.verbose })
            const e = d?.nodes?.[childId]
            if (!e?.document) continue
            if (!isVisibleNode(e.document)) continue
            childDoc = e.document
        }

        const sectionName = childDoc?.name || `section-${i + 1}`
        const safe = sanitizeFileName(sectionName)
        const safeId = sanitizeFileName(childId.replace(':', '-'))
        const sectionFileName = `${String(i + 1).padStart(2, '0')}-${safe}-${safeId}.md`
        const sectionPath = path.join(sectionDirAbs, sectionFileName)

        log(args.verbose, `Crawling section ${i + 1}/${topLevelChildren.length}: ${sectionName} (${childId})`)

        const { nodeMap } = await crawlSubtree({
            token,
            fileKey,
            rootId: childId,
            batchSize: args.batchSize,
            concurrency: args.concurrency,
            verbose: args.verbose,
        })

        // Collect inventories
        for (const node of nodeMap.values()) collectInventories(node, inventories)

        const treeLines = buildTreeLines({ nodeMap, rootId: childId })
        const sectionHeader = [
            `# Section: ${sectionName}`,
            '',
            `- File key: ${fileKey}`,
            `- Root node id: ${childId}`,
            '',
            '## Layer Tree (Visible Only)',
            '',
            '```text',
            ...treeLines,
            '```',
            '',
            '## Detailed Spec (Visible Only)',
            '',
        ].join('\n')

        const detailMd = buildNodeDetailMarkdown({ nodeMap, rootId: childId, fileKey })
        await fs.writeFile(sectionPath, sectionHeader + detailMd, 'utf8')

        sectionLinks.push({
            idx: i + 1,
            name: sectionName,
            id: childId,
            file: path.join(args.sectionDir, sectionFileName).replace(/\\/g, '/'),
            nodeCount: nodeMap.size,
        })
    }

    // Index markdown
    const indexParts = []
    indexParts.push(`# Figma Node Report`)
    indexParts.push('')
    indexParts.push(`- Generated: ${new Date().toISOString()}`)
    indexParts.push(`- File key: ${fileKey}`)
    indexParts.push(`- Root node id: ${rootNorm.id}`)
    indexParts.push(`- Root node name: ${rootNorm.name ?? 'Unnamed'}`)
    indexParts.push(`- Root node type: ${rootNorm.type}`)
    if (rootNorm.known?.absoluteBoundingBox) indexParts.push(`- Root bounds: ${bboxSummary(rootNorm.known.absoluteBoundingBox) || ''}`)
    indexParts.push('')

    indexParts.push('## What This Report Contains')
    indexParts.push('')
    indexParts.push('- Visible nodes only (`visible=false` skipped entirely)')
    indexParts.push('- No vector path/network geometry (placeholder only)')
    indexParts.push('- Instances described as-resolved (subtree content as returned by API)')
    indexParts.push('- One section file per top-level child of the target node')
    indexParts.push('')

    indexParts.push('## Root Split (Top-Level Children)')
    indexParts.push('')
    if (sectionLinks.length === 0) {
        indexParts.push('- No visible sections produced (unexpected).')
    } else {
        for (const s of sectionLinks) {
            indexParts.push(`- ${String(s.idx).padStart(2, '0')}. ${s.name} (id: ${s.id}, nodes: ${s.nodeCount}) -> ${s.file}`)
        }
    }
    indexParts.push('')

    indexParts.push('## Root Node (Depth=1 Snapshot)')
    indexParts.push('')
    indexParts.push('```json')
    indexParts.push(stableStringify({
        id: rootNorm.id,
        name: rootNorm.name,
        type: rootNorm.type,
        bounds: rootNorm.known?.absoluteBoundingBox,
        layoutMode: rootNorm.known?.layoutMode,
        itemSpacing: rootNorm.known?.itemSpacing,
        padding: {
            top: rootNorm.known?.paddingTop,
            right: rootNorm.known?.paddingRight,
            bottom: rootNorm.known?.paddingBottom,
            left: rootNorm.known?.paddingLeft,
        },
        childIds: rootNorm.childIds,
    }))
    indexParts.push('```')
    indexParts.push('')

    indexParts.push('## Implementation Guidance (React + TS + twin.macro)')
    indexParts.push('')
    indexParts.push('- Treat each section file as a candidate top-level React component or sub-tree to compose into a page component.')
    indexParts.push('- Prefer reproducing auto-layout nodes as `flex` containers; use arbitrary values when spacing/sizing do not match Tailwind scale (`gap-[12px]`, `p-[20px]`).')
    indexParts.push('- For absolute positioning / constraints, translate to `relative` parent + `absolute` children and preserve numeric offsets using arbitrary values.')
    indexParts.push('- Keep typography numeric and explicit (`text-[14px] leading-[20px] tracking-[0.01em]`) unless you already have a token system.')
    indexParts.push('- Vectors: geometry omitted in report; implement as placeholder `svg` or use exported SVGs in a later phase.')
    indexParts.push('')

    indexParts.push(inventoryMarkdown(inventories))

    const indexPath = path.join(outDirAbs, 'figma-node-report.md')
    await fs.writeFile(indexPath, indexParts.join('\n'), 'utf8')

    // eslint-disable-next-line no-console
    console.log(`Wrote report: ${path.join(args.outDir, 'figma-node-report.md')}`)
    // eslint-disable-next-line no-console
    console.log(`Wrote sections: ${path.join(args.outDir, args.sectionDir)}`)
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err?.stack || String(err))
    process.exit(1)
})
