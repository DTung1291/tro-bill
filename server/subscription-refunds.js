'use strict';

const db = require('./db');

const REQUEST_TYPES = new Set(['refund', 'mistaken_transfer']);
const ADMIN_STATUSES = new Set(['reviewing', 'approved', 'rejected', 'refunded']);
const TRANSITIONS = {
  pending: new Set(['reviewing', 'approved', 'rejected']),
  reviewing: new Set(['approved', 'rejected']),
  approved: new Set(['refunded', 'rejected'])
};

class RefundRequestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RefundRequestError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parsePositiveAmount(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999999999999) {
    throw new RefundRequestError(
      400,
      'INVALID_REFUND_AMOUNT',
      'Số tiền yêu cầu phải là số nguyên VND lớn hơn 0'
    );
  }
  return amount;
}

function validateReason(value, label = 'Lý do') {
  const reason = String(value || '').trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new RefundRequestError(
      400,
      'INVALID_REFUND_REASON',
      `${label} phải từ 10 đến 500 ký tự`
    );
  }
  return reason;
}

function refundRequestJson(row) {
  if (!row) return null;
  return {
    id: Number(row.id || row.refund_request_id),
    paymentId: Number(row.payment_id || row.id),
    requestType: row.request_type,
    requestedAmountVnd: Number(row.requested_amount_vnd),
    reason: row.reason,
    status: row.status || row.refund_status,
    adminNote: row.admin_note || '',
    refundReference: row.refund_reference || '',
    reviewedAt: row.reviewed_at,
    resolvedAt: row.resolved_at,
    refundedAt: row.refunded_at,
    createdAt: row.created_at || row.refund_created_at,
    updatedAt: row.updated_at || row.refund_updated_at
  };
}

function requestInput(req) {
  const requestType = String(req.body?.requestType || '').trim();
  if (!REQUEST_TYPES.has(requestType)) {
    throw new RefundRequestError(
      400,
      'INVALID_REFUND_REQUEST_TYPE',
      'Loại yêu cầu hoàn tiền không hợp lệ'
    );
  }
  return {
    paymentId: Number(req.params.paymentId),
    requestType,
    requestedAmountVnd: parsePositiveAmount(req.body?.requestedAmountVnd),
    reason: validateReason(req.body?.reason)
  };
}

function sendRefundError(res, error) {
  if (!(error instanceof RefundRequestError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

async function createRefundRequest(req, res) {
  let input;
  try {
    input = requestInput(req);
    if (!Number.isInteger(input.paymentId) || input.paymentId <= 0) {
      throw new RefundRequestError(400, 'INVALID_PAYMENT_ID', 'Mã payment không hợp lệ');
    }
  } catch (error) {
    if (sendRefundError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const paymentResult = await client.query(
      `SELECT sp.id, sp.user_id, sp.amount_vnd, sp.status, sp.provider_reference,
              p.code AS plan_code, p.name AS plan_name, u.email AS user_email
       FROM subscription_payments sp
       JOIN plans p ON p.id=sp.plan_id
       JOIN users u ON u.id=sp.user_id
       WHERE sp.id=$1 AND sp.user_id=$2
       LIMIT 1
       FOR UPDATE OF sp`,
      [input.paymentId, req.userId]
    );
    const payment = paymentResult.rows[0];
    if (!payment) {
      throw new RefundRequestError(404, 'PAYMENT_NOT_FOUND', 'Không tìm thấy payment');
    }
    if (payment.status === 'refunded') {
      throw new RefundRequestError(409, 'PAYMENT_ALREADY_REFUNDED', 'Payment đã được hoàn tiền');
    }
    if (input.requestType === 'refund') {
      if (payment.status !== 'paid') {
        throw new RefundRequestError(
          409,
          'PAYMENT_NOT_PAID',
          'Chỉ payment đã xác nhận mới có thể yêu cầu hoàn tiền'
        );
      }
      if (input.requestedAmountVnd > Number(payment.amount_vnd)) {
        throw new RefundRequestError(
          400,
          'REFUND_AMOUNT_EXCEEDS_PAYMENT',
          'Số tiền hoàn không được lớn hơn payment đã xác nhận'
        );
      }
    }

    const existingResult = await client.query(
      `SELECT id, status
       FROM subscription_refund_requests
       WHERE user_id=$1 AND payment_id=$2
         AND status IN ('pending', 'reviewing', 'approved', 'refunded')
       ORDER BY created_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [req.userId, input.paymentId]
    );
    const existing = existingResult.rows[0];
    if (existing) {
      const code = existing.status === 'refunded'
        ? 'PAYMENT_ALREADY_REFUNDED'
        : 'REFUND_REQUEST_ALREADY_OPEN';
      throw new RefundRequestError(
        409,
        code,
        existing.status === 'refunded'
          ? 'Payment đã có yêu cầu hoàn tiền hoàn tất'
          : 'Payment đang có một yêu cầu được xử lý'
      );
    }

    const inserted = await client.query(
      `INSERT INTO subscription_refund_requests
         (user_id, payment_id, request_type, requested_amount_vnd, reason)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        req.userId,
        input.paymentId,
        input.requestType,
        input.requestedAmountVnd,
        input.reason
      ]
    );
    const requestRow = inserted.rows[0];
    await client.query(
      `INSERT INTO subscription_change_logs
         (actor_user_id, actor_email_snapshot, target_user_id, target_email_snapshot,
          action, previous_plan_code, new_plan_code, reason, metadata)
       VALUES ($1,$2,$1,$2,'subscription_refund_requested',$3,$3,$4,$5::jsonb)`,
      [
        req.userId,
        payment.user_email,
        payment.plan_code,
        input.reason,
        JSON.stringify({
          requestId: Number(requestRow.id),
          paymentId: Number(payment.id),
          requestType: input.requestType,
          requestedAmountVnd: input.requestedAmountVnd
        })
      ]
    );
    await client.query('COMMIT');
    return res.status(201).json({ refundRequest: refundRequestJson(requestRow) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return res.status(409).json({
        error: 'Payment đang có một yêu cầu được xử lý',
        code: 'REFUND_REQUEST_ALREADY_OPEN'
      });
    }
    if (sendRefundError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function cancelRefundRequest(req, res) {
  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Mã yêu cầu không hợp lệ', code: 'INVALID_REFUND_REQUEST_ID' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT rr.*, sp.plan_id, p.code AS plan_code, u.email AS user_email
       FROM subscription_refund_requests rr
       JOIN subscription_payments sp ON sp.id=rr.payment_id AND sp.user_id=rr.user_id
       JOIN plans p ON p.id=sp.plan_id
       JOIN users u ON u.id=rr.user_id
       WHERE rr.id=$1 AND rr.user_id=$2
       LIMIT 1
       FOR UPDATE OF rr`,
      [requestId, req.userId]
    );
    const requestRow = found.rows[0];
    if (!requestRow) {
      throw new RefundRequestError(404, 'REFUND_REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu');
    }
    if (requestRow.status !== 'pending') {
      throw new RefundRequestError(
        409,
        'REFUND_REQUEST_CANNOT_CANCEL',
        'Chỉ yêu cầu đang chờ xử lý mới có thể hủy'
      );
    }
    const updated = await client.query(
      `UPDATE subscription_refund_requests
       SET status='canceled', resolved_at=now(), updated_at=now()
       WHERE id=$1
       RETURNING *`,
      [requestId]
    );
    await client.query(
      `INSERT INTO subscription_change_logs
         (actor_user_id, actor_email_snapshot, target_user_id, target_email_snapshot,
          action, previous_plan_code, new_plan_code, reason, metadata)
       VALUES ($1,$2,$1,$2,'subscription_refund_canceled',$3,$3,$4,$5::jsonb)`,
      [
        req.userId,
        requestRow.user_email,
        requestRow.plan_code,
        'Người dùng đã chủ động hủy yêu cầu hoàn tiền',
        JSON.stringify({ requestId, paymentId: Number(requestRow.payment_id) })
      ]
    );
    await client.query('COMMIT');
    return res.json({ refundRequest: refundRequestJson(updated.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (sendRefundError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function listAdminRefundRequests(req, res) {
  const requestedStatus = String(req.query?.status || 'active').trim();
  const allowedFilters = new Set([
    'active', 'all', 'pending', 'reviewing', 'approved', 'rejected', 'refunded', 'canceled'
  ]);
  if (!allowedFilters.has(requestedStatus)) {
    return res.status(400).json({ error: 'Bộ lọc trạng thái không hợp lệ', code: 'INVALID_REFUND_STATUS' });
  }
  const status = ['active', 'all'].includes(requestedStatus) ? null : requestedStatus;
  const activeOnly = requestedStatus === 'active';
  const { rows } = await db.query(
    `SELECT rr.*, u.email AS user_email, au.email AS current_admin_email,
            sp.provider_reference, sp.transfer_content, sp.amount_vnd AS payment_amount_vnd,
            sp.status AS payment_status, sp.paid_at, sp.settlement_provider,
            sp.settlement_reference, p.code AS plan_code, p.name AS plan_name
     FROM subscription_refund_requests rr
     JOIN users u ON u.id=rr.user_id
     LEFT JOIN users au ON au.id=rr.admin_user_id
     JOIN subscription_payments sp ON sp.id=rr.payment_id AND sp.user_id=rr.user_id
     JOIN plans p ON p.id=sp.plan_id
     WHERE ($1::text IS NULL OR rr.status=$1)
       AND ($2::boolean=false OR rr.status IN ('pending','reviewing','approved'))
     ORDER BY CASE rr.status
       WHEN 'pending' THEN 1 WHEN 'reviewing' THEN 2 WHEN 'approved' THEN 3 ELSE 4 END,
       rr.created_at ASC
     LIMIT 200`,
    [status, activeOnly]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({
    refundRequests: rows.map(row => ({
      ...refundRequestJson(row),
      userId: Number(row.user_id),
      userEmail: row.user_email,
      adminEmail: row.admin_email_snapshot || row.current_admin_email || '',
      payment: {
        id: Number(row.payment_id),
        orderReference: row.provider_reference || '',
        transferContent: row.transfer_content || '',
        amountVnd: Number(row.payment_amount_vnd),
        status: row.payment_status,
        paidAt: row.paid_at,
        settlementProvider: row.settlement_provider || '',
        settlementReference: row.settlement_reference || ''
      },
      plan: { code: row.plan_code, name: row.plan_name }
    }))
  });
}

function adminTransitionInput(req) {
  const status = String(req.body?.status || '').trim();
  if (!ADMIN_STATUSES.has(status)) {
    throw new RefundRequestError(400, 'INVALID_REFUND_STATUS', 'Trạng thái xử lý không hợp lệ');
  }
  const note = validateReason(req.body?.note, 'Ghi chú xử lý');
  const refundReference = String(req.body?.refundReference || '').trim();
  if (status === 'refunded' && (refundReference.length < 3 || refundReference.length > 100)) {
    throw new RefundRequestError(
      400,
      'INVALID_REFUND_REFERENCE',
      'Mã giao dịch hoàn tiền phải từ 3 đến 100 ký tự'
    );
  }
  return { status, note, refundReference: status === 'refunded' ? refundReference : null };
}

async function transitionAdminRefundRequest(req, res) {
  const requestId = Number(req.params.id);
  let input;
  try {
    if (!Number.isInteger(requestId) || requestId <= 0) {
      throw new RefundRequestError(400, 'INVALID_REFUND_REQUEST_ID', 'Mã yêu cầu không hợp lệ');
    }
    input = adminTransitionInput(req);
  } catch (error) {
    if (sendRefundError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT rr.*, u.email AS user_email, p.code AS plan_code
       FROM subscription_refund_requests rr
       JOIN users u ON u.id=rr.user_id
       JOIN subscription_payments sp ON sp.id=rr.payment_id AND sp.user_id=rr.user_id
       JOIN plans p ON p.id=sp.plan_id
       WHERE rr.id=$1
       LIMIT 1
       FOR UPDATE OF rr`,
      [requestId]
    );
    const requestRow = found.rows[0];
    if (!requestRow) {
      throw new RefundRequestError(404, 'REFUND_REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu');
    }
    if (!TRANSITIONS[requestRow.status]?.has(input.status)) {
      throw new RefundRequestError(
        409,
        'INVALID_REFUND_TRANSITION',
        `Không thể chuyển yêu cầu từ ${requestRow.status} sang ${input.status}`
      );
    }

    const updated = await client.query(
      `UPDATE subscription_refund_requests
       SET status=$2, admin_user_id=$3, admin_email_snapshot=$4, admin_note=$5,
           refund_reference=$6,
           reviewed_at=COALESCE(reviewed_at, now()),
           resolved_at=CASE WHEN $2 IN ('rejected','refunded') THEN now() ELSE NULL END,
           refunded_at=CASE WHEN $2='refunded' THEN now() ELSE NULL END,
           updated_at=now()
       WHERE id=$1
       RETURNING *`,
      [requestId, input.status, req.userId, req.userEmail, input.note, input.refundReference]
    );
    await client.query(
      `INSERT INTO subscription_change_logs
         (actor_user_id, actor_email_snapshot, target_user_id, target_email_snapshot,
          action, previous_plan_code, new_plan_code, reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8::jsonb)`,
      [
        req.userId,
        req.userEmail,
        requestRow.user_id,
        requestRow.user_email,
        `subscription_refund_${input.status}`,
        requestRow.plan_code,
        input.note,
        JSON.stringify({
          requestId,
          paymentId: Number(requestRow.payment_id),
          previousStatus: requestRow.status,
          newStatus: input.status,
          requestedAmountVnd: Number(requestRow.requested_amount_vnd),
          refundReference: input.refundReference || undefined
        })
      ]
    );
    await client.query('COMMIT');
    return res.json({ refundRequest: refundRequestJson(updated.rows[0]), audited: true });
  } catch (error) {
    await client.query('ROLLBACK');
    if (sendRefundError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  RefundRequestError,
  adminTransitionInput,
  cancelRefundRequest,
  createRefundRequest,
  listAdminRefundRequests,
  parsePositiveAmount,
  refundRequestJson,
  requestInput,
  transitionAdminRefundRequest
};
