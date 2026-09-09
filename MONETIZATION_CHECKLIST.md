# Checklist thương mại hóa TrọBill

Mục tiêu: đưa TrọBill từ sản phẩm quản lý nội bộ thành SaaS có doanh thu lặp lại, ưu tiên nhóm chủ trọ quản lý khoảng 10–50 phòng.

## Cách sử dụng

- Đánh dấu `[x]` khi công việc đã đạt đủ tiêu chí hoàn thành.
- Thực hiện theo thứ tự từ Giai đoạn 0 đến Giai đoạn 5.
- Không mở bán đại trà trước khi hoàn thành toàn bộ mục **Bắt buộc trước pilot trả phí**.
- Các mức giá bên dưới là giả thuyết cần kiểm chứng, không phải giá cố định.

## Giai đoạn 0 — Kiểm chứng nhu cầu và mô hình giá

- [x] Xác định khách hàng mục tiêu ban đầu: chủ trọ có 10–50 phòng.
  Hồ sơ `docs/PILOT_CUSTOMER_PROFILE.md` chốt ICP v1 là chủ trọ trực tiếp vận
  hành 10–50 phòng, thường có 1–3 khu và có quyền quyết định quy trình bill/thu
  tiền. Tài liệu có điều kiện bắt buộc, nhóm ưu tiên, phạm vi loại trừ, câu hỏi
  sàng lọc và quy tắc ghi bằng chứng ẩn danh. Đây là giả thuyết tuyển mẫu, chưa
  được coi là bằng chứng nhu cầu, thông điệp hay mức giá.
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
- [x] Thay `DATABASE_URL` bằng role Neon tạo qua SQL, không kế thừa `neon_superuser`, rồi thu hồi role runtime tạo từ Console/API.

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
  của Vercel. Migration `20260907_disable_legacy_runtime_logins.sql` đã chạy trên
  Neon staging `br-ancient-wave-azwc43to` và production
  `br-fancy-star-azyclc1h`, cả hai đạt 3/3 cờ role đích, login cũ và membership
  quản trị. `tro_bill_runtime` được giữ `NOLOGIN` làm mẫu quyền; `tro_bill_app`
  do Console tạo chỉ có ở staging đã được xóa sau khi xác minh 0 kết nối và
  không sở hữu bảng, hàm, database hoặc role. Readiness hai môi trường đều `ok`;
  health monitor production `34134850555` thành công.

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
  Admin có bảng đối soát payment `pending` và có thể xác nhận thủ công sau khi
  kiểm tra tiền thực nhận. Mã giao dịch dùng chung khóa idempotency với webhook;
  xác nhận, cập nhật gói và audit nằm trong cùng transaction. Người dùng có nút
  báo đã chuyển để yêu cầu kiểm tra nhưng không thể tự đổi trạng thái payment.
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

- [x] Một tài khoản chủ sở hữu quản lý được nhiều khu/tòa nhà.
- [x] Có vai trò chủ sở hữu, quản lý, kế toán và người ghi điện nước.
- [x] Nhân viên chỉ xem được khu hoặc nghiệp vụ được giao.
- [x] Ghi audit log khi thay đổi giá, hóa đơn, giao dịch và hợp đồng.
- [x] Dashboard tổng hợp và bộ lọc theo từng khu.
- [x] Hỗ trợ nhiều tài khoản ngân hàng nhận tiền theo khu.

Trạng thái đến ngày 30/08/2026: khu/tòa nhà đã có CRUD riêng theo tài khoản,
mỗi phòng bắt buộc thuộc đúng một khu và dữ liệu cũ được đưa vào khu mặc định.
Trang Phòng hỗ trợ lọc, gắn/chuyển khu; backup cũ và backup nhiều khu đều được
ánh xạ an toàn khi import. Migration đã áp dụng và xác minh trên staging lẫn
production; 318/318 test và smoke test production thành công.

Trạng thái đến ngày 31/08/2026: đã có membership bất biến cho chủ sở hữu và ba
vai trò nhân viên quản lý, kế toán, người ghi điện nước. Chủ chỉ thêm được tài
khoản TrọBill đã xác minh; giới hạn nhân viên theo gói được kiểm tra ở API và UI,
trong khi thao tác thu hồi luôn khả dụng. Migration đã áp dụng trên staging và
production; 326/326 test, GitHub Actions và readiness production đều thành công.
Smoke test tài khoản thật xác nhận card responsive ở viewport 390x844 và form
Free 0/0 khóa rõ ràng.

Phân quyền ngày 31/08/2026 tách danh tính đăng nhập khỏi workspace chủ được giao.
Chủ chọn khu và nghiệp vụ theo ma trận vai trò; nhân viên chỉ mở workspace khi có
ít nhất một khu và một nghiệp vụ, state được lọc theo khu và lược trường ngoài
nghiệp vụ. Workspace nhân viên hiện chỉ đọc để không cho snapshot đã lọc ghi đè
dữ liệu khu khác; đổi vai trò chỉ thu hồi phạm vi khi vai trò thật sự thay đổi.
Chi phí cấp tài khoản chỉ hiện khi nhân viên được giao toàn bộ khu. Migration
assignment đã áp dụng trên `staging-privacy` và production, cả hai đạt 6/6 cờ;
340/340 test, CI, readiness và smoke test production sau reload đều thành công.

Audit nghiệp vụ ngày 31/08/2026 dùng chung `data_audit_logs` với retention 365
ngày, phân biệt nhân viên thực hiện với tài khoản sở hữu dữ liệu và ghi cùng
transaction cho biểu phí, nguồn/phát hành hóa đơn, ledger tiền phòng/cọc, đối
soát ngân hàng, hợp đồng/phụ lục/chuyển phòng/trả phòng/quyết toán. Audit chỉ lưu
loại thao tác, tài nguyên, tên trường và mục đích ngắn, không lưu giá trị
trước/sau; request idempotent không tạo log lặp và autosave no-op không tạo log
rác. Không cần migration mới vì bảng/permission hiện có đã đáp ứng. Bộ đầy đủ
đạt 344/344 test, CI `33403227484` thành công; production revision
`1dfcf13872cd` readiness HTTP 200. Smoke test tài khoản thật xác nhận nhật ký tải
được actor, nhãn nghiệp vụ, không lỗi console/tràn ngang và reload vẫn đúng chủ
`admin@trobill.local` với 7 phòng.

Dashboard theo khu phát hành ngày 01/09/2026: bộ lọc riêng trên Tổng quan giới
hạn phòng, doanh thu, điện, nước, tiến độ và trạng thái theo khu. Chi phí có thể
gắn một khu hoặc để chung; dữ liệu cũ giữ là chi phí chung, chỉ được tính ở chế
độ “Tất cả khu” để không tạo số liệu phân bổ giả. Migration
`20260831_dashboard_property_expenses.sql` đã chạy trên `staging-privacy` và
production, cả hai đạt 5/5 cờ xác minh. Preview thử với hai khu, hai phòng và hai
phạm vi chi phí cho kết quả đúng; desktop/mobile không tràn ngang. Bộ đầy đủ đạt
347/347 test, CI `33431637140` thành công; production revision `c0858ca10e12`
ready với database/schema `ok`, runtime role `restricted`. Smoke test tài khoản
thật xác nhận bộ lọc nhận đúng khu có 7 phòng và không có lỗi console.

Tài khoản ngân hàng theo khu ngày 01/09/2026 đã qua kiểm thử Preview: danh mục tài
khoản theo chủ, một mặc định, gán/kế thừa theo khu và kênh SePay riêng từng tài
khoản đã có schema/API/UI. QR, email, hợp đồng và đối soát dùng tài khoản hiệu
lực theo khu; giao dịch bị chặn khi ghép sang hóa đơn dùng tài khoản khác.
Migration staging và production đều đạt 7/7 cờ; 354/354 test tự động thành
công. API
E2E trên Preview đã tạo đúng một tài khoản mặc định, một tài khoản riêng cho khu
B, đồng bộ cấu hình cũ, gán khu và cập nhật tên thành công. Hai hóa đơn test cũng
trả đúng `bankAccountId` tương ứng cho khu mặc định và khu
B. Preview hotfix đã sửa lỗi client làm rơi assignment khi nạp state; desktop và
mobile 390px không tràn, selector SePay đủ hai tài khoản, QR A101 dùng VCB và QR
B201 dùng MB, console sạch. Commit `42f438e` đã push; CI `33467448343` thành
công. Production deployment `tro-bill-p7unxgbia-dtung.vercel.app`
(`dpl_HYknWy6c4e3HizrGufxKk392T7Qr`) READY; alias chính trả revision
`42f438e2c5cb`, database/schema `ok`, runtime role `restricted`. Smoke test tài
khoản thật xác nhận backfill ICB mặc định, khu hiện tại kế thừa đúng, SePay dùng
đúng tài khoản; desktop/mobile 390px không tràn ngang, console và runtime error
scan sạch.

### Bảo trì và tài sản

- [x] Quản lý tài sản/nội thất theo phòng.
  Đã phát hành: danh mục có mã, số lượng, tình trạng, serial, ngày/giá mua;
  hỗ trợ chuyển phòng, ngừng dùng có lý do, khôi phục, export dữ liệu và tự điền
  biên bản bàn giao. API lọc nhân viên theo khu; chỉ chủ tài khoản được ghi.
  Migration staging và production đều đạt 5/5 cờ; Preview đã qua E2E
  tạo/sửa/chuyển phòng/ngừng dùng/khôi phục, desktop/mobile và confirm modal.
  Production revision `300c178874d9` đã qua readiness, schema/runtime role,
  static asset pins, toàn vẹn dữ liệu và quét Runtime Errors.
- [x] Khách thuê gửi yêu cầu sửa chữa.
  Đã phát hành cổng riêng theo hợp đồng: token 256-bit chỉ lưu SHA-256, nằm trong
  URL fragment và tự mất hiệu lực khi hết hạn/hợp đồng kết thúc. Khách không cần
  tài khoản TrọBill, có thể gửi nhiều yêu cầu append-only với idempotency và rate
  limit; trang public không trả tên, CCCD hoặc hồ sơ khách. Chủ tài khoản tạo,
  thu hồi và xem yêu cầu trong hồ sơ hợp đồng; nhân viên chưa được quản lý portal.
  Migration staging/production đều đạt 6/6 cờ. Preview đã qua E2E hai phía,
  audit và cleanup; desktop/mobile không tràn. Production revision
  `1ee0873bad8e` readiness sạch và endpoint token giả trả lỗi 404 an toàn.
- [x] Phân công người xử lý và theo dõi trạng thái.
  Đã phát hành: chủ tài khoản chỉ phân công thành viên có đồng thời quyền khu
  hiện tại của phòng và nghiệp vụ `rooms`; nhân viên chỉ thấy yêu cầu giao cho
  chính mình, không được hủy và chỉ chuyển theo vòng đời hợp lệ. Assignment hiện
  tại đi cùng event append-only và audit tách actor/subject; nội dung khách gửi
  không được sửa, hoàn tất/hủy bắt buộc ghi chú. Migration staging/production
  đều đạt 6/6 cờ. Preview E2E xác nhận owner phân công, staff chỉ thấy A101 trong
  một khu, chuyển `new -> acknowledged -> in_progress -> resolved`, owner đọc lại
  đủ 4 sự kiện; dữ liệu test đã dọn về 0 và gói owner trả Free. Desktop/mobile
  390px không tràn và khóa scroll nền. Bộ đầy đủ đạt 377/377, CI `33954279257`
  thành công; production revision `d952d9c36f3b` ready với database/schema `ok`,
  runtime role `restricted`, asset pins `style 114 / api 107 / app 117` và route
  mới trả 401 khi chưa đăng nhập.
- [x] Ghi nhận chi phí sửa chữa vào báo cáo thực tế.
  Đã phát hành: chủ tài khoản ghi khoản đã thanh toán ngay trong yêu cầu sửa
  chữa; hệ thống tự gắn đúng khu, kỳ của ngày trả, mã yêu cầu và snapshot phòng
  vào sổ `expense_entries`. Nhân viên không nhận số tiền; retry dùng UUID
  idempotency, audit nằm cùng transaction. Khoản liên kết chỉ đọc trong báo cáo,
  không bị chuyển tháng và được `PUT /api/state` bảo toàn trước tab cũ. Migration
  staging/production đều đạt 6/6 cờ. Preview E2E ghi 123.456 đ, dashboard tăng
  300.000 đ → 423.456 đ, reload vẫn giữ nguồn/trạng thái chỉ đọc; desktop/mobile
  390px không tràn, dữ liệu test đã dọn về 0. Bộ đầy đủ đạt 382/382, CI
  `34006992069` thành công; production revision `6f0ec26e2d31` ready với
  database/schema `ok`, runtime role `restricted`, asset pins
  `style 115 / api 108 / app 119`, endpoint mới trả 401 khi chưa đăng nhập và
  log runtime sau deploy không có lỗi.

### Hoàn thành giai đoạn khi

- [x] Một chủ trọ có thể giao việc cho nhân viên mà không phải cấp toàn quyền tài khoản.

## Giai đoạn 5 — Báo cáo tài chính, thuế và mở rộng doanh thu

### Báo cáo

- [x] Báo cáo doanh thu, thực thu, công nợ, chi phí và lợi nhuận.
  Báo cáo tháng lấy trực tiếp từ ledger server: doanh thu là tổng hóa đơn hiệu
  lực phát hành trong kỳ; thực thu là giao dịch thu/hoàn tác phát sinh trong kỳ
  theo giờ Việt Nam và loại tiền cọc chuyển bù nợ; công nợ là tổng số còn thiếu
  của từng hóa đơn tại cuối kỳ; lợi nhuận tiền mặt bằng thực thu trừ chi phí đã
  trả. API khóa theo workspace `overview`, lọc khu được giao cho staff và không
  lộ chi phí chung nếu staff chưa được giao toàn bộ khu. Preview
  `tro-bill-a1pvogbp8-dtung.vercel.app` đã đối chiếu đúng số liệu staging, đổi
  tháng/làm mới thành công; desktop và mobile 390×844 không tràn, console sạch.
  Bộ đầy đủ đạt 388/388, secret scan/diff sạch; CI `34007985181` thành công.
  Production revision `ea8cfa2af7ed` ready với database/schema `ok`, runtime
  role `restricted`, asset pins `style 116 / api 109 / app 120`; endpoint mới
  trả 401 khi chưa đăng nhập và runtime error scan sau deploy không có lỗi.
- [x] Lọc theo tháng, quý, năm, khu và phòng.
  Bộ lọc dùng cùng định nghĩa năm chỉ số của báo cáo tài chính, hỗ trợ tháng,
  quý, năm và kết hợp khu/phòng. Khu chỉ tính chi phí gắn trực tiếp; phòng chỉ
  tính chi phí sửa chữa đã liên kết, không tự phân bổ chi phí chung. Server xác
  thực ownership và phạm vi khu của staff trước khi tổng hợp. Preview
  `tro-bill-qf9llywns-dtung.vercel.app` đã kiểm tra dữ liệu staging cho tháng,
  quý, năm, hai khu và hai phòng; đổi khu tự loại phòng không phù hợp. Mobile
  390×844 không tràn ngang, console sạch. Bộ đầy đủ đạt 391/391, secret scan và
  diff sạch; CI `34020348803` thành công. Production revision
  `41314eb84b01` ready với database/schema `ok`, runtime role `restricted`, asset
  pins `style 117 / api 110 / app 122`; lọc phòng và quý đã smoke test bằng dữ
  liệu thật, endpoint chưa đăng nhập trả 401 và Runtime Logs không có lỗi.
- [x] Tách tiền thuê, điện nước, dịch vụ, cọc và khoản điều chỉnh.
  Cơ cấu doanh thu dùng snapshot chi tiết hiệu lực của hóa đơn: tiền thuê,
  điện, nước, dịch vụ và điều chỉnh ròng (phụ thu + phí chậm - giảm giá) luôn
  đối soát về tổng doanh thu; hóa đơn legacy thiếu chi tiết được đưa vào nhóm
  chưa phân loại. Tiền cọc hiển thị thành dòng tiền riêng gồm thu, hoàn, khấu
  trừ và dòng tiền thuần; khấu trừ là chuyển số dư nội bộ nên không tính là tiền
  mới nhận. Preview `tro-bill-kgh0234o3-dtung.vercel.app` đã kiểm tra tháng,
  quý, hai khu/phòng và mobile 390×844 không tràn ngang. Production revision
  `679995ecb255` đã đối soát dữ liệu thật toàn khu và phòng 101, endpoint chưa
  đăng nhập trả 401, database/schema `ok`, runtime role `restricted`, console
  và Runtime Logs sạch; không cần migration.
- [x] Báo cáo tỷ lệ lấp đầy và thời gian phòng trống.
  Báo cáo tháng/quý/năm tính theo ngày-phòng đã quan sát, ưu tiên trạng thái có
  khách > giữ chỗ > đang sửa > trống; thời gian sửa chữa không nằm trong mẫu số
  có thể cho thuê. UI có tổng tỷ lệ, số ngày-phòng từng trạng thái, chuỗi trống
  dài nhất/cuối kỳ và lọc khu/phòng; trạng thái tải không giả báo “không có dữ
  liệu”. Preview `dpl_3NkxKRKjMFqjSDNVFNm4nabtXEwc` và Production revision
  `9c3461ec4a63` đã kiểm tra dữ liệu thật: tháng 9 là 42/42 (100%), Q3 là
  436/476 (91,6%); CI `34044169080`, 393/393 test, console/Runtime Logs sạch,
  database/schema `ok`, runtime role `restricted`; không cần migration.
- [x] Xuất Excel/PDF cho kế toán.
  Hai nút xuất dùng đúng snapshot báo cáo đang lọc theo tháng/quý/năm, khu và
  phòng. Excel là workbook `.xlsx` OOXML thật với sheet tổng hợp và chi tiết
  phòng, giá trị VND/tỷ lệ giữ kiểu số; chuỗi được escape và không thể trở thành
  công thức. PDF in A4 ngang, bảng tự tách trang và lặp tiêu đề cột. Preview
  `dpl_21hwneWZTwT42hupP5DbXkJeqPBn` đã tạo file qua nút thật, mobile 390×844
  không tràn; mẫu 48 phòng in đủ 3 trang và đủ 48/48 dòng. Production revision
  `a17ac0329304` đã kiểm tra dữ liệu thật toàn khu và Q3/phòng 403; CI
  `34044949466`, 396/396 test, console/Runtime Logs sạch, database/schema `ok`,
  runtime role `restricted`; không cần migration hay dependency mới.
- [x] Có báo cáo doanh thu năm phục vụ kê khai thuế.
  Báo cáo năm có đủ 12 tháng và bảng theo khu/địa điểm kinh doanh, tách tiền
  thuê, điện, nước, dịch vụ, điều chỉnh và phần chưa phân loại; tổng chi tiết
  được đối soát với báo cáo tài chính cùng bộ lọc. Excel thêm sheet “Đối chiếu
  doanh thu năm”, PDF thêm phần kê khai tương ứng. Đây là số liệu hỗ trợ chuẩn
  bị hồ sơ, không tự suy diễn doanh thu tính thuế hay số thuế phải nộp khi chưa
  biết phương pháp/trạng thái thuế của chủ trọ. Preview
  `dpl_4kWC9uLwVSqLkAmmUwV8pQnGNy9g` đã kiểm tra desktop, breakpoint mobile,
  lọc khu và xuất Excel; Production `dpl_3kGfoQsRYzVLwyMRaXtrbKgZphEm`
  revision `b049670321ca` đã đối soát 99.166.710 đ, 21 hóa đơn, 3/12 tháng và
  khớp 100%. CI `34073770384`, 399/399 test, console/Runtime Logs sạch,
  database/schema `ok`, runtime role `restricted`; không cần migration.

### Hóa đơn điện tử và tích hợp

- [x] Khảo sát ít nhất hai nhà cung cấp hóa đơn điện tử có API.
  Đã so sánh MISA meInvoice, VNPT Invoice và Viettel S-Invoice tại
  `docs/E_INVOICE_PROVIDER_SURVEY.md`. MISA được ưu tiên xin sandbox/báo giá vì
  có tài liệu REST/JSON và môi trường test công khai; VNPT là phương án đối chứng
  bắt buộc nhưng cần xác nhận API hiện hành thay cho public SOAP cũ; Viettel chỉ
  là dự phòng đến khi cung cấp đủ đặc tả. Chưa chọn/tích hợp nhà cung cấp nếu chưa
  có API contract 2026, mô hình ủy quyền nhiều tenant, sandbox, báo giá/SLA và
  điều khoản dữ liệu bằng văn bản.
- [x] Xác định trường hợp khách hàng nào thực sự cần hóa đơn điện tử.
  Ma trận tại `docs/E_INVOICE_ELIGIBILITY_POLICY.md` tách cá nhân/hộ cho thuê
  BĐS dài hạn, dịch vụ lưu trú, doanh nghiệp/tổ chức, hoạt động hỗn hợp, nhu cầu
  tự nguyện và tiền đặt cọc. TrọBill mặc định `review_required`, không coi bill
  nội bộ là HĐĐT và chỉ bật phát hành khi workspace có đăng ký HĐĐT, provider,
  credential riêng, căn cứ còn hiệu lực cùng xác nhận kế toán/pháp lý. Chính sách
  dựa trên Nghị định 254/2026/NĐ-CP và hướng dẫn Cục Thuế công bố năm 2026.
- [ ] Đồng bộ thông tin người thuê và khoản thu sang nhà cung cấp hóa đơn.
  Nền tảng trung gian đã phát hành ngày 07/09/2026: mỗi workspace có hồ sơ pháp
  lý owner-only, trạng thái đủ điều kiện do server suy ra, ngày hiệu lực, nhà
  cung cấp dự kiến, xác nhận của chủ và audit không lưu giá trị nhạy cảm. API/UI
  ghi rõ bill TrọBill chưa phải HĐĐT thuế; không nhận API key trong trình duyệt
  và mọi sửa hồ sơ đều thu hồi xác minh kết nối cũ. Migration staging/production
  đạt 5/5 cờ; Production revision `245f984e7c56`, deployment
  `dpl_Dg1XmfaB7WLz1qEaEZnA6nwJYYhW`, CI `34092666303`, 407/407 test. Mục này
  vẫn chưa hoàn tất cho đến khi có sandbox/API contract 2026 và adapter phát
  hành draft idempotent được kiểm thử.

  Tiền kiểm nguồn đã phát hành cùng ngày ở commit `e004fba`: server dựng snapshot
  tối thiểu từ đúng hóa đơn, hợp đồng và hồ sơ owner; tách tiền phòng, điện,
  nước, rác, Wifi, quản lý, giảm giá, phụ thu và phí chậm; đối soát tổng VND và
  tạo fingerprint SHA-256 ổn định. Khi có nhiều hợp đồng cùng kỳ, người dùng phải
  chọn rõ thay vì hệ thống tự đoán khách. Payload tiền kiểm không chứa CCCD, số
  điện thoại, email hay credential provider và luôn trả `dispatchAllowed=false`;
  giao diện ghi rõ chưa gửi/phát hành HĐĐT. Migration bổ sung tên pháp lý người
  bán đã chạy trên Neon staging và production, cả hai đạt 3/3 kiểm tra. Production
  revision `e004fbadb8bf`, CI `34094777689`, 414/414 test; health monitor phục
  hồi ở run `34129697639`. Đây là bước chuẩn bị adapter, chưa phải đồng bộ thật.

- [x] Lưu mã tra cứu và trạng thái hóa đơn điện tử.
  Đã phát hành sổ trạng thái provider-neutral ở commit `968076b`: mỗi hồ sơ khóa
  theo workspace, hóa đơn nguồn, provider và mã tài liệu ngoài; lưu số hóa đơn,
  mã tra cứu, mã cơ quan thuế, trạng thái chuẩn hóa và thời điểm phát hành. Mỗi
  callback chỉ lưu SHA-256 payload, chống dùng lại event ID với nội dung khác,
  chặn event đến trễ và ghi lịch sử append-only; mã đã nhận không thể bị đổi.
  Trình duyệt chỉ có API owner-only để đọc, không có route ghi hoặc nút phát hành.
  Migration `20260908_electronic_invoice_records.sql` đạt 5/5 trên Neon Preview
  và Production; Preview E2E run `34234080279` thành công, Production deployment
  `dpl_5Yf9EG7jqkDUnQGCEakrPiowXPq9` trả readiness HTTP 200 với database/schema
  `ok`, runtime role `restricted`. Sổ sẽ chưa có bản ghi thật cho tới khi adapter
  được xác minh bằng sandbox/API contract hiện hành.
- [x] Có quy trình điều chỉnh hoặc thay thế hóa đơn sai.
  Runbook `docs/E_INVOICE_CORRECTION_RUNBOOK.md` phân loại rõ trường hợp chỉ
  thông báo, điều chỉnh, thay thế hoặc phát sinh chênh lệch do quyết toán; quy
  định vai trò owner/kế toán/provider/support, đóng băng bằng chứng, idempotency,
  callback, đối chiếu kết quả và sáu nhóm sự cố kỹ thuật. Quy trình dùng sổ trạng
  thái append-only đã phát hành nhưng cố ý không thêm nút điều chỉnh/thay thế khi
  chưa có provider contract, credential riêng, nơi lưu XML/PDF và mapping được
  người có chuyên môn duyệt. Thao tác thật tạm thực hiện trên cổng provider và
  chỉ được đồng bộ về TrọBill sau khi adapter xác minh.
- [ ] Được kế toán hoặc đơn vị tư vấn pháp lý kiểm tra nghiệp vụ trước khi phát hành.

### Kênh doanh thu bổ sung — chỉ làm sau khi SaaS ổn định

- [ ] Gói nhập dữ liệu và triển khai ban đầu có thu phí.
- [ ] Gói thương hiệu riêng cho đơn vị quản lý lớn.
- [ ] Phí thêm nhân viên hoặc thêm khu trọ.
- [ ] Gói lưu trữ ảnh/chứng từ dung lượng cao.
- [ ] Chương trình giới thiệu khách hàng có thưởng.
- [ ] Chưa xây marketplace tìm phòng cho đến khi có lượng chủ trọ hoạt động đủ lớn.

## Checklist mở bán

- [x] Có landing page mô tả đúng vấn đề, tính năng và bảng giá.
  Đã phát hành `/gioi-thieu`: mô tả đúng luồng phòng → chỉ số → bill/VietQR →
  thanh toán/công nợ, nêu rõ bill TrọBill chưa phải HĐĐT thuế và lấy bảng giá
  từ `GET /api/public/plans`. Endpoint chỉ trả gói `active + public`; production
  ngày 08/09/2026 trả HTTP 200 và đang công khai đúng gói Free 10 phòng, không
  ghi cứng hoặc tự suy đoán giá trả phí. Commit `feda8ca`, CI `34175028079`.
- [x] Có hướng dẫn bắt đầu nhanh và dữ liệu mẫu.
  Đã phát hành `/huong-dan` với quy trình 5 bước và generator JSON cho ba phòng
  giả lập trong tháng hiện tại. Mỗi lượt tải tạo UUID mới; file không có khách,
  CCCD, điện thoại, email hoặc tài khoản ngân hàng và cảnh báo chỉ nhập ở tài
  khoản trống/sao lưu trước. Production revision `e2bb6b2fcad2` trả HTTP 200,
  database/schema `ok`, runtime role `restricted`; CI `34176436306`, 422/422 test.
- [x] Có công cụ nhập phòng/khách từ Excel hoặc JSON.
  Đã phát hành luồng nhập CSV UTF-8 xuất từ Excel hoặc JSON với preview số khu,
  phòng và khách trước khi ghi; mặc định gộp bằng ID mới, còn thay thế bắt buộc
  xác nhận riêng. Dữ liệu được kiểm tra định dạng, trùng ID/phòng, ngày, email,
  CCCD; file có khách phải xác nhận quyền xử lý dữ liệu cá nhân. Giới hạn 5 MB,
  500 phòng và 2.000 khách; frontend chỉ báo thành công sau khi server xác nhận
  và khôi phục giao diện nếu PUT bị từ chối. Production revision
  `eab951bd939e` trả HTTP 200, database/schema `ok`, runtime role `restricted`;
  CI `34177957306`, 429/429 test và secret scan sạch.
- [ ] Có kênh hỗ trợ chính thức và thời gian phản hồi cam kết.
- [ ] Có điều khoản sử dụng, chính sách bảo mật và chính sách hoàn tiền.
  Bản pilot của cả ba tài liệu đã phát hành công khai: điều khoản và bảo mật
  phiên bản 08/09/2026, cùng `/refund-policy.html` tách rõ tiền gói TrọBill khỏi
  tiền thuê/cọc và mô tả đúng workflow yêu cầu → rà soát → duyệt/từ chối → mã
  giao dịch hoàn. Tài khoản cũ được yêu cầu xác nhận lại phiên bản mới. Mục này
  chưa đóng vì còn phải bổ sung thông tin pháp nhân/kênh hỗ trợ và được tư vấn
  pháp lý rà soát trước khi bán. Production revision `3daf767b2024`, CI
  `34179242211`, 436/436 test và secret scan sạch.
- [ ] Hoàn thiện thủ tục kinh doanh, thuế và website/app phù hợp với mô hình bán dịch vụ.
- [x] Chạy kiểm thử end-to-end trên staging với dữ liệu giả lập.
  Runner thủ công `npm run test:e2e:staging` và GitHub Actions đã có guard chống
  production, xác minh health/cookie/account context của hai tài khoản độc lập,
  tạo khu UUID bằng A, bắt B không được thấy, mô phỏng tab cũ cookie B + context A
  phải trả `SESSION_ACCOUNT_CHANGED`, rồi cleanup đúng marker. Hai migration
  `20260907_electronic_invoice_profiles.sql` và
  `20260907_electronic_invoice_preflight.sql` đã chạy trên Neon `staging-privacy`
  (`br-ancient-wave-azwc43to`) ngày 08/09/2026, lần lượt đạt 5/5 và 3/3 cờ xác
  minh. Preview `tro-bill-6n5t42b90-dtung.vercel.app` sau đó trả HTTP 200 với
  database/schema `ok`, runtime role `restricted`. Hai workspace staging chuyên
  dụng và năm Environment secrets đã được cấu hình. Runner bỏ header đặt bypass
  cookie để tránh redirect xung đột với `redirect=error`; commit `d89a212`, bộ
  test 445/445. Workflow `34201397172` chạy xanh đủ sáu bước và truy vấn Neon
  sau cùng xác nhận không còn khu có tiền tố `E2E-`.
- [ ] Chạy thử một chu kỳ bill hoàn chỉnh với 5 khách pilot.
- [ ] Thu tiền thật thành công từ ít nhất 3 khách pilot.
- [ ] Theo dõi pilot qua kỳ lập bill thứ hai trước khi quảng bá rộng.

## Tiêu chí sẵn sàng mở bán đại trà

- [x] Không có lỗi làm mất hoặc lẫn dữ liệu giữa các tài khoản.
  Regression test client đã kiểm tra đổi cookie giữa tab, hủy autosave và tuần tự
  hóa PUT state; runner staging commit `1e5549b` bổ sung kiểm tra hai cookie/context
  và dữ liệu khu thực qua API. Workflow `34201397172` đã chạy xanh trên Preview
  bằng hai workspace độc lập: B không thấy marker của A, cookie B + context A bị
  chặn `SESSION_ACCOUNT_CHANGED`, cookie A vẫn đọc đúng dữ liệu và cleanup về 0.
- [x] Backup và phục hồi đã được kiểm chứng.
- [x] Subscription và giới hạn gói được kiểm tra ở server.
  Server lấy entitlement trực tiếp từ `subscriptions` + `plans`, chặn vượt giới
  hạn phòng trước khi thay state và chặn vượt giới hạn nhân viên trước INSERT.
  Tài khoản hết trial/ân hạn bị chặn ở middleware chung trên các API ghi vận
  hành cũ; vẫn cho phép xem/xuất/xóa tài khoản, mua hoặc gia hạn gói và các thao
  tác giảm rủi ro như thu hồi link, hủy lịch gửi, tắt kênh hoặc xóa nhân viên.
  Production revision `d5adcd7282d4` trả HTTP 200, database/schema `ok`, runtime
  role `restricted`; CI `34178776243`, 433/433 test và secret scan sạch.
- [ ] Thanh toán gói TrọBill được ghi nhận tự động và không bị trùng.
  Webhook chuẩn hóa đã kiểm tra chữ ký, idempotency theo event/transaction và từ
  chối `409 WEBHOOK_EVENT_PAYLOAD_MISMATCH` nếu cùng event ID bị gửi lại với loại
  event hoặc raw payload khác. Tiêu chí vẫn mở vì VietQR tĩnh không phát webhook;
  cần nối adapter của nhà cung cấp thật và xác minh ít nhất một giao dịch pilot
  trên production. Đường dự phòng đối soát thủ công dùng cùng khóa transaction
  với webhook nên không thể gia hạn lặp; mục vẫn mở vì đường tự động chưa có
  provider thật. Production revision `ac14d1ccb3ff`, CI `34193887394`, 437/437
  test và secret scan sạch.
- [x] Hóa đơn tiền trọ hỗ trợ công nợ và thanh toán một phần.
- [ ] Có ít nhất 70% khách pilot quay lại ở kỳ lập bill thứ hai.
- [ ] Có ít nhất 3 khách hàng trả phí và sẵn sàng tiếp tục sử dụng.
- [ ] Có quy trình hỗ trợ, xử lý sự cố và phản hồi bảo mật.
  Quy trình sự cố nội bộ nằm trong `OPERATIONS.md`; `SECURITY.md` hướng người báo
  sang GitHub Private Vulnerability Reporting và cấm đưa cookie, CCCD hoặc dữ
  liệu khách lên Issue công khai. Kênh riêng tư đã bật và API GitHub xác nhận
  `enabled=true` ngày 08/09/2026. Mục vẫn mở vì chưa có kênh hỗ trợ khách hàng
  chính thức và SLA do chủ sản phẩm phê duyệt.
