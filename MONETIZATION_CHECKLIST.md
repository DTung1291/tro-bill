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
- [ ] Khách xem được chỉ số và ảnh đồng hồ nếu có.
- [ ] Khách quét VietQR theo số tiền còn lại.
- [ ] Khách gửi minh chứng chuyển khoản.
- [ ] Khách tải phiếu thu sau khi được xác nhận.
- [ ] Khách xem lịch sử hóa đơn và thanh toán của chính phòng mình.
- [ ] Liên kết không làm lộ dữ liệu của phòng hoặc khách khác.

### Gửi hóa đơn và nhắc nợ

- [ ] Có mẫu tin nhắn hóa đơn và mẫu nhắc nợ.
- [ ] Gửi hoặc chia sẻ qua Zalo, email và liên kết hệ thống.
- [ ] Cho phép hẹn ngày gửi hóa đơn.
- [ ] Tự động nhắc trước hạn và sau hạn theo cấu hình.
- [ ] Dừng nhắc ngay khi hóa đơn đã được thanh toán đủ.
- [ ] Lưu trạng thái gửi thành công/thất bại và cho phép gửi lại.
- [ ] Tách phí SMS/Zalo khỏi giá subscription nếu phát sinh theo lượt.

### Hoàn thành giai đoạn khi

- [ ] Có thể theo dõi đầy đủ một hóa đơn từ lúc phát hành đến khi thanh toán nhiều lần và nhận phiếu thu.

## Giai đoạn 4 — Hợp đồng và vận hành nhiều khu trọ

### Vòng đời thuê phòng

- [ ] Quản lý hợp đồng thuê và các phụ lục thay đổi giá.
- [ ] Tạo hợp đồng từ mẫu và xuất PDF.
- [ ] Quản lý ngày bắt đầu, ngày hết hạn và chu kỳ thanh toán.
- [ ] Nhắc hợp đồng sắp hết hạn.
- [ ] Quản lý đặt cọc và biên bản bàn giao tài sản.
- [ ] Hỗ trợ giữ chỗ, chuyển phòng và trả phòng.
- [ ] Chốt bill cuối cùng khi khách trả phòng.
- [ ] Quản lý trạng thái phòng: trống, giữ chỗ, đang thuê, đang sửa.

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
