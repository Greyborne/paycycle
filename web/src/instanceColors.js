// Preset colors for the optional non-production instance badge/favicon tint
// (see INSTANCE_LABEL / INSTANCE_COLOR in server/config.js).
//
// Raw hex literals are unavoidable in this one file: the favicon is built as
// a `data:image/svg+xml,...` URI at runtime (see App.jsx), and a data URI
// cannot reference a CSS custom property. This is the ONLY module allowed to
// contain literal color values for this feature - every other consumer (the
// sidebar badge, etc.) reads the color via CSS custom properties that App.jsx
// sets on `:root` from this same map at boot. No component file should
// contain a hex/rgb/hsl value for instance branding.
//
// Each preset carries:
//   - `favicon`: the solid fill swapped in for the icon.svg background rect.
//   - `badge`: a translucent-tint + ink pair per theme, tuned so the badge
//     text clears WCAG AA (4.5:1) once the tint is alpha-composited over the
//     sidebar's actual background token (`--page`) in that theme - not over
//     a flat guess. See the contrast ratios recorded in the feature report.
export const INSTANCE_COLORS = {
  blue: {
    favicon: '#2f6fed',
    badge: { alphaDark: 0.22, inkDark: '#8fb8ff', alphaLight: 0.16, inkLight: '#1a45c4' },
  },
  green: {
    favicon: '#1f9d55',
    badge: { alphaDark: 0.22, inkDark: '#6ee7a0', alphaLight: 0.16, inkLight: '#0f6b31' },
  },
  purple: {
    favicon: '#8b5cf6',
    badge: { alphaDark: 0.22, inkDark: '#c4b5fd', alphaLight: 0.16, inkLight: '#611fc9' },
  },
  red: {
    favicon: '#e0393e',
    badge: { alphaDark: 0.22, inkDark: '#ff9a9d', alphaLight: 0.16, inkLight: '#a3181c' },
  },
  amber: {
    favicon: '#c9891b',
    badge: { alphaDark: 0.22, inkDark: '#f4c76b', alphaLight: 0.16, inkLight: '#7a4d09' },
  },
};

// Converts "#rrggbb" + alpha into an "rgba(r, g, b, a)" string, so the badge
// tint can be expressed as a CSS custom property without a hex literal
// appearing anywhere outside this module.
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Builds the tinted favicon/apple-touch-icon SVG markup, matching
// web/public/icon.svg exactly apart from the background rect's fill.
export function tintedIconSvg(fill) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
    `<rect width="512" height="512" rx="96" fill="${fill}"/>` +
    `<path d="M256 116a140 140 0 1 0 140 140" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round"/>` +
    `<path d="M366 200l30 56 34-52z" fill="#fff"/>` +
    `<text x="256" y="296" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="150" font-weight="700" fill="#fff" text-anchor="middle">$</text>` +
    `</svg>`;
}

// Applies an instance color preset to the document: sets the badge's CSS
// custom properties on :root and returns the tinted favicon data URI (or
// null if the name isn't a recognised preset - callers should already have
// this validated server-side, but this is defensive against a stale build).
export function applyInstanceColor(name) {
  const preset = INSTANCE_COLORS[name];
  if (!preset) return null;
  const root = document.documentElement;
  const { alphaDark, inkDark, alphaLight, inkLight } = preset.badge;
  root.style.setProperty('--instance-badge-bg-dark', hexToRgba(preset.favicon, alphaDark));
  root.style.setProperty('--instance-badge-ink-dark', inkDark);
  root.style.setProperty('--instance-badge-bg-light', hexToRgba(preset.favicon, alphaLight));
  root.style.setProperty('--instance-badge-ink-light', inkLight);
  const svg = tintedIconSvg(preset.favicon);
  return { dataUri: `data:image/svg+xml,${encodeURIComponent(svg)}`, hex: preset.favicon };
}
