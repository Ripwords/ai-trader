# ai·trader design system

This is the locked design system for `apps/web`. Every page shares it, and a new page
follows it instead of choosing its own style. Tokens live in
`apps/web/app/assets/css/main.css`, and Nuxt UI theming lives in
`apps/web/app/app.config.ts`.

## Genre and voice

- **Genre:** modern-minimal and utilitarian, like a single-user trading desk. Data
  comes first. Decoration earns its place only if it tells you something, such as a
  direction tape, a status dot or an allocation bar.
- **Copy voice:** lowercase, terse and literal ("refresh", "edit plan", "show 21
  closed"). Actions are verbs. Explain errors in plain words and offer a retry.
  Never put environment variable names, IDs or hashes in user-facing copy. Those go
  in `<TechnicalDetails>`.

## Page macrostructure (app family)

Every page uses the same skeleton:

1. **`PageHeader`:** the title, optional breadcrumbs, and at most two actions. It
   does not repeat links that the top nav already provides.
2. **Key-figure strip:** the two to four numbers the page exists to answer, shown
   before anything else. On phones they form a 2×2 grid.
3. **Workspace:** a single view, or tabs that set the URL query `?tab=` when the
   page has more than one job. Only the active tab renders.
4. **Editors and forms** open in a `USlideover` (side panel) or a `UModal`. They
   never sit open inline between read-only data.

## Colour tokens

| Token | Value | Use |
| --- | --- | --- |
| `--ink-0` … `--ink-3` | `#07080a` … `#1f242a` | Page background up to the raised surface |
| `--ink-line` / `--ink-line-strong` | warm white at 6% / 12% | Hairlines and borders. These are the only border colours. |
| `--paper-0` | `#f7f4ee` | Primary text and key figures |
| `--paper-1` / `--paper-2` | `#e8e3d8` / `#b6b1a4` | Body text and secondary text |
| `--paper-3` | `#8f8b80` | Labels and meta. It passes AA (4.5:1) on every ink. |
| `--accent` / `--color-brand-*` | `#d4a96a` | The only chromatic brand colour: primary action, active tab, focus |
| `--tape-up` / `--tape-down` | `#7ec99c` / `#e07a5f` | Gains and losses only. Never use them for decoration. |

Do not write hex values or `rgba()` inside components. If you need a new value,
add it to `:root` as a named token first.

## Type

- **Inter** (`--font-sans`) is for prose, headings, names and buttons.
- **JetBrains Mono** (`--font-mono`, `.num`) is for every number, ticker and
  eyebrow label, with tabular figures.
- **Eyebrow labels** use `.label-eyebrow` (11px mono, uppercase, 0.16em tracking,
  `--paper-3`). Put them on data blocks only, not on every section.
- **Key figures** use `.stat-value` or `.stat-value-lg`. They wrap instead of
  truncating.
- **Minimum text size** is 11px. Headings are never italic.

## Shape and space

- **Radius:** cards (`.surface-1`) use `--radius-card` (8px). Inner chips, inputs
  and buttons use `--radius-sm` (4px). Never put a bordered card inside a bordered
  card; drop the inner border.
- **Spacing:** page gutters come from `--page-x` and `--page-y`. Space between
  sections is `gap-6`, and space inside a card is `p-4 sm:p-5`.

## Shared components

All of these live in `app/components/ui/` and are auto-imported:

| Component | Replaces |
| --- | --- |
| `<StatTile label value sub tone>` | Hand-built stat cards |
| `<PageState kind="loading\|empty\|error" @retry>` | "loading…" text, silent empties, and errors that look like empty data |
| `<StatusPill tone label>` | Ad-hoc status dots. Uses a flat dot with no glow. |

Buttons are always `UButton`. Primary is `color="primary"`, secondary is
`variant="ghost" color="neutral"`, and destructive is `color="error"`. Form
controls are Nuxt UI (`UInput`, `USelect`, `UInputNumber`).

## States

Every view that fetches data has distinct loading, empty and error states. An
error is never shown as an empty list or as a zero. A safety control, such as the
kill switch, going live, or placing an order, shows its failure next to the
control.

## Motion

Motion is minimal. Only state changes animate (a tab underline, a panel sliding
in). Infinite animations are limited to "something is running" indicators.
`prefers-reduced-motion` turns all of them off globally.

## Responsive floor

- **Widths:** pages are checked at 320, 375, 414 and 768 px.
- **No horizontal page scroll:** the root uses `overflow-x: clip`.
- **Wide tables:** either sit in `.table-scroll` with a sticky first column, or
  turn into one card per row below `sm`.
- **Tap targets:** at least 44px on touch screens (`.tap`).
- **Help text:** must be visible, not hover-only. Explanations that matter on
  touch screens cannot live only in a `title` tooltip.

## UI content rules

- **Hide empty rows by default.** Closed positions and zero-balance accounts sit
  behind a "show N …" toggle.
- **No single-option controls:** don't render a control or list that has only one
  choice.
- **Fold all-passing checks** into one line, "All N checks passed". Show failures
  and warnings open.
- **Confirmations:** never use `window.confirm` or `alert`. Use the app modal, and
  Esc must close it.
