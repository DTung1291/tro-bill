(function initFinancialReportExport(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FinancialReportExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function financialReportExportFactory() {
  'use strict';

  const STATUS_LABELS = {
    occupied: 'Có khách',
    reserved: 'Giữ chỗ',
    maintenance: 'Đang sửa',
    vacant: 'Trống'
  };

  function text(value) {
    return String(value === undefined || value === null ? '' : value);
  }

  function number(value) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : 0;
  }

  function xmlEscape(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function htmlEscape(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function columnName(index) {
    let value = index + 1;
    let result = '';
    while (value > 0) {
      const remainder = (value - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      value = Math.floor((value - 1) / 26);
    }
    return result;
  }

  function stringCell(value, style = 0) {
    return { value: text(value), type: 'string', style };
  }

  function numberCell(value, style = 0) {
    return { value: number(value), type: 'number', style };
  }

  function percentageCell(value) {
    return numberCell(Math.round(number(value) * 100) / 10000, 3);
  }

  function reportRows(report = {}, context = {}) {
    const invoice = report.breakdown?.invoice || {};
    const deposit = report.breakdown?.deposit || {};
    const occupancy = report.occupancy || {};
    return [
      [stringCell('BÁO CÁO TÀI CHÍNH TRỌBILL', 1)],
      [stringCell('Kỳ báo cáo', 1), stringCell(context.periodLabel || report.period)],
      [stringCell('Phạm vi', 1), stringCell(context.scopeLabel || 'Tất cả khu')],
      [stringCell('Thời điểm xuất', 1), stringCell(context.exportedAtLabel || '')],
      [],
      [stringCell('TỔNG QUAN', 1)],
      [stringCell('Chỉ tiêu', 1), stringCell('Giá trị (VND)', 1), stringCell('Ghi chú', 1)],
      [stringCell('Doanh thu hóa đơn'), numberCell(report.revenueVnd, 2), stringCell(`${number(report.invoiceCount)} hóa đơn phát hành`)],
      [stringCell('Thực thu'), numberCell(report.collectedVnd, 2), stringCell('Tiền thực nhận trong kỳ')],
      [stringCell('Công nợ cuối kỳ'), numberCell(report.outstandingVnd, 2), stringCell(`${number(report.unpaidInvoiceCount)} hóa đơn còn thiếu`)],
      [stringCell('Chi phí thực tế'), numberCell(report.expensesVnd, 2), stringCell('Khoản đã trả trong kỳ')],
      [stringCell('Lợi nhuận tiền mặt'), numberCell(report.profitVnd, 2), stringCell('Thực thu trừ chi phí thực tế')],
      [],
      [stringCell('CƠ CẤU HÓA ĐƠN', 1)],
      [stringCell('Tiền thuê'), numberCell(invoice.rentVnd, 2)],
      [stringCell('Tiền điện'), numberCell(invoice.electricityVnd, 2)],
      [stringCell('Tiền nước'), numberCell(invoice.waterVnd, 2)],
      [stringCell('Dịch vụ'), numberCell(invoice.servicesVnd, 2)],
      [stringCell('Giảm giá'), numberCell(invoice.discountVnd, 2)],
      [stringCell('Phụ thu'), numberCell(invoice.surchargeVnd, 2)],
      [stringCell('Phí chậm thanh toán'), numberCell(invoice.lateFeeVnd, 2)],
      [stringCell('Điều chỉnh ròng'), numberCell(invoice.adjustmentNetVnd, 2)],
      [stringCell('Chưa phân loại'), numberCell(invoice.uncategorizedVnd, 2)],
      [],
      [stringCell('TIỀN CỌC', 1)],
      [stringCell('Thu cọc'), numberCell(deposit.collectedVnd, 2)],
      [stringCell('Hoàn cọc'), numberCell(deposit.refundedVnd, 2)],
      [stringCell('Khấu trừ cọc'), numberCell(deposit.deductedVnd, 2)],
      [stringCell('Dòng tiền cọc thuần'), numberCell(deposit.netCashflowVnd, 2)],
      [],
      [stringCell('LẤP ĐẦY', 1)],
      [stringCell('Tỷ lệ lấp đầy'), percentageCell(occupancy.occupancyRatePercent)],
      [stringCell('Số phòng hiện tại'), numberCell(occupancy.roomCount)],
      [stringCell('Số ngày đã quan sát'), numberCell(occupancy.calendarDays)],
      [stringCell('Ngày-phòng có thể cho thuê'), numberCell(occupancy.rentableRoomDays)],
      [stringCell('Ngày-phòng có khách'), numberCell(occupancy.occupiedRoomDays)],
      [stringCell('Ngày-phòng trống'), numberCell(occupancy.vacantRoomDays)],
      [stringCell('Ngày-phòng giữ chỗ'), numberCell(occupancy.reservedRoomDays)],
      [stringCell('Ngày-phòng đang sửa'), numberCell(occupancy.maintenanceRoomDays)],
      [stringCell('Chuỗi trống dài nhất'), numberCell(occupancy.longestVacantDays)],
      [stringCell('Phòng trống cuối kỳ'), numberCell(occupancy.endingVacantRoomCount)]
    ];
  }

  function roomRows(report = {}) {
    const rooms = Array.isArray(report.occupancy?.rooms) ? report.occupancy.rooms : [];
    return [
      [
        'Phòng', 'Khu', 'Lấp đầy', 'Có khách', 'Trống', 'Giữ chỗ', 'Đang sửa',
        'Chuỗi trống dài nhất', 'Trống cuối kỳ', 'Trạng thái cuối kỳ'
      ].map(value => stringCell(value, 1)),
      ...rooms.map(room => [
        stringCell(room.roomName || room.roomId),
        stringCell(room.propertyName),
        percentageCell(room.occupancyRatePercent),
        numberCell(room.occupiedRoomDays),
        numberCell(room.vacantRoomDays),
        numberCell(room.reservedRoomDays),
        numberCell(room.maintenanceRoomDays),
        numberCell(room.longestVacantDays),
        numberCell(room.endingVacantDays),
        stringCell(STATUS_LABELS[room.endingStatus] || 'Trống')
      ])
    ];
  }

  function annualEvidenceRows(report = {}, context = {}) {
    const evidence = report.annualRevenueEvidence || {};
    const months = Array.isArray(evidence.months) ? evidence.months : [];
    const locations = Array.isArray(evidence.locations) ? evidence.locations : [];
    const revenueColumns = row => [
      numberCell(row.invoiceCount),
      numberCell(row.rentVnd, 2),
      numberCell(row.electricityVnd, 2),
      numberCell(row.waterVnd, 2),
      numberCell(row.servicesVnd, 2),
      numberCell(row.adjustmentNetVnd, 2),
      numberCell(row.uncategorizedVnd, 2),
      numberCell(row.revenueVnd, 2)
    ];
    return [
      [stringCell('ĐỐI CHIẾU DOANH THU NĂM', 1)],
      [stringCell('Năm', 1), stringCell(evidence.year || report.period)],
      [stringCell('Phạm vi', 1), stringCell(context.scopeLabel || 'Tất cả khu')],
      [stringCell('Cơ sở số liệu', 1), stringCell('Tổng hóa đơn đã phát hành trên Tro Bill')],
      [stringCell('Lưu ý', 1), stringCell('Tài liệu đối chiếu, không thay thế tờ khai và không tự xác định doanh thu chịu thuế.')],
      [],
      ['THEO THÁNG'].map(value => stringCell(value, 1)),
      [
        'Tháng', 'Số hóa đơn', 'Tiền thuê', 'Tiền điện', 'Tiền nước', 'Dịch vụ',
        'Điều chỉnh ròng', 'Chưa phân loại', 'Tổng doanh thu hóa đơn'
      ].map(value => stringCell(value, 1)),
      ...months.map(month => [stringCell(month.period), ...revenueColumns(month)]),
      [
        stringCell('Tổng năm', 1),
        numberCell(months.reduce((total, month) => total + number(month.invoiceCount), 0), 1),
        ...[
          'rentVnd', 'electricityVnd', 'waterVnd', 'servicesVnd', 'adjustmentNetVnd',
          'uncategorizedVnd', 'revenueVnd'
        ].map(key => numberCell(months.reduce((total, month) => total + number(month[key]), 0), 2))
      ],
      [],
      ['THEO KHU / ĐỊA ĐIỂM'].map(value => stringCell(value, 1)),
      [
        'Khu', 'Địa chỉ', 'Số hóa đơn', 'Tiền thuê', 'Tiền điện', 'Tiền nước',
        'Dịch vụ', 'Điều chỉnh ròng', 'Chưa phân loại', 'Tổng doanh thu hóa đơn'
      ].map(value => stringCell(value, 1)),
      ...locations.map(location => [
        stringCell(location.propertyName || 'Chưa xác định khu'),
        stringCell(location.propertyAddress),
        ...revenueColumns(location)
      ])
    ];
  }

  function worksheetXml(rows, options = {}) {
    const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 1);
    const lastCell = `${columnName(maxColumns - 1)}${Math.max(rows.length, 1)}`;
    const data = rows.map((row, rowIndex) => {
      const cells = row.map((cell, columnIndex) => {
        if (!cell) return '';
        const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
        const style = cell.style ? ` s="${cell.style}"` : '';
        if (cell.type === 'number') {
          return `<c r="${ref}"${style}><v>${number(cell.value)}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(cell.value)}</t></is></c>`;
      }).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    const columns = (options.widths || []).map((width, index) => (
      `<col min="${index + 1}" max="${index + 1}" width="${number(width)}" customWidth="1"/>`
    )).join('');
    const freeze = options.freezeHeader
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    const filter = options.freezeHeader && rows.length
      ? `<autoFilter ref="A1:${lastCell}"/>`
      : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCell}"/>${freeze}<sheetFormatPr defaultRowHeight="15"/>
${columns ? `<cols>${columns}</cols>` : ''}<sheetData>${data}</sheetData>${filter}
<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;
  }

  function uint32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
  }

  function uint16(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
  }

  function joinBytes(parts) {
    const size = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    parts.forEach(part => {
      output.set(part, offset);
      offset += part.length;
    });
    return output;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipStore(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    files.forEach(file => {
      const name = encoder.encode(file.name);
      const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);
      const localHeader = joinBytes([
        uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0x21),
        uint32(crc), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name
      ]);
      localParts.push(localHeader, data);
      centralParts.push(joinBytes([
        uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0x21),
        uint32(crc), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
        uint16(0), uint16(0), uint32(0), uint32(offset), name
      ]));
      offset += localHeader.length + data.length;
    });
    const central = joinBytes(centralParts);
    const end = joinBytes([
      uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length),
      uint32(central.length), uint32(offset), uint16(0)
    ]);
    return joinBytes([...localParts, central, end]);
  }

  function buildXlsx(report = {}, context = {}) {
    const summarySheet = worksheetXml(reportRows(report, context), { widths: [30, 22, 42] });
    const detailSheet = worksheetXml(roomRows(report), {
      freezeHeader: true,
      widths: [15, 24, 13, 13, 13, 13, 13, 22, 18, 22]
    });
    const sheets = [
      { name: 'Tổng hợp', data: summarySheet },
      { name: 'Chi tiết phòng', data: detailSheet }
    ];
    if (report.annualRevenueEvidence) {
      sheets.push({
        name: 'Đối chiếu doanh thu năm',
        data: worksheetXml(annualEvidenceRows(report, context), {
          widths: [22, 34, 13, 18, 18, 18, 18, 19, 18, 24]
        })
      });
    }
    const worksheetOverrides = sheets.map((sheet, index) => (
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )).join('');
    const workbookSheets = sheets.map((sheet, index) => (
      `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    )).join('');
    const worksheetRelationships = sheets.map((sheet, index) => (
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )).join('');
    return zipStore([
      {
        name: '[Content_Types].xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${worksheetOverrides}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
      },
      {
        name: '_rels/.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
      },
      {
        name: 'xl/workbook.xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${workbookSheets}</sheets>
</workbook>`
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${worksheetRelationships}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
      },
      {
        name: 'xl/styles.xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0 &quot;₫&quot;"/><numFmt numFmtId="165" formatCode="0.00%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
      },
      ...sheets.map((sheet, index) => ({
        name: `xl/worksheets/sheet${index + 1}.xml`,
        data: sheet.data
      }))
    ]);
  }

  function vnd(value) {
    return `${Math.round(number(value)).toLocaleString('vi-VN')} đ`;
  }

  function percent(value) {
    return `${number(value).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%`;
  }

  function buildPrintHtml(report = {}, context = {}) {
    const invoice = report.breakdown?.invoice || {};
    const deposit = report.breakdown?.deposit || {};
    const occupancy = report.occupancy || {};
    const rooms = Array.isArray(occupancy.rooms) ? occupancy.rooms : [];
    const annualEvidence = report.annualRevenueEvidence || null;
    const annualMonths = Array.isArray(annualEvidence?.months) ? annualEvidence.months : [];
    const annualLocations = Array.isArray(annualEvidence?.locations) ? annualEvidence.locations : [];
    const metricRows = [
      ['Doanh thu hóa đơn', report.revenueVnd], ['Thực thu', report.collectedVnd],
      ['Công nợ cuối kỳ', report.outstandingVnd], ['Chi phí thực tế', report.expensesVnd],
      ['Lợi nhuận tiền mặt', report.profitVnd]
    ];
    const breakdownRows = [
      ['Tiền thuê', invoice.rentVnd], ['Tiền điện', invoice.electricityVnd],
      ['Tiền nước', invoice.waterVnd], ['Dịch vụ', invoice.servicesVnd],
      ['Giảm giá', invoice.discountVnd], ['Phụ thu', invoice.surchargeVnd],
      ['Phí chậm thanh toán', invoice.lateFeeVnd], ['Điều chỉnh ròng', invoice.adjustmentNetVnd],
      ['Chưa phân loại', invoice.uncategorizedVnd]
    ];
    const tableRows = (rows) => rows.map(([label, value]) => (
      `<tr><td>${htmlEscape(label)}</td><td class="number">${htmlEscape(vnd(value))}</td></tr>`
    )).join('');
    return `<article class="financial-report-print">
      <header><h1>BÁO CÁO TÀI CHÍNH TRỌBILL</h1>
        <p>${htmlEscape(context.periodLabel || report.period)} · ${htmlEscape(context.scopeLabel || 'Tất cả khu')}</p>
        <small>Xuất lúc ${htmlEscape(context.exportedAtLabel || '')}</small>
      </header>
      <section><h2>Tổng quan</h2><table><tbody>${tableRows(metricRows)}</tbody></table></section>
      <section><h2>Cơ cấu hóa đơn</h2><table><tbody>${tableRows(breakdownRows)}</tbody></table></section>
      <section><h2>Tiền cọc</h2><table><tbody>${tableRows([
        ['Thu cọc', deposit.collectedVnd], ['Hoàn cọc', deposit.refundedVnd],
        ['Khấu trừ cọc', deposit.deductedVnd], ['Dòng tiền cọc thuần', deposit.netCashflowVnd]
      ])}</tbody></table></section>
      ${annualEvidence ? `<section class="annual-revenue-evidence"><h2>Đối chiếu doanh thu năm ${htmlEscape(annualEvidence.year)}</h2>
        <p>Tổng hóa đơn đã phát hành trên Tro Bill. Đây là tài liệu đối chiếu, không thay thế tờ khai và không tự xác định doanh thu chịu thuế.</p>
        <table><thead><tr><th>Tháng</th><th>Số HĐ</th><th>Tiền thuê</th><th>Điện</th><th>Nước</th><th>Dịch vụ</th><th>Điều chỉnh</th><th>Chưa phân loại</th><th>Tổng</th></tr></thead>
        <tbody>${annualMonths.map(month => `<tr><td>${htmlEscape(month.period)}</td><td class="number">${number(month.invoiceCount)}</td><td class="number">${htmlEscape(vnd(month.rentVnd))}</td><td class="number">${htmlEscape(vnd(month.electricityVnd))}</td><td class="number">${htmlEscape(vnd(month.waterVnd))}</td><td class="number">${htmlEscape(vnd(month.servicesVnd))}</td><td class="number">${htmlEscape(vnd(month.adjustmentNetVnd))}</td><td class="number">${htmlEscape(vnd(month.uncategorizedVnd))}</td><td class="number">${htmlEscape(vnd(month.revenueVnd))}</td></tr>`).join('')}</tbody></table>
        <h3>Theo khu / địa điểm</h3>
        <table><thead><tr><th>Khu</th><th>Địa chỉ</th><th>Số HĐ</th><th>Doanh thu hóa đơn</th></tr></thead>
        <tbody>${annualLocations.map(location => `<tr><td>${htmlEscape(location.propertyName || 'Chưa xác định khu')}</td><td>${htmlEscape(location.propertyAddress)}</td><td class="number">${number(location.invoiceCount)}</td><td class="number">${htmlEscape(vnd(location.revenueVnd))}</td></tr>`).join('')}</tbody></table>
      </section>` : ''}
      <section><h2>Lấp đầy</h2>
        <p><strong>${htmlEscape(percent(occupancy.occupancyRatePercent))}</strong> · ${number(occupancy.occupiedRoomDays)}/${number(occupancy.rentableRoomDays)} ngày-phòng có thể cho thuê · ${number(occupancy.vacantRoomDays)} ngày-phòng trống</p>
        <table class="room-detail"><thead><tr><th>Phòng</th><th>Khu</th><th>Lấp đầy</th><th>Có khách</th><th>Trống</th><th>Giữ chỗ</th><th>Đang sửa</th><th>Trống dài nhất</th><th>Cuối kỳ</th></tr></thead>
        <tbody>${rooms.map(room => `<tr><td>${htmlEscape(room.roomName || room.roomId)}</td><td>${htmlEscape(room.propertyName)}</td><td class="number">${htmlEscape(percent(room.occupancyRatePercent))}</td><td class="number">${number(room.occupiedRoomDays)}</td><td class="number">${number(room.vacantRoomDays)}</td><td class="number">${number(room.reservedRoomDays)}</td><td class="number">${number(room.maintenanceRoomDays)}</td><td class="number">${number(room.longestVacantDays)}</td><td>${htmlEscape(STATUS_LABELS[room.endingStatus] || 'Trống')}</td></tr>`).join('')}</tbody></table>
      </section>
      <footer>Tiền cọc không cộng vào doanh thu hóa đơn. Thời gian sửa chữa không tính vào ngày-phòng có thể cho thuê.</footer>
    </article>`;
  }

  return {
    annualEvidenceRows,
    buildPrintHtml,
    buildXlsx,
    htmlEscape,
    reportRows,
    roomRows,
    xmlEscape,
    zipStore
  };
});
