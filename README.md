# Castle Gateway — PayTM Only

A lightweight UPI payment gateway using **PayTM only**, deployable on Railway.

---

## Setup

### 1. Edit your UPI details in `server.js`

```js
const MERCHANT = {
  upi : 'paytm.s1h4uwq@pty',        // ← your PayTM UPI VPA
  name: 'Audiva Fm Private Limited', // ← must match registered name exactly
};
```

### 2. Deploy to Railway

```bash
git init
git add .
git commit -m "init"
# connect to Railway and push
```

Make sure `RAILWAY_PUBLIC_DOMAIN` is set automatically by Railway (it is by default).

---

## API Reference

### Create Order
```
POST /api/create
Content-Type: application/json

{ "amount": "499.00", "order_id": "ORDER123" }
```
**Response:**
```json
{
  "status": "SUCCESS",
  "order_id": "ORDER123",
  "amount": "499.00",
  "payment_url": "https://your-app.railway.app/pay/ORDER123"
}
```

---

### Check Order Status
```
GET /api/status?order_id=ORDER123
```

---

### Verify UTR (manual confirmation)
```
GET /api/verify?utr=123456789012&order_id=ORDER123&amount=499.00
```

---

### Payment Page
```
GET /pay/:order_id
```
Opens the payment UI. Send this link to your customer.

---

## Notes

- Orders are stored as JSON files in `/data/` directory
- UTR must be exactly 12 digits
- Each UTR can only be used once (duplicate check built in)
- The payment page auto-polls for confirmation every 5 seconds after the user returns from PayTM
