// ============================================================================
// VELOCCI — On-the-fly product / hero SVG imagery
// Renders premium automotive product artwork (key cases, holders, medals) as
// self-contained SVG. Brand-distinguished via the emblem + accent colour so no
// two products look generic and there is never an empty grid.
// ============================================================================
'use strict';
const { brandEmblem, keyShapeSVG } = require('./emblems');

const GOLD = '#C8A15A';
const GOLD_SOFT = '#DCC58F';
const DARK = '#252525';
const BLACK = '#111111';
const IVORY = '#F3F0E8';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

// A luxury keyfob illustration, style-parameterised.
function keyfob(style, accent) {
  const w = 200, h = 200;
  const bezel = accent || GOLD;
  let bodyFill = '#17151d';
  if (style === 'leather') bodyFill = '#3a2f28';
  if (style === 'carbon') bodyFill = '#1c1c22';

  // carbon weave
  let weave = '';
  if (style === 'carbon') {
    for (let i = -200; i < 400; i += 16) {
      weave += `<line x1="${i}" y1="0" x2="${i+200}" y2="200" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1"/>`;
      weave += `<line x1="${i+100}" y1="0" x2="${i-100}" y2="200" stroke="#000" stroke-opacity="0.12" stroke-width="1"/>`;
    }
  }
  const leatherStitch = style === 'leather'
    ? `<g stroke="${GOLD_SOFT}" stroke-width="1.4" stroke-dasharray="4 5" fill="none">
        <rect x="42" y="40" width="116" height="112" rx="26"/>
      </g>` : '';

  return `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Velocci key case">
    <defs>
      <linearGradient id="gb" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${bezel}"/><stop offset="1" stop-color="#8a6a2f"/>
      </linearGradient>
      <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${bodyFill}"/><stop offset="1" stop-color="#000"/>
      </linearGradient>
    </defs>
    <rect width="200" height="200" fill="#EFEADF"/>
    <ellipse cx="100" cy="168" rx="64" ry="12" fill="#000" opacity="0.10"/>
    <g transform="rotate(-16 100 100)">
      <rect x="38" y="34" width="124" height="124" rx="30" fill="url(#body)"/>
      ${weave}
      <rect x="52" y="48" width="96" height="96" rx="22" fill="none" stroke="url(#gb)" stroke-width="6"/>
      ${leatherStitch}
      <circle cx="100" cy="102" r="30" fill="#0c0c0f"/>
      <circle cx="100" cy="102" r="24" fill="none" stroke="url(#gb)" stroke-width="3"/>
      <text x="100" y="113" text-anchor="middle" font-size="28" font-family="Georgia,serif" font-weight="bold" fill="${bezel}">V</text>
    </g>
    <text x="100" y="188" text-anchor="middle" font-size="9" letter-spacing="3" fill="#8a8577" font-family="Arial">VELOCCI</text>
  </svg>`;
}

function holderImg(accent) {
  const w = 200, h = 200;
  const bezel = accent || GOLD;
  return `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Velocci key holder">
    <defs><linearGradient id="hb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bezel}"/><stop offset="1" stop-color="#8a6a2f"/></linearGradient></defs>
    <rect width="200" height="200" fill="#EFEADF"/>
    <ellipse cx="100" cy="170" rx="60" ry="10" fill="#000" opacity="0.10"/>
    <g transform="rotate(-12 100 100)">
      <circle cx="100" cy="86" r="40" fill="none" stroke="url(#hb)" stroke-width="12"/>
      <rect x="70" y="96" width="60" height="66" rx="14" fill="#17171b"/>
      <rect x="82" y="112" width="36" height="30" rx="6" fill="none" stroke="url(#hb)" stroke-width="3"/>
      <circle cx="100" cy="128" r="4" fill="${bezel}"/>
      <text x="100" y="78" text-anchor="middle" font-size="26" font-family="Georgia,serif" font-weight="bold" fill="#fff">V</text>
    </g>
    <text x="100" y="188" text-anchor="middle" font-size="9" letter-spacing="3" fill="#8a8577" font-family="Arial">VELOCCI</text>
  </svg>`;
}

function medalImg(accent) {
  const bezel = accent || GOLD;
  return `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Velocci car medal">
    <defs><linearGradient id="mg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bezel}"/><stop offset="1" stop-color="#8a6a2f"/></linearGradient></defs>
    <rect width="200" height="200" fill="#EFEADF"/>
    <ellipse cx="100" cy="172" rx="60" ry="8" fill="#000" opacity="0.10"/>
    <g transform="rotate(-8 100 100)">
      <circle cx="100" cy="94" r="54" fill="#121212"/>
      <circle cx="100" cy="94" r="54" fill="none" stroke="url(#mg)" stroke-width="7"/>
      <circle cx="100" cy="94" r="40" fill="none" stroke="${bezel}" stroke-width="1.5" stroke-dasharray="3 4"/>
      <text x="100" y="110" text-anchor="middle" font-size="46" font-family="Georgia,serif" font-weight="bold" fill="${bezel}">V</text>
      <path d="M100 158 l6 14 -11-5 -11 5 z" fill="${bezel}"/>
    </g>
    <text x="100" y="188" text-anchor="middle" font-size="9" letter-spacing="3" fill="#8a8577" font-family="Arial">VELOCCI</text>
  </svg>`;
}

function heroImg(brand) {
  // full hero composition: large keyfob with brand emblem, on ivory
  const emblem = brandEmblem(brand.mark || 'star3', { size: 70, accent: brand.emblem || GOLD });
  return `<svg viewBox="0 0 600 520" width="600" height="520" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Velocci luxury key">
    <defs>
      <linearGradient id="hgrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C8A15A"/><stop offset="1" stop-color="#8a6a2f"/></linearGradient>
      <linearGradient id="hbody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1b21"/><stop offset="1" stop-color="#000"/></linearGradient>
    </defs>
    <rect width="600" height="520" fill="#F3F0E8"/>
    <ellipse cx="320" cy="470" rx="180" ry="26" fill="#000" opacity="0.10"/>
    <g transform="rotate(-14 320 250)">
      <rect x="200" y="120" width="240" height="240" rx="54" fill="url(#hbody)"/>
      <g opacity="0.5"><circle cx="240" cy="160" r="3" fill="#fff" opacity="0.4"/><circle cx="300" cy="140" r="2" fill="#fff" opacity="0.3"/><circle cx="380" cy="180" r="3" fill="#fff" opacity="0.4"/></g>
      <rect x="228" y="150" width="184" height="180" rx="40" fill="none" stroke="url(#hgrad)" stroke-width="9"/>
      <circle cx="320" cy="240" r="54" fill="#0c0c0e"/>
      <circle cx="320" cy="240" r="44" fill="none" stroke="url(#hgrad)" stroke-width="4"/>
      <text x="320" y="260" text-anchor="middle" font-size="52" font-family="Georgia,serif" font-weight="bold" fill="#C8A15A">V</text>
    </g>
    <g transform="translate(430 300)">${emblem}</g>
    <text x="320" y="500" text-anchor="middle" font-size="12" letter-spacing="6" fill="#8a8577" font-family="Arial">VELOCCI — AUTOMOTIVE LUXURY</text>
  </svg>`;
}

// detail crops for the gallery
function detailImg(kind) {
  const map = {
    a: `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="#E9E1D2"/><text x="100" y="96" text-anchor="middle" font-size="20" font-family="Georgia,serif" fill="#8a8577" letter-spacing="2">VELOCCI</text><rect x="30" y="110" width="140" height="3" fill="#C8A15A"/><text x="100" y="140" text-anchor="middle" font-size="11" letter-spacing="2" fill="#252525">CARBON EDITION</text></svg>`,
    b: `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="#E9E1D2"/><circle cx="100" cy="100" r="56" fill="none" stroke="#C8A15A" stroke-width="3"/><circle cx="100" cy="100" r="30" fill="#252525"/><text x="100" y="106" text-anchor="middle" font-size="24" fill="#C8A15A" font-family="Georgia,serif">V</text></svg>`,
  };
  return map[kind] || map.a;
}

function asset(reqUrl, query) {
  const type = query.type || 'product';
  const brand = query.brand;
  let accent = GOLD;
  if (brand) { try { const store = require('./store'); const db = store.load(); const b = db.brands.find(x => x.slug === brand); if (b) accent = b.emblem; } catch (e) {} }
  if (type === 'hero') return heroImg({ mark: query.mark || 'star3', emblem: accent });
  const style = query.style || 'carbon';
  const category = type;
  if (category === 'keyholder') return holderImg(accent);
  if (category === 'medal') return medalImg(accent);
  if (category === 'detail-a') return detailImg('a');
  if (category === 'detail-b') return detailImg('b');
  return keyfob(style, accent);
}

module.exports = { asset, keyfob, holderImg, medalImg, heroImg, detailImg, brandEmblem };
