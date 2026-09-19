'use strict';
// InstaPay payment-proof API flow. This test uses the existing JSON fallback
// in a temporary store so it never changes the checked-in catalog.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3137;
const TOKEN = 'instapay-proof-test-token';
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vilocci-instapay-'));
const dbFile = path.join(scratchDir, 'velocci-db.json');
fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), dbFile);
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, detail); }
};

async function request(method, pathname, body, admin = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers['x-admin-dev-token'] = TOKEN;
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('VILOCCI running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before start (${code})`));
    });
  });
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DRIVER: 'json',
      VELOCCI_DB: dbFile,
      ADMIN_DEV_TOKEN: TOKEN,
      VITE_SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      VITE_SUPABASE_ANON_KEY: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
  try {
    await waitForServer(child);
    const data = await request('GET', '/api/data');
    const product = data.json.products.find((p) => (p.keyShapes || []).some((s) => s.available)) || data.json.products[0];
    const color = (product.colors || []).find((c) => c.enabled !== false);
    const cart = [{ productId: product.id, keyShape: '', qty: 1, colorId: color ? color.id : null }];
    const customer = { fullName: 'Proof Tester', phone: '+201000000000', city: 'Cairo', address: '1 Test Street' };

    const missing = await request('POST', '/api/orders', { customer, cart, payment: 'InstaPay' });
    check('InstaPay without proof is blocked', missing.status === 400 && missing.json.code === 'PAYMENT_PROOF_REQUIRED', JSON.stringify(missing.json));

    const invalid = await request('POST', '/api/orders', { customer, cart, payment: 'InstaPay', paymentProof: 'data:image/png;base64,not-an-image' });
    check('invalid proof is rejected', invalid.status === 400 && invalid.json.code === 'BAD_SIGNATURE', JSON.stringify(invalid.json));

    const cod = await request('POST', '/api/orders', { customer, cart, payment: 'Cash on Delivery' });
    check('COD still works without a proof', cod.status === 200 && cod.json.ok === true, JSON.stringify(cod.json));
    check('COD does not require a payment verification status', cod.json.paymentStatus === 'Not Required', JSON.stringify(cod.json));

    const insta = await request('POST', '/api/orders', { customer, cart, payment: 'InstaPay', paymentProof: png });
    check('InstaPay with a valid proof creates the order', insta.status === 200 && insta.json.ok === true, JSON.stringify(insta.json));
    check('InstaPay starts as Pending Verification', insta.json.paymentStatus === 'Pending Verification', JSON.stringify(insta.json));

    const adminList = await request('GET', '/api/admin/orders', undefined, true);
    const stored = (adminList.json.orders || []).find((o) => o.id === insta.json.orderId);
    check('admin Orders identifies InstaPay', stored && stored.payment === 'InstaPay');
    check('admin Orders keeps the proof reference with that order', stored && stored.paymentProof && stored.paymentProof.available === true);
    check('admin Orders shows Pending Verification', stored && stored.paymentStatus === 'Pending Verification', JSON.stringify(stored));

    const detail = await request('GET', `/api/admin/order/${encodeURIComponent(insta.json.orderId)}`, undefined, true);
    check('admin order detail includes payment proof', detail.json.paymentProof && detail.json.paymentProof.available === true);
    check('admin order detail shows Pending Verification', detail.json.paymentStatus === 'Pending Verification', JSON.stringify(detail.json));
    const proof = await request('GET', `/api/admin/order/${encodeURIComponent(insta.json.orderId)}/payment-proof`, undefined, true);
    check('admin can open the stored proof', proof.status === 200 && proof.json.ok === true && proof.json.url === png);

    const verified = await request('POST', '/api/admin/order-payment-status', { id: insta.json.orderId, status: 'Verified' }, true);
    check('admin can verify the InstaPay payment', verified.status === 200 && verified.json.paymentStatus === 'Verified', JSON.stringify(verified.json));
    const afterVerify = await request('GET', `/api/admin/order/${encodeURIComponent(insta.json.orderId)}`, undefined, true);
    check('Verified payment status persists with the order', afterVerify.json.paymentStatus === 'Verified', JSON.stringify(afterVerify.json));

    const rejected = await request('POST', '/api/admin/order-payment-status', { id: insta.json.orderId, status: 'Rejected' }, true);
    check('admin can reject the InstaPay payment', rejected.status === 200 && rejected.json.paymentStatus === 'Rejected', JSON.stringify(rejected.json));
    const afterReject = await request('GET', `/api/admin/order/${encodeURIComponent(insta.json.orderId)}`, undefined, true);
    check('Rejected payment status persists with the order', afterReject.json.paymentStatus === 'Rejected', JSON.stringify(afterReject.json));

    const codReject = await request('POST', '/api/admin/order-payment-status', { id: cod.json.orderId, status: 'Verified' }, true);
    check('COD cannot be payment-proof verified', codReject.status === 400, JSON.stringify(codReject.json));

    const noProofOrders = (adminList.json.orders || []).filter((o) => o.payment === 'InstaPay' && (!o.paymentProof || !o.paymentProof.available));
    check('no InstaPay order exists without a proof', noProofOrders.length === 0);
  } finally {
    child.kill('SIGTERM');
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
