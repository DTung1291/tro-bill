'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-contract-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  amendmentCode,
  amendmentInput,
  changeContractStatus,
  contractCode,
  contractDocumentJson,
  contractInput,
  createAmendment,
  createContract,
  documentPurposeInput,
  getContractDocument,
  listContracts,
  restoreContractRateMilestones,
  statusInput
} = require('../rental-contracts');

const root = path.join(__dirname, '..', '..');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[String(name).toLowerCase()] = value; return res; }
  };
  return { record, res };
}

function contractRow(overrides = {}) {
  return {
    id: 36,
    user_id: 7,
    contract_code: 'HD-2026-000010',
    room_id: 'room-1',
    room_name_snapshot: 'P101',
    tenant_id: 'tenant-1',
    tenant_name_snapshot: 'Nguyễn Văn A',
    tenant_phone_snapshot: '0901234567',
    tenant_cccd_snapshot: '048098001234',
    tenant_issue_date_snapshot: '2021-05-10',
    tenant_dob_snapshot: '1998-03-24',
    tenant_gender_snapshot: 'Nam',
    tenant_address_snapshot: 'Hải Châu, Đà Nẵng',
    status: 'active',
    starts_on: '2026-08-10',
    ends_on: '2027-08-09',
    billing_cycle_months: 3,
    payment_due_day: 10,
    monthly_rent_vnd: '3000000',
    deposit_vnd: '3000000',
    terms: 'Thanh toán trước ngày 5 hàng tháng',
    status_reason: '',
    activated_at: '2026-08-27T01:00:00.000Z',
    ended_at: null,
    cancelled_at: null,
    created_at: '2026-08-27T01:00:00.000Z',
    updated_at: '2026-08-27T01:00:00.000Z',
    ...overrides
  };
}

function rateRow(overrides = {}) {
  return {
    user_id: 7,
    room_id: 'room-1',
    effective_from: '2026-08',
    rent_price: '3000000',
    electric_rate: '3500',
    water_rate: '50000',
    trash_fee: '50000',
    wifi_fee: '40000',
    manage_fee: '0',
    ...overrides
  };
}

function activeContractRequest(body = {}) {
  return {
    userId: 7,
    params: {},
    query: {},
    body: {
      roomId: 'room-1',
      tenantId: 'tenant-1',
      status: 'active',
      startsOn: '2026-08-10',
      endsOn: '2027-08-09',
      billingCycleMonths: 3,
      paymentDueDay: 10,
      monthlyRentVnd: 3000000,
      depositVnd: 3000000,
      terms: 'Thanh toán trước ngày 5 hàng tháng',
      ...body
    }
  };
}

test('input hợp đồng, phụ lục và chuyển trạng thái được giới hạn chặt', () => {
  const parsedContract = contractInput(activeContractRequest().body);
  assert.equal(parsedContract.monthlyRentVnd, 3000000);
  assert.equal(parsedContract.billingCycleMonths, 3);
  assert.equal(parsedContract.paymentDueDay, 10);
  assert.equal(contractCode(36, '2026-08-10'), 'HD-2026-000010');
  assert.equal(amendmentCode(37, '2026-10'), 'PL-202610-000011');
  assert.equal(documentPurposeInput({ purpose: 'In hợp đồng để hai bên ký' }), 'In hợp đồng để hai bên ký');
  assert.throws(
    () => contractInput(activeContractRequest({ startsOn: '2026-02-30' }).body),
    (error) => error.code === 'INVALID_CONTRACT_DATE'
  );
  assert.throws(
    () => contractInput(activeContractRequest({ endsOn: '2026-08-01' }).body),
    (error) => error.code === 'INVALID_CONTRACT_DATE_RANGE'
  );
  assert.throws(
    () => contractInput(activeContractRequest({ billingCycleMonths: 2 }).body),
    (error) => error.code === 'INVALID_CONTRACT_BILLING_CYCLE'
  );
  assert.throws(
    () => contractInput(activeContractRequest({ paymentDueDay: 29 }).body),
    (error) => error.code === 'INVALID_CONTRACT_PAYMENT_DUE_DAY'
  );
  assert.throws(
    () => amendmentInput({ effectiveFrom: '2026-13', newMonthlyRentVnd: 3200000, reason: 'Đủ mười ký tự' }),
    (error) => error.code === 'INVALID_AMENDMENT_PERIOD'
  );
  assert.throws(
    () => statusInput({ status: 'ended', reason: 'ngắn' }),
    (error) => error.code === 'INVALID_CONTRACT_STATUS_REASON'
  );
  assert.throws(
    () => documentPurposeInput({ purpose: 'in' }),
    (error) => error.code === 'INVALID_CONTRACT_DOCUMENT_PURPOSE'
  );
});

test('tạo hợp đồng active khóa đúng phòng/khách và đồng bộ mốc giá trong một transaction', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rooms room') && sql.includes('JOIN tenants tenant')) {
        return { rows: [{
          room_id: 'room-1',
          room_name: 'P101',
          tenant_id: 'tenant-1',
          tenant_name: 'Nguyễn Văn A',
          tenant_phone: '0901234567',
          tenant_cccd: '048098001234',
          tenant_issue_date: '2021-05-10',
          tenant_dob: '1998-03-24',
          tenant_gender: 'Nam',
          tenant_address: 'Hải Châu, Đà Nẵng'
        }] };
      }
      if (sql.includes("nextval('rental_contracts_id_seq')")) return { rows: [{ id: 36 }] };
      if (sql.includes('INSERT INTO rental_contracts')) return { rows: [contractRow()] };
      if (sql.includes('FROM room_rate_history')) return { rows: [rateRow({ rent_price: '2800000' })] };
      if (sql.includes('INSERT INTO room_rate_history')) return { rows: [rateRow()] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createContract(activeContractRequest(), response.res, {
    getClient: async () => client,
    enforceWrite: async () => ({ accessMode: 'full' })
  });

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.contract.code, 'HD-2026-000010');
  assert.equal(response.record.body.contract.status, 'active');
  assert.equal(response.record.body.contract.billingCycleMonths, 3);
  assert.equal(response.record.body.contract.paymentDueDay, 10);
  assert.equal(response.record.body.rate.rentPrice, 3000000);
  const owner = calls.find(call => call.sql.includes('JOIN tenants tenant'));
  assert.deepEqual(owner.params, [7, 'room-1', 'tenant-1']);
  assert.match(owner.sql, /room\.user_id=\$1/);
  assert.match(owner.sql, /tenant\.user_id=room\.user_id/);
  const contractInsert = calls.find(call => call.sql.includes('INSERT INTO rental_contracts'));
  assert.deepEqual(contractInsert.params.slice(7, 13), [
    '0901234567',
    '048098001234',
    '2021-05-10',
    '1998-03-24',
    'Nam',
    'Hải Châu, Đà Nẵng'
  ]);
  assert.deepEqual(contractInsert.params.slice(16, 18), [3, 10]);
  const rateInsert = calls.find(call => call.sql.includes('INSERT INTO room_rate_history'));
  assert.equal(rateInsert.params[2], '2026-08');
  assert.equal(rateInsert.params[3], 3000000);
  const roomUpdate = calls.find(call => call.sql.includes('UPDATE rooms'));
  assert.equal(roomUpdate.params[4], '2026-08-10');
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
  assert.equal(calls.some(call => /DELETE FROM rental_contract/.test(call.sql)), false);
});

test('phụ lục active là append-only và tạo mốc giá mới cho công thức hóa đơn', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rental_contracts') && sql.includes('FOR UPDATE')) {
        return { rows: [contractRow()] };
      }
      if (sql.includes('FROM rental_contract_amendments')) return { rows: [] };
      if (sql.includes("nextval('rental_contract_amendments_id_seq')")) return { rows: [{ id: 37 }] };
      if (sql.includes('INSERT INTO rental_contract_amendments')) {
        return { rows: [{
          id: 37,
          user_id: 7,
          contract_id: 36,
          amendment_code: 'PL-202610-000011',
          effective_from: '2026-10',
          previous_monthly_rent_vnd: '3000000',
          new_monthly_rent_vnd: '3200000',
          reason: 'Điều chỉnh theo thỏa thuận hai bên',
          created_at: '2026-08-27T01:00:00.000Z'
        }] };
      }
      if (sql.includes('FROM room_rate_history')) return { rows: [rateRow()] };
      if (sql.includes('INSERT INTO room_rate_history')) {
        return { rows: [rateRow({ effective_from: '2026-10', rent_price: '3200000' })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createAmendment({
    userId: 7,
    params: { id: '36' },
    body: {
      effectiveFrom: '2026-10',
      newMonthlyRentVnd: 3200000,
      reason: 'Điều chỉnh theo thỏa thuận hai bên'
    }
  }, response.res, {
    getClient: async () => client,
    enforceWrite: async () => ({ accessMode: 'full' })
  });

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.amendment.code, 'PL-202610-000011');
  assert.equal(response.record.body.amendment.previousMonthlyRentVnd, 3000000);
  assert.equal(response.record.body.rate.effectiveFrom, '2026-10');
  const insert = calls.find(call => call.sql.includes('INSERT INTO rental_contract_amendments'));
  assert.deepEqual(insert.params.slice(4), [
    '2026-10',
    3000000,
    3200000,
    'Điều chỉnh theo thỏa thuận hai bên'
  ]);
  assert.equal(calls.some(call => /UPDATE rental_contract_amendments|DELETE FROM rental_contract_amendments/.test(call.sql)), false);
});

test('kết thúc hợp đồng chỉ cập nhật trạng thái thuộc đúng user và giữ nguyên hồ sơ', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rental_contracts') && sql.includes('FOR UPDATE')) {
        return { rows: [contractRow()] };
      }
      if (sql.includes('UPDATE rental_contracts')) {
        return { rows: [contractRow({
          status: 'ended',
          status_reason: 'Khách đã hoàn tất trả phòng',
          ended_at: '2026-08-27T02:00:00.000Z'
        })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await changeContractStatus({
    userId: 7,
    params: { id: '36' },
    body: { status: 'ended', reason: 'Khách đã hoàn tất trả phòng' }
  }, response.res, {
    getClient: async () => client,
    enforceWrite: async () => ({ accessMode: 'full' })
  });

  assert.equal(response.record.body.contract.status, 'ended');
  assert.equal(response.record.body.contract.statusReason, 'Khách đã hoàn tất trả phòng');
  const update = calls.find(call => call.sql.includes('UPDATE rental_contracts'));
  assert.deepEqual(update.params, [7, 36, 'ended', 'Khách đã hoàn tất trả phòng']);
  assert.match(update.sql, /WHERE user_id=\$1 AND id=\$2/);
  assert.equal(calls.some(call => /DELETE FROM rental_contracts/.test(call.sql)), false);
});

test('danh sách hợp đồng chỉ lấy dữ liệu thuộc user và ghép phụ lục đúng contract', async () => {
  const calls = [];
  const response = responseRecorder();
  await listContracts({ userId: 7, query: { roomId: 'room-1' } }, response.res, {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM rental_contracts')) return { rows: [contractRow()] };
      return { rows: [{
        id: 37,
        contract_id: 36,
        amendment_code: 'PL-202610-000011',
        effective_from: '2026-10',
        previous_monthly_rent_vnd: '3000000',
        new_monthly_rent_vnd: '3200000',
        reason: 'Điều chỉnh theo thỏa thuận hai bên',
        created_at: '2026-08-27T01:00:00.000Z'
      }] };
    }
  });
  assert.equal(response.record.body.contracts[0].currentMonthlyRentVnd, 3200000);
  assert.equal(response.record.body.contracts[0].amendments.length, 1);
  assert.match(calls[0].sql, /WHERE user_id=\$1/);
  assert.doesNotMatch(calls[0].sql, /tenant_cccd_snapshot/);
  assert.equal('tenant' in response.record.body.contracts[0], false);
  assert.deepEqual(calls[0].params, [7, 'room-1']);
  assert.match(calls[1].sql, /WHERE user_id=\$1 AND contract_id=ANY/);
});

test('bản hợp đồng chỉ mở snapshot CCCD sau lý do hợp lệ và ghi audit không chứa CCCD', async () => {
  const calls = [];
  const response = responseRecorder();
  await getContractDocument({
    userId: 7,
    userEmail: 'owner@example.com',
    params: { id: '36' },
    body: { purpose: 'In hai bản để chủ trọ và khách thuê ký' },
    headers: { 'user-agent': 'node-test' },
    get(name) { return this.headers[String(name).toLowerCase()] || ''; },
    ip: '127.0.0.1'
  }, response.res, {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rental_contracts')) return { rows: [contractRow()] };
      if (sql.includes('FROM rental_contract_amendments')) return { rows: [] };
      return { rows: [] };
    }
  });

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.tenant.cccd, '048098001234');
  assert.equal(response.record.body.contract.code, 'HD-2026-000010');
  assert.equal(response.record.body.audited, true);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(response.record.headers.pragma, 'no-cache');
  const audit = calls.find(call => call.sql.includes('INSERT INTO data_audit_logs'));
  assert.equal(audit.params[3], 'rental_contract_document_export');
  assert.equal(audit.params[4], 'rental_contract');
  assert.equal(audit.params[5], '36');
  assert.equal(audit.params[7], 'In hai bản để chủ trọ và khách thuê ký');
  assert.equal(audit.params.includes('048098001234'), false);
});

test('bản hợp đồng không cho user đọc hợp đồng của tài khoản khác', async () => {
  const response = responseRecorder();
  await getContractDocument({
    userId: 8,
    userEmail: 'other@example.com',
    params: { id: '36' },
    body: { purpose: 'Kiểm tra bản hợp đồng trước khi ký' }
  }, response.res, { query: async () => ({ rows: [] }) });
  assert.equal(response.record.statusCode, 404);
  assert.equal(response.record.body.code, 'CONTRACT_NOT_FOUND');
});

test('JSON bản hợp đồng dùng snapshot bất biến và không làm biến đổi hợp đồng công khai', () => {
  const row = contractRow();
  const documentResult = contractDocumentJson(row, []);
  assert.equal(documentResult.tenant.fullName, 'Nguyễn Văn A');
  assert.equal(documentResult.tenant.cccd, '048098001234');
  assert.equal(documentResult.contract.tenantName, 'Nguyễn Văn A');
  assert.equal('tenantCccd' in documentResult.contract, false);
});

test('lưu state cũ vẫn phục hồi đủ mốc giá bất biến từ hợp đồng và phụ lục', async () => {
  const calls = [];
  let eventQueryDone = false;
  const restored = await restoreContractRateMilestones(async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM rental_contracts contract') && sql.includes('UNION ALL')) {
      eventQueryDone = true;
      return { rows: [
        {
          contract_id: 36,
          room_id: 'room-1',
          effective_from: '2026-08',
          rent_vnd: '3000000',
          rent_start_date: '2026-08-10'
        },
        {
          contract_id: 36,
          room_id: 'room-1',
          effective_from: '2026-10',
          rent_vnd: '3200000',
          rent_start_date: null
        }
      ] };
    }
    if (sql.includes('FROM room_rate_history')) {
      return { rows: [rateRow({ rent_price: '2800000' })] };
    }
    if (sql.includes('INSERT INTO room_rate_history')) {
      return { rows: [rateRow({
        effective_from: params[2],
        rent_price: String(params[3])
      })] };
    }
    return { rows: [] };
  }, 7);

  assert.equal(eventQueryDone, true);
  assert.equal(restored.length, 2);
  assert.deepEqual(restored.map(rate => [rate.effectiveFrom, rate.rentPrice]), [
    ['2026-08', 3000000],
    ['2026-10', 3200000]
  ]);
  const roomUpdates = calls.filter(call => call.sql.includes('UPDATE rooms'));
  assert.equal(roomUpdates.length, 2);
  assert.equal(roomUpdates[0].params[4], '2026-08-10');
  assert.equal(roomUpdates[1].params[4], '');
});

test('schema, migration, API và UI có hợp đồng cùng phụ lục giá bất biến', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260827_rental_contracts.sql'),
    'utf8'
  );
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const documentMigration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260827_contract_document_templates.sql'),
    'utf8'
  );
  const paymentCycleMigration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260828_contract_payment_cycles.sql'),
    'utf8'
  );
  const cycleSource = fs.readFileSync(path.join(root, 'rental-contract-cycle.js'), 'utf8');
  const contractTemplate = fs.readFileSync(path.join(root, 'contract-template.js'), 'utf8');

  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS rental_contracts/);
    assert.match(source, /CREATE TABLE IF NOT EXISTS rental_contract_amendments/);
    assert.match(source, /rental_contract_amendments_contract_owner_fk/);
    assert.match(source, /rental_contracts_code_valid/);
    assert.match(source, /rental_contract_amendments_code_valid/);
    assert.match(source, /idx_rental_contracts_one_active_room/);
    assert.match(source, /GRANT UPDATE \(status, status_reason, activated_at, ended_at, cancelled_at, updated_at\) ON rental_contracts/);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE[^\n]*rental_contract_amendments/);
    assert.match(source, /GRANT SELECT, INSERT ON rental_contract_amendments/);
  }
  assert.doesNotMatch(schema, /room_id\s+TEXT NOT NULL REFERENCES rooms/);
  assert.match(serverSource, /\/api\/rental-contracts\/\:id\/amendments/);
  assert.match(serverSource, /\/api\/rental-contracts\/\:id\/document/);
  assert.match(apiSource, /function createRentalContractAmendment/);
  assert.match(apiSource, /function getRentalContractDocument/);
  assert.match(appSource, /function openRentalContractModal/);
  assert.match(appSource, /function applyContractRateToRoom/);
  assert.match(html, /id="rental-contract-modal"/);
  assert.match(html, /id="rental-contract-form"/);
  assert.match(html, /id="rental-contract-document-modal"/);
  assert.match(html, /rental-contract-cycle\.js\?v=2/);
  assert.match(html, /contract-template\.js\?v=2/);
  assert.match(css, /\.modal\.rental-contract-modal/);
  assert.match(css, /\.rental-contract-document/);
  assert.match(css, /@page rentalContract/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.rental-contract-form-grid/);
  assert.match(documentMigration, /tenant_cccd_snapshot/);
  assert.match(documentMigration, /rental_contracts_tenant_document_snapshot_valid/);
  assert.match(paymentCycleMigration, /billing_cycle_months/);
  assert.match(paymentCycleMigration, /rental_contracts_payment_schedule_valid/);
  assert.match(cycleSource, /nextPaymentDueOn/);
  assert.match(appSource, /rentalContractNextPaymentLabel/);
  assert.match(html, /id="rental-contract-billing-cycle"/);
  assert.match(html, /id="rental-contract-payment-due-day"/);
  assert.match(contractTemplate, /HỢP ĐỒNG THUÊ VÀ CHO THUÊ PHÒNG Ở/);
  assert.match(contractTemplate, /ĐIỀU 8: THỎA THUẬN CHUNG/);
  assert.match(contractTemplate, /Trang thiết bị kèm theo phòng/);
});
