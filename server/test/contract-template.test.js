'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require(path.join(__dirname, '..', '..', 'contract-template.js'));

const template = globalThis.ContractTemplate;

function sampleDocument() {
  return {
    contract: {
      id: 36,
      code: 'HD-2026-000010',
      roomId: 'room-1',
      roomName: 'P101',
      startsOn: '2026-08-10',
      endsOn: '2027-08-09',
      monthlyRentVnd: 3000000,
      depositVnd: 3000000,
      terms: 'Không nuôi thú cưng',
      amendments: [{
        code: 'PL-202610-000011',
        effectiveFrom: '2026-10',
        previousMonthlyRentVnd: 3000000,
        newMonthlyRentVnd: 3200000,
        reason: 'Điều chỉnh theo thỏa thuận hai bên'
      }]
    },
    tenant: {
      fullName: 'Nguyễn Văn A',
      phone: '0901234567',
      cccd: '048098001234',
      issueDate: '2021-05-10',
      address: 'Hải Châu, Đà Nẵng'
    }
  };
}

test('mẫu hợp đồng điền đúng dữ liệu, đủ 8 điều và phụ lục', () => {
  const html = template.build(sampleDocument(), {
    lessor: {
      fullName: 'Trần Thị B',
      cccd: '048199009999',
      issueDate: '2020-01-02',
      issuePlace: 'Cục CSQLHC',
      phone: '0911222333',
      address: 'Đà Nẵng'
    },
    propertyAddress: '40 Vũ Hữu, Hải Châu, Đà Nẵng',
    rentalPurpose: 'Để ở',
    maximumOccupants: 2,
    electricRate: 4000,
    waterRate: 20000,
    waterUnit: 'm³',
    wifiFee: 0,
    equipment: template.DEFAULT_EQUIPMENT
  });

  assert.match(html, /HD-2026-000010/);
  assert.match(html, /048098001234/);
  assert.match(html, /Ba triệu đồng/);
  assert.match(html, /PL-202610-000011/);
  for (let article = 1; article <= 8; article += 1) {
    assert.match(html, new RegExp(`ĐIỀU ${article}:`));
  }
  assert.equal((html.match(/<tr>/g) || []).length, 11);
});

test('mẫu hợp đồng escape toàn bộ dữ liệu nhập từ người dùng', () => {
  const documentData = sampleDocument();
  documentData.tenant.fullName = '<img src=x onerror=alert(1)>';
  documentData.contract.terms = '<script>alert(1)</script>';
  const html = template.build(documentData, {
    lessor: { fullName: '<b>owner</b>' },
    propertyAddress: '<svg onload=alert(1)>',
    equipment: [['<script>', 1, '<img>']]
  });
  assert.doesNotMatch(html, /<script>|<img src=x|<svg onload|<b>owner/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
});

test('đổi số tiền VND sang chữ cho các mốc thường dùng', () => {
  assert.equal(template.moneyInWords(0), 'Không đồng');
  assert.equal(template.moneyInWords(3000000), 'Ba triệu đồng');
  assert.equal(template.moneyInWords(3200000), 'Ba triệu hai trăm nghìn đồng');
  assert.equal(template.moneyInWords(1005000), 'Một triệu không trăm lẻ năm nghìn đồng');
});
