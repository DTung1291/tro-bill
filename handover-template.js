/**
 * TrọBill — mẫu biên bản nhận/trả phòng và bàn giao tài sản.
 */
'use strict';

const RentalHandoverTemplate = (() => {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function text(value, fallback = '........................................................') {
    const normalized = String(value ?? '').trim();
    return escapeHtml(normalized || fallback);
  }

  function dateText(value) {
    const parts = String(value || '').slice(0, 10).split('-');
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : text(value);
  }

  function numberText(value) {
    if (value === null || value === undefined || value === '') return 'Không ghi nhận';
    return Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 3 });
  }

  function money(value) {
    return `${Math.max(0, Number(value) || 0).toLocaleString('vi-VN')} đồng`;
  }

  function typeLabel(type) {
    return type === 'check_out' ? 'TRẢ PHÒNG' : 'NHẬN PHÒNG';
  }

  function itemRows(items) {
    return (Array.isArray(items) ? items : []).map((item, index) => `
      <tr>
        <td class="handover-doc-center">${index + 1}</td>
        <td>${text(item.name, '')}</td>
        <td class="handover-doc-center">${text(numberText(item.quantity), '')}</td>
        <td class="handover-doc-center">${text(item.unit, '')}</td>
        <td>${text(item.condition, '')}</td>
        <td>${text(item.note, '')}</td>
      </tr>`).join('');
  }

  function build(handover = {}) {
    const lessorName = String(handover.lessorName || '').trim();
    const balanceMatches = Number(handover.expectedDepositVnd) === Number(handover.depositBalanceSnapshotVnd);
    const depositStatus = balanceMatches
      ? 'Số dư cọc khớp số tiền cọc theo hợp đồng tại thời điểm lập biên bản.'
      : 'Số dư cọc thực tế khác số tiền cọc theo hợp đồng; hai bên cần đối chiếu sổ giao dịch cọc.';
    return `
      <article class="rental-handover-document" data-handover-document="${text(handover.id, '')}">
        <header class="handover-doc-national-header">
          <h1>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</h1>
          <p><strong>Độc lập - Tự do - Hạnh phúc</strong></p>
          <p>---------------</p>
        </header>

        <h1 class="handover-doc-title">BIÊN BẢN ${typeLabel(handover.handoverType)} VÀ BÀN GIAO TÀI SẢN</h1>
        <p class="handover-doc-code">Mã biên bản: <strong>${text(handover.code)}</strong></p>
        <p>Hôm nay, ngày <strong>${dateText(handover.occurredOn)}</strong>, các bên lập biên bản bàn giao gắn với hợp đồng <strong>${text(handover.contractCode)}</strong>.</p>

        <section class="handover-doc-parties">
          <h2>1. THÔNG TIN CÁC BÊN VÀ PHÒNG</h2>
          <p><strong>Bên cho thuê/Bên giao:</strong> ${text(lessorName)}</p>
          <p><strong>Bên thuê/Bên nhận:</strong> ${text(handover.tenantName)}</p>
          <p><strong>Địa chỉ:</strong> ${text(handover.propertyAddress)}</p>
          <p><strong>Phòng:</strong> ${text(handover.roomName)} &nbsp; <strong>Mã phòng:</strong> ${text(handover.roomId)}</p>
        </section>

        <section>
          <h2>2. CHỈ SỐ VÀ HIỆN TRẠNG CHUNG</h2>
          <table class="handover-doc-summary">
            <tbody>
              <tr><th>Chỉ số điện</th><td>${text(numberText(handover.electricityReading), '')}</td><th>Chỉ số nước</th><td>${text(numberText(handover.waterReading), '')}</td></tr>
              <tr><th>Số chìa khóa</th><td>${text(handover.keyCount, '0')}</td><th>Ngày bàn giao</th><td>${dateText(handover.occurredOn)}</td></tr>
            </tbody>
          </table>
          <p><strong>Tình trạng chung:</strong> ${text(handover.generalCondition)}</p>
        </section>

        <section>
          <h2>3. DANH SÁCH TÀI SẢN BÀN GIAO</h2>
          <table class="handover-doc-items">
            <thead>
              <tr><th>STT</th><th>Tài sản</th><th>SL</th><th>Đơn vị</th><th>Tình trạng</th><th>Ghi chú</th></tr>
            </thead>
            <tbody>${itemRows(handover.items)}</tbody>
          </table>
        </section>

        <section>
          <h2>4. ĐỐI CHIẾU TIỀN CỌC</h2>
          <table class="handover-doc-summary">
            <tbody>
              <tr><th>Tiền cọc theo hợp đồng</th><td>${money(handover.expectedDepositVnd)}</td></tr>
              <tr><th>Số dư sổ cọc tại thời điểm xác nhận</th><td>${money(handover.depositBalanceSnapshotVnd)}</td></tr>
            </tbody>
          </table>
          <p><strong>Kết quả:</strong> ${text(depositStatus, '')}</p>
          <p>Số dư trên là bản chụp từ sổ giao dịch cọc TrọBill tại thời điểm xác nhận biên bản; việc thu, khấu trừ hoặc hoàn cọc phải được ghi bằng giao dịch riêng trong sổ cọc.</p>
        </section>

        <section>
          <h2>5. GHI CHÚ VÀ XÁC NHẬN</h2>
          <p><strong>Ghi chú:</strong> ${text(handover.notes)}</p>
          <p>Hai bên đã cùng kiểm tra phòng, chỉ số và tài sản nêu trên; xác nhận thông tin là đúng tại thời điểm bàn giao. Biên bản được lập thành 02 bản có giá trị như nhau, mỗi bên giữ 01 bản.</p>
        </section>

        <section class="handover-doc-signatures">
          <div><h2>BÊN CHO THUÊ/BÊN GIAO</h2><p>(Ký và ghi rõ họ tên)</p><strong>${text(lessorName, '')}</strong></div>
          <div><h2>BÊN THUÊ/BÊN NHẬN</h2><p>(Ký và ghi rõ họ tên)</p><strong>${text(handover.tenantName, '')}</strong></div>
        </section>
      </article>`;
  }

  return { build, typeLabel };
})();

globalThis.RentalHandoverTemplate = RentalHandoverTemplate;
