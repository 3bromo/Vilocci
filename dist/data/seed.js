// ============================================================================
// SPINTO — Seed data
// Builds a fully-populated store: brands, models/years/shapes, ~80 products,
// bundles, hero slides, homepage sections, settings and translations.
// Run with:  npm run seed   (or)   node data/seed.js
// ============================================================================
'use strict';
const store = require('../lib/store');
const { brandEmblem } = require('../lib/emblems');

const GOLD = '#C8A15A';

// ---------------------------------------------------------------------------
// BRANDS — stylized emblems + models + years + key shapes
// tier: luxury | mainstream | ev   (drives pricing & style)
// ---------------------------------------------------------------------------
const brandDefs = [
  { slug:'mercedes-benz', en:'Mercedes-Benz', ar:'مرسيدس', mark:'star3', tier:'luxury', em:'#C8A15A',
    models:[ {en:'C-Class', ar:'سي كلاس', years:[2015,2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'E-Class', ar:'إي كلاس', years:[2016,2017,2018,2019,2020,2021,2022,2023], shapes:['A','B','C']},
             {en:'S-Class', ar:'إس كلاس', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']} ]},
  { slug:'bmw', en:'BMW', ar:'بي إم دبليو', mark:'roundel', tier:'luxury', em:'#2E7BD6',
    models:[ {en:'Series 3', ar:'الفئة الثالثة', years:[2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Series 5', ar:'الفئة الخامسة', years:[2017,2018,2019,2020,2021,2022,2023], shapes:['A','C']},
             {en:'X5', ar:'إكس 5', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']} ]},
  { slug:'audi', en:'Audi', ar:'أودي', mark:'rings', tier:'luxury', em:'#B50A0A',
    models:[ {en:'A3', ar:'إيه 3', years:[2016,2017,2018,2019,2020,2021,2022,2023], shapes:['A','B']},
             {en:'A4', ar:'إيه 4', years:[2016,2017,2018,2019,2020,2021,2022,2023], shapes:['A','C']},
             {en:'Q5', ar:'كيو 5', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']} ]},
  { slug:'porsche', en:'Porsche', ar:'بورشه', mark:'shield', tier:'luxury', em:'#D4AF37',
    models:[ {en:'911', ar:'911', years:[2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','C']},
             {en:'Cayenne', ar:'كايين', years:[2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Macan', ar:'ماكان', years:[2016,2017,2018,2019,2020,2021,2022,2023], shapes:['B','C']} ]},
  { slug:'land-rover', en:'Land Rover', ar:'لاند روفر', mark:'oval', tier:'luxury', em:'#4C7A3A',
    models:[ {en:'Defender', ar:'ديفندر', years:[2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Discovery', ar:'ديسكفري', years:[2017,2018,2019,2020,2021,2022], shapes:['B','C']} ]},
  { slug:'range-rover', en:'Range Rover', ar:'رينج روفر', mark:'oval', tier:'luxury', em:'#2E7D52',
    models:[ {en:'Sport', ar:'سبورت', years:[2018,2019,2020,2021,2022,2023], shapes:['A','B']},
             {en:'Vogue', ar:'فوج', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']},
             {en:'Evoque', ar:'إفوك', years:[2019,2020,2021,2022,2023], shapes:['A','C']} ]},
  { slug:'lexus', en:'Lexus', ar:'لكزس', mark:'lexus', tier:'luxury', em:'#1D1D1D',
    models:[ {en:'ES', ar:'إي إس', years:[2018,2019,2020,2021,2022,2023], shapes:['A','B']},
             {en:'RX', ar:'آر إكس', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']},
             {en:'NX', ar:'إن إكس', years:[2019,2020,2021,2022,2023], shapes:['A','C']} ]},
  { slug:'toyota', en:'Toyota', ar:'تويوتا', mark:'toyota', tier:'mainstream', em:'#B50A0A',
    models:[ {en:'Corolla', ar:'كورولا', years:[2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Camry', ar:'كامري', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['A','C']},
             {en:'Land Cruiser', ar:'لاند كروزر', years:[2017,2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']} ]},
  { slug:'jeep', en:'Jeep', ar:'جيب', mark:'jeep', tier:'mainstream', em:'#1D1D1D',
    models:[ {en:'Wrangler', ar:'رانجلر', years:[2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Grand Cherokee', ar:'جراند شيروكي', years:[2016,2017,2018,2019,2020,2021,2022,2023], shapes:['B','C']},
             {en:'Compass', ar:'كومباس', years:[2018,2019,2020,2021,2022,2023], shapes:['A','C']} ]},
  { slug:'volkswagen', en:'Volkswagen', ar:'فولكس فاجن', mark:'vw', tier:'mainstream', em:'#1D4D8C',
    models:[ {en:'Golf', ar:'جولف', years:[2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Passat', ar:'باسات', years:[2016,2017,2018,2019,2020,2021,2022], shapes:['A','C']},
             {en:'Tiguan', ar:'تيجوان', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']} ]},
  { slug:'volvo', en:'Volvo', ar:'فولفو', mark:'volvo', tier:'mainstream', em:'#1D1D3D',
    models:[ {en:'XC60', ar:'إكس سي 60', years:[2018,2019,2020,2021,2022,2023], shapes:['A','B']},
             {en:'XC90', ar:'إكس سي 90', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']},
             {en:'S60', ar:'إس 60', years:[2019,2020,2021,2022,2023], shapes:['A','C']} ]},
  { slug:'ford', en:'Ford', ar:'فورد', mark:'ford', tier:'mainstream', em:'#1D4D8C',
    models:[ {en:'Focus', ar:'فوكس', years:[2016,2017,2018,2019,2020,2021,2022,2023], shapes:['A','B']},
             {en:'Explorer', ar:'إكسبلورر', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']},
             {en:'F-150', ar:'إف 150', years:[2016,2017,2018,2019,2020,2021,2022,2023], shapes:['A','C']} ]},
  { slug:'honda', en:'Honda', ar:'هوندا', mark:'honda', tier:'mainstream', em:'#B50A0A',
    models:[ {en:'Civic', ar:'سيفيك', years:[2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Accord', ar:'أكورد', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['A','C']},
             {en:'CR-V', ar:'سي آر في', years:[2017,2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']} ]},
  { slug:'hyundai', en:'Hyundai', ar:'هيونداي', mark:'hyundai', tier:'mainstream', em:'#1D4D8C',
    models:[ {en:'Elantra', ar:'إلنترا', years:[2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Tucson', ar:'توسان', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['B','C']},
             {en:'Santa Fe', ar:'سانتا في', years:[2016,2017,2018,2019,2020,2021,2022], shapes:['A','C']} ]},
  { slug:'kia', en:'Kia', ar:'كيا', mark:'kia', tier:'mainstream', em:'#B50A0A',
    models:[ {en:'Sportage', ar:'سبورتاج', years:[2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'K5', ar:'كاي 5', years:[2020,2021,2022,2023,2024], shapes:['A','C']},
             {en:'Sorento', ar:'سورينتو', years:[2016,2017,2018,2019,2020,2021,2022,2023], shapes:['B','C']} ]},
  { slug:'tesla', en:'Tesla', ar:'تسلا', mark:'tesla', tier:'ev', em:'#B50A0A',
    models:[ {en:'Model 3', ar:'موديل 3', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Model Y', ar:'موديل Y', years:[2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Model S', ar:'موديل S', years:[2016,2017,2018,2019,2020,2021,2022,2023], shapes:['C']} ]},
  { slug:'maserati', en:'Maserati', ar:'مازيراتي', mark:'trident', tier:'luxury', em:'#1D1D1D',
    models:[ {en:'Ghibli', ar:'جيبيلي', years:[2018,2019,2020,2021,2022,2023], shapes:['A','B']},
             {en:'Quattroporte', ar:'كواتروبورتي', years:[2018,2019,2020,2021,2022,2023], shapes:['B','C']},
             {en:'Levante', ar:'ليفانتي', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['A','C']} ]},
  { slug:'ferrari', en:'Ferrari', ar:'فيراري', mark:'horse', tier:'luxury', em:'#B50A0A',
    models:[ {en:'F8', ar:'إف 8', years:[2019,2020,2021,2022,2023], shapes:['A','B']},
             {en:'Roma', ar:'روما', years:[2020,2021,2022,2023,2024], shapes:['A','C']},
             {en:'SF90', ar:'إس إف 90', years:[2020,2021,2022,2023,2024], shapes:['B','C']} ]},
  { slug:'lamborghini', en:'Lamborghini', ar:'لامبورجيني', mark:'bull', tier:'luxury', em:'#C8A15A',
    models:[ {en:'Huracan', ar:'هوراكان', years:[2016,2017,2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Urus', ar:'أوروس', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['A','C']} ]},
  { slug:'bentley', en:'Bentley', ar:'بنتلي', mark:'bentley', tier:'luxury', em:'#1D1D1D',
    models:[ {en:'Continental', ar:'كونتينينتال', years:[2018,2019,2020,2021,2022,2023,2024], shapes:['A','B']},
             {en:'Flying Spur', ar:'فلاينج سبير', years:[2019,2020,2021,2022,2023,2024], shapes:['B','C']} ]},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Output image URLs rendered by the on-the-fly SVG asset generator.
const asset = (type, slug, style) =>
  `/img/asset.svg?type=${type}${slug ? `&brand=${slug}` : ''}${style ? `&style=${style}` : ''}`;
const pimg = (category, slug, style) => [
  asset(category, slug, style),
  asset('detail-a', slug),
  asset('detail-b', slug),
];

// choose stock availability for a product's shapes; most brands have A/B/C
// available and D out-of-stock (like the reference). Some vary.
function shapePlan(index) {
  if (index % 5 === 0) return { available: ['A','B'], out: ['C','D'] };
  if (index % 4 === 0) return { available: ['A','C'], out: ['B','D'] };
  return { available: ['A','B','C'], out: ['D'] };
}

function buildProducts() {
  const products = [];
  const pricesFor = (tier) => {
    if (tier === 'luxury') return { case: 1450, case2: 1350, holder: 850, medal: 550 };
    if (tier === 'ev')     return { case: 1500, case2: 1400, holder: 900, medal: 600 };
    return { case: 1150, case2: 1150, holder: 800, medal: 500 };
  };

  brandDefs.forEach((b, bi) => {
    const p = pricesFor(b.tier);
    const plan = shapePlan(bi);
    const allShapes = ['A','B','C','D'];
    const shapeAvailability = allShapes.map(sh => ({
      shape: sh,
      available: plan.available.includes(sh),
    }));

    const brandNameEN = b.en;
    const brandNameAR = b.ar;
    const models = b.models.map(m => m.en);

    // --- Key Case 1: Carbon Edition ----------------------------------------
    products.push({
      id:'p_'+slugify(b.slug)+'_case_carbon', slug:slugify(b.slug)+'-carbon-key-case',
      category:'keycase', brandSlug:b.slug,
      name_en:`Spinto Carbon Key Case — ${brandNameEN}`,
      name_ar:`جراب مفاتيح كربون فاخر — ${brandNameAR}`,
      short_en:'Matte carbon fibre shell with a champagne-gold alloy bezel.',
      short_ar:'هيكل ألياف كربون مطفي مع إطار سبيكة ذهبي شامبين.',
      description_en:`The Spinto Carbon Key Case for the ${brandNameEN} is precision-machined from aerospace-grade carbon fibre. A soft-touch matte shell and a champagne-gold alloy bezel protect your key from scratches while keeping full button access. Engineered to match the character of your car.`,
      description_ar:`جراب مفاتيح سبينتو الكربوني لسيارة ${brandNameAR} مصنوع بدقة من ألياف كربون عالية الجودة. هيكل خارجي ناعم الملمس مع إطار سبيكة ذهبي شامبين يحمي مفتاحك من الخدوش مع بقاء الأزرار سهلة الوصول. مصمم ليتناسب مع شخصية سيارتك.`,
      material_en:'Carbon fibre, alloy bezel', material_ar:'ألياف كربون، إطار سبيكة',
      price:p.case, oldPrice:p.case+150, discount:Math.round(150/(p.case+150)*100),
      images:pimg('keycase', b.slug, 'carbon'),
      keyShapes: shapeAvailability.map(x=>Object.assign({},x)),
      models, years:[2021,2022,2023,2024], inventory: bi%3===0?2:8, outOfStock:false,
      featured: bi%2===0, bestSeller: bi%2===0, newArrival: bi%3===0, limitedEdition: bi%5===0, preorder:false,
      warranty_en:'2-year warranty', warranty_ar:'ضمان سنتان', badge_en:'Carbon Edition', badge_ar:'إصدار كربون',
      active:true, order: bi,
    });

    // --- Key Case 2: Premium Leather ---------------------------------------
    products.push({
      id:'p_'+slugify(b.slug)+'_case_leather', slug:slugify(b.slug)+'-premium-leather-key-case',
      category:'keycase', brandSlug:b.slug,
      name_en:`Spinto Premium Leather Key Case — ${brandNameEN}`,
      name_ar:`جراب مفاتيح جلد فاخر — ${brandNameAR}`,
      short_en:'Hand-stitched full-grain leather with a supple premium hand feel.',
      short_ar:'جلد كامل الحبيبات مخيط يدويًا بملمس فاخر وناعم.',
      description_en:`Wrapped in full-grain Italian-style leather and hand-stitched by master craftsmen, the Spinto Premium Leather Key Case for the ${brandNameEN} offers timeless elegance and everyday protection with a luxurious, supple feel.`,
      description_ar:`جراب مفاتيح سبينتو الجلدي الفاخر لسيارة ${brandNameAR} مغلف بجلد كامل الحبيبات ومخيط يدويًا على يد حرفيين مهرة، يمنحك أناقة خالدة وحماية يومية بملمس فاخر وناعم.`,
      material_en:'Full-grain leather', material_ar:'جلد كامل الحبيبات',
      price:p.case2, oldPrice:p.case2+120, discount:Math.round(120/(p.case2+120)*100),
      images:pimg('keycase', b.slug, 'leather'),
      keyShapes: shapeAvailability.map(x=>Object.assign({},x)),
      models, years:[2021,2022,2023,2024], inventory: 12, outOfStock:false,
      featured: bi%3===0, bestSeller: bi%3===1, newArrival: bi%2===0, limitedEdition:false, preorder:false,
      warranty_en:'1-year warranty', warranty_ar:'ضمان سنة', badge_en:'Premium Leather', badge_ar:'جلد فاخر',
      active:true, order: bi+0.5,
    });

    // --- Key Holder: Signature Metal ---------------------------------------
    products.push({
      id:'p_'+slugify(b.slug)+'_holder', slug:slugify(b.slug)+'-signature-metal-key-holder',
      category:'keyholder', brandSlug:b.slug,
      name_en:`Spinto Signature Metal Key Holder — ${brandNameEN}`,
      name_ar:`حامل مفاتيح معدني مميز — ${brandNameAR}`,
      short_en:'Machined champagne-gold alloy with a secure silicone core.',
      short_ar:'سبيكة ذهبية مصقولة مع قلب سيليكون آمن.',
      description_en:`A sculptural signature holder machined from champagne-gold alloy for the ${brandNameEN}. The secure silicone core keeps your key snug while the precision clasp lets you carry it on your belt or in your bag.`,
      description_ar:`حامل مميز مصنوع من سبيكة ذهبية شامبين مصقولة لسيارة ${brandNameAR}. يضم القلب السيليكوني الآمن مفتاحك بإحكام بينما يسمح لك المشبك الدقيق بحمله على حزامك أو في حقيبتك.`,
      material_en:'Alloy, silicone', material_ar:'سبيكة، سيليكون',
      price:p.holder, oldPrice:p.holder+80, discount:Math.round(80/(p.holder+80)*100),
      images:pimg('keyholder', b.slug),
      keyShapes: shapeAvailability.map(x=>Object.assign({},x)),
      models, years:[2021,2022,2023,2024], inventory: 20, outOfStock:false,
      featured: false, bestSeller: bi%2===1, newArrival: bi%4===0, limitedEdition: false, preorder:false,
      warranty_en:'1-year warranty', warranty_ar:'ضمان سنة', badge_en:'Signature', badge_ar:'مميز',
      active:true, order: bi+0.75,
    });

    // --- Medal: Black & Gold ------------------------------------------------
    products.push({
      id:'p_'+slugify(b.slug)+'_medal', slug:slugify(b.slug)+'-medal-black-gold',
      category:'medal', brandSlug:b.slug,
      name_en:`${brandNameEN} Medal — Black & Gold`,
      name_ar:`ميدالية ${brandNameAR} — أسود وذهبي`,
      short_en:'A refined collector emblem finished in black and champagne gold.',
      short_ar:'شارة راقية للجمع بتشطيب أسود وذهبي شامبين.',
      description_en:`The Spinto ${brandNameEN} collector Medal is finished in deep black and champagne gold. Machined as a refined emblem, it is the perfect finishing touch for enthusiasts who appreciate detail.`,
      description_ar:`ميدالية سبينتو لسيارة ${brandNameAR} بتشطيب أسود عميق وذهبي شامبين. مصممة كشارة راقية، وهي اللمسة النهائية المثالية لعشاق التفاصيل الدقيقة.`,
      material_en:'Alloy, black & gold', material_ar:'سبيكة، أسود وذهبي',
      price:p.medal, oldPrice:p.medal+60, discount:Math.round(60/(p.medal+60)*100),
      images:pimg('medal', b.slug),
      keyShapes: shapeAvailability.map(x=>Object.assign({},x)),
      models, years:[2021,2022,2023,2024], inventory: 30, outOfStock:false,
      featured: false, bestSeller: bi%2===0, newArrival:false, limitedEdition: bi%4===0, preorder:false,
      warranty_en:'1-year warranty', warranty_ar:'ضمان سنة', badge_en:'Black & Gold', badge_ar:'أسود وذهبي',
      active:true, order: bi+0.25,
    });
  });

  // A special pre-order product to demonstrate the pre-order flow.
  const tesla = brandDefs.find(b=>b.slug==='tesla');
  products.push({
    id:'p_tesla_case_premium', slug:'tesla-premium-key-case',
    category:'keycase', brandSlug:'tesla',
    name_en:'Spinto Premium Key Case — Tesla (Pre-Order)',
    name_ar:'جراب مفاتيح فاخر — تسلا (طلب مسبق)',
    short_en:'A limited pre-order run for the Tesla Model 3 / Y card key.',
    short_ar:'إصدار مسبق محدود لبطاقة مفتاح موديل 3 / Y من تسلا.',
    description_en:`A limited pre-order run of the Spinto Premium Key Case for Tesla Model 3 / Y card keys. Reserve yours now; no payment is taken until we confirm.`,
    description_ar:`إصدار مسبق محدود من جراب سبينتو الفاخر لبطاقة مفتاح تسلا موديل 3 / Y. احجز الآن، لا يتم السداد حتى نؤكد الطلب.`,
    material_en:'Saffiano leather', material_ar:'جلد سافيانو',
    price:1600, oldPrice:null, discount:0,
    images:pimg('keycase', 'tesla', 'leather'),
    keyShapes:[{shape:'A',available:true},{shape:'B',available:true},{shape:'C',available:false},{shape:'D',available:false}],
    models:['Model 3','Model Y'], years:[2022,2023,2024], inventory:0, outOfStock:false,
    featured:false, bestSeller:false, newArrival:false, limitedEdition:true, preorder:true,
    warranty_en:'1-year warranty', warranty_ar:'ضمان سنة', badge_en:'Pre-Order', badge_ar:'طلب مسبق',
    active:true, order: 100,
  });

  return products;
}

// ---------------------------------------------------------------------------
// BUNDLES — one per brand, computed normal total & savings
// ---------------------------------------------------------------------------
function buildBundles() {
  return brandDefs.map(b => {
    const caseP = products.find(p=>p.brandSlug===b.slug && p.category==='keycase');
    const holderP = products.find(p=>p.brandSlug===b.slug && p.category==='keyholder');
    const medalP = products.find(p=>p.brandSlug===b.slug && p.category==='medal');
    const normal = caseP.price + holderP.price + medalP.price;
    const bundle = Math.round(normal * 0.878); // about 12% saving
    const now = new Date();
    const end = new Date(); end.setMonth(end.getMonth()+3);
    return {
      id:'b_'+b.slug, brandSlug:b.slug,
      keyCaseProductId: caseP.id, keyHolderProductId: holderP.id, medalProductId: medalP.id,
      normalTotal: normal, bundlePrice: bundle,
      discount: normal - bundle, discountPercent: Math.round((normal-bundle)/normal*100),
      title_en:`Complete Your ${b.en} Set`, title_ar:`أكمل طقم ${b.ar}`,
      sub_en:`These products are designed to fit your ${b.en} key perfectly.`,
      sub_ar:`هذه المنتجات مصممة لتناسب مفتاح ${b.ar} بشكل مثالي.`,
      startDate: now.toISOString(), endDate: end.toISOString(), active: true,
    };
  });
}

// ---------------------------------------------------------------------------
// HERO SLIDES
// ---------------------------------------------------------------------------
function buildHeroSlides() {
  return [
    { id:'h1', order:1, active:true, image:'/img/hero.jpg',
      headline_en:'LUXURY FOR\nTHE KEY YOU\nCARRY EVERY DAY',
      headline_ar:'فخامة في كل تفصيلة\nلمفتاح سيارتك\nكل يوم',
      sub_en:'Premium automotive accessories crafted to match the character of your car.',
      sub_ar:'إكسسوارات سيارات فاخرة مصممة لتتناسب مع شخصية سيارتك.',
      btn1_en:'SHOP COLLECTION', btn1_ar:'تسوق المفاتيح', btn1_link:'/category/keycases',
      btn2_en:'SHOP BY CAR BRAND', btn2_ar:'تسوق حسب ماركة السيارة', btn2_link:'/brands',
      accent_en:'Carbon Edition', accent_ar:'إصدار كربون' },
    { id:'h2', order:2, active:true, image:'/img/hero2.jpg',
      headline_en:'FIND YOUR KEY\nIN ONE\nSIMPLE STEP',
      headline_ar:'اعثر على مفتاحك\nفي خطوة\nواحدة بسيطة',
      sub_en:'Use our Fitment Finder to match your exact model and key shape.',
      sub_ar:'استخدم أداة التوافق لمطابقة موديل سيارتك وشكل المفتاح بدقة.',
      btn1_en:'FIND YOUR KEY', btn1_ar:'اعثر على مفتاحك', btn1_link:'/fitment',
      btn2_en:'SHOP BY CAR BRAND', btn2_ar:'تسوق حسب ماركة السيارة', btn2_link:'/brands',
      accent_en:'Signature Collection', accent_ar:'التشكيلة المميزة' },
    { id:'h3', order:3, active:true, image:'/img/hero3.jpg',
      headline_en:'THE FINISHING\nTOUCH FOR THE\nDETAIL OBSESSED',
      headline_ar:'اللمسة\nالأخيرة\nلِعشاق التفاصيل',
      sub_en:'Collector medals and signature key holders crafted to perfection.',
      sub_ar:'ميداليات للجمع وحاملات مفاتيح مميزة صُنعت بإتقان.',
      btn1_en:'SHOP MEDALS', btn1_ar:'تسوق الميداليات', btn1_link:'/category/medals',
      btn2_en:'SHOP KEY HOLDERS', btn2_ar:'تسوق حاملات المفاتيح', btn2_link:'/category/keyholders',
      accent_en:'Limited Edition', accent_ar:'إصدار محدود' },
  ];
}

// ---------------------------------------------------------------------------
// HOMEPAGE SECTIONS (order + enabled)
// ---------------------------------------------------------------------------
function buildHomeSections() {
  return [
    { id:'hero', type:'hero', title:'Hero', order:1, enabled:true },
    { id:'brands', type:'brands', title:'Shop by Car Brand', order:2, enabled:true },
    { id:'benefits', type:'benefits', title:'Benefits', order:3, enabled:true },
    { id:'bestsellers', type:'bestsellers', title:'Best Sellers', order:4, enabled:true },
    { id:'new', type:'newarrivals', title:'New Arrivals', order:5, enabled:true },
    { id:'keycases', type:'keycases', title:'Key Cases', order:6, enabled:true },
    { id:'keyholders', type:'keyholders', title:'Key Holders', order:7, enabled:true },
    { id:'medals', type:'medals', title:'Car Medals', order:8, enabled:true },
    { id:'set', type:'completeset', title:'Complete Your Set', order:9, enabled:true },
    { id:'limited', type:'limited', title:'Limited Edition', order:10, enabled:true },
    { id:'why', type:'why', title:'Why Spinto', order:11, enabled:true },
  ];
}

// ---------------------------------------------------------------------------
// TRANSLATIONS (EN / AR)
// ---------------------------------------------------------------------------
function buildLanguages() {
  const t = {
    en: {
      home:'Home', keycases:'Key Cases', keyholders:'Key Holders', medals:'Medals',
      brands:'Brands', about:'About', nav_about:'About', contact:'Contact',
      search:'Search', account:'Account', cart:'Cart',
      free_delivery:'FREE DELIVERY ON ALL ORDERS', limited_time:'Limited Time Only',
      days:'DAYS', hrs:'HRS', mins:'MINS', secs:'SECS',
      shop_collection:'SHOP COLLECTION', shop_by_brand:'SHOP BY CAR BRAND',
      view_all:'VIEW ALL', prev:'Previous', next:'Next',
      best_sellers:'Best Sellers', new_arrivals:'New Arrivals',
      shop_by_car_brand:'Shop by Car Brand',
      premium_materials:'PREMIUM MATERIALS', pm_sub:'Built to last',
      perfect_compatibility:'PERFECT COMPATIBILITY', pc_sub:'Designed for your key',
      cash_on_delivery:'CASH ON DELIVERY', cod_sub:'Pay when you receive your order',
      easy_returns:'EASY RETURNS', er_sub:'7 days policy',
      add_to_cart:'ADD TO CART', out_of_stock:'OUT OF STOCK', only_left:'Only {n} left in stock',
      select_key_shape:'SELECT YOUR KEY SHAPE', shape:'Shape',
      quantity:'Quantity', total:'Total', subtotal:'Subtotal', bundle_discount:'Bundle Discount',
      delivery_fee:'Delivery Fee', proceed_to_checkout:'PROCEED TO CHECKOUT',
      your_cart:'YOUR CART', complete_your_set:'COMPLETE YOUR {brand} SET & SAVE',
      regular_price:'REGULAR PRICE', bundle_price:'BUNDLE PRICE', you_save:'YOU SAVE',
      add_3_piece_set:'ADD 3-PIECE SET', add_medal:'Add Medal', add_holder:'Add Key Holder',
      premium_quality:'Premium Quality', warranty:'Warranty', description:'Description',
      material:'Material', compatibility:'Compatibility', shipping_returns:'Shipping & Returns',
      selected:'Selected', key_case_only:'Key Case only', key_case_medal:'Key Case + Medal',
      key_case_holder:'Key Case + Key Holder', three_piece:'Complete 3-piece Set',
      fitment_finder:'FIND YOUR KEY', find_key_title:'Find Your Key',
      brand:'Brand', model:'Model', year:'Year', key_shape:'Key Shape',
      select:'Select', select_brand:'Select Brand', select_model:'Select Model',
      select_year:'Select Year', show_products:'Show Compatible Products',
      select_car_brand:'Select Your Car Brand', select_car_model:'Select Your Model',
      select_year_of_model:'Select Model Year', select_key_shape:'Select Your Key Shape',
      your_vehicle:'Your Vehicle', change:'Change', back:'Back', continue_lbl:'Continue',
      view_product:'View Product', step:'Step', of:'of', available:'Available', not_available:'Out of Stock',
      find_your_key:'Find Your Key', choose_from:'Choose from', results_for:'Results for', clear_fitment:'Clear',
      choose_brand:'Choose your car brand to begin', exact_match:'Exact match for your key',
      bundle_discount_applied:'Bundle Discount Applied', you_will_save:'You will save up to {n} on this order',
      keyguide:'Key Guide', shipping:'Shipping & Returns', warranty_page:'Warranty',
      about_velocci:'About Spinto', workshop:'Workshop Story',
      why_velocci:'Why Spinto', complete_your_set:'Complete Your Set',
      key_cases:'Key Cases', key_holders:'Key Holders', car_medals:'Car Medals',
      limited_edition:'Limited Edition', cash:'Cash on Delivery', cod_note:'Pay when you receive your order',
      full_name:'Full Name', phone:'Phone Number', city:'City', area:'Area',
      full_address:'Full Address', order_notes:'Order Notes', place_order:'Place Order',
      order_summary:'Order Summary', empty_cart:'Your cart is empty.',
      continue_shopping:'Continue shopping', points_of_sale:'Points of Sale',
      remove:'Remove', free_shipping:'Free shipping on orders over {n} EGP',
      you_saved:'You saved EGP {n} on this order',
      bundle_applied:'Bundle Applied!', customer_details:'Customer Details', order_items:'Order Items',
      order_date:'Order Date', payment_method:'Payment Method', free:'Free',
      breadcrumb_home:'Home', breadcrumb_key_cases:'Key Cases', breadcrumb_key_holders:'Key Holders',
      breadcrumb_medals:'Car Medals', personal:{},
      preorder_note:'Pre-order — no payment required yet.', reserve:'RESERVE PRE-ORDER',
      by_brand:'By Brand', all_products:'All Products',
      sort_by:'Sort', price_low:'Price: Low to High', price_high:'Price: High to Low',
      back_home:'Back to Home', order_confirmed:'Order Confirmed!', order_thanks:'Thank you. We will call you to confirm your order.',
      order_id:'Order ID', your_order_is:'Your order has been placed successfully.',
      selected_brand:'Selected Brand', clear:'Clear', fitment_banner:'Your selected vehicle: {info}',
      related:'You may also like', no_products:'No products yet.',
      specifications:'Specifications', compatible_vehicles:'Compatible Vehicles', fits:'Fits',
    },
    ar: {
      home:'الرئيسية', keycases:'جرابات المفاتيح', keyholders:'حاملات المفاتيح', medals:'الميداليات',
      brands:'الماركات', about:'حول', nav_about:'حول سبينتو', contact:'تواصل معنا',
      search:'بحث', account:'حسابي', cart:'السلة',
      free_delivery:'توصيل مجاني على جميع الطلبات', limited_time:'لفترة محدودة',
      days:'يوم', hrs:'ساعة', mins:'دقيقة', secs:'ثانية',
      shop_collection:'تسوق المفاتيح', shop_by_brand:'تسوق حسب ماركة السيارة',
      view_all:'عرض الكل', prev:'السابق', next:'التالي',
      best_sellers:'الأكثر مبيعًا', new_arrivals:'وصل حديثًا',
      shop_by_car_brand:'تسوق حسب ماركة السيارة',
      premium_materials:'خامات فاخرة', pm_sub:'صُنعت لتدوم',
      perfect_compatibility:'توافق مثالي', pc_sub:'مصمم لمفتاحك',
      cash_on_delivery:'الدفع عند الاستلام', cod_sub:'ادفع عند استلام طلبك',
      easy_returns:'استرجاع سهل', er_sub:'سياسة 7 أيام',
      add_to_cart:'أضف إلى السلة', out_of_stock:'غير متوفر', only_left:'متبقي {n} فقط في المخزون',
      select_key_shape:'حدد شكل المفتاح', shape:'الشكل',
      quantity:'الكمية', total:'الإجمالي', subtotal:'الإجمالي الفرعي', bundle_discount:'خصم المجموعة',
      delivery_fee:'رسوم التوصيل', proceed_to_checkout:'متابعة الشراء',
      your_cart:'سلة المشتريات', complete_your_set:'أكمل طقم {brand} و وفّر',
      regular_price:'السعر العادي', bundle_price:'سعر المجموعة', you_save:'توفيرك',
      add_3_piece_set:'أضف الطقم الكامل (3 قطع)', add_medal:'أضف الميدالية', add_holder:'أضف الحامل',
      premium_quality:'جودة فاخرة', warranty:'الضمان', description:'الوصف',
      material:'الخامة', compatibility:'التوافق', shipping_returns:'الشحن والإرجاع',
      selected:'تم الاختيار', key_case_only:'الجراب فقط', key_case_medal:'الجراب + الميدالية',
      key_case_holder:'الجراب + الحامل', three_piece:'الطقم الكامل (3 قطع)',
      fitment_finder:'اعرف مفتاحك', find_key_title:'اعرف مفتاحك',
      brand:'الماركة', model:'الموديل', year:'السنة', key_shape:'شكل المفتاح',
      select:'اختر', select_brand:'اختر الماركة', select_model:'اختر الموديل',
      select_year:'اختر السنة', show_products:'عرض المنتجات المتوافقة',
      select_car_brand:'اختار ماركة عربيتك', select_car_model:'اختار موديل عربيتك',
      select_year_of_model:'اختار سنة الموديل', select_key_shape:'اختار شكل المفتاح',
      your_vehicle:'عربيتك', change:'تغيير', back:'رجوع', continue_lbl:'متابعة',
      view_product:'عرض المنتج', step:'الخطوة', of:'من', available:'متوفر', not_available:'غير متوفر',
      find_your_key:'اعرف مفتاحك', choose_from:'اختر من', results_for:'نتائج', clear_fitment:'مسح',
      choose_brand:'اختر ماركة سيارتك للبدء', exact_match:'تطابق دقيق لمفتاحك',
      compatible_products:'المنتجات المتوافقة', no_results:'لا توجد منتجات مطابقة لهذا الاختيار.', can_review:'تقييم', compatible_with:'متوافق مع {brand}', bundle_discount_applied:'تم تطبيق خصم المجموعة', you_will_save:'ستوفر حتى {n} في هذا الطلب',
      keyguide:'دليل المفتاح', shipping:'الشحن والإرجاع', warranty_page:'الضمان',
      about_velocci:'حول سبينتو', workshop:'قصة الورشة',
      why_velocci:'لماذا سبينتو', complete_your_set:'أكمل طقمك',
      key_cases:'جرابات المفاتيح', key_holders:'حاملات المفاتيح', car_medals:'ميداليات السيارات',
      limited_edition:'إصدار محدود', cash:'الدفع عند الاستلام', cod_note:'ادفع عند استلام طلبك',
      full_name:'الاسم الكامل', phone:'رقم الهاتف', city:'المدينة', area:'المنطقة',
      full_address:'العنوان بالكامل', order_notes:'ملاحظات الطلب', place_order:'تأكيد الطلب',
      order_summary:'ملخص الطلب', empty_cart:'السلة فارغة.',
      continue_shopping:'مواصلة التسوق', points_of_sale:'نقاط البيع',
      remove:'إزالة', free_shipping:'توصيل مجاني للطلبات فوق {n} جنيه',
      you_saved:'وفرت EGP {n} في هذا الطلب',
      bundle_applied:'تم تطبيق خصم المجموعة!', customer_details:'بيانات العميل', order_items:'منتجات الطلب',
      order_date:'تاريخ الطلب', payment_method:'طريقة الدفع', free:'مجاني',
      breadcrumb_home:'الرئيسية', breadcrumb_key_cases:'جرابات المفاتيح', breadcrumb_key_holders:'حاملات المفاتيح',
      breadcrumb_medals:'ميداليات السيارات', personal:{},
      preorder_note:'طلب مسبق — لا يلزم الدفع الآن.', reserve:'احجز الطلب المسبق',
      by_brand:'حسب الماركة', all_products:'كل المنتجات',
      sort_by:'ترتيب', price_low:'السعر: من الأقل إلى الأعلى', price_high:'السعر: من الأعلى إلى الأقل',
      back_home:'العودة للرئيسية', order_confirmed:'تم تأكيد الطلب!', order_thanks:'شكرًا لك. سنتصل بك لتأكيد طلبك.',
      order_id:'رقم الطلب', your_order_is:'تم استلام طلبك بنجاح.',
      selected_brand:'الماركة المختارة', clear:'مسح', fitment_banner:'سيارتك المختارة: {info}',
      related:'قد يعجبك أيضًا', no_products:'لا توجد منتجات بعد.',
      specifications:'المواصفات', compatible_vehicles:'الموديلات المتوافقة', fits:'يناسب',
    },
  };
  return { current:'en', supported:['en','ar'], dict:t };
}

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------
function buildSettings() {
  const now = new Date();
  const promoEnd = new Date(); promoEnd.setDate(promoEnd.getDate()+3); promoEnd.setHours(23,59,59,0);
  return {
    shopName:'SPINTO', tagline:'Premium automotive key accessories',
    logo:{ type:'text', value:'SPINTO', accent:true },
    contact:{ phone:'+20 100 000 0000', email:'hello@spinto.com', whatstext:'+20 100 000 0000' },
    whatsapp:'+20 100 000 0000', instagram:'spinto', facebook:'spinto', tiktok:'spinto',
    shippingFee:60, freeShippingThreshold:2000,
    returnPolicy:{ days:7, note_en:'7-day return policy on all items.', note_ar:'سياسة إرجاع 7 أيام على جميع المنتجات.' },
    warranty_en:'All Spinto products are covered by a manufacture warranty.', warranty_ar:'جميع منتجات سبينتو مشمولة بضمان المصنع.',
    currency:'EGP', currencySymbol:'EGP',
    copyright_en:'© 2026 Spinto. All rights reserved.', copyright_ar:'© 2026 سبينتو. جميع الحقوق محفوظة.',
    footerAbout_en:'SPINTO crafts premium automotive key accessories for the world\'s finest car brands.', footerAbout_ar:'تصنع سبينتو إكسسوارات مفاتيح فاخرة لأفضل ماركات السيارات في العالم.',
    deliveryNote_en:'Cash on Delivery — pay when you receive your order.', deliveryNote_ar:'الدفع عند الاستلام — ادفع عند استلام طلبك.',
  };
}

// ---------------------------------------------------------------------------
// PROMO BAR
// ---------------------------------------------------------------------------
function buildPromoBar() {
  const end = new Date(); end.setDate(end.getDate()+3); end.setHours(23,59,59,0);
  return {
    enabled:true, endTime: end.toISOString(),
    text_en:'FREE DELIVERY ON ALL ORDERS', sub_en:'Limited Time Only',
    text_ar:'توصيل مجاني على جميع الطلبات', sub_ar:'لفترة محدودة',
  };
}

// Main entry
let products = [];
function seed(force) {
  if (store.load().products.length && store.load().settings.shopName && !force) {
    console.log('[seed] store already populated — skipping (use --force to reseed).');
    return store.load();
  }
  products = buildProducts();
  // ensure every product carries the admin-editable specs + explicit fitment list
  products = products.map(p => {
    const brand = brandDefs.find(b => b.slug === p.brandSlug);
    const bn_en = brand ? brand.en : '';
    const bn_ar = brand ? brand.ar : '';
    const specs = [
      p.material_en ? { label_en: 'Material', label_ar: 'الخامة', value_en: p.material_en || '', value_ar: p.material_ar || '' } : null,
      p.warranty_en ? { label_en: 'Warranty', label_ar: 'الضمان', value_en: p.warranty_en || '', value_ar: p.warranty_ar || '' } : null,
      { label_en: 'Brand', label_ar: 'الماركة', value_en: bn_en, value_ar: bn_ar },
      { label_en: 'Category', label_ar: 'الفئة', value_en: p.category || '', value_ar: p.category || '' },
    ].filter(Boolean);
    const vehicles = (p.models || []).reduce((acc, m) => {
      (p.years || []).forEach(y => acc.push({ brand: p.brandSlug, model: m, year: y }));
      return acc;
    }, []);
    return Object.assign({}, p, { specs, vehicles });
  });
  const db = {
    meta:{ version:1, updatedAt:new Date().toISOString() },
    settings: buildSettings(),
    languages: buildLanguages(),
    heroSlides: buildHeroSlides(),
    homeSections: buildHomeSections(),
    brands: brandDefs.map((b,i)=>({ id:'b_'+b.slug, slug:b.slug, name_en:b.en, name_ar:b.ar, mark:b.mark,
      emblem:b.em, tier:b.tier, models:b.models, order:i, active:true })),
    bundles: buildBundles(),
    products,
    orders:[], preorders:[], messages:[],
    promoBar: buildPromoBar(),
  };
  store.reset(db);
  console.log(`[seed] seeded ${db.brands.length} brands, ${db.products.length} products, ${db.bundles.length} bundles.`);
  return db;
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  seed(force);
}

module.exports = { seed };
