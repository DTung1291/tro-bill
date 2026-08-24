# Webhook thanh toán subscription

TrọBill nhận kết quả chuyển khoản tại:

```text
POST /api/webhooks/subscription-payments/bank-transfer
Content-Type: application/json
```

VietQR tĩnh không tự gửi webhook. Dịch vụ ngân hàng hoặc đối soát được chọn sau
này phải ánh xạ giao dịch sang hợp đồng dưới đây và dùng cùng
`PAYMENT_WEBHOOK_SECRET` của đúng môi trường.

## Chữ ký bắt buộc

Mỗi request phải có ba header:

```text
X-Payment-Event-Id: evt_20260825_001
X-Payment-Timestamp: 1787593023
X-Payment-Signature: v1=<64 ký tự hex>
```

Chuỗi cần ký là byte UTF-8 của timestamp, một dấu chấm và **raw request body**:

```text
<timestamp>.<raw-body>
```

Chữ ký là HMAC-SHA256 với `PAYMENT_WEBHOOK_SECRET`. Server so sánh constant-time
và chỉ nhận timestamp lệch tối đa 5 phút để chống replay. Không được parse rồi
serialize lại JSON trước khi kiểm tra vì raw body có thể thay đổi.

Ví dụ tạo chữ ký bằng Node.js:

```js
const crypto = require('node:crypto');

const timestamp = String(Math.floor(Date.now() / 1000));
const rawBody = Buffer.from(JSON.stringify(payload));
const signature = crypto
  .createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
  .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
  .digest('hex');
```

## Payload chuẩn hóa

```json
{
  "type": "payment.completed",
  "transactionId": "BANK-TXN-001",
  "transferContent": "THANH TOAN TB112233AABBCC",
  "bankAccount": "123456789",
  "amountVnd": 299000,
  "paidAt": "2026-08-25T01:30:00.000Z"
}
```

- `transactionId`: mã duy nhất của giao dịch tại nguồn.
- `transferContent`: phải chứa mã đơn dạng `TB` + 12 ký tự hex.
- `bankAccount`: tài khoản thực nhận; phải khớp snapshot trên đơn.
- `amountVnd`: số nguyên VND; phải khớp tuyệt đối số tiền trên đơn.
- `paidAt`: thời điểm giao dịch theo ISO 8601 và không được nằm trong tương lai.

TrọBill không lưu tên, tài khoản hoặc nội dung khác của người chuyển. Audit chỉ
giữ các trường cần đối soát, hash SHA-256 của raw payload và kết quả xác minh.

## Idempotency và kết quả

- Cặp `bank_transfer + X-Payment-Event-Id` chỉ được tạo một lần.
- Cặp `bank_transfer + transactionId` chỉ được gắn cho một payment.
- Event hoặc transaction gửi lại không gia hạn/nâng gói lần thứ hai.
- Chỉ khi mã đơn, tài khoản nhận, số tiền, thời hạn và trạng thái subscription
  đều hợp lệ thì payment được đánh dấu `paid` và subscription được cập nhật trong
  cùng transaction database.
- Giao dịch lệch tiền, sai tài khoản, quá hạn hoặc không ghép được trả `202` với
  `requiresReview: true`; hệ thống nguồn không cần retry vô hạn.
- Chữ ký sai hoặc timestamp hết hạn trả `401` và không ghi payload vào database.

Không gửi thử webhook đã ký vào Production bằng giao dịch giả. Dùng Preview và
database staging để kiểm thử adapter trước khi kết nối nguồn giao dịch thật.
