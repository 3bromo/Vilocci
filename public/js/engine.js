/* ==========================================================================
   VELOCCI — shared browser engine
   SVG renderers (brand emblems, key shapes) + formatting helpers used by both
   the storefront and the admin panel. Pure client-side.
   ========================================================================== */
window.VEL = window.VEL || {};

VEL.gold = '#C8A15A';

/* ---- Brand emblem generator (same marks as the Node lib) ---- */
VEL.brandEmblem = function (mark, opts) {
  opts = opts || {};
  var s = opts.size || 56;
  var stroke = opts.stroke || '#252525';
  var accent = opts.accent || VEL.gold;
  var bg = opts.bg || '#FFFFFF';
  var c = s / 2;
  var inner = {
    star3: `<path d="M ${c} ${c} L ${c} ${c - s*0.36} M ${c} ${c} L ${c + s*0.31} ${c + s*0.18} M ${c} ${c} L ${c - s*0.31} ${c + s*0.18}" stroke="${accent}" stroke-width="${s*0.06}" fill="none" stroke-linecap="round"/>`,
    roundel: `<path d="M ${c} ${c - s*0.34} A ${s*0.34} ${s*0.34} 0 0 0 ${c} ${c + s*0.34} Z" fill="${accent}"/><path d="M ${c} ${c - s*0.34} A ${s*0.34} ${s*0.34} 0 0 1 ${c} ${c + s*0.34} Z" fill="${stroke}" opacity="0.85"/>`,
    rings: `<g fill="none" stroke="${stroke}" stroke-width="${s*0.055}">${[-1.5,-0.5,0.5,1.5].map(function(i){return `<circle cx="${c + i*s*0.16}" cy="${c}" r="${s*0.13}"/>`;}).join('')}</g>`,
    shield: `<path d="M ${c} ${c - s*0.32} L ${c + s*0.28} ${c - s*0.2} L ${c + s*0.28} ${c + s*0.12} L ${c} ${c + s*0.34} L ${c - s*0.28} ${c + s*0.12} L ${c - s*0.28} ${c - s*0.2} Z" fill="${accent}"/>`,
    oval: `<ellipse cx="${c}" cy="${c}" rx="${s*0.3}" ry="${s*0.2}" fill="none" stroke="#4C7A3A" stroke-width="${s*0.06}"/><text x="${c}" y="${c + s*0.05}" text-anchor="middle" font-size="${s*0.22}" font-weight="700" fill="#4C7A3A" font-family="Georgia,serif">LR</text>`,
    lexus: `<text x="${c}" y="${c + s*0.22}" text-anchor="middle" font-size="${s*0.55}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">L</text><ellipse cx="${c}" cy="${c}" rx="${s*0.34}" ry="${s*0.42}" fill="none" stroke="${stroke}" stroke-width="${s*0.05}"/>`,
    toyota: `<g fill="none" stroke="${stroke}" stroke-width="${s*0.05}"><ellipse cx="${c - s*0.08}" cy="${c}" rx="${s*0.14}" ry="${s*0.24}"/><ellipse cx="${c + s*0.08}" cy="${c}" rx="${s*0.14}" ry="${s*0.24}"/></g>`,
    jeep: `<g fill="${stroke}">${[-1,0,1].map(function(i){return `<rect x="${c + i*s*0.13 - s*0.045}" y="${c - s*0.2}" width="${s*0.09}" height="${s*0.4}" rx="${s*0.02}"/>`;}).join('')}</g>`,
    vw: `<circle cx="${c}" cy="${c}" r="${s*0.3}" fill="none" stroke="${stroke}" stroke-width="${s*0.05}"/><text x="${c}" y="${c + s*0.16}" text-anchor="middle" font-size="${s*0.3}" font-weight="700" fill="${stroke}" font-family="Arial">V</text>`,
    volvo: `<circle cx="${c}" cy="${c}" r="${s*0.24}" fill="none" stroke="${stroke}" stroke-width="${s*0.05}"/><line x1="${c - s*0.3}" y1="${c}" x2="${c + s*0.3}" y2="${c}" stroke="${stroke}" stroke-width="${s*0.05}"/>`,
    ford: `<ellipse cx="${c}" cy="${c}" rx="${s*0.32}" ry="${s*0.2}" fill="none" stroke="${stroke}" stroke-width="${s*0.05}"/><text x="${c}" y="${c + s*0.08}" text-anchor="middle" font-size="${s*0.24}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">F</text>`,
    honda: `<rect x="${c - s*0.14}" y="${c - s*0.3}" width="${s*0.09}" height="${s*0.6}" rx="${s*0.03}" fill="${stroke}"/><rect x="${c + s*0.05}" y="${c - s*0.3}" width="${s*0.09}" height="${s*0.6}" rx="${s*0.03}" fill="${stroke}"/><line x1="${c - s*0.05}" y1="${c}" x2="${c + s*0.05}" y2="${c}" stroke="${stroke}" stroke-width="${s*0.05}"/>`,
    hyundai: `<text x="${c}" y="${c + s*0.22}" text-anchor="middle" font-size="${s*0.5}" font-weight="700" fill="${stroke}" font-family="Arial" font-style="italic">H</text><ellipse cx="${c}" cy="${c - s*0.06}" rx="${s*0.32}" ry="${s*0.2}" fill="none" stroke="${accent}" stroke-width="${s*0.04}"/>`,
    kia: `<text x="${c}" y="${c + s*0.18}" text-anchor="middle" font-size="${s*0.4}" font-weight="700" fill="${stroke}" font-family="Arial">KIA</text>`,
    tesla: `<path d="M ${c} ${c - s*0.32} L ${c + s*0.2} ${c + s*0.28} L ${c - s*0.2} ${c + s*0.28} Z" fill="${stroke}"/><line x1="${c}" y1="${c - s*0.32}" x2="${c}" y2="${c + s*0.28}" stroke="${accent}" stroke-width="${s*0.05}"/>`,
    trident: `<g stroke="${stroke}" stroke-width="${s*0.055}" fill="none" stroke-linecap="round"><path d="M ${c} ${c + s*0.3} L ${c} ${c - s*0.3}"/><path d="M ${c} ${c} L ${c - s*0.24} ${c - s*0.18}"/><path d="M ${c} ${c} L ${c + s*0.24} ${c - s*0.18}"/></g>`,
    horse: `<text x="${c}" y="${c + s*0.08}" text-anchor="middle" font-size="${s*0.4}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">&#8455;</text>`,
    bull: `<text x="${c}" y="${c + s*0.12}" text-anchor="middle" font-size="${s*0.42}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">&#9650;</text>`,
    bentley: `<text x="${c}" y="${c + s*0.18}" text-anchor="middle" font-size="${s*0.5}" font-weight="700" fill="${stroke}" font-family="Georgia,serif">B</text><g stroke="${accent}" stroke-width="${s*0.04}" fill="none"><path d="M ${c - s*0.34} ${c} Q ${c - s*0.1} ${c - s*0.2} ${c} ${c - s*0.16}"/><path d="M ${c + s*0.34} ${c} Q ${c + s*0.1} ${c - s*0.2} ${c} ${c - s*0.16}"/></g>`,
    default: `<circle cx="${c}" cy="${c}" r="${s*0.28}" fill="none" stroke="${accent}" stroke-width="${s*0.05}"/>`
  };
  return `<svg viewBox="0 0 ${s} ${s}" width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true"><rect width="${s}" height="${s}" rx="${s*0.14}" fill="${bg}"/>${inner[mark]||inner.default}</svg>`;
};

/* ---- Key shape silhouettes (realistic keyfobs with buttons) ---- */
VEL.keyShapeSVG = function (shape, opts) {
  opts = opts || {};
  var w = opts.w || 96, h = opts.h || 150;
  var dim = (opts.color === 'grey' || opts.color === '#B9B9B9');
  var color = opts.color === undefined ? '#282624' : opts.color;
  var body = dim ? '#4a4640' : color;
  var btn = dim ? '#6a6255' : '#1a1816';
  var btnLine = dim ? '#8a8272' : '#3a3630';
  var gold = dim ? '#a9a08c' : '#D9A84E';
  // button cluster
  var buttons = function (x, y, rows) {
    var out = '';
    var positions = {
      1: [[0,0]],
      2: [[0,-12],[0,12]],
      3: [[0,-13],[0,0],[0,13]],
      4: [[-13,-13],[13,-13],[-13,13],[13,13]]
    }[rows] || [];
    positions.forEach(function (p) {
      out += `<rect x="${x + p[0] - 8}" y="${y + p[1] - 9}" width="16" height="18" rx="3" fill="${btn}" stroke="${btnLine}" stroke-width="0.8"/>`;
    });
    return out;
  };
  var paths = {
    A: `<rect x="22" y="20" width="52" height="76" rx="14" fill="${body}"/><rect x="24" y="22" width="48" height="72" rx="12" fill="none" stroke="${gold}" stroke-width="1.6" opacity="0.5"/>${buttons(48,52,3)}<rect x="36" y="98" width="24" height="14" rx="6" fill="${body}"/><rect x="43" y="112" width="10" height="26" rx="4" fill="${body}"/>`,
    B: `<rect x="26" y="16" width="44" height="66" rx="12" fill="${body}"/><rect x="28" y="18" width="40" height="62" rx="10" fill="none" stroke="${gold}" stroke-width="1.6" opacity="0.5"/>${buttons(48,40,2)}<path d="M 22 74 L 74 74 L 63 88 L 33 88 Z" fill="${body}"/><rect x="43" y="88" width="10" height="30" rx="4" fill="${body}"/><rect x="30" y="86" width="8" height="20" rx="4" fill="${body}"/><rect x="58" y="86" width="8" height="20" rx="4" fill="${body}"/>`,
    C: `<rect x="20" y="22" width="56" height="80" rx="20" fill="${body}"/><rect x="22" y="24" width="52" height="76" rx="18" fill="none" stroke="${gold}" stroke-width="1.6" opacity="0.5"/><rect x="30" y="32" width="36" height="36" rx="8" fill="${dim?'#e6e2da':'#141210'}"/>${buttons(48,50,2)}<rect x="40" y="88" width="16" height="26" rx="6" fill="${body}"/><rect x="44" y="114" width="8" height="24" rx="4" fill="${body}"/>`,
    D: `<rect x="30" y="16" width="36" height="62" rx="10" fill="${body}"/><circle cx="48" cy="32" r="6" fill="none" stroke="${btnLine}" stroke-width="1.4"/><path d="M 24 72 Q 48 64 72 72 L 72 86 L 24 86 Z" fill="${body}"/><rect x="43" y="86" width="10" height="28" rx="4" fill="${body}"/><rect x="30" y="84" width="8" height="20" rx="4" fill="${body}"/><rect x="58" y="84" width="8" height="20" rx="4" fill="${body}"/>`
  };
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Key Shape ${shape}"><rect x="3" y="3" width="${w-6}" height="${h-6}" rx="14" fill="#faf7ef"/>${paths[shape]||paths.A}</svg>`;
};

/* ---- Logo mark: an elegant thin "V" ---- */
VEL.logoMark = function (size, color) {
  size = size || 30;
  var stroke = color || '#B8862E';
  return `<svg viewBox="0 0 44 28" width="${size}" height="${Math.round(size*0.64)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="VELOCCI" fill="none" stroke="${stroke}" stroke-linecap="round">
    <path d="M7 4 C 15 8, 20 11, 37 6" stroke-width="3.4"/>
    <path d="M6 6 C 13 9, 18 12, 22 25 C 26 12, 33 8, 38 6" stroke-width="3.4"/>
  </svg>`;
};

/* ---- Real car brand logo assets ----
   Official automotive logos stored as individual files under /img/logos/.
   Slug -> file. Some brands ship as PNG (photo-quality colour crests), the
   rest are clean vector SVGs. This resolver is the single source of truth. */
VEL.brandLogoUrl = function (slug) {
  var EXT = {
    'mercedes-benz':'svg','bmw':'svg','audi':'svg','porsche':'png',
    'land-rover':'svg','range-rover':'svg','lexus':'svg','toyota':'svg',
    'jeep':'svg','volkswagen':'svg','volvo':'svg','ford':'svg','honda':'svg',
    'hyundai':'svg','kia':'svg','tesla':'svg','maserati':'svg','ferrari':'png',
    'lamborghini':'svg','bentley':'svg',
    'mg':'svg','peugeot':'svg','byd':'svg','gac':'svg','jetour':'svg',
    'citroen':'svg','haval':'svg','cupra':'svg','skoda':'svg'
  };
  var ext = EXT[slug] || 'svg';
  return '/img/logos/' + slug + '.' + ext;
};
/* Reusable SVG filters for a "champagne-gold duotone" treatment of the real
   logos (dark-teal shadow -> bright champagne highlight). This preserves each
   logo's internal luminance detail (e.g. BMW's two-tone quadrants) without
   redrawing or distorting the mark. */
VEL.goldFilterDef = function (id) {
  return '<filter id="' + id + '" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">' +
    '<feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0"/>' +
    '<feComponentTransfer>' +
      '<feFuncR type="linear" slope="0.55" intercept="0.46"/>' +
      '<feFuncG type="linear" slope="0.54" intercept="0.34"/>' +
      '<feFuncB type="linear" slope="0.54" intercept="0.05"/>' +
    '</feComponentTransfer>' +
  '</filter>';
};

// Render a real logo as a duotone gold inline-SVG <image> for gold-on-green
// tile contexts (preserves aspect ratio, no distortion).
VEL.brandLogo = function (slug, opts) {
  opts = opts || {};
  var w = opts.w || 120, h = opts.h || 120;
  var cls = opts.cls ? ' ' + opts.cls : '';
  var gold = opts.gold !== false;
  var fid = 'gf_' + slug.replace(/[^a-z0-9]/gi, '') + '_' + Math.round(w) + 'x' + Math.round(h);
  var defs = gold ? '<defs>' + VEL.goldFilterDef(fid) + '</defs>' : '';
  var filt = gold ? ' filter="url(#' + fid + ')"' : '';
  var url = VEL.brandLogoUrl(slug);
  return '<svg class="brand-logo' + cls + '" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
    '" role="img" aria-label="' + VEL.esc(slug) + '">' + defs +
    '<image href="' + url + '" x="0" y="0" width="' + w + '" height="' + h + '" preserveAspectRatio="xMidYMid meet"' + filt + '/>' +
  '</svg>';
};

// Render a real logo as a plain <img> (natural colours) for light contexts.
VEL.brandLogoImg = function (slug, opts) {
  opts = opts || {};
  var h = opts.h || 64;
  var cls = opts.cls ? ' ' + opts.cls : '';
  return '<img class="brand-logo' + cls + '" src="' + VEL.brandLogoUrl(slug) +
    '" alt="' + VEL.esc(slug) + '" loading="lazy" style="height:' + h + 'px;width:auto;object-fit:contain;">';
};

/* ---- Helpers ---- */
VEL.money = function (n) {
  var v = Math.round(n || 0);
  return 'EGP ' + v.toLocaleString('en-US');
};
VEL.esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[m];
  });
};
VEL.plural = function (n, one, many) { return n === 1 ? one : many; };
