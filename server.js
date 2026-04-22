const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════
//  CONFIG — edit these before deploying
// ═══════════════════════════════════════════════════════════════
const MERCHANTS = {
  paytm: {
    upi : 'paytm.s1h4uwq@pty',
    name: 'Audiva Fm Private Limited',
    app : 'paytmmp',
  },
  phonepe: {
    upi : 'merchant@ybl',          // ← replace with your PhonePE UPI
    name: 'Your Business Name',
    app : 'phonepe',
  },
  gpay: {
    upi : 'merchant@okicici',      // ← replace with your GPay UPI
    name: 'Your Business Name',
    app : 'tez',
  },
};

// ── Order storage (JSON files in /data/) ─────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function orderFile(id) {
  return path.join(DATA_DIR, id.replace(/[^a-zA-Z0-9_\-]/g,'') + '.json');
}
function saveOrder(id, data) {
  fs.writeFileSync(orderFile(id), JSON.stringify(data, null, 2));
}
function getOrder(id) {
  const f = orderFile(id);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f,'utf8')) : null;
}
function updateOrder(id, updates) {
  const o = getOrder(id);
  if (!o) return;
  Object.assign(o, updates);
  saveOrder(id, o);
}
function allOrders() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,f),'utf8')); } catch{ return null; } })
    .filter(Boolean);
}

// CORS — allow all origins (restrict after go-live)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/create — Create order
// ═══════════════════════════════════════════════════════════════
app.post('/api/create', (req, res) => {
  const { merchant='paytm', amount, order_id } = req.body;

  if (!MERCHANTS[merchant])           return res.json({ status:'FAILED', message:'Unknown merchant', order_id:'', amount:'0.00', payment_url:'' });
  if (!amount || parseFloat(amount)<=0) return res.json({ status:'FAILED', message:'Invalid amount', order_id:'', amount:'0.00', payment_url:'' });
  if (!order_id)                       return res.json({ status:'FAILED', message:'order_id required', order_id:'', amount:'0.00', payment_url:'' });
  if (getOrder(order_id))              return res.json({ status:'FAILED', message:'Order ID already exists', order_id, amount:'0.00', payment_url:'' });

  const m   = MERCHANTS[merchant];
  const amt = parseFloat(amount).toFixed(2);
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;
  const payment_url = `${host}/pay/${merchant}/${order_id}`;

  saveOrder(order_id, {
    order_id, amount: amt, merchant,
    upi: m.upi, name: m.name,
    status: 'PENDING', utr: '', payer: '',
    created_at: new Date().toISOString(),
    settled_at: '', payment_url,
  });

  res.json({ status:'SUCCESS', message:'Order created successfully', order_id, amount:amt, payment_url });
});

// ═══════════════════════════════════════════════════════════════
//  GET /api/status?order_id=X — Check order status
// ═══════════════════════════════════════════════════════════════
app.get('/api/status', (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.json({ status:'FAILED', message:'order_id required' });

  const o = getOrder(order_id);
  if (!o) return res.json({ status:'FAILED', message:'Order not found', order_id });

  res.json({
    status   : o.status,
    amount   : o.amount,
    UTR      : o.utr,
    order_id : o.order_id,
    message  : '0',
    merchantDetails: {
      pg_type           : 'UPI-PG',
      payment_source    : o.merchant,
      mode              : 'UPI_INTENT',
      added_on          : o.created_at,
      settled_at        : o.settled_at,
      transaction_amount: o.amount,
      unmapped_status   : o.status === 'SUCCESS' ? 'captured' : o.status.toLowerCase(),
      error_code        : 'E000',
      error_message     : 'NO ERROR',
    },
    payerDetails: {
      payer_name   : o.payer,
      bank_ref_num : o.utr,
      utr          : o.utr,
      field9       : o.status==='SUCCESS' ? '0|SUCCESS|Completed Using Callback' : '',
    },
  });
});

// ═══════════════════════════════════════════════════════════════
//  GET /api/verify?utr=X&order_id=Y&amount=Z — Verify UTR
// ═══════════════════════════════════════════════════════════════
app.get('/api/verify', (req, res) => {
  const utr      = (req.query.utr||'').replace(/\D/g,'');
  const order_id = req.query.order_id || '';
  const amount   = req.query.amount   || '';

  if (utr.length !== 12) return res.json({ status:'FAILED', message:'UTR must be 12 digits' });
  const o = getOrder(order_id);
  if (!o) return res.json({ status:'FAILED', message:'Order not found' });
  if (o.status === 'SUCCESS') return res.json({ status:'SUCCESS', message:'Already verified', utr: o.utr });

  // Prevent duplicate UTR
  const dup = allOrders().find(x => x.utr === utr && x.order_id !== order_id);
  if (dup) return res.json({ status:'FAILED', message:`UTR already used for order ${dup.order_id}` });

  updateOrder(order_id, { status:'SUCCESS', utr, payer:'UTR Verified', settled_at: new Date().toISOString() });
  res.json({ status:'SUCCESS', message:'Payment verified', order_id, amount:o.amount, utr });
});

// ═══════════════════════════════════════════════════════════════
//  GET /pay/:merchant/:order_id — Payment page (the main page)
// ═══════════════════════════════════════════════════════════════
app.get('/pay/:merchant/:order_id', (req, res) => {
  const { merchant, order_id } = req.params;
  const m = MERCHANTS[merchant];
  const o = getOrder(order_id);

  if (!m || !o) return res.status(404).send('<h3 style="font-family:sans-serif;padding:24px">Order not found</h3>');

  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;

  const pa  = encodeURIComponent(o.upi);
  const pn  = encodeURIComponent(o.name);
  const am  = o.amount;
  const tn  = encodeURIComponent('Payment');

  const intents = {
    paytmmp : `paytmmp://pay?pa=${pa}&pn=${pn}&am=${am}&cu=INR&tn=${tn}`,
    phonepe : `phonepe://pay?pa=${pa}&pn=${pn}&am=${am}&cu=INR&tn=${tn}`,
    gpay    : `tez://upi/pay?pa=${pa}&pn=${pn}&am=${am}&cu=INR&tn=${tn}`,
    generic : `upi://pay?pa=${pa}&pn=${pn}&am=${am}&cu=INR&tn=${tn}`,
  };

  const statusUrl = `${host}/api/status?order_id=${encodeURIComponent(order_id)}`;
  const verifyUrl = `${host}/api/verify`;
  const qrUrl     = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(intents.generic)}&bgcolor=ffffff&color=000000&margin=8&ecc=H`;

  // Inline HTML — same pattern as antqpay.com, served from HTTPS
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Pay ₹${o.amount} · ${o.name}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;min-height:100dvh;display:flex;flex-direction:column;align-items:center;padding:20px 16px 40px;color:#1a202c}
.card{background:#fff;border-radius:20px;overflow:hidden;width:100%;max-width:380px;box-shadow:0 8px 30px rgba(0,0,0,.10)}
.head{background:linear-gradient(135deg,#1a1a2e,#0f3460);padding:26px 20px 20px;text-align:center;color:#fff}
.verified{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600;margin-bottom:12px}
.mname{font-size:13px;color:rgba(255,255,255,.7);margin-bottom:8px}
.albl{font-size:10px;color:rgba(255,255,255,.5);letter-spacing:.1em;text-transform:uppercase;margin-bottom:2px}
.amt{font-size:52px;font-weight:800;line-height:1;letter-spacing:-1px}
.amt sup{font-size:24px;font-weight:400;opacity:.6;vertical-align:super}
.body{padding:20px}
.qr-wrap{background:#fff;border:2px solid #e2e8f0;border-radius:14px;padding:10px;width:190px;height:190px;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.08)}
.qr-wrap img{width:100%;height:100%;border-radius:8px;display:block}
.upi-id{text-align:center;font-family:monospace;font-size:13px;font-weight:600;margin-bottom:4px}
.upi-sub{text-align:center;font-size:11px;color:#64748b;margin-bottom:16px}
.divider{display:flex;align-items:center;gap:10px;font-size:11px;color:#94a3b8;margin:14px 0}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:#e2e8f0}
.ibtn{display:flex;align-items:center;gap:13px;width:100%;padding:14px 16px;border-radius:12px;border:2px solid;cursor:pointer;font-family:inherit;transition:all .14s;text-align:left;margin-bottom:9px;background:#fff}
.ibtn:active{transform:scale(.97)}
.iname{font-size:14px;font-weight:700;display:block;margin-bottom:2px}
.isub{font-size:11px;display:block;opacity:.6}
.ibtn.paytm{border-color:#bfdbfe;background:#eff6ff}.ibtn.paytm .iname{color:#1d4ed8}
.ibtn.phonepe{border-color:#e9d5ff;background:#faf5ff}.ibtn.phonepe .iname{color:#7e22ce}
.ibtn.gpay{border-color:#bfdbfe;background:#eff6ff}.ibtn.gpay .iname{color:#1d4ed8}
.ibtn.any{border-color:#e2e8f0;background:#f8fafc}.ibtn.any .iname{color:#334155}
.status-msg{border-radius:10px;padding:11px 14px;font-size:13px;font-weight:600;text-align:center;margin-bottom:14px;display:none}
.overlay{position:fixed;inset:0;background:rgba(240,244,248,.96);display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:100}
.overlay.show{display:flex}
.spinner{width:40px;height:40px;border:3px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.ov-title{font-size:16px;font-weight:700;color:#1e293b}
.ov-sub{font-size:12px;color:#64748b;text-align:center;line-height:1.6;max-width:260px}
.poll-bar{width:220px;height:3px;background:#e2e8f0;border-radius:2px;overflow:hidden}
.poll-fill{height:100%;background:#6366f1;border-radius:2px;animation:sw 2s ease-in-out infinite}
@keyframes sw{0%{width:0;margin-left:0}50%{width:55%;margin-left:22%}100%{width:0;margin-left:100%}}
.success-screen{display:none;padding:24px;text-align:center}
.success-screen.show{display:block}
.s-ring{width:72px;height:72px;border-radius:50%;background:#f0fdf4;border:2px solid #86efac;display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 14px;box-shadow:0 0 30px rgba(34,197,94,.2)}
.s-title{font-size:22px;font-weight:800;color:#166534;margin-bottom:6px}
.s-sub{font-size:13px;color:#64748b;margin-bottom:18px}
.d-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:0 14px;text-align:left;margin-bottom:14px}
.d-row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px}
.d-row:last-child{border:none}
.dk{color:#64748b;font-size:12px}
.dv{font-weight:700;font-family:monospace;font-size:12px;word-break:break-all}
.utr-box{background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:14px;padding:16px;margin-top:10px;display:none}
.utr-inp{width:100%;padding:13px;font-size:22px;font-weight:800;font-family:monospace;letter-spacing:.1em;border:2px solid #e2e8f0;border-radius:10px;text-align:center;color:#0f172a;background:#fff}
.utr-inp:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.1)}
.utr-count{text-align:center;font-size:11px;color:#94a3b8;margin:6px 0 12px}
.vfy-btn{width:100%;padding:13px;border-radius:10px;background:#0f172a;color:#fff;font-size:14px;font-weight:700;border:none;cursor:pointer;font-family:inherit}
.vfy-btn:disabled{background:#e2e8f0;color:#94a3b8;cursor:not-allowed}
.vfy-res{display:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;text-align:center;margin-top:8px}
.paid-btn{width:100%;margin-top:14px;padding:14px;border-radius:12px;background:#f0fdf4;border:2px solid #86efac;color:#166534;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}
.paid-btn:hover{background:#22c55e;color:#fff}
.note{font-size:11px;color:#94a3b8;text-align:center;line-height:1.8;margin-top:14px}
.footer{background:#f8fafc;border-top:1px solid #f1f5f9;padding:10px;display:flex;justify-content:center;gap:16px;font-size:10px;color:#94a3b8;font-weight:600}
/* FS QR */
.qr-fs{position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.qr-fs-inner{background:#fff;border-radius:16px;padding:14px}
.qr-fs-inner img{width:min(300px,82vw);height:min(300px,82vw);display:block;border-radius:8px}
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <div class="verified">
      <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#22c55e"/><path d="M2.5 5l1.8 1.8 3.2-3.5" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Verified Merchant
    </div>
    <div class="mname">${o.name}</div>
    <div class="albl">PAYING AMOUNT</div>
    <div class="amt"><sup>₹</sup>${o.amount}</div>
  </div>

  <div class="success-screen" id="success-screen"></div>

  <div class="body" id="pay-body">
    <div class="status-msg" id="status-msg"></div>

    <!-- QR -->
    <div class="qr-wrap" onclick="showFSQR()">
      <img src="${qrUrl}" alt="UPI QR">
    </div>
    <div class="upi-id">${o.upi}</div>
    <div class="upi-sub">Tap to enlarge · Scan with any UPI app</div>

    <div class="divider">open app directly</div>

    <button class="ibtn paytm" onclick="fire('paytmmp')">
      <span style="font-size:22px">🔷</span>
      <div><span class="iname">Open PayTM</span><span class="isub">paytmmp:// · Best for @pty UPI IDs · 100% intent</span></div>
    </button>
    <button class="ibtn phonepe" onclick="fire('phonepe')">
      <span style="font-size:22px">🟣</span>
      <div><span class="iname">Open PhonePE</span><span class="isub">phonepe:// · Direct to PhonePE app</span></div>
    </button>
    <button class="ibtn gpay" onclick="fire('gpay')">
      <span style="font-size:22px">🔵</span>
      <div><span class="iname">Open Google Pay</span><span class="isub">tez:// · Direct to GPay</span></div>
    </button>
    <button class="ibtn any" onclick="fire('generic')">
      <span style="font-size:20px">📱</span>
      <div><span class="iname">Any UPI App</span><span class="isub">upi:// · Shows all installed UPI apps</span></div>
    </button>

    <button class="paid-btn" id="paid-btn" onclick="showUTR()">✓ I've Paid — Verify Payment</button>

    <div class="utr-box" id="utr-box">
      <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:8px;letter-spacing:.04em;text-transform:uppercase">Enter UTR / UPI Ref Number</div>
      <div style="font-size:12px;color:#64748b;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:12px;line-height:1.7">
        Open your UPI app → find payment → copy<br>
        <strong>UPI Ref ID</strong> or <strong>Transaction ID</strong><br>
        It's a <strong>12-digit number</strong>
      </div>
      <input class="utr-inp" id="utr-inp" type="tel" maxlength="12" placeholder="123456789012"
        oninput="this.value=this.value.replace(/\\D/g,'');onUTR(this.value)">
      <div class="utr-count" id="utr-count">0 / 12 digits</div>
      <div class="vfy-res" id="vfy-res"></div>
      <button class="vfy-btn" id="vfy-btn" onclick="verifyUTR()" disabled>Verify &amp; Confirm</button>
      <button onclick="hideUTR()" style="width:100%;margin-top:8px;padding:10px;background:none;border:1.5px solid #e2e8f0;border-radius:8px;color:#64748b;font-size:13px;cursor:pointer;font-family:inherit">← Back</button>
    </div>

    <div class="note">Order: ${order_id}<br>Do not pay twice for the same order</div>
  </div>

  <div class="footer"><span>🔒 256-bit SSL</span><span>BHIM UPI</span><span>Secure</span></div>
</div>

<!-- Loading overlay -->
<div class="overlay" id="overlay">
  <div class="spinner"></div>
  <div class="ov-title" id="ov-title">Opening app…</div>
  <div class="ov-sub" id="ov-sub">Complete payment and come back here</div>
  <div class="poll-bar"><div class="poll-fill"></div></div>
</div>

<script>
const INTENTS = ${JSON.stringify(intents)};
const STATUS_URL = '${statusUrl}';
const VERIFY_URL = '${verifyUrl}';
const ORDER_ID   = '${order_id}';
const AMOUNT     = '${o.amount}';
const BIG_QR     = '${qrUrl.replace('280x280','400x400')}';
const UPI_ID     = '${o.upi}';
let pollTimer = null, retHandler = null;

// ── FIRE INTENT ──────────────────────────────────────────────
// Served from https:// → Android fires intent → UPI app opens
function fire(scheme) {
  const url = INTENTS[scheme];
  if (!url) return;
  const n = {paytmmp:'PayTM',phonepe:'PhonePE',gpay:'Google Pay',generic:'UPI App'};
  overlay('Opening ' + (n[scheme]||'app') + '…', 'Complete payment and return here');
  window.location.href = url;
  if (retHandler) document.removeEventListener('visibilitychange', retHandler);
  retHandler = function() {
    if (document.visibilityState === 'visible') {
      document.removeEventListener('visibilitychange', retHandler);
      retHandler = null;
      overlay('Checking payment…', 'Verifying with server…');
      startPoll();
    }
  };
  document.addEventListener('visibilitychange', retHandler);
}

// ── POLL STATUS ──────────────────────────────────────────────
function startPoll() {
  let n = 0;
  clearInterval(pollTimer);
  pollTimer = setInterval(function() {
    n++;
    fetch(STATUS_URL).then(r=>r.json()).then(d=>{
      if (d.status==='SUCCESS') { clearInterval(pollTimer); hideOverlay(); showSuccess(d); }
      else if (d.status==='FAILED') { clearInterval(pollTimer); hideOverlay(); showMsg('Payment failed. Try again.','#fef2f2','#fecaca','#991b1b'); }
      else if (n>=12) { clearInterval(pollTimer); hideOverlay(); showMsg('Payment pending — enter UTR to confirm','#fffbeb','#fde68a','#92400e'); showUTR(); }
    }).catch(()=>{});
  }, 5000);
}

function overlay(t,s) { document.getElementById('overlay').classList.add('show'); document.getElementById('ov-title').textContent=t; document.getElementById('ov-sub').textContent=s; }
function hideOverlay() { document.getElementById('overlay').classList.remove('show'); }

function showMsg(msg, bg, border, color) {
  const el = document.getElementById('status-msg');
  el.style.cssText='display:block;background:'+bg+';border:1.5px solid '+border+';color:'+color;
  el.textContent = msg;
}

function showSuccess(d) {
  hideOverlay();
  document.getElementById('pay-body').style.display='none';
  const ss = document.getElementById('success-screen');
  ss.classList.add('show');
  ss.innerHTML =
    '<div class="s-ring">✓</div>'+
    '<div class="s-title">Payment Confirmed!</div>'+
    '<div class="s-sub">₹'+AMOUNT+' received</div>'+
    '<div class="d-box">'+
      dr('Order ID',ORDER_ID)+dr('Amount','₹'+AMOUNT,'#166534')+
      dr('Status','SUCCESS ✓','#166534')+dr('UTR',d.UTR||d.payerDetails?.utr||'—')+
      dr('Time',new Date().toLocaleTimeString('en-IN'))+
    '</div>';
}
function dr(k,v,c){ return '<div class="d-row"><span class="dk">'+k+'</span><span class="dv"'+(c?' style="color:'+c+'"':'')+'>'+v+'</span></div>'; }

// ── UTR ──────────────────────────────────────────────────────
function showUTR() { document.getElementById('paid-btn').style.display='none'; document.getElementById('utr-box').style.display='block'; setTimeout(()=>document.getElementById('utr-inp').focus(),150); }
function hideUTR()  { document.getElementById('paid-btn').style.display='block'; document.getElementById('utr-box').style.display='none'; }
function onUTR(v) {
  const n=v.length, c=document.getElementById('utr-count');
  c.textContent=n+' / 12 digits'; c.style.color=n===12?'#16a34a':n>0?'#d97706':'#94a3b8';
  const b=document.getElementById('vfy-btn'); b.disabled=n!==12;
}
function verifyUTR() {
  const utr=document.getElementById('utr-inp').value.trim();
  if (utr.length!==12) return;
  const btn=document.getElementById('vfy-btn'); btn.textContent='Verifying…'; btn.disabled=true;
  fetch(VERIFY_URL+'?utr='+utr+'&order_id='+encodeURIComponent(ORDER_ID)+'&amount='+encodeURIComponent(AMOUNT))
    .then(r=>r.json()).then(d=>{
      btn.textContent='Verify & Confirm'; btn.disabled=false;
      const r=document.getElementById('vfy-res');
      if (d.status==='SUCCESS') {
        r.style.cssText='display:block;background:#f0fdf4;border:1.5px solid #86efac;color:#166534'; r.textContent='✓ ₹'+AMOUNT+' confirmed · UTR: '+utr;
        setTimeout(()=>showSuccess({UTR:utr}),700);
      } else {
        r.style.cssText='display:block;background:#fef2f2;border:1.5px solid #fecaca;color:#991b1b'; r.textContent='✗ '+(d.message||'UTR not found');
      }
    }).catch(()=>{ btn.textContent='Verify & Confirm'; btn.disabled=false; });
}

// ── FULLSCREEN QR ────────────────────────────────────────────
function showFSQR() {
  const el=document.createElement('div'); el.className='qr-fs'; el.id='qr-fs';
  el.innerHTML='<div style="font-size:11px;font-weight:600;color:#94a3b8;margin-bottom:14px;text-transform:uppercase;letter-spacing:.05em">Open UPI app → Scan QR</div>'+
    '<div class="qr-fs-inner"><img src="'+BIG_QR+'" alt="QR"></div>'+
    '<div style="font-size:13px;font-weight:600;color:#fff;margin-top:14px">₹'+AMOUNT+'</div>'+
    '<div style="font-family:monospace;font-size:12px;color:#a5b4fc;margin-top:4px">'+UPI_ID+'</div>'+
    '<div style="font-size:11px;color:#64748b;margin-top:8px;text-align:center;line-height:1.7">PayTM · PhonePE · GPay · BHIM · Any UPI App<br>Amount fills automatically</div>'+
    '<button onclick="document.getElementById(\'qr-fs\').remove()" style="margin-top:18px;padding:9px 28px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#94a3b8;font-size:13px;cursor:pointer;font-family:inherit">✕ Close</button>';
  const old=document.getElementById('qr-fs'); if(old) old.remove();
  document.body.appendChild(el);
  if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(()=>{});
}

// Auto-check on load
fetch(STATUS_URL).then(r=>r.json()).then(d=>{ if(d.status==='SUCCESS') showSuccess(d); }).catch(()=>{});
</script>
</body></html>`);
});

// ── health check ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', orders: allOrders().length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Castle Gateway running on port ${PORT}`));
