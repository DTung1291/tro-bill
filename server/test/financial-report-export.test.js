'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  annualEvidenceRows,
  buildPrintHtml,
  buildXlsx
} = require('../../financial-report-export');

const root = path.resolve(__dirname, '..', '..');

function sampleReport() {
  return {
    period: '2026-Q3',
    range: { type: 'quarter', key: '2026-Q3' },
    revenueVnd: 12345678,
    collectedVnd: 11000000,
    outstandingVnd: 1345678,
    expensesVnd: 2000000,
    profitVnd: 9000000,
    invoiceCount: 7,
    unpaidInvoiceCount: 1,
    breakdown: {
      invoice: {
        rentVnd: 9000000,
        electricityVnd: 1000000,
        waterVnd: 500000,
        servicesVnd: 1000000,
        discountVnd: 100000,
        surchargeVnd: 700000,
        lateFeeVnd: 245678,
        adjustmentNetVnd: 845678,
        uncategorizedVnd: 0
      },
      deposit: {
        collectedVnd: 4500000,
        refundedVnd: 500000,
        deductedVnd: 250000,
        netCashflowVnd: 4000000
      }
    },
    occupancy: {
      occupancyRatePercent: 91.6,
      roomCount: 7,
      calendarDays: 68,
      rentableRoomDays: 476,
      occupiedRoomDays: 436,
      vacantRoomDays: 40,
      reservedRoomDays: 0,
      maintenanceRoomDays: 0,
      longestVacantDays: 40,
      endingVacantRoomCount: 0,
      rooms: [{
        roomId: 'room-403',
        roomName: '=HYPERLINK("https://example.com")',
        propertyName: 'Khu <Vũ Hữu> & Nhà',
        occupancyRatePercent: 41.18,
        occupiedRoomDays: 28,
        vacantRoomDays: 40,
        reservedRoomDays: 0,
        maintenanceRoomDays: 0,
        longestVacantDays: 40,
        endingVacantDays: 0,
        endingStatus: 'occupied'
      }]
    }
  };
}

function annualSampleReport() {
  return {
    ...sampleReport(),
    period: '2026',
    range: { type: 'year', key: '2026' },
    annualRevenueEvidence: {
      year: 2026,
      basis: 'issued_invoice_total',
      currency: 'VND',
      activeMonthCount: 2,
      monthlyRevenueVnd: 12345678,
      reconciliationDifferenceVnd: 0,
      legalClassificationRequired: true,
      months: [
        {
          period: '2026-01', invoiceCount: 3, rentVnd: 4000000, electricityVnd: 400000,
          waterVnd: 200000, servicesVnd: 300000, adjustmentNetVnd: 100000,
          uncategorizedVnd: 0, revenueVnd: 5000000
        },
        {
          period: '2026-02', invoiceCount: 4, rentVnd: 5000000, electricityVnd: 600000,
          waterVnd: 300000, servicesVnd: 700000, adjustmentNetVnd: 745678,
          uncategorizedVnd: 0, revenueVnd: 7345678
        }
      ],
      locations: [{
        propertyId: 12,
        propertyName: 'Khu <A>',
        propertyAddress: '40 Vũ Hữu & Thanh Xuân',
        invoiceCount: 7,
        rentVnd: 9000000,
        electricityVnd: 1000000,
        waterVnd: 500000,
        servicesVnd: 1000000,
        adjustmentNetVnd: 845678,
        uncategorizedVnd: 0,
        revenueVnd: 12345678
      }]
    }
  };
}

function storedZipEntries(bytes) {
  const entries = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    assert.equal(method, 0, 'workbook phải dùng ZIP store để đọc ổn định không cần dependency');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.set(name, decoder.decode(bytes.slice(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return entries;
}

test('xuất workbook XLSX chuẩn OOXML với sheet tổng hợp và chi tiết phòng', () => {
  const bytes = buildXlsx(sampleReport(), {
    periodLabel: 'Quý 3/2026',
    scopeLabel: 'Tất cả khu',
    exportedAtLabel: '23:30 06/09/2026'
  });
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const entries = storedZipEntries(bytes);
  assert.deepEqual([...entries.keys()], [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml'
  ]);
  assert.match(entries.get('xl/workbook.xml'), /name="Tổng hợp"/);
  assert.match(entries.get('xl/workbook.xml'), /name="Chi tiết phòng"/);
  assert.match(entries.get('xl/worksheets/sheet1.xml'), /BÁO CÁO TÀI CHÍNH TRỌBILL/);
  assert.match(entries.get('xl/worksheets/sheet1.xml'), /<v>12345678<\/v>/);
  assert.match(entries.get('xl/worksheets/sheet1.xml'), /<v>0\.916<\/v>/);
  assert.match(entries.get('xl/worksheets/sheet2.xml'), /t="inlineStr"[^>]*><is><t xml:space="preserve">=HYPERLINK/);
  assert.match(entries.get('xl/worksheets/sheet2.xml'), /Khu &lt;Vũ Hữu&gt; &amp; Nhà/);
  assert.doesNotMatch(entries.get('xl/worksheets/sheet2.xml'), /<f>/);
});

test('mẫu PDF escape dữ liệu và tách bảng phòng để in nhiều trang', () => {
  const html = buildPrintHtml(sampleReport(), {
    periodLabel: 'Quý 3/2026',
    scopeLabel: '<script>alert(1)</script>',
    exportedAtLabel: '23:30 06/09/2026'
  });
  assert.match(html, /financial-report-print/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /<thead>/);
  assert.match(html, /Khu &lt;Vũ Hữu&gt; &amp; Nhà/);
  assert.match(html, /91,6%/);
});

test('báo cáo năm thêm sheet và nội dung PDF đối chiếu doanh thu theo tháng, khu', () => {
  const report = annualSampleReport();
  const rows = annualEvidenceRows(report, { scopeLabel: 'Tất cả khu' });
  assert.equal(rows[0][0].value, 'ĐỐI CHIẾU DOANH THU NĂM');
  assert.equal(rows[8][8].value, 5000000);

  const entries = storedZipEntries(buildXlsx(report, {
    periodLabel: 'Năm 2026', scopeLabel: 'Tất cả khu', exportedAtLabel: '07/09/2026'
  }));
  assert.match(entries.get('xl/workbook.xml'), /name="Đối chiếu doanh thu năm"/);
  assert.match(entries.get('xl/worksheets/sheet3.xml'), /Tổng hóa đơn đã phát hành trên Tro Bill/);
  assert.match(entries.get('xl/worksheets/sheet3.xml'), /Khu &lt;A&gt;/);
  assert.match(entries.get('xl/worksheets/sheet3.xml'), /40 Vũ Hữu &amp; Thanh Xuân/);
  assert.match(entries.get('xl/worksheets/sheet3.xml'), /<v>12345678<\/v>/);

  const html = buildPrintHtml(report, {
    periodLabel: 'Năm 2026', scopeLabel: 'Tất cả khu', exportedAtLabel: '07/09/2026'
  });
  assert.match(html, /Đối chiếu doanh thu năm 2026/);
  assert.match(html, /không thay thế tờ khai/);
  assert.match(html, /Khu &lt;A&gt;/);
  assert.match(html, /40 Vũ Hữu &amp; Thanh Xuân/);
});

test('UI nối nút Excel và PDF vào đúng báo cáo đã lọc cùng print CSS', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  assert.match(index, /id="financial-report-export-excel"/);
  assert.match(index, /id="financial-report-export-pdf"/);
  assert.match(index, /id="annual-revenue-evidence"/);
  assert.match(index, /id="annual-revenue-month-rows"/);
  assert.match(index, /id="annual-revenue-location-rows"/);
  assert.match(index, /financial-report-export\.js\?v=2[\s\S]*app\.js\?v=132/);
  assert.match(app, /FinancialReportExport\.buildXlsx\(report/);
  assert.match(app, /FinancialReportExport\.buildPrintHtml/);
  assert.match(app, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(app, /function renderAnnualRevenueEvidence/);
  assert.match(app, /annualRevenueEvidence/);
  assert.match(css, /body:has\(\.financial-report-print\)\s*\{\s*page: financialReport/);
  assert.match(css, /@page financialReport\s*\{[\s\S]*size: A4 landscape/);
  assert.match(css, /\.financial-report-print thead\s*\{\s*display: table-header-group/);
  assert.match(css, /\.annual-revenue-table-wrap\s*\{[\s\S]*overflow-x: auto/);
});
