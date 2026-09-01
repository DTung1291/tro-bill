# Nhật ký quyết định kỹ thuật và nghiệp vụ

Tài liệu này giữ “mindset” có thể kiểm chứng của dự án dưới dạng quyết định,
không lưu suy luận nội bộ hoặc transcript phiên chat. Mục đã phát hành không bị
xóa; khi đổi hướng, thêm quyết định mới có dòng `Thay thế:` trỏ tới mục cũ.

## D-001 — Dữ liệu luôn thuộc một tài khoản

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** API nghiệp vụ lấy chủ sở hữu từ phiên (`req.userId`), mọi truy
  vấn và quan hệ database scope theo `user_id`; client không được chọn owner.
- **Lý do:** Lỗi lẫn phiên/tài khoản từng có khả năng khiến state của người này
  hiển thị hoặc ghi vào người khác. Đây là rủi ro mất dữ liệu nghiêm trọng.
- **Hệ quả:** Mọi route/bảng mới phải có test ownership/cross-account; khóa ngoại
  ghép được ưu tiên khi quan hệ đi qua phòng.

## D-002 — Cookie phiên và account context chống ghi chéo tab

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** JWT chỉ ở cookie `HttpOnly`; frontend xác minh account context
  trước khi nạp/lưu state và vô hiệu hóa dữ liệu cũ khi tài khoản đổi.
- **Lý do:** Nhiều tài khoản đăng nhập trên cùng browser từng reload lẫn nhau.
- **Hệ quả:** Không khôi phục token/local state cũ để “đơn giản hóa” đăng nhập;
  mọi thay đổi auth phải chạy test `account-session-isolation` và cookie.

## D-003 — Giá có mốc hiệu lực, chứng từ là snapshot

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Giá phòng, điện, nước và phí lưu theo `effectiveFrom`; hóa đơn
  và hợp đồng lưu snapshot tại thời điểm phát hành/tạo.
- **Lý do:** Giá từ tháng 2 hoặc tháng 4 không được làm thay đổi tháng trước hay
  chứng từ đã chốt.
- **Hệ quả:** Không cập nhật ngược mọi kỳ khi sửa giá. Tháng bắt đầu thuê tính
  tiền theo ngày và tính cả ngày vào ở: ngày 10/08 là 22/31 ngày.

## D-004 — Sổ tài chính append-only

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Thanh toán, cọc, hoàn cọc, khấu trừ và sửa/hủy giao dịch dùng
  bút toán/điều chỉnh có dấu vết; webhook và delivery có khóa idempotency.
- **Lý do:** Xóa/sửa trực tiếp làm mất khả năng đối soát và có thể ghi tiền hai
  lần khi request được gửi lại.
- **Hệ quả:** Hạng mục đặt cọc/biên bản sắp tới phải tái sử dụng
  `tenant_deposit_ledger`, không tạo cột số dư hoặc ledger cạnh tranh.

## D-005 — CCCD che mặc định và mọi lần mở đều có trách nhiệm

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** State/UI chỉ nhận CCCD đã che. Reveal/export bản đầy đủ kiểm tra
  ownership, yêu cầu lý do hỗ trợ hoặc xác thực mật khẩu theo luồng, trả
  `no-store` và ghi audit tối giản.
- **Lý do:** Admin không phải “người kiểm duyệt” tự do; admin chỉ hỗ trợ kỹ thuật
  và chính người phụ trách dữ liệu phải có thể rà soát lý do truy cập.
- **Hệ quả:** Không đưa CCCD vào log, message lỗi, handoff hoặc fixture chứa dữ
  liệu thật.

## D-006 — Migration tiến tới và runtime least privilege

- **Trạng thái:** Đang áp dụng; thu hồi role cũ còn chờ xác minh deployment.
- **Quyết định:** `server/schema.sql` là schema đầy đủ, mỗi thay đổi đã phát hành
  có migration tiến tới chạy lại an toàn; app dùng `tro_bill_runtime_sql` chỉ có
  quyền cần thiết, backup dùng role chỉ đọc riêng.
- **Lý do:** Serverless instance không được có quyền DDL/superuser và deploy mới
  không được khởi động trước khi schema cần thiết sẵn sàng.
- **Hệ quả:** Cập nhật grants trong cùng migration/schema, staging trước
  production; không sửa migration cũ để che lịch sử.

## D-007 — Chu kỳ hợp đồng không đổi chu kỳ lập hóa đơn vận hành

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Hợp đồng có thể ghi thanh toán 1/3/6/12 tháng mỗi kỳ, nhưng hóa
  đơn TrọBill vẫn được lập theo tháng.
- **Lý do:** Chu kỳ hợp đồng mô tả nghĩa vụ hai bên; thay cơ chế billing hiện hữu
  sẽ tác động công nợ, điện nước và nhắc nợ ngoài phạm vi tính năng hợp đồng.
- **Hệ quả:** Không tự gộp hóa đơn nhiều tháng chỉ vì hợp đồng có chu kỳ 3 tháng.

## D-008 — Email/cron retry an toàn và ưu tiên kênh miễn phí

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Email hiện ưu tiên Brevo Free; Web Share dùng cho Zalo/ứng dụng.
  Cron/delivery giới hạn batch, chống gửi trùng và chỉ retry lỗi tạm thời.
- **Lý do:** Giữ chi phí pilot thấp nhưng không hy sinh tính đúng/idempotency.
- **Hệ quả:** SMS/Zalo API trả phí sau này là add-on minh bạch, không tự gộp vào
  subscription.

## D-009 — Tài liệu hợp đồng phải được kiểm tra bằng PDF thật

- **Trạng thái:** Đang áp dụng.
- **Quyết định:** Mẫu HTML bám nội dung DOCX được cung cấp; print media phải bỏ
  `position: fixed`/khóa overflow của modal và cho nội dung chảy qua nhiều trang.
- **Lý do:** Preview HTML đúng vẫn có thể in 1/1 trang và cắt toàn bộ nội dung sau
  viewport.
- **Hệ quả:** Mọi sửa CSS/template hợp đồng phải tạo PDF, đếm trang và kiểm tra
  trực quan trang đầu, giữa và cuối.

## D-010 — Context của agent nằm trong Git, không nằm trong một cuộc chat

- **Trạng thái:** Đang áp dụng từ 29/08/2026.
- **Quyết định:** Quy tắc ở `AGENTS.md`, trạng thái sống ở `AI_HANDOFF.md`, quyết
  định bền vững ở tài liệu này; `CLAUDE.md` nhập lại cùng nguồn thay vì sao chép.
- **Lý do:** Transcript dài chứa giả định/lối thử đã bỏ và chỉ agent gốc nhìn
  thấy; Git cho mọi agent cùng xem phiên bản, diff, review và rollback.
- **Hệ quả:** Agent kết thúc tính năng phải cập nhật handoff trong commit cuối;
  không lưu chain-of-thought, secret hoặc dữ liệu khách hàng để “giữ context”.

## D-011 — Biên bản bàn giao là snapshot bất biến của hợp đồng và sổ cọc

- **Trạng thái:** Đang áp dụng từ 29/08/2026.
- **Quyết định:** Mỗi hợp đồng có tối đa một biên bản nhận phòng và một biên bản
  trả phòng. Biên bản lưu snapshot bên thuê/phòng, chỉ số, chìa khóa, hiện trạng,
  tài sản, tiền cọc theo hợp đồng và số dư sổ cọc tại thời điểm xác nhận; runtime
  chỉ được SELECT/INSERT, không được UPDATE/DELETE.
- **Lý do:** Chứng từ đã ký phải phản ánh đúng thời điểm bàn giao, trong khi giao
  dịch thu/khấu trừ/hoàn cọc có thể tiếp tục phát sinh độc lập sau đó.
- **Hệ quả:** Không thêm cột số dư cọc mới và không sửa biên bản để khớp số dư
  hiện tại. Mọi điều chỉnh tiền đi qua `tenant_deposit_transactions`; chuyển/trả
  phòng sau này phải giữ nguyên biên bản cũ và tạo nghiệp vụ tiếp nối có audit.

## D-012 — Chuyển phòng tạo hợp đồng mới và vòng đời có nhật ký bất biến

- **Trạng thái:** Đang áp dụng từ 29/08/2026.
- **Quyết định:** Mỗi phòng chỉ có một lượt giữ chỗ active. Chuyển phòng kết thúc
  hợp đồng cũ, chuyển tenant sang phòng đích và tạo hợp đồng active mới trong một
  transaction; không sửa `room_id` của hợp đồng cũ. Trả/chuyển phòng yêu cầu biên
  bản `check_out`. Các mốc giữ chỗ, chuyển và trả được ghi vào event append-only.
- **Lý do:** Sửa phòng trực tiếp trên hợp đồng làm sai snapshot pháp lý, lịch sử
  giá và liên kết chứng từ; thao tác rời rạc có thể để khách/hợp đồng ở trạng thái
  nửa chừng khi một bước thất bại.
- **Hệ quả:** Phòng đích phải không có hợp đồng hoặc giữ chỗ active. Giữ chỗ chỉ
  được chuyển thành hợp đồng khi client gửi đúng `reservationId`; bill cuối cùng
  và trạng thái phòng sẽ dựa trên event/hợp đồng thay vì xóa lịch sử cũ.

## D-013 — Quyết toán cuối là snapshot bất biến trên invoice và ledger hiện có

- **Trạng thái:** Đang áp dụng từ 30/08/2026.
- **Quyết định:** Chỉ chốt quyết toán sau event `checked_out` và biên bản
  `check_out` cùng ngày. Giữ nguyên `issued_total_vnd`/`detail_snapshot`, ghi tổng
  và chi tiết sau quyết toán vào các cột `final_*` chỉ một lần. Tiền phòng tính từ
  ngày bắt đầu của hợp đồng (nếu cùng tháng) đến ngày trả phòng, bao gồm cả hai
  đầu ngày. Tiền cọc bù nợ tạo receipt/allocation và giao dịch khấu trừ; cọc còn
  lại tạo giao dịch hoàn, tất cả trong cùng transaction.
- **Lý do:** Sửa hóa đơn gốc làm mất chứng từ đã phát hành; tạo một nguồn công nợ
  hoặc số dư cọc khác sẽ khiến đối soát QR, nhắc nợ, biên nhận và sổ cọc lệch nhau.
- **Hệ quả:** Mọi luồng đọc số tiền phải dùng
  `COALESCE(final_total_vnd, issued_total_vnd)`. Final settlement là append-only,
  idempotent theo hợp đồng và không thể chạy nếu chỉ số điện/nước khác biên bản.
  Hoàn tiền thuê do trả thừa được lưu riêng trong snapshot quyết toán; việc chi
  tiền thực tế vẫn là nghiệp vụ vận hành cần chủ trọ xác nhận ngoài hệ thống.

## D-014 — Trạng thái phòng là dữ liệu suy ra ở server

- **Trạng thái:** Đang áp dụng từ 30/08/2026.
- **Quyết định:** Không lưu một cột trạng thái phòng cho cả bốn trạng thái.
  **Đang thuê** được suy ra từ khách hiện có hoặc hợp đồng active (để tương thích
  dữ liệu trước khi có hợp đồng điện tử), **giữ chỗ** từ reservation active,
  **đang sửa** từ `room_maintenance_periods` active, còn lại là **trống**. Server
  trả trạng thái tổng hợp và đánh dấu `conflict` nếu dữ liệu cũ có nhiều nguồn
  cùng hoạt động.
- **Lý do:** Một cột do client tự cập nhật có thể lệch hợp đồng, giữ chỗ hoặc
  danh sách khách; thao tác đồng thời còn có thể ghi đè trạng thái đúng.
- **Hệ quả:** Tạo giữ chỗ, kích hoạt/chuyển hợp đồng, bắt đầu sửa và thay state
  đều phải khóa phòng rồi kiểm tra mọi nguồn xung đột trong cùng transaction.
  Sửa chữa có lịch sử riêng; hai mốc bắt đầu/hoàn thành được ghi vào event
  append-only. UI không được tự suy trạng thái từ các cache chưa tải.

## D-015 — Khóa đồng thời phải giữ nguyên least privilege và thứ tự snapshot

- **Trạng thái:** Đang áp dụng từ 30/08/2026.
- **Quyết định:** Ledger append-only không được cấp `UPDATE` chỉ để dùng row
  lock; các thao tác cọc dùng advisory lock ổn định theo idempotency, giao dịch
  hoàn tác và tài khoản số dư. Vì `PUT /api/state` thay toàn bộ snapshot, frontend
  phải xếp hàng các request và server phải khóa tuần tự theo `user_id` trước mọi
  row lock.
- **Lý do:** PostgreSQL yêu cầu quyền `UPDATE` cho `SELECT ... FOR UPDATE`, từng
  làm API cọc lỗi `42501`. Nhiều autosave chạy chồng vừa có thể deadlock vừa cho
  phép snapshot cũ commit sau và ghi đè snapshot mới.
- **Hệ quả:** Không sửa lỗi khóa bằng cách nới quyền trên sổ tài chính. Mọi đường
  ghi cọc mới phải dùng cùng khóa `deposit-balance:<user>:<account>` với trigger;
  mọi thay đổi cơ chế autosave phải giữ kiểm tra account context, revision và hai
  lớp tuần tự client/server.

## D-016 — Khu/tòa nhà là thực thể ổn định ngoài snapshot state

- **Trạng thái:** Đang áp dụng từ 30/08/2026.
- **Quyết định:** Khu/tòa nhà nằm trong bảng `properties` có CRUD riêng; mỗi
  phòng giữ `property_id` có ownership FK cùng `user_id`. `PUT /api/state` chỉ
  thay dữ liệu phòng và tự dùng khu mặc định khi client/import cũ thiếu
  `propertyId`, không xóa hoặc tạo lại danh sách khu.
- **Lý do:** Khu là cấu hình dài hạn, trong khi state cũ xóa/ghi lại toàn bộ
  phòng. Đưa khu vào snapshot ghi toàn phần sẽ cho tab cũ vô tình xóa khu hoặc
  tạo tham chiếu chéo tài khoản.
- **Hệ quả:** Mỗi tài khoản luôn có “Khu trọ chính”; khu mặc định không được xóa,
  khu còn phòng phải chuyển hết phòng trước khi xóa. Migration có trigger gắn
  khu mặc định cho server cũ để rollout schema trước code không làm gián đoạn
  ghi dữ liệu. Backup nhiều khu phải ánh xạ ID theo tài khoản đích trước khi ghi
  phòng; địa chỉ hợp đồng/biên bản lấy mặc định từ khu của phòng.

## D-017 — Vai trò tài khoản tách khỏi quyền truy cập dữ liệu

- **Trạng thái:** Đang áp dụng từ 31/08/2026.
- **Quyết định:** Mỗi tài khoản vận hành có một membership `owner` bất biến và
  có thể gán tài khoản TrọBill đã xác minh vào một trong ba vai trò `manager`,
  `accountant`, `meter_reader`. Dữ liệu nghiệp vụ vẫn thuộc `account_user_id`
  của chủ sở hữu; membership chỉ mô tả vai trò và chưa tự cấp quyền đọc/ghi dữ
  liệu của chủ. Quyền đó chỉ được kích hoạt khi có phạm vi khu hoặc nghiệp vụ
  được giao ở hạng mục phân quyền tiếp theo.
- **Lý do:** Cho nhân viên truy cập toàn bộ dữ liệu ngay khi gán vai trò sẽ vượt
  quá nguyên tắc least privilege và làm mục “chỉ xem khu/nghiệp vụ được giao”
  không còn chốt chặn an toàn.
- **Hệ quả:** Chỉ chủ sở hữu quản lý danh sách vai trò; không thể sửa/xóa owner.
  Thêm hoặc đổi vai trò tuân theo gói và hạn mức nhân viên, nhưng thu hồi thành
  viên luôn được phép kể cả khi gói hết hạn/hạ cấp. Mọi endpoint dữ liệu dành
  cho nhân viên sau này phải xác minh membership cùng assignment cụ thể, không
  được thay `req.userId` bằng account chủ chỉ dựa trên role.

## D-018 — Workspace nhân viên tách actor khỏi phạm vi dữ liệu hiệu lực

- **Trạng thái:** Đang áp dụng từ 31/08/2026.
- **Quyết định:** Cookie và `X-Trobill-Account-Context` luôn xác định tài khoản
  thật đang đăng nhập (`actor`). Client chỉ được chọn tài khoản làm việc bằng
  `X-Trobill-Workspace-Account-Id`; server phải xác minh membership, vai trò,
  ít nhất một khu và từng nghiệp vụ được giao trước khi đổi phạm vi truy vấn sang
  `account_user_id` của chủ. Workspace nhân viên hiện chỉ đọc; `PUT /api/state`
  luôn bị chặn vì endpoint này thay toàn bộ snapshot.
- **Lý do:** Dùng workspace như danh tính đăng nhập sẽ tái tạo lỗi lẫn tài khoản
  giữa các tab. Cho nhân viên ghi một snapshot đã lọc có thể xóa dữ liệu ở những
  khu họ không nhìn thấy.
- **Hệ quả:** Mọi dữ liệu trả về cho nhân viên phải vừa lọc theo khu, vừa lược bỏ
  trường ngoài nghiệp vụ. Các quyền ghi sau này cần endpoint hẹp theo từng tài
  nguyên, kiểm tra lại khu/nghiệp vụ trong transaction; không được mở ghi bằng
  cách bỏ chốt read-only của state.

## D-019 — Audit nghiệp vụ dùng chung nhật ký dữ liệu và tách actor khỏi subject

- **Trạng thái:** Đang áp dụng từ 31/08/2026.
- **Quyết định:** Thay đổi biểu phí, nguồn/phát hành hóa đơn, ledger tiền
  phòng/cọc, đối soát ngân hàng và vòng đời hợp đồng được ghi vào
  `data_audit_logs` trong cùng transaction với nghiệp vụ. Nhật ký phân biệt
  `actor_user_id` là người thật đang thao tác với `subject_user_id` là tài khoản
  sở hữu dữ liệu; tác vụ tự động để actor rỗng và hiển thị là “Hệ thống”. Audit
  chỉ lưu loại thao tác, tài nguyên, tên trường đã đổi và mục đích ngắn, không
  lưu giá trị trước/sau hoặc snapshot dữ liệu nhạy cảm.
- **Lý do:** Tạo thêm một bảng audit tài chính/hợp đồng sẽ phân mảnh lịch sử và
  chính sách lưu giữ. Ghi log sau khi commit có thể làm nghiệp vụ thành công
  nhưng mất dấu vết; coi workspace là actor sẽ tiếp tục gây nhầm tài khoản khi
  nhân viên làm việc thay chủ.
- **Hệ quả:** Mọi đường ghi mới trong bốn nhóm nghiệp vụ phải dùng
  `requestDataAuditEntry` và ghi trước `COMMIT`; request idempotent phát lại
  không được tạo log mới. `PUT /api/state` phải so sánh dữ liệu hiện có với
  snapshot gửi lên để bỏ qua no-op. Trường audit mới phải được allowlist và nhật
  ký tiếp tục áp dụng retention 365 ngày.

## D-020 — Chi phí theo khu không được tự phân bổ từ dữ liệu chung

- **Trạng thái:** Đã phát hành production ngày 01/09/2026.
- **Quyết định:** `expense_entries.property_id` là quan hệ nullable có ownership
  FK cùng `user_id`. `NULL` nghĩa là chi phí chung của toàn tài khoản; dashboard
  “Tất cả khu” tính cả chi phí chung và chi phí đã gắn khu, còn dashboard một khu
  chỉ tính khoản gắn trực tiếp vào khu đó. Dữ liệu cũ giữ `NULL`, không tự gán
  sang khu mặc định và không tự chia tỷ lệ theo số phòng/doanh thu.
- **Lý do:** Hệ thống không có căn cứ nghiệp vụ để biết chi phí điện, sửa chữa
  hoặc vận hành cũ thực sự thuộc khu nào. Tự gán hoặc phân bổ sẽ làm báo cáo lợi
  nhuận từng khu trông chính xác nhưng sai số liệu gốc.
- **Hệ quả:** Form chi phí phải cho chọn một khu hoặc “Chi phí chung” và giải
  thích phạm vi tính. Khu còn khoản chi đã gắn không được xóa cho đến khi khoản
  chi được chuyển khu hoặc đưa về chung. Nhân viên chỉ nhận khoản chi thuộc khu
  được giao; chi phí chung chỉ được trả về khi họ được giao toàn bộ khu của tài
  khoản. Nếu sau này cần phân bổ chi phí chung, phải thêm quy tắc và bút toán
  phân bổ có thể kiểm tra, không thay đổi âm thầm ý nghĩa của `NULL`.

## D-021 — Tài khoản nhận tiền là danh mục dùng chung, khu chỉ giữ tham chiếu

- **Trạng thái:** Đã phát hành production từ 01/09/2026.
- **Quyết định:** Mỗi chủ trọ có danh mục `rent_bank_accounts`, đúng một tài
  khoản mặc định và tối đa 20 tài khoản. `properties.rent_bank_account_id` có
  thể trỏ tới một tài khoản cùng chủ; `NULL` nghĩa là kế thừa tài khoản mặc
  định. Một tài khoản được phép dùng cho nhiều khu. Kênh SePay và giao dịch ngân
  hàng giữ `bank_account_id` để mỗi tài khoản có webhook riêng và chỉ đối soát
  với hóa đơn dùng đúng tài khoản đó. Ba trường `settings.bank_*` tiếp tục phản
  chiếu tài khoản mặc định trong giai đoạn tương thích.
- **Lý do:** Sao chép đầy đủ thông tin ngân hàng vào từng khu tạo dữ liệu trùng,
  khó đổi một tài khoản dùng chung và không mô hình hóa được nhiều webhook
  SePay. Chỉ dựa vào số tài khoản trong giao dịch cũng không đủ khóa ownership
  hoặc ngăn ghép thủ công sang hóa đơn của khu khác.
- **Hệ quả:** Đổi tài khoản mặc định phải đồng bộ cấu hình cũ trong cùng
  transaction. Không được xóa tài khoản đang là mặc định, đang gán cho khu hoặc
  đã có kênh/lịch sử đối soát. QR, email, link hóa đơn, hợp đồng và tin nhắn lấy
  tài khoản hiệu lực theo khu rồi mới fallback mặc định. Giao dịch có
  `bank_account_id` chỉ được tự động hoặc thủ công ghép với invoice có cùng tài
  khoản hiệu lực; giao dịch legacy chưa có ID vẫn giữ luồng tương thích.

## D-022 — Tài sản phòng dùng lưu trữ mềm và không giữ FK trực tiếp tới snapshot phòng

- **Trạng thái:** Đang triển khai từ 01/09/2026.
- **Quyết định:** Mỗi tài sản có mã ổn định, phòng hiện tại và snapshot tên
  phòng. Tài sản không có thao tác xóa vật lý; ngừng dùng phải lưu lý do và thời
  điểm, sau đó có thể khôi phục vào một phòng còn tồn tại. Không tạo foreign key
  trực tiếp từ `room_assets.room_id` sang `rooms` vì endpoint state cũ thay toàn
  bộ các row phòng. Thay vào đó mọi đường ghi khóa cùng advisory lock với state,
  xác minh ownership trong transaction và `PUT /state` chặn xóa phòng còn tài
  sản hoạt động.
- **Lý do:** Xóa tài sản làm mất lịch sử bàn giao và kiểm kê. Foreign key trực
  tiếp sẽ làm cơ chế thay snapshot phòng hiện tại lỗi hoặc buộc cascade ngoài ý
  muốn dù ID phòng logic không đổi.
- **Hệ quả:** Tài sản đã lưu trữ vẫn giữ tên phòng cuối để xuất dữ liệu. Chỉ chủ
  tài khoản được ghi; nhân viên có nghiệp vụ phòng chỉ đọc tài sản thuộc khu đã
  giao. Danh mục tài sản đang hoạt động là nguồn mặc định cho biên bản bàn giao,
  nhưng biên bản đã xác nhận vẫn là snapshot bất biến.
