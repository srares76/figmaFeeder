# Figma Node Report

- Generated: 2026-01-20T10:37:33.059Z
- File key: JEW2G6V0LITFox9oAsSVE2
- Root node id: 17727:22414
- Root node name: Group 611
- Root node type: GROUP
- Root bounds: 48x20 at (12751, 7675.599609375)

## What This Report Contains

- Visible nodes only (`visible=false` skipped entirely)
- No vector path/network geometry (placeholder only)
- Instances described as-resolved (subtree content as returned by API)
- One section file per top-level child of the target node

## Root Split (Top-Level Children)

- 01. Container (id: 17727:22415, nodes: 1) -> sections/01-container-17727-22415.md
- 02. Text (id: 17727:22416, nodes: 2) -> sections/02-text-17727-22416.md

## Root Node (Depth=1 Snapshot)

```json
{
  "bounds": {
    "height": 20,
    "width": 48,
    "x": 12751,
    "y": 7675.599609375
  },
  "childIds": [
    "17727:22415",
    "17727:22416"
  ],
  "id": "17727:22414",
  "name": "Group 611",
  "padding": {},
  "type": "GROUP"
}
```

## Implementation Guidance (React + TS + twin.macro)

- Treat each section file as a candidate top-level React component or sub-tree to compose into a page component.
- Prefer reproducing auto-layout nodes as `flex` containers; use arbitrary values when spacing/sizing do not match Tailwind scale (`gap-[12px]`, `p-[20px]`).
- For absolute positioning / constraints, translate to `relative` parent + `absolute` children and preserve numeric offsets using arbitrary values.
- Keep typography numeric and explicit (`text-[14px] leading-[20px] tracking-[0.01em]`) unless you already have a token system.
- Vectors: geometry omitted in report; implement as placeholder `svg` or use exported SVGs in a later phase.

## Typography Inventory (Subtree)

- Unique styles: 1

```json
[
  {
    "count": 1,
    "style": {
      "fontFamily": "Roboto",
      "fontPostScriptName": null,
      "fontSize": 14,
      "fontWeight": 500,
      "letterSpacing": 0,
      "lineHeightPercent": 121.90476989746094,
      "lineHeightPercentFontSize": 142.85714721679688,
      "lineHeightPx": 20
    }
  }
]
```

## Color Inventory (Subtree, Solid Paints Only)

- Unique colors: 1

```json
[
  {
    "count": 2,
    "hex": "#f4cf3b"
  }
]
```

## Effects Inventory (Subtree)

- Unique effects: 1

```json
[
  {
    "count": 1,
    "effect": {
      "blendMode": "NORMAL",
      "color": {
        "a": 0.6000000238418579,
        "b": 0.23137255012989044,
        "g": 0.8117647171020508,
        "r": 0.95686274766922
      },
      "offset": {
        "x": 0,
        "y": 0
      },
      "radius": 15,
      "showShadowBehindNode": false,
      "spread": -3,
      "type": "DROP_SHADOW"
    }
  }
]
```
