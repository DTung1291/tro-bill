# Checklist thương mại hóa TrọBill

Mục tiêu: đưa TrọBill từ sản phẩm quản lý nội bộ thành SaaS có doanh thu lặp lại, ưu tiên nhóm chủ trọ quản lý khoảng 10–50 phòng.

## Cách sử dụng

- Đánh dấu `[x]` khi công việc đã đạt đủ tiêu chí hoàn thành.
- Thực hiện theo thứ tự từ Giai đoạn 0 đến Giai đoạn 5.
- Không mở bán đại trà trước khi hoàn thành toàn bộ mục **Bắt buộc trước pilot trả phí**.
- Các mức giá bên dưới là giả thuyết cần kiểm chứng, không phải giá cố định.

## Giai đoạn 0 — Kiểm chứng nhu cầu và mô hình giá

- [ ] Xác định khách hàng mục tiêu ban đầu: chủ trọ có 10–50 phòng.
- [ ] Phỏng vấn ít nhất 10 chủ trọ về quy trình lập bill, thu tiền và nhắc nợ.
- [ ] Ghi nhận ba vấn đề khiến khách hàng mất nhiều thời gian hoặc thất thoát tiền nhất.
- [ ] Chọn thông điệp chính của sản phẩm, ví dụ: “Chốt bill, gửi QR và đối soát tiền trọ trong một nơi”.
- [ ] Chọn 5 khách hàng pilot sẵn sàng sử dụng dữ liệu thật.
- [ ] Thống nhất chính sách hỗ trợ nhập dữ liệu ban đầu cho khách pilot.
- [ ] Tạo bảng giá thử nghiệm:
  - [ ] Free: tối đa 10 phòng.
  - [ ] Standard: tối đa 25 phòng.
  - [ ] Pro: tối đa 50 phòng.
  - [ ] Business: tối đa 100 phòng và có nhân viên.
- [ ] Xác định giá tháng, giá năm và mức giảm khi trả theo năm.
- [ ] Không cung cấp gói trọn đời trong giai đoạn đầu.
- [ ] Xác định các chỉ số cần theo dõi:
  - [ ] Tỷ lệ tạo hóa đơn đầu tiên sau khi đăng ký.
  - [ ] Thời gian từ đăng ký đến hóa đơn đầu tiên.
  - [ ] Tỷ lệ quay lại ở kỳ lập bill thứ hai.
  - [ ] Tỷ lệ dùng thử chuyển thành trả phí.
  - [ ] Tỷ lệ hóa đơn được thanh toán đúng hạn.

### Hoàn thành giai đoạn khi

- [ ] Có ít nhất 5 khách pilot và một bảng giá thử nghiệm được chấp nhận để triển khai.

## Giai đoạn 1 — Bắt buộc trước pilot trả phí

### Bảo mật tài khoản

- [x] Chuyển token đăng nhập khỏi `localStorage` sang cookie `HttpOnly`, `Secure`, `SameSite` phù hợp.
- [x] Thêm xác minh email khi đăng ký.
- [x] Thêm quên mật khẩu và đặt lại mật khẩu bằng liên kết có thời hạn.
- [x] Thêm giới hạn số lần đăng nhập và đăng ký theo IP/tài khoản.
- [x] Thêm cơ chế đăng xuất khỏi tất cả thiết bị.
- [x] Kiểm tra tất cả API đều xác thực quyền sở hữu dữ liệu.
- [x] Không cho admin xem toàn bộ CCCD nếu không có lý do hỗ trợ hợp lệ.

### Bảo vệ dữ liệu khách thuê

- [x] Che bớt số CCCD trên giao diện mặc định.
- [x] Ghi nhật ký khi xem, sửa, xuất hoặc xóa dữ liệu nhạy cảm.
- [x] Có chính sách bảo mật và điều khoản sử dụng.
- [x] Có thông báo mục đích thu thập dữ liệu khách thuê.
- [x] Có chức năng xuất dữ liệu của tài khoản.
- [x] Có chức năng yêu cầu xóa tài khoản và dữ liệu liên quan.
- [x] Xác định thời gian lưu dữ liệu sau khi tài khoản ngừng sử dụng.

Trạng thái ngày 24/08/2026:

- CCCD được che ở state và giao diện; chỉ API theo quyền sở hữu mới trả bản đầy
  đủ, không cache và luôn ghi audit. Chủ tài khoản thấy cả lịch sử admin xem
  CCCD cùng lý do hỗ trợ; audit không chứa giá trị CCCD cũ/mới.
- Đăng ký mới ghi phiên bản đồng ý chính sách/điều khoản. Hồ sơ khách thuê mới
  hoặc thay đổi dữ liệu nhạy cảm bắt buộc xác nhận đã gửi thông báo mục đích.
- Cài đặt hỗ trợ xuất JSON đầy đủ sau khi nhập lại mật khẩu và tự xóa tài khoản
  bằng mật khẩu + cụm xác nhận. Dữ liệu nhạy cảm cũng được xóa khỏi bộ nhớ trình
  duyệt sau khi tài khoản bị xóa.
- Dữ liệu chính bị xóa ngay khi xóa tài khoản; backup mã hóa tối đa 30 ngày và
  audit tối giản tối đa 365 ngày. Chính sách/điều khoản hiện là bản pilot, phải
  được rà soát pháp lý và bổ sung thông tin pháp nhân trước khi mở bán đại trà.
- Migration đã chạy trên Neon Production và staging. Cả hai môi trường dùng
  runtime role `tro_bill_app` chỉ có quyền CRUD, không có quyền tạo schema.

### An toàn dữ liệu và vận hành

- [x] Thiết lập sao lưu cơ sở dữ liệu tự động.
- [x] Thử phục hồi thành công từ một bản sao lưu.
- [x] Có log lỗi server và cảnh báo khi API hoặc database gặp sự cố.
- [x] Thiết lập HTTPS cho môi trường production.
- [x] Tách rõ môi trường development, staging và production.
- [x] Không để secret hoặc thông tin database trong repository.
- [x] Viết kiểm thử cho đăng nhập, phân quyền và các công thức tính bill quan trọng.
- [ ] Thay `DATABASE_URL` bằng role Neon tạo qua SQL, không kế thừa `neon_superuser`, rồi thu hồi role runtime tạo từ Console/API.

Trạng thái ngày 24/08/2026:

- Restore drill đã dùng backup mã hóa từ Neon production, phục hồi thành công
  vào PostgreSQL 18 trống và qua kiểm tra toàn vẹn; dữ liệu tạm đã được xóa.
- Production `tro-bill.vercel.app` chuyển HTTP sang HTTPS và có HSTS.
- Quét tracked files cùng toàn bộ Git history không phát hiện secret; CI tiếp tục
  chặn secret và chạy 41 kiểm thử bảo mật/bill trên mỗi thay đổi.
- Lỗi server được ghi JSON theo `incidentId`/`requestId`; health monitor đã mở
  GitHub Issue duy nhất, gán người phụ trách và sẽ tự đóng khi production phục hồi.
- Vercel Preview dùng `APP_ENV=staging`, JWT riêng và Neon branch schema-only
  riêng; readiness staging đã xác minh cả cấu hình lẫn database đều `ok`.
- Workflow backup và restore drill hằng ngày chạy trong repo private
  `DTung1291/tro-bill-operations`. Role `tro_bill_backup` đã kiểm tra chỉ đọc;
  hai GitHub Secrets đã cấu hình; run `32742953010` đã xanh và artifact mã hóa có
  checksum hợp lệ. Khóa giải mã dự phòng nằm độc lập trong macOS Keychain.
- Đã cấu hình Brevo Free làm provider email tạm thời: sender đã xác minh và
  `EMAIL_PROVIDER`, `BREVO_API_KEY`, `EMAIL_FROM` đã được đặt cho cả Production
  lẫn Preview trên Vercel. Production readiness trả `200` với cấu hình và database
  đều `ok`; người dùng đã tự kiểm tra gửi email thật thành công.
- Đã tạo role SQL `tro_bill_runtime_sql` không kế thừa `neon_superuser`, đồng bộ
  đúng quyền CRUD cần thiết trên staging/production và cập nhật `DATABASE_URL`
  của Vercel. Chỉ thu hồi role cũ `tro_bill_app` sau khi deployment mới được xác
  nhận chạy bằng role hạn chế quyền để tránh làm gián đoạn production.

### Hoàn thành giai đoạn khi

- [x] Có thể khôi phục dữ liệu từ backup và không còn token đăng nhập lưu trong `localStorage`.
- [x] Luồng đăng ký, xác minh email, quên mật khẩu và xóa tài khoản hoạt động đầy đủ.

## Giai đoạn 2 — Hệ thống gói trả phí

### Dữ liệu subscription

- [x] Tạo bảng `plans` lưu mã gói, giá và giới hạn sử dụng.
- [x] Tạo bảng `subscriptions` lưu gói hiện tại, ngày bắt đầu, ngày hết hạn và trạng thái.
- [x] Tạo bảng `subscription_payments` lưu từng lần thanh toán.
- [x] Tạo bảng `payment_events` để lưu webhook và chống xử lý trùng.
- [x] Tạo entitlement phía server cho từng tính năng trả phí.
- [x] Không dùng biến hoặc trạng thái phía client để tự quyết định tài khoản Premium.

### Vòng đời gói dịch vụ

- [x] Hỗ trợ dùng thử 14–30 ngày.
- [x] Hỗ trợ nâng gói và gia hạn.
- [x] Hỗ trợ trạng thái đang hoạt động, sắp hết hạn, ân hạn và hết hạn.
- [x] Khi hết hạn, chuyển tài khoản sang chỉ xem thay vì xóa dữ liệu.
- [x] Cho phép người dùng xuất dữ liệu dù gói đã hết hạn.
- [x] Hiển thị số phòng đang dùng và giới hạn của gói.
- [x] Gửi thông báo trước ngày hết hạn.

### Thanh toán gói TrọBill

- [x] Tạo payment link hoặc VietQR riêng cho từng đơn hàng subscription.
- [x] Tích hợp webhook xác nhận giao dịch và kiểm tra chữ ký.
- [x] Webhook phải idempotent, nhận lại nhiều lần vẫn chỉ ghi nhận một thanh toán.
- [x] Tự động kích hoạt hoặc gia hạn gói sau khi thanh toán thành công.
- [x] Có lịch sử thanh toán và biên nhận cho chủ trọ.
- [x] Có quy trình hoàn tiền hoặc xử lý thanh toán nhầm.
- [ ] Nếu bán trong ứng dụng Android trên Google Play, hoàn thiện Play Billing và xác minh giao dịch phía server.

### Trang quản trị doanh thu

- [x] Hiển thị số tài khoản dùng thử, đang trả phí và đã hết hạn.
- [x] Hiển thị doanh thu tháng, doanh thu năm và doanh thu định kỳ.
- [x] Hiển thị tỷ lệ dùng thử chuyển thành trả phí.
- [x] Hiển thị số gói sắp hết hạn cần chăm sóc.
- [x] Cho phép admin gia hạn hoặc cấp gói có ghi rõ lý do và audit log.

  Trang quản trị hiển thị gói hiện tại của từng tài khoản, chỉ đưa ra thao tác
  dùng thử/nâng gói/gia hạn phù hợp và bắt buộc xác nhận lý do 10–500 ký tự.
  Cập nhật subscription và ghi `subscription_change_logs` chạy trong cùng
  transaction; bảng nhật ký admin chỉ trả metadata chu kỳ hoặc số ngày trial.

### Hoàn thành giai đoạn khi

- [ ] Một khách pilot có thể tự thanh toán, được kích hoạt gói tự động và bị giới hạn đúng theo gói ở phía server.

## Giai đoạn 3 — Luồng thu tiền trọ khép kín

### Công nợ và giao dịch

- [x] Thay trạng thái `paid` đơn giản bằng sổ giao dịch thanh toán.
- [x] Hỗ trợ thanh toán đủ, thanh toán một phần và nhiều lần.
- [x] Hỗ trợ nợ cũ chuyển sang kỳ sau.
- [x] Hỗ trợ giảm giá, phụ thu và phí chậm thanh toán.
- [x] Hỗ trợ tiền cọc, khấu trừ cọc và hoàn cọc.
- [x] Hỗ trợ sửa/hủy giao dịch bằng bút toán điều chỉnh, không xóa dấu vết.
- [x] Tạo phiếu thu có mã riêng cho từng lần thanh toán.
- [x] Hiển thị tuổi nợ: chưa đến hạn, quá hạn 1–7 ngày, 8–30 ngày và trên 30 ngày.

### VietQR và đối soát

- [x] Mỗi hóa đơn có nội dung chuyển khoản duy nhất, ngắn và dễ nhập.
- [x] QR luôn chứa đúng số tiền còn phải trả, không chỉ tổng hóa đơn ban đầu.
- [x] Cho phép chủ trọ xác nhận thủ công khi chưa kết nối ngân hàng.
- [x] Cho phép kết nối kênh thanh toán của từng chủ trọ để nhận webhook.
- [x] Tự động ghép giao dịch với hóa đơn theo mã, số tiền và tài khoản nhận.
- [x] Có danh sách giao dịch chưa ghép hoặc nghi ngờ để xử lý thủ công.
- [x] Tiền thuê đi thẳng vào tài khoản chủ trọ; TrọBill không giữ hộ tiền thuê.

### Cổng dành cho khách thuê

- [x] Tạo liên kết hóa đơn bảo mật, có thời hạn hoặc OTP.
- [x] Khách xem được chi tiết tiền phòng, điện, nước và dịch vụ.
- [x] Khách xem được chỉ số và ảnh đồng hồ nếu có.
- [x] Khách quét VietQR theo số tiền còn lại.
- [x] Khách gửi minh chứng chuyển khoản.
- [x] Khách tải phiếu thu sau khi được xác nhận.
- [x] Khách xem lịch sử hóa đơn và thanh toán của chính phòng mình.
- [x] Liên kết không làm lộ dữ liệu của phòng hoặc khách khác.

### Gửi hóa đơn và nhắc nợ

- [x] Có mẫu tin nhắn hóa đơn và mẫu nhắc nợ.
- [x] Gửi hoặc chia sẻ qua Zalo, email và liên kết hệ thống.
- [x] Cho phép hẹn ngày gửi hóa đơn.
- [x] Tự động nhắc trước hạn và sau hạn theo cấu hình.
- [x] Dừng nhắc ngay khi hóa đơn đã được thanh toán đủ.
- [x] Lưu trạng thái gửi thành công/thất bại và cho phép gửi lại.
- [x] Tách phí SMS/Zalo khỏi giá subscription nếu phát sinh theo lượt.

  TrọBill hiện ưu tiên kênh miễn phí: Zalo/ứng dụng dùng Web Share trên thiết bị
  và email dùng quota provider đã cấu hình. SMS/Zalo API trả phí chưa được bật;
  nếu tích hợp sau này phải là add-on theo lượt, hiển thị đơn giá và được chủ tài
  khoản xác nhận trước, không tự động gộp vào giá subscription.

### Hoàn thành giai đoạn khi

- [x] Có thể theo dõi đầy đủ một hóa đơn từ lúc phát hành đến khi thanh toán nhiều lần và nhận phiếu thu.

  Kiểm thử vòng đời tạo hóa đơn 3.000.000đ, thu hai lần 1.000.000đ và
  2.000.000đ, xác nhận trạng thái chuyển từ thanh toán một phần sang đã thanh
  toán, QR dừng hiển thị khi hết nợ và cổng khách thuê trả đủ hai phiếu thu.

## Giai đoạn 4 — Hợp đồng và vận hành nhiều khu trọ

### Vòng đời thuê phòng

- [x] Quản lý hợp đồng thuê và các phụ lục thay đổi giá.
- [x] Tạo hợp đồng từ mẫu và xuất PDF.
- [x] Quản lý ngày bắt đầu, ngày hết hạn và chu kỳ thanh toán.
- [x] Nhắc hợp đồng sắp hết hạn.
- [x] Quản lý đặt cọc và biên bản bàn giao tài sản.
- [x] Hỗ trợ giữ chỗ, chuyển phòng và trả phòng.
- [x] Chốt bill cuối cùng khi khách trả phòng.
- [x] Quản lý trạng thái phòng: trống, giữ chỗ, đang thuê, đang sửa.

Trạng thái đến ngày 30/08/2026:

- Hợp đồng lưu bản chụp phòng/khách thuê, có trạng thái nháp, hiệu lực, kết thúc
  và hủy; mỗi phòng chỉ có một hợp đồng đang hiệu lực trong một tài khoản.
- Phụ lục thay đổi giá là lịch sử chỉ được thêm mới, có mã và tháng áp dụng;
  khi kích hoạt hợp đồng hoặc thêm phụ lục, giá được đồng bộ vào lịch sử giá
  phòng để hóa đơn cũ không bị thay đổi.
- Không cho xóa/chuyển phòng hoặc khách thuê đang có hợp đồng hiệu lực. Một tab
  cũ lưu state cũng không thể xóa các mốc giá đã phát sinh từ hợp đồng.
- Migration đã chạy và kiểm tra quyền trên Neon staging/production; bộ test đầy
  đủ và kiểm tra giao diện desktop tại local đều thành công.
- Giữ chỗ có ngày nhận phòng, ngày hết hạn và tiền cọc dự kiến; mỗi phòng chỉ có
  một lượt đang hoạt động. Tạo hợp đồng có thể chuyển lượt giữ chỗ thành hợp đồng
  trong cùng transaction. Chuyển phòng kết thúc hợp đồng cũ, chuyển khách và tạo
  hợp đồng mới nguyên tử; trả phòng bắt buộc có biên bản trả phòng. Mọi thay đổi
  được ghi vào nhật ký vòng đời append-only.
- Mẫu `document/HopDongThuePhongNew.docx` đã được đưa vào luồng **Xem / In hợp
  đồng**. Bản in Letter giữ thứ tự 8 điều, phụ lục giá, bảng trang thiết bị và
  chữ ký; đã kiểm tra trực quan đủ 5 trang trước khi phát hành.
- Thông tin khách thuê được chụp tại thời điểm tạo hợp đồng để hồ sơ đã ký không
  đổi theo hồ sơ hiện tại. Việc mở bản đầy đủ bắt buộc có lý do, không cache và
  được ghi audit; migration snapshot đã chạy trên Neon staging/production ngày
  28/08/2026.
- Hợp đồng lưu chu kỳ thanh toán 1, 3, 6 hoặc 12 tháng và ngày đến hạn từ 1–28;
  kỳ đầu không thể đến hạn trước ngày bắt đầu, kỳ sau dừng tại ngày kết thúc.
  Giao diện hiển thị kỳ đến hạn tiếp theo và Điều 4 trong bản in tính đúng tổng
  tiền mỗi kỳ. Migration đã đạt đủ 3 kiểm tra trên Neon staging/production ngày
  28/08/2026; 274/274 test tự động thành công. Hóa đơn vận hành vẫn được lập
  theo tháng; chu kỳ trên là lịch thanh toán được hai bên ghi trong hợp đồng.
- Hợp đồng đang hiệu lực có ngày kết thúc được cảnh báo trên giao diện và gửi
  email cho chủ tài khoản ở các mốc 30, 14, 7, 3 và 1 ngày. Cron dùng ngày lịch
  Việt Nam, giới hạn 20 email mỗi lượt, chống gửi trùng theo hợp đồng/mốc/ngày
  kết thúc và tự thử lại lỗi tạm thời mà không lưu nội dung lỗi nhạy cảm. Bảng
  nhật ký chỉ cấp quyền tối thiểu, đã đạt đủ 4 kiểm tra trên Neon
  staging/production ngày 28/08/2026; 281/281 test tự động thành công.
- Mỗi hợp đồng có tối đa một biên bản nhận phòng và một biên bản trả phòng bất
  biến, ghi ngày bàn giao, chỉ số điện/nước, chìa khóa, hiện trạng và tối đa 50
  tài sản. Số dư cọc được chụp trực tiếp từ sổ giao dịch cọc hiện có tại thời
  điểm xác nhận; không tạo ledger hoặc cột số dư cạnh tranh. Bản in A4 không có
  CCCD và đã được kiểm tra trực quan đủ 3 trang với 32 tài sản. Popup không tràn
  viewport và khóa scroll nền ở desktop/mobile. Migration
  `20260829_rental_handover_records.sql` đạt đủ 6 kiểm tra bảng, ownership,
  một-bản-mỗi-loại và append-only trên Neon `staging-privacy` lẫn production;
  credential `tro_bill_runtime_sql` production có INSERT nhưng không có
  UPDATE/DELETE. Toàn bộ 288/288 test tự động thành công.
- Sau khi trả phòng, hệ thống lập bản xem trước quyết toán từ hóa đơn đúng tháng,
  tính tiền phòng theo số ngày ở thực tế có tính cả ngày vào và ngày trả, đối
  chiếu chỉ số điện/nước với biên bản trả phòng, rồi cho bù công nợ và hoàn số dư
  từ sổ cọc. Khi xác nhận, tổng/chi tiết hóa đơn cuối và biên quyết toán được
  khóa bất biến; khoản cọc bù nợ được phân bổ vào ledger thu tiền trong cùng một
  transaction và thao tác gửi lại cùng nội dung không tạo giao dịch trùng. Số
  tiền phải thu ở QR, nhắc nợ, đối soát và biên nhận đều dùng tổng cuối đã chốt.
  Migration `20260830_rental_final_settlements.sql` đạt đủ 5 kiểm tra schema,
  ownership, snapshot bất biến và quyền append-only trên Neon `staging-privacy`
  lẫn production; toàn bộ 303/303 test tự động thành công.
- Trạng thái phòng (trống/giữ chỗ/đang thuê/đang sửa) được server suy ra tự động
  từ khách hiện có hoặc hợp đồng hiệu lực, lượt giữ chỗ hoạt động và đợt sửa
  chữa hoạt động. Bảng
  `room_maintenance_periods` lưu các đợt sửa phòng với mã dạng `SUA-YYYY-NNNNNN`,
  snapshot tên phòng, ngày bắt đầu/dự kiến kết thúc/hoàn thành thực tế, lý do và
  ghi chú hoàn thành. Mỗi phòng chỉ có tối đa một đợt sửa đang hoạt động; khi
  hoàn thành cần nhập ngày và ghi chú 10–500 ký tự. API `/api/room-maintenance`
  cho phép liệt kê, tạo mới và hoàn thành đợt sửa chữa. Giao diện hiển thị badge
  trạng thái trên mỗi room card và nút "🔄 Trạng thái" mở modal quản lý sửa với
  form bắt đầu/hoàn thành sửa chữa và lịch sử 5 đợt gần nhất. Migration
  `20260830_room_operational_statuses.sql` đã chạy và đạt đủ 5 cờ kiểm tra trên
  Neon `staging-privacy` lẫn production ngày 30/08/2026. Dữ liệu sửa chữa được
  tải song song với state khi khởi động app và xuất trong `/api/privacy/export`.
  Bản review đã bổ sung chốt chặn xung đột, trạng thái tương thích khách thuê cũ,
  event vòng đời, khóa scroll/modal an toàn; toàn bộ 311/311 test hồi quy thành
  công.

### Nhiều khu và phân quyền

- [ ] Một tài khoản chủ sở hữu quản lý được nhiều khu/tòa nhà.
- [ ] Có vai trò chủ sở hữu, quản lý, kế toán và người ghi điện nước.
- [ ] Nhân viên chỉ xem được khu hoặc nghiệp vụ được giao.
- [ ] Ghi audit log khi thay đổi giá, hóa đơn, giao dịch và hợp đồng.
- [ ] Dashboard tổng hợp và bộ lọc theo từng khu.
- [ ] Hỗ trợ nhiều tài khoản ngân hàng nhận tiền theo khu.

### Bảo trì và tài sản

- [ ] Quản lý tài sản/nội thất theo phòng.
- [ ] Khách thuê gửi yêu cầu sửa chữa.
- [ ] Phân công người xử lý và theo dõi trạng thái.
- [ ] Ghi nhận chi phí sửa chữa vào báo cáo thực tế.

### Hoàn thành giai đoạn khi

- [ ] Một chủ trọ có thể giao việc cho nhân viên mà không phải cấp toàn quyền tài khoản.

## Giai đoạn 5 — Báo cáo tài chính, thuế và mở rộng doanh thu

### Báo cáo

- [ ] Báo cáo doanh thu, thực thu, công nợ, chi phí và lợi nhuận.
- [ ] Lọc theo tháng, quý, năm, khu và phòng.
- [ ] Tách tiền thuê, điện nước, dịch vụ, cọc và khoản điều chỉnh.
- [ ] Báo cáo tỷ lệ lấp đầy và thời gian phòng trống.
- [ ] Xuất Excel/PDF cho kế toán.
- [ ] Có báo cáo doanh thu năm phục vụ kê khai thuế.

### Hóa đơn điện tử và tích hợp

- [ ] Khảo sát ít nhất hai nhà cung cấp hóa đơn điện tử có API.
- [ ] Xác định trường hợp khách hàng nào thực sự cần hóa đơn điện tử.
- [ ] Đồng bộ thông tin người thuê và khoản thu sang nhà cung cấp hóa đơn.
- [ ] Lưu mã tra cứu và trạng thái hóa đơn điện tử.
- [ ] Có quy trình điều chỉnh hoặc thay thế hóa đơn sai.
- [ ] Được kế toán hoặc đơn vị tư vấn pháp lý kiểm tra nghiệp vụ trước khi phát hành.

### Kênh doanh thu bổ sung — chỉ làm sau khi SaaS ổn định

- [ ] Gói nhập dữ liệu và triển khai ban đầu có thu phí.
- [ ] Gói thương hiệu riêng cho đơn vị quản lý lớn.
- [ ] Phí thêm nhân viên hoặc thêm khu trọ.
- [ ] Gói lưu trữ ảnh/chứng từ dung lượng cao.
- [ ] Chương trình giới thiệu khách hàng có thưởng.
- [ ] Chưa xây marketplace tìm phòng cho đến khi có lượng chủ trọ hoạt động đủ lớn.

## Checklist mở bán

- [ ] Có landing page mô tả đúng vấn đề, tính năng và bảng giá.
- [ ] Có hướng dẫn bắt đầu nhanh và dữ liệu mẫu.
- [ ] Có công cụ nhập phòng/khách từ Excel hoặc JSON.
- [ ] Có kênh hỗ trợ chính thức và thời gian phản hồi cam kết.
- [ ] Có điều khoản sử dụng, chính sách bảo mật và chính sách hoàn tiền.
- [ ] Hoàn thiện thủ tục kinh doanh, thuế và website/app phù hợp với mô hình bán dịch vụ.
- [ ] Chạy kiểm thử end-to-end trên staging với dữ liệu giả lập.
- [ ] Chạy thử một chu kỳ bill hoàn chỉnh với 5 khách pilot.
- [ ] Thu tiền thật thành công từ ít nhất 3 khách pilot.
- [ ] Theo dõi pilot qua kỳ lập bill thứ hai trước khi quảng bá rộng.

## Tiêu chí sẵn sàng mở bán đại trà

- [ ] Không có lỗi làm mất hoặc lẫn dữ liệu giữa các tài khoản.
- [x] Backup và phục hồi đã được kiểm chứng.
- [ ] Subscription và giới hạn gói được kiểm tra ở server.
- [ ] Thanh toán gói TrọBill được ghi nhận tự động và không bị trùng.
- [x] Hóa đơn tiền trọ hỗ trợ công nợ và thanh toán một phần.
- [ ] Có ít nhất 70% khách pilot quay lại ở kỳ lập bill thứ hai.
- [ ] Có ít nhất 3 khách hàng trả phí và sẵn sàng tiếp tục sử dụng.
- [ ] Có quy trình hỗ trợ, xử lý sự cố và phản hồi bảo mật.
