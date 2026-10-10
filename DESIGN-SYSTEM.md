# Nova Studio Design System

The source of truth is the existing theme palette plus the `--nova-*` semantic tokens near the top of `src/App.css`. `data-theme` selects midnight or Arctic Dawn; `data-custom-background` on the application shell selects photo-safe or plain-scene material values. Do not add another parallel token file.

## Surface hierarchy

| Level | Use | Tokens | Treatment |
| --- | --- | --- | --- |
| Foundation | Sidebar, permanent navigation | `--nova-foundation-*` | Stable navy or theme-matched light surface, quiet edge, no large backdrop blur |
| Floating | Composer, selected floating panels | `--nova-floating-*`, `--nova-filter-floating` | Transmitted background, layered inner reflection, soft spatial shadow |
| Elevated | Menus, popovers, short-lived overlays | `--nova-elevated-*`, `--nova-filter-elevated` | Stronger separation and text readability; a menu keeps its own overflow and stacking rules |

These are material roles, not a requirement to make every component translucent. The composer keeps its local `--c-rim-*` optical reflections, and sidebar rows keep their local layout and selection indicator. Shared tokens define their common depth and timing.

## Token groups

- Brand and semantics: `--nova-brand`, `--nova-brand-secondary`, `--nova-success`, `--nova-warning`, `--nova-error` alias the existing theme colors.
- Text and states: `--nova-text-*`, `--nova-state-hover`, `--nova-state-active`, `--nova-state-edge`, `--nova-focus-outline`, `--nova-disabled-opacity`.
- Material: `--nova-foundation-*`, `--nova-floating-*`, `--nova-elevated-*`, `--nova-filter-*`.
- Geometry and type: `--nova-radius-*`, `--nova-space-*`, `--nova-font-sans`, `--nova-type-*`.
- Motion: `--nova-motion-press`, `--nova-motion-hover`, `--nova-motion-focus`, `--nova-motion-menu-open`, `--nova-motion-menu-close`, `--nova-motion-collapse`, `--nova-ease-fluid`, `--nova-ease-exit`.

Use the token for a material role before introducing a new alpha, blur or timing value. Local values remain appropriate for optical details or a control's unique semantics. `prefers-reduced-motion` must reduce transitions and animations without changing the control's state or focus visibility.

## Adapted examples

- `.studio-sidebar` uses Foundation tokens and shared hover, active, focus and collapse timing while retaining its width and content structure.
- `.nova-input` uses Floating surface, edge, shadow, filter, radius and motion tokens while keeping its carefully tuned rim and control treatments.
- `.nova-surface-elevated` is a small reusable material class. Model and project pickers apply it; menu positioning, navigation, opening and closing remain in their existing components.

For a new popover, add `nova-surface-elevated` to its root, then supply only its size, position and interaction behavior. For a new permanent panel, consume Foundation tokens without copying the composer's focus reflection. For a new floating panel, start with Floating tokens, then add only the local reflections needed by that shape. Preserve readable text over photo backgrounds by relying on the scene override rather than sampling pixels every frame.

## Migration boundary

The composer, sidebar, model picker and project picker are adapted. Settings cards, Todo and Schedule detail panels, slash-command and file-mention menus, tooltips, context menus, and other older surfaces remain on their current styles. Migrate each one after checking its layout, interaction and all theme/background combinations; do not bulk-replace selectors.
