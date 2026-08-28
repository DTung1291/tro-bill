/**
 * TrọBill — mẫu hợp đồng thuê phòng.
 * Nội dung và thứ tự được tái hiện từ document/HopDongThuePhongNew.docx.
 */
'use strict';

const ContractTemplate = (() => {
  const DEFAULT_EQUIPMENT = [
    ['Giường gỗ', 1, ''],
    ['Tủ quần áo (gỗ)', 1, ''],
    ['Tủ bếp (gỗ)', 1, ''],
    ['Điều hòa', 1, ''],
    ['Bình nóng lạnh', 1, ''],
    ['Nệm cao su non', 1, ''],
    ['Máy giặt', 1, ''],
    ['Bếp từ', 1, '']
  ];

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

  function numberVnd(value) {
    return `${Math.max(0, Number(value) || 0).toLocaleString('vi-VN')} đồng`;
  }

  function readThreeDigits(value, forceHundreds = false) {
    const digits = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
    const amount = Math.max(0, Math.trunc(Number(value) || 0));
    const hundred = Math.floor(amount / 100);
    const ten = Math.floor((amount % 100) / 10);
    const unit = amount % 10;
    const words = [];
    if (hundred > 0 || forceHundreds) {
      words.push(`${digits[hundred]} trăm`);
      if (ten === 0 && unit > 0) words.push('lẻ');
    }
    if (ten > 1) words.push(`${digits[ten]} mươi`);
    else if (ten === 1) words.push('mười');
    if (unit > 0) {
      if (unit === 1 && ten > 1) words.push('mốt');
      else if (unit === 5 && ten > 0) words.push('lăm');
      else if (unit === 4 && ten > 1) words.push('tư');
      else words.push(digits[unit]);
    }
    return words.join(' ');
  }

  function moneyInWords(value) {
    const amount = Math.max(0, Math.trunc(Number(value) || 0));
    if (amount === 0) return 'Không đồng';
    const units = ['', 'nghìn', 'triệu', 'tỷ'];
    const groups = [];
    let remaining = amount;
    while (remaining > 0 && groups.length < units.length) {
      groups.push(remaining % 1000);
      remaining = Math.floor(remaining / 1000);
    }
    const highest = groups.length - 1;
    const parts = [];
    for (let index = highest; index >= 0; index -= 1) {
      const group = groups[index];
      if (group === 0) continue;
      const forceHundreds = index < highest && group < 100;
      parts.push(readThreeDigits(group, forceHundreds));
      if (units[index]) parts.push(units[index]);
    }
    const result = `${parts.join(' ').replace(/\s+/g, ' ').trim()} đồng`;
    return result.charAt(0).toUpperCase() + result.slice(1);
  }

  function dateParts(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return match ? { year: match[1], month: match[2], day: match[3] } : null;
  }

  function fullDate(value, fallback = 'không xác định') {
    const parts = dateParts(value);
    return parts
      ? `ngày ${parts.day} tháng ${parts.month} năm ${parts.year}`
      : fallback;
  }

  function compactDate(value) {
    const parts = dateParts(value);
    return parts ? `${parts.day}/${parts.month}/${parts.year}` : '';
  }

  function durationMonths(startsOn, endsOn) {
    const start = dateParts(startsOn);
    const end = dateParts(endsOn);
    if (!start || !end) return 'không xác định';
    const months = (Number(end.year) - Number(start.year)) * 12
      + Number(end.month) - Number(start.month);
    return String(Math.max(1, months));
  }

  function parseEquipment(value) {
    const rows = Array.isArray(value) ? value : DEFAULT_EQUIPMENT;
    return rows.slice(0, 10).map((row) => ({
      name: String(Array.isArray(row) ? row[0] : row?.name || '').trim(),
      quantity: String(Array.isArray(row) ? row[1] : row?.quantity || '').trim(),
      condition: String(Array.isArray(row) ? row[2] : row?.condition || '').trim()
    }));
  }

  function equipmentRows(rows) {
    const normalized = parseEquipment(rows);
    while (normalized.length < 10) normalized.push({ name: '', quantity: '', condition: '' });
    return normalized.map((row, index) => `
      <tr>
        <td class="contract-doc-center">${index + 1}</td>
        <td>${text(row.name, '')}</td>
        <td class="contract-doc-center">${text(row.quantity, '')}</td>
        <td>${text(row.condition, '')}</td>
      </tr>`).join('');
  }

  function amendmentSection(amendments) {
    if (!Array.isArray(amendments) || amendments.length === 0) return '';
    return `
      <section class="contract-doc-addendum">
        <h2>PHỤ LỤC GIÁ ĐÃ PHÁT HÀNH</h2>
        <p>Các phụ lục sau là một phần không tách rời của hợp đồng:</p>
        <ol>${amendments.map((item) => `
          <li><strong>${text(item.code, 'Phụ lục')}</strong> — áp dụng từ ${text(item.effectiveFrom)}:
            ${numberVnd(item.previousMonthlyRentVnd)} → ${numberVnd(item.newMonthlyRentVnd)}.
            Lý do: ${text(item.reason, 'Không ghi')}.</li>`).join('')}</ol>
      </section>`;
  }

  function build(documentData = {}, options = {}) {
    const contract = documentData.contract || {};
    const tenant = documentData.tenant || {};
    const lessor = options.lessor || {};
    const propertyAddress = options.propertyAddress || '40 Vũ Hữu, Quận Hải Châu, TP Đà Nẵng';
    const startsOn = fullDate(contract.startsOn);
    const endsOn = fullDate(contract.endsOn);
    const rentWords = moneyInWords(contract.monthlyRentVnd);
    const depositWords = moneyInWords(contract.depositVnd);
    const terms = String(contract.terms || '').trim();
    const bankPayment = String(options.bankPayment || '').trim();
    const maximumOccupants = Math.max(1, Number(options.maximumOccupants) || 1);
    const floor = String(options.floor || '').trim();
    const roomLabel = String(contract.roomName || '').trim();
    const wifiText = Number(options.wifiFee) > 0
      ? `${numberVnd(options.wifiFee)}/tháng`
      : 'Miễn phí';
    const waterUnit = String(options.waterUnit || 'm3').trim();

    return `
      <article class="rental-contract-document" data-contract-document="${text(contract.id, '')}">
        <header class="contract-doc-national-header">
          <h1>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</h1>
          <p><strong>Độc lập – Tự do – Hạnh phúc</strong></p>
          <p>—o0o—</p>
        </header>

        <div class="contract-doc-legal-bases">
          <p>- Căn cứ Bộ Luật dân sự số 33/2005/QH11 và Luật Nhà ở số 56/2005/QH11 của Nước Cộng hoà Xã hội Chủ nghĩa Việt Nam ban hành năm 2005,</p>
          <p>- Căn cứ các văn bản pháp luật khác có liên quan,</p>
          <p>- Căn cứ khả năng và nhu cầu của hai bên trong hợp đồng này.</p>
        </div>

        <h1 class="contract-doc-title">HỢP ĐỒNG THUÊ VÀ CHO THUÊ PHÒNG Ở</h1>
        <p class="contract-doc-code">Mã hợp đồng: <strong>${text(contract.code, 'Chưa có mã')}</strong></p>

        <section class="contract-doc-party">
          <h2><u>Bên Cho Thuê</u> (Sau đây gọi tắt là Bên A)</h2>
          <p>Ông/bà: <strong>${text(lessor.fullName)}</strong></p>
          <p>Số CCCD/CMTND: <strong>${text(lessor.cccd)}</strong> &nbsp; Cấp ngày: <strong>${text(compactDate(lessor.issueDate), '…/…/……')}</strong> &nbsp; Nơi cấp: <strong>${text(lessor.issuePlace)}</strong></p>
          <p>HKTT: <strong>${text(lessor.address)}</strong></p>
          <p>Điện thoại: <strong>${text(lessor.phone)}</strong></p>
          <p>Là chủ cho thuê hợp pháp căn nhà tại <strong>${text(propertyAddress)}</strong>.</p>
        </section>

        <section class="contract-doc-party">
          <h2><u>Bên Thuê</u> (Sau đây gọi tắt là Bên B)</h2>
          <p>Ông/bà: <strong>${text(tenant.fullName)}</strong></p>
          <p>Số CCCD/CMTND: <strong>${text(tenant.cccd)}</strong> &nbsp; Cấp ngày: <strong>${text(compactDate(tenant.issueDate), '…/…/……')}</strong></p>
          <p>HKTT: <strong>${text(tenant.address)}</strong></p>
          <p>Điện thoại: <strong>${text(tenant.phone)}</strong></p>
        </section>

        <p>Hai bên đồng ý thực hiện việc thuê và cho thuê phòng với các thoả thuận sau đây:</p>

        <section>
          <h2>ĐIỀU 1: NỘI DUNG THỎA THUẬN VÀ TIỀN ĐẶT CỌC HỢP ĐỒNG</h2>
          <p>Bên A đồng ý cho bên B thuê phòng ở số: <strong>${text(roomLabel)}</strong>${floor ? `, tầng <strong>${text(floor)}</strong>` : ''} thuộc căn nhà tại địa chỉ <strong>${text(propertyAddress)}</strong>. Mục đích thuê: <strong>${text(options.rentalPurpose, 'Để ở')}</strong>.</p>
        </section>

        <section>
          <h2>ĐIỀU 2: TIỀN ĐẶT CỌC</h2>
          <p>Ngay khi ký hợp đồng, bên B phải nộp 1 khoản tiền đặt cọc để thuê phòng là <strong>${numberVnd(contract.depositVnd)} (${depositWords})</strong>. Số tiền đặt cọc này sẽ được xử lý như sau:</p>
          <p>- Nếu sau khi ký hợp đồng, Bên B hủy bỏ hợp đồng không thuê nữa thì bên A có quyền giữ lại tiền cọc, không phải hoàn trả lại cho bên B. Ngược lại, nếu sau khi ký hợp đồng bên A hủy bỏ hợp đồng không cho bên B thuê nữa thì bên A sẽ phải hoàn trả bên B toàn bộ số tiền cọc đã nhận của bên A, đồng thời phải bồi thường cho bên B tiền phạt hủy hợp đồng tương đương với số tiền cọc đã nhận.</p>
          <p>- Số tiền cọc sẽ được bên A hoàn trả lại cho bên B sau khi 2 bên thanh lý hợp đồng và bên B trả lại phòng thuê nguyên trạng cho bên A như khi nhận mà không vi phạm bất kỳ điều gì đã thỏa thuận trong hợp đồng. Nếu có bất kỳ hỏng hóc, mất mát liên quan đến phòng thuê mà lỗi phát sinh từ bên B, bên A có quyền khấu trừ vào tiền cọc.</p>
          <p>- Trong trường hợp bên B đơn phương hủy bỏ hợp đồng mà không thông báo cho bên A trước 1 tháng như quy định trong hợp đồng, thì bên A có quyền giữ lại tiền cọc mà không phải hoàn trả cho bên B.</p>
        </section>

        <section>
          <h2>ĐIỀU 3: THỜI HẠN THUÊ</h2>
          <p>Thời hạn thuê phòng nêu tại Điều 1 của Hợp đồng này là <strong>${durationMonths(contract.startsOn, contract.endsOn)} tháng</strong>.</p>
          <p><strong>Ngày bắt đầu: ${startsOn}</strong></p>
          <p><strong>Ngày kết thúc: ${endsOn}</strong></p>
          <p>Hết hạn hợp đồng bên B được quyền ưu tiên thuê tiếp nếu có nhu cầu theo giá thỏa thuận giữa 2 bên nhưng phải xác nhận việc thuê với bên A tối thiểu 1 tháng trước ngày kết thúc hợp đồng; nếu trước thời hạn này bên A không nhận được xác nhận thuê tiếp của bên B, bên A sẽ hiểu là bên B không có nhu cầu thuê tiếp. Bên A có quyền tìm khách thuê mới, đồng thời bên B có trách nhiệm tạo điều kiện cho khách thuê mới xem phòng vào thời gian thích hợp của bên B.</p>
          <p>Trong thời gian hợp đồng còn hiệu lực, nếu bên nào muốn đơn phương thay đổi hợp đồng sẽ phải thông báo cho bên kia tối thiểu 1 tháng.</p>
        </section>

        <section>
          <h2>ĐIỀU 4: GIÁ THUÊ VÀ PHƯƠNG THỨC THANH TOÁN</h2>
          <p>1. Giá thuê phòng nêu tại Điều 1 của Hợp đồng này là: <strong>${numberVnd(contract.monthlyRentVnd)}/tháng</strong> (bằng chữ: <strong>${rentWords}</strong>). Tiền thuê không bao gồm chi phí điện, nước, điện thoại, internet, phí vệ sinh...</p>
          <p>Thời hạn thanh toán: Bên B có trách nhiệm thanh toán tiền thuê mỗi tháng 1 lần vào đầu tháng từ ngày mùng 1 đến ngày mùng 5. Nếu quá thời hạn trên, bên B không thanh toán tiền thuê mà không được sự chấp thuận gia hạn thanh toán của bên A, bên A có quyền xử lý theo thỏa thuận và quy định pháp luật.</p>
          <p>Đơn vị thanh toán: Tiền đồng Việt Nam.</p>
          <p>Phương thức thanh toán: Bên B có thể thanh toán bằng tiền mặt hoặc chuyển khoản vào tài khoản sau của bên A: <strong>${text(bankPayment)}</strong>.</p>
        </section>

        <section>
          <h2>ĐIỀU 5: NGHĨA VỤ VÀ QUYỀN CỦA BÊN A</h2>
          <p><strong>1. Bên A có các nghĩa vụ sau đây:</strong></p>
          <p>- Giao phòng nêu tại Điều 1 của Hợp đồng này cùng các thiết bị trong phụ lục đính kèm cho bên B vào thời điểm ký kết hợp đồng.</p>
          <p>- Bảo đảm quyền cho thuê nhà và cam kết không có bất kỳ tranh chấp, khiếu nại nào đối với căn nhà cho thuê và đảm bảo cho bên B sử dụng ổn định phòng thuê trong thời hạn thuê;</p>
          <p>- Quản lý vận hành, bảo dưỡng, bảo trì, sửa chữa phòng theo định kỳ hoặc theo thoả thuận.</p>
          <p><strong>2. Bên A có các quyền sau đây:</strong></p>
          <p>- Nhận đủ tiền thuê phòng, theo phương thức đã thoả thuận;</p>
          <p>- Đơn phương đình chỉ thực hiện hợp đồng nếu bên B vi phạm bất kỳ điều gì đã thỏa thuận trong hợp đồng thuê hoặc có một trong các hành vi sau đây:</p>
          <p class="contract-doc-subitem">+ Sử dụng phòng không đúng mục đích thuê;</p>
          <p class="contract-doc-subitem">+ Không thực hiện việc thanh toán theo đúng thỏa thuận trong hợp đồng;</p>
          <p class="contract-doc-subitem">+ Làm phòng hư hỏng nghiêm trọng;</p>
          <p class="contract-doc-subitem">+ Sửa chữa, đổi hoặc cho người khác thuê lại toàn bộ hoặc một phần phòng đang thuê mà không có sự đồng ý của bên A;</p>
          <p class="contract-doc-subitem">+ Có thái độ bất lịch sự, gây gổ, ồn ào làm mất trật tự công cộng nhiều lần và ảnh hưởng nghiêm trọng đến sinh hoạt bình thường của khách thuê khác cũng như của những người xung quanh;</p>
          <p class="contract-doc-subitem">+ Làm ảnh hưởng nghiêm trọng đến vệ sinh môi trường;</p>
          <p>- Cải tạo, nâng cấp căn phòng cho thuê khi được bên B đồng ý, nhưng không được gây phiền hà cho bên B;</p>
          <p>- Được lấy lại phòng khi hết hạn Hợp đồng thuê.</p>
        </section>

        <section>
          <h2>ĐIỀU 6: NGHĨA VỤ VÀ QUYỀN CỦA BÊN B</h2>
          <p><strong>1. Bên B có các nghĩa vụ sau đây:</strong></p>
          <p>- Sử dụng phòng đúng mục đích đã thoả thuận với số lượng tối đa <strong>${maximumOccupants} người/căn</strong>. Phải đăng ký và nộp 01 bản sao chứng minh nhân dân/căn cước công dân của tất cả những người sẽ ở tại căn phòng cho bên A.</p>
          <p>- Bên B có trách nhiệm hoàn tất các thủ tục đăng ký tạm trú tạm vắng đầy đủ với chính quyền địa phương theo quy định của pháp luật. Trường hợp cho khách ở lại qua đêm phải tuân thủ quy định cư trú và nội quy của khu nhà.</p>
          <p>- Sử dụng căn phòng thuê theo đúng mục đích thỏa thuận và đúng pháp luật, tuân thủ các quy định về đảm bảo vệ sinh, an toàn phòng chống cháy nổ theo quy định chung của nhà nước, nội quy của khu nhà, giữ gìn an ninh trật tự, nếp sống văn hóa đô thị; nghiêm cấm các hành vi tụ tập cờ bạc, nhậu nhẹt và có bất kỳ hành vi vi phạm pháp luật nào tại căn nhà thuê.</p>
          <p>- Có thái độ văn minh, lịch sự với các khách thuê khác trong tòa nhà. Ký cam kết và tuân thủ nghiêm túc các nội quy, quy định của tòa nhà.</p>
          <p>- Không ký hợp đồng cho thuê lại hoặc nhượng lại hợp đồng thuê nhà này cho bất kỳ một bên thứ ba nào mà không có sự đồng ý của bên A.</p>
          <p>- Thanh toán đầy đủ tiền thuê và đúng hạn như đã thoả thuận;</p>
          <p>- Tự bảo quản tài sản cá nhân, giữ gìn căn phòng, sửa chữa những hư hỏng do mình gây ra đối với các thiết bị lắp đặt trong phòng thuê cũng như trong tòa nhà thuộc sở hữu của bên A. Không được đập phá, tháo dỡ, thay đổi cấu trúc, không đục tường, đóng đinh mà không được sự đồng ý của bên A. Trường hợp hỏng hóc do lỗi bên B gây ra thì bên B phải hoàn lại theo giá trị thiệt hại hoặc tự lắp đặt lại thiết bị nếu bên cho thuê đồng ý.</p>
          <p>- Tôn trọng quy tắc sinh hoạt công cộng;</p>
          <p>- Bàn giao lại phòng và trang thiết bị đi kèm cho bên A theo đúng nguyên trạng khi nhận nhà sau khi hết hạn Hợp đồng thuê.</p>
          <p>- Trong thời gian thuê nếu không có nhu cầu thuê nữa thì bên B phải báo cho bên A trước 01 tháng để hai bên cùng quyết toán tiền thuê nhà và các khoản khác.</p>
          <p><strong>2. Bên B có các quyền sau đây:</strong></p>
          <p>- Nhận phòng thuê theo đúng thoả thuận;</p>
          <p>- Được tiếp tục thuê theo các điều kiện đã thoả thuận với bên A, trong trường hợp thay đổi chủ sở hữu căn nhà;</p>
          <p>- Được ưu tiên ký hợp đồng thuê tiếp, nếu đã hết hạn thuê mà phòng vẫn dùng để cho thuê;</p>
          <p>- Yêu cầu bên A sửa chữa phòng đang cho thuê trong trường hợp phòng bị hư hỏng nặng;</p>
          <p>- Đơn phương đình chỉ thực hiện hợp đồng thuê căn phòng nhưng phải báo cho bên A biết trước một tháng và yêu cầu bồi thường thiệt hại, nếu bên A có một trong các hành vi sau đây:</p>
          <p class="contract-doc-subitem">+ Không sửa chữa phòng khi chất lượng căn phòng giảm sút nghiêm trọng;</p>
          <p class="contract-doc-subitem">+ Tăng giá phòng bất hợp lý;</p>
          <p class="contract-doc-subitem">+ Quyền sử dụng phòng bị hạn chế do lợi ích của người thứ ba.</p>
        </section>

        <section>
          <h2>ĐIỀU 7: CAM ĐOAN CỦA CÁC BÊN</h2>
          <p>Bên A và bên B chịu trách nhiệm trước pháp luật về những lời cam đoan sau đây:</p>
          <p>1. Bên A cam đoan</p>
          <p class="contract-doc-subitem">1.1. Những thông tin về nhân thân, về căn phòng đã ghi trong Hợp đồng này là đúng sự thật;</p>
          <p class="contract-doc-subitem">1.2. Tại thời điểm giao kết Hợp đồng này: a) Căn phòng không có tranh chấp; b) Căn phòng không bị kê biên để bảo đảm thi hành án;</p>
          <p class="contract-doc-subitem">1.3. Việc giao kết Hợp đồng này hoàn toàn tự nguyện, không bị lừa dối, không bị ép buộc;</p>
          <p class="contract-doc-subitem">1.4. Thực hiện đúng và đầy đủ các thoả thuận đã ghi trong Hợp đồng này.</p>
          <p>2. Bên B cam đoan</p>
          <p class="contract-doc-subitem">2.1. Những thông tin về nhân thân đã ghi trong Hợp đồng này là đúng sự thật;</p>
          <p class="contract-doc-subitem">2.2. Đã xem xét kỹ, biết rõ về căn phòng nêu tại Điều 1 của Hợp đồng này và các giấy tờ về quyền sở hữu căn nhà, quyền sử dụng đất;</p>
          <p class="contract-doc-subitem">2.3. Việc giao kết Hợp đồng này hoàn toàn tự nguyện, không bị lừa dối, không bị ép buộc;</p>
          <p class="contract-doc-subitem">2.4. Thực hiện đúng và đầy đủ các thoả thuận đã ghi trong Hợp đồng này.</p>
        </section>

        <section>
          <h2>ĐIỀU 8: THỎA THUẬN CHUNG</h2>
          <ul>
            <li>Trong quá trình thực hiện Hợp đồng này, nếu phát sinh tranh chấp, các bên cùng nhau thương lượng giải quyết trên nguyên tắc tôn trọng quyền lợi của nhau; trong trường hợp không thương lượng được thì một trong hai bên có quyền khởi kiện để yêu cầu toà án có thẩm quyền giải quyết theo quy định của pháp luật.</li>
            <li>Hợp đồng được lập thành 2 bản có giá trị như nhau, mỗi bên giữ 1 bản để thực hiện.</li>
            <li>Hợp đồng có hiệu lực kể từ ngày ký.</li>
          </ul>
        </section>

        ${terms ? `<section class="contract-doc-addendum"><h2>THỎA THUẬN BỔ SUNG</h2><p>${escapeHtml(terms).replace(/\n/g, '<br>')}</p></section>` : ''}
        ${amendmentSection(contract.amendments)}

        <section class="contract-doc-equipment">
          <p>Trang thiết bị kèm theo phòng: Số <strong>${text(roomLabel)}</strong>${floor ? `, tầng <strong>${text(floor)}</strong>` : ''}</p>
          <table>
            <thead><tr><th>STT</th><th>Tên thiết bị</th><th>Số lượng</th><th>Tình trạng</th></tr></thead>
            <tbody>${equipmentRows(options.equipment)}</tbody>
          </table>
        </section>

        <section class="contract-doc-services">
          <h2>Bảng giá các dịch vụ kèm theo:</h2>
          <ul>
            <li>Wifi: <strong>${text(wifiText)}</strong></li>
            <li>Tiền điện: Tính theo số công tơ phòng × đơn giá <strong>${numberVnd(options.electricRate)}/kWh</strong>.</li>
            <li>Tiền nước: <strong>${numberVnd(options.waterRate)}/${text(waterUnit, 'm3')}</strong>.</li>
          </ul>
        </section>

        <section class="contract-doc-signatures">
          <div><h2>ĐẠI DIỆN BÊN A</h2><p>(Ký và ghi rõ họ tên)</p><strong>${text(lessor.fullName, '')}</strong></div>
          <div><h2>ĐẠI DIỆN BÊN B</h2><p>(Ký và ghi rõ họ tên)</p><strong>${text(tenant.fullName, '')}</strong></div>
        </section>
      </article>`;
  }

  return { DEFAULT_EQUIPMENT, build, moneyInWords, parseEquipment };
})();

globalThis.ContractTemplate = ContractTemplate;
