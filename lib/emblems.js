// ============================================================================
// VELOCCI — SVG emblem / key-shape renderers
// Stylized, original marks that evoke each automotive brand. These are NOT
// copies of any trademarked logo — they are original abstract emblems used to
// identify a brand within the fitment / brand selector system.
// ============================================================================
'use strict';

const gold = '#C8A15A';
const dark = '#252525';

// --- Brand emblem generator -------------------------------------------------
// Each brand records a `mark` describing an abstract emblem.
function brandEmblem(mark, opts) {
  opts = opts || {};
  const size = opts.size || 56;
  const stroke = opts.stroke || '#252525';
  const fill = opts.fill || 'transparent';
  const bg = opts.bg || '#FFFFFF';
  const accent = opts.accent || gold;
  const s = size;
  const c = s / 2;

  const inner = {
    // Abstract 3-pointed star (Mercedes-like)
    star3: `<path d="M ${c} ${c} L ${c} ${c - s*0.36} M ${c} ${c} L ${c + s*0.31} ${c + s*0.18} M ${c} ${c} L ${c - s*0.31} ${c + s*0.18}" stroke="${accent}" stroke-width="${s*0.06}" fill="none" stroke-linecap="round"/>`,
    // Quadrant ring (BMW-like)
    roundel: `<path d="M ${c} ${c - s*0.34} A ${s*0.34} ${s*0.34} 0 0 0 ${c} ${c + s*0.34} Z" fill="${accent}"/><path d="M ${c} ${c - s*0.34} A ${s*0.34} ${s*0.34} 0 0 1 ${c} ${c + s*0.34} Z" fill="${stroke}" opacity="0.85"/>`,
    // Four interlocking rings (Audi-like)
    rings: `<g fill="none" stroke="${stroke}" stroke-width="${s*0.055}">${[-1.5, -0.5, 0.5, 1.5].map(i => `<circle cx="${c + i*s*0.16}" cy="${c}" r="${s*0.13}"/>`).join('')}</g>`,
    // Crest shield
    shield: `<path d="M ${c} ${c - s*0.32} L ${c + s*0.28} ${c - s*0.2} L ${c + s*0.28} ${c + s*0.12} L ${c} ${c + s*0.34} L ${c - s*0.28} ${c + s*0.12} L ${c - s*0.28} ${c - s*0.2} Z" fill="${accent}"/>`,
    // Green oval (Land-Rover-ish)
    oval: `<ellipse cx="${c}" cy="${c}" rx="${s*0.3}" ry="${s*0.2}" fill="none" stroke="#4C7A3A" stroke-width="${s*0.06}"/><text x="${c}" y="${c + s*0.05}" text-anchor="middle" font-size="${s*0.22}" font-weight="700" fill="#4C7A3A" font-family="Georgia,serif">LR</text>`,
    // L oval (Lexus-ish)
    lexus: `<text x="${c}" y="${c + s*0.22}" text-anchor="middle" font-size="${s*0.55}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">L</text><ellipse cx="${c}" cy="${c}" rx="${s*0.34}" ry="${s*0.42}" fill="none" stroke="${stroke}" stroke-width="${s*0.05}"/>`,
    // Overlapping ovals (Toyota-ish)
    toyota: `<g fill="none" stroke="${stroke}" stroke-width="${s*0.05}"><ellipse cx="${c - s*0.08}" cy="${c}" rx="${s*0.14}" ry="${s*0.24}"/><ellipse cx="${c + s*0.08}" cy="${c}" rx="${s*0.14}" ry="${s*0.24}"/></g>`,
    // Grille (Jeep-ish)
    jeep: `<g fill="${stroke}">${[-1, 0, 1].map(i => `<rect x="${c + i*s*0.13 - s*0.045}" y="${c - s*0.2}" width="${s*0.09}" height="${s*0.4}" rx="${s*0.02}"/>`).join('')}</g>`,
    // VW circle
    vw: `<circle cx="${c}" cy="${c}" r="${s*0.3}" fill="none" stroke="${stroke}" stroke-width="${s*0.05}"/><text x="${c}" y="${c + s*0.16}" text-anchor="middle" font-size="${s*0.3}" font-weight="700" fill="${stroke}" font-family="Arial">V</text>`,
    // Iron mark (Volvo-ish)
    volvo: `<circle cx="${c}" cy="${c}" r="${s*0.24}" fill="none" stroke="${stroke}" stroke-width="${s*0.05}"/><line x1="${c - s*0.3}" y1="${c}" x2="${c + s*0.3}" y2="${c}" stroke="${stroke}" stroke-width="${s*0.05}"/>`,
    // Ford oval
    ford: `<ellipse cx="${c}" cy="${c}" rx="${s*0.32}" ry="${s*0.2}" fill="none" stroke="${stroke}" stroke-width="${s*0.05}"/><text x="${c}" y="${c + s*0.08}" text-anchor="middle" font-size="${s*0.24}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">F</text>`,
    // Honda H
    honda: `<rect x="${c - s*0.14}" y="${c - s*0.3}" width="${s*0.09}" height="${s*0.6}" rx="${s*0.03}" fill="${stroke}"/><rect x="${c + s*0.05}" y="${c - s*0.3}" width="${s*0.09}" height="${s*0.6}" rx="${s*0.03}" fill="${stroke}"/><line x1="${c - s*0.05}" y1="${c}" x2="${c + s*0.05}" y2="${c}" stroke="${stroke}" stroke-width="${s*0.05}"/>`,
    // Hyundai slanted H
    hyundai: `<text x="${c}" y="${c + s*0.22}" text-anchor="middle" font-size="${s*0.5}" font-weight="700" fill="${stroke}" font-family="Arial" font-style="italic">H</text><ellipse cx="${c}" cy="${c - s*0.06}" rx="${s*0.32}" ry="${s*0.2}" fill="none" stroke="${accent}" stroke-width="${s*0.04}"/>`,
    // Kia
    kia: `<text x="${c}" y="${c + s*0.18}" text-anchor="middle" font-size="${s*0.4}" font-weight="700" fill="${stroke}" font-family="Arial">KIA</text>`,
    // Tesla T
    tesla: `<path d="M ${c} ${c - s*0.32} L ${c + s*0.2} ${c + s*0.28} L ${c - s*0.2} ${c + s*0.28} Z" fill="${stroke}"/><line x1="${c}" y1="${c - s*0.32}" x2="${c}" y2="${c + s*0.28}" stroke="${accent}" stroke-width="${s*0.05}"/>`,
    // Trident (Maserati-ish)
    trident: `<g stroke="${stroke}" stroke-width="${s*0.055}" fill="none" stroke-linecap="round"><path d="M ${c} ${c + s*0.3} L ${c} ${c - s*0.3}"/><path d="M ${c} ${c} L ${c - s*0.24} ${c - s*0.18}"/><path d="M ${c} ${c} L ${c + s*0.24} ${c - s*0.18}"/></g>`,
    // Prancing-ish horse (generic)
    horse: `<text x="${c}" y="${c + s*0.08}" text-anchor="middle" font-size="${s*0.4}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">&#8455;</text>`,
    // Bull (Lamborghini-ish)
    bull: `<text x="${c}" y="${c + s*0.12}" text-anchor="middle" font-size="${s*0.42}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">&#9650;</text>`,
    // Winged B (Bentley-ish)
    bentley: `<text x="${c}" y="${c + s*0.18}" text-anchor="middle" font-size="${s*0.5}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">B</text><g stroke="${accent}" stroke-width="${s*0.04}" fill="none"><path d="M ${c - s*0.34} ${c} Q ${c - s*0.1} ${c - s*0.2} ${c} ${c - s*0.16}"/><path d="M ${c + s*0.34} ${c} Q ${c + s*0.1} ${c - s*0.2} ${c} ${c - s*0.16}"/></g>`,
    // Default circle
    default: `<circle cx="${c}" cy="${c}" r="${s*0.28}" fill="none" stroke="${accent}" stroke-width="${s*0.05}"/>`,
  };

  return `<svg viewBox="0 0 ${s} ${s}" width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
    <rect width="${s}" height="${s}" rx="${s*0.14}" fill="${bg}"/>
    ${inner[mark] || inner.default}
  </svg>`;
}

// --- Key shape silhouettes ---------------------------------------------------
// Four abstract modern keyfob silhouettes (Shape A/B/C/D), used in the
// key-shape selector on the product page and in the fitment finder.
function keyShapeSVG(shape, opts) {
  opts = opts || {};
  const w = opts.w || 96;
  const h = opts.h || 150;
  const color = opts.color === undefined ? '#2b2b2b' : opts.color;
  const dim = opts.color === 'grey' || opts.color === '#B9B9B9';
  const s = 1;

  // Body geometries are intentionally distinct so each shape reads as a
  // different key silhouette.
  const paths = {
    A: `<rect x="20" y="18" width="56" height="78" rx="16" fill="${color}"/><circle cx="48" cy="34" r="6" fill="none" stroke="${dim ? '#fff' : '#fff'}" stroke-width="3"/><rect x="34" y="96" width="28" height="16" rx="6" fill="${color}"/><rect x="42" y="112" width="12" height="26" rx="5" fill="${color}"/>`,
    B: `<rect x="24" y="16" width="48" height="70" rx="14" fill="${color}"/><circle cx="48" cy="34" r="5" fill="#fff"/><path d="M 20 74 L 48 66 L 76 74 L 48 86 Z" fill="${color}"/><rect x="42" y="88" width="12" height="30" rx="5" fill="${color}"/><rect x="30" y="86" width="8" height="20" rx="4" fill="${color}"/><rect x="58" y="86" width="8" height="20" rx="4" fill="${color}"/>`,
    C: `<rect x="18" y="20" width="60" height="82" rx="20" fill="${color}"/><rect x="26" y="28" width="44" height="34" rx="10" fill="${dim ? '#fff' : '#1a1a1a'}"/><rect x="40" y="90" width="16" height="24" rx="6" fill="${color}"/><rect x="44" y="114" width="8" height="22" rx="4" fill="${color}"/>`,
    D: `<rect x="30" y="14" width="36" height="64" rx="12" fill="${color}"/><circle cx="48" cy="32" r="5" fill="#fff"/><path d="M 24 70 Q 48 62 72 70 L 72 84 L 24 84 Z" fill="${color}"/><rect x="42" y="84" width="12" height="28" rx="5" fill="${color}"/><rect x="28" y="82" width="9" height="18" rx="4" fill="${color}"/><rect x="58" y="82" width="9" height="18" rx="4" fill="${color}"/>`,
  };
  const self = paths[shape] || paths.A;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Key Shape ${shape}">
    <rect x="2" y="2" width="${w-4}" height="${h-4}" rx="14" fill="none" stroke="${dim ? '#c9c9c9' : '#e4ded0'}" stroke-width="2"/>
    ${self}
  </svg>`;
}

module.exports = { brandEmblem, keyShapeSVG };
