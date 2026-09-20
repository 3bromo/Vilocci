/* VILOCCI storefront search: indexed, normalized relevance search. */
(function (root) {
  'use strict';
  function normalize(value) {
    return String(value == null ? '' : value).normalize('NFKC').toLowerCase()
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
      .replace(/[ًٌٍَُِّْـ]/g, '').replace(/[ؤئ]/g, 'ء')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }
  function compact(value) { return normalize(value).replace(/\s/g, ''); }
  function tokens(value) { return normalize(value).split(' ').filter(Boolean); }
  function distance(a, b) {
    if (a === b) return 0; if (!a || !b) return Math.max(a.length, b.length);
    if (Math.abs(a.length - b.length) > 2) return 99;
    let prev = Array.from({length:b.length + 1}, (_, i) => i);
    for (let i=1;i<=a.length;i++) { const row=[i]; for(let j=1;j<=b.length;j++) row[j]=Math.min(row[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1)); prev=row; }
    return prev[b.length];
  }
  function fields(product, brands) {
    const brand = (brands || []).find(b => b.slug === product.brandSlug);
    const vehicle = (product.models || []).map(m => typeof m === 'string' ? m : (m.en || m.ar || '')).join(' ');
    return [product.name_en, product.name_ar, product.brand, product.brandName, brand && brand.name_en, brand && brand.name_ar,
      product.brandSlug, vehicle, product.category, product.categoryName, ...(product.searchable || [])].filter(Boolean).join(' ');
  }
  function createIndex(products, brands) {
    return (products || []).map(product => { const text=fields(product, brands), norm=normalize(text); return { product, norm, compact:norm.replace(/ /g,''), words:tokens(text), name:normalize(product.name_en+' '+(product.name_ar||'')) }; });
  }
  function search(index, query, limit=7) {
    const q=normalize(query), qc=q.replace(/ /g,''), qt=q.split(' ').filter(Boolean); if (!q) return [];
    return index.map(item => { let score=0, matched=false;
      const name=item.name, ncompact=name.replace(/ /g,'');
      if (name===q) score+=1000; else if (name.includes(q)) score+=600;
      if (ncompact===qc) score+=900; else if (ncompact.includes(qc)) score+=500;
      qt.forEach(token => { if(item.words.includes(token)){score+=220;matched=true;} else if(item.norm.includes(token)){score+=90;matched=true;} else { const best=Math.min(...item.words.map(w=>distance(token,w))); const threshold=token.length>=6?2:token.length>=4?1:0; if(best<=threshold){score+=Math.max(35,100-best*25);matched=true;} } });
      if(item.norm.includes(q)) {score+=120;matched=true;} if(!matched && score<100) score=0;
      return { product:item.product, score };
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score || String(a.product.name_en).localeCompare(String(b.product.name_en))).slice(0,limit).map(x=>x.product);
  }
  root.VEL = root.VEL || {}; root.VEL.Search = { normalize, compact, tokens, createIndex, search };
  if (typeof module !== 'undefined') module.exports = root.VEL.Search;
})(typeof window !== 'undefined' ? window : globalThis);
