# Bàn giao công việc AI — TrọBill

Tài liệu này chỉ lưu **trạng thái vận hành hiện tại** để agent kế tiếp bắt đầu
đúng chỗ. Các lý do bền vững nằm trong `AI_DECISIONS.md`; quy tắc bắt buộc nằm
trong `../AGENTS.md`.

## Trạng thái hiện tại

| Trường | Giá trị |
|---|---|
| Cập nhật lần cuối | 31/08/2026 (Asia/Ho_Chi_Minh) |
| Trạng thái | Đang làm — dashboard tổng hợp và bộ lọc theo từng khu |
| Branch chuẩn | `main` |
| Worktree kỳ vọng | Đang có thay đổi dashboard/schema chưa commit; migration staging đã chạy, chưa push production |
| Phần ứng dụng phát hành gần nhất | `1dfcf13` — audit nghiệp vụ cùng transaction; actor tách khỏi tài khoản dữ liệu |
| Việc code tiếp theo | Commit, dựng Preview trỏ `staging-privacy` và kiểm tra desktop/mobile |
| Việc vận hành còn mở | Migration production chưa chạy; credential local `tro_bill_app` đã cũ và chưa được thu hồi |

Không dùng commit trên bảng làm HEAD mặc định: luôn lấy HEAD thật bằng `git log`.
“Phát hành gần nhất” chỉ là mốc ứng dụng đã được kiểm tra production.

## Mục tiêu đang theo đuổi

Tiếp tục `MONETIZATION_CHECKLIST.md` theo thứ tự, hoàn thành từng phần có test và
cho người dùng kiểm tra. Bản review trạng thái phòng đã phát hành: server suy
trạng thái từ khách/hợp đồng/giữ chỗ/sửa chữa, khóa phòng trước thao tác, ghi
event sửa chữa và cập nhật UI/cache an toàn. Migration và production đã được xác
minh. Hotfix đã phát hành để giao dịch cọc tương thích runtime least privilege và
để các bản lưu toàn-state không chạy chồng/ghi đè ngược thứ tự. Sau khi người
dùng smoke test đúng loại giao dịch cọc, phần đầu **Nhiều khu và phân quyền** đã
được triển khai và phát hành: khu có CRUD riêng, phòng gắn ownership theo khu,
có khu mặc định và import tương thích. Mô hình vai trò và phân quyền nhân viên đã
phát hành: actor đăng nhập tách khỏi workspace chủ, dữ liệu lọc theo khu/nghiệp
vụ và staff chỉ đọc. Audit giá, hóa đơn, giao dịch và hợp đồng đã phát hành,
dùng chung retention/least privilege của nhật ký dữ liệu. Hạng mục tiếp theo là
dashboard tổng hợp và bộ lọc theo từng khu. Code/schema/UI cho hạng mục này đang
ở worktree: dashboard lọc phòng và tổng tiền theo khu; chi phí có thể gắn khu
hoặc để chung; nhân viên được lọc chi phí theo assignment. Dữ liệu chi phí cũ
được giữ là chi phí chung, không tự phân bổ. Migration
`20260831_dashboard_property_expenses.sql` đã chạy trên Neon `staging-privacy`
ngày 31/08/2026 và đạt 5/5 cờ cột, ownership FK, index, quyền runtime và toàn
vẹn tham chiếu. Chưa chạy production; bước tiếp theo là dựng Preview và kiểm tra
UI trước khi nâng production rồi mới push `main`.

## Bản đồ hệ thống ngắn

- Frontend thuần: `index.html`, `app.js`, `style.css`, `api.js` và các module ở
  thư mục gốc. Server phục vụ frontend và API cùng origin.
- Backend Express/CommonJS: `server/index.js` lắp route; nghiệp vụ tách theo
  module trong `server/`; `api/index.js` là entry cho Vercel.
- Database: Neon PostgreSQL. Schema đầy đủ ở `server/schema.sql`; migration tiến
  tới ở `server/migrations/`; runtime role mục tiêu là `tro_bill_runtime_sql`.
- State cũ của frontend được tách/lắp trong `server/state.js`. Các luồng tài
  chính, hợp đồng, subscription và dữ liệu nhạy cảm có API/bảng riêng.
- Test dùng `node:test` trong `server/test/`. Lệnh đầy đủ từ root là `npm test`.
- Vận hành/deploy: `vercel.json`, `.github/workflows/`, `OPERATIONS.md`.
- Production: `https://tro-bill.vercel.app`.
- Mẫu hợp đồng nguồn: `document/HopDongThuePhongNew.docx`; HTML in được dựng bởi
  `contract-template.js`, chu kỳ bởi `rental-contract-cycle.js`.

## Mốc đã giao gần đây

- `772ce86`: tạo hợp đồng từ mẫu DOCX đã cung cấp và luồng xem/in.
- `08a206f`: chu kỳ thanh toán hợp đồng 1/3/6/12 tháng và ngày đến hạn.
- `696bea5`: cảnh báo + email nhắc hợp đồng hết hạn ở mốc 30/14/7/3/1 ngày.
- `842e246`: bỏ khóa viewport của modal trong print media; bản hợp đồng Letter đã
  tạo và kiểm tra trực quan đủ 5 trang, không mất nội dung/chữ ký.
- Toàn bộ migration đến
  `20260828_rental_contract_expiry_notifications.sql` đã được ghi nhận là áp dụng
  và xác minh quyền trên Neon staging lẫn production ngày 28/08/2026.
- Tại mốc `842e246`, bộ test tự động đạt 282/282, quét secret sạch và production
  readiness trả `200`. Agent mới phải chạy lại test sau thay đổi của mình.
- Sau khi tạo bộ tài liệu bàn giao ngày 29/08/2026, `npm test` tiếp tục đạt
  282/282, `npm run check:secrets` sạch và `git diff --check` không có lỗi.
- Biên bản nhận/trả phòng lưu snapshot bất biến, giới hạn một bản mỗi loại trên
  mỗi hợp đồng và dùng số dư từ `tenant_deposit_transactions`. Migration
  `20260829_rental_handover_records.sql` đã chạy thành công trên Neon branch
  `staging-privacy` và production ngày 29/08/2026; cả 6 cờ xác minh đều `true`.
  Branch cũ tên `staging` thiếu `rental_contracts`, lần chạy thử đã rollback và
  không phải database Preview; không dùng branch đó cho migration tiếp theo.
- Bộ test đầy đủ đạt 288/288, secret scan sạch, popup đã kiểm tra ở 1440×900 và
  390×844. PDF A4 thử nghiệm 32 tài sản có đủ 3 trang; đã nhìn cả trang đầu,
  giữa và cuối, không mất phần đối chiếu cọc hoặc chữ ký.
- GitHub Actions `33239622788` thành công; production readiness revision
  `2ded7ef3a030` trả HTTP 200 với database, runtime role và schema đều `ok`.
- Giữ chỗ, chuyển phòng và trả phòng đã có API/UI/schema/test. Migration
  `20260829_rental_lifecycle.sql` đã chạy trên `staging-privacy` và production
  ngày 29/08/2026; cả 6 cờ bảng, ownership, unique active reservation và quyền
  event append-only đều `true`. Test mục tiêu đạt 18/18, toàn bộ test đạt
  295/295; giao diện đã kiểm tra tại 1440×900 và 390×844 không tràn viewport.
- Commit `5375daa` đã push lên `main`; GitHub Actions `33240721704` thành công.
  Deployment production `tro-bill-ph6am8l8m-dtung.vercel.app` ở trạng thái
  `Ready`; alias `tro-bill.vercel.app/api/health/ready` trả HTTP 200, revision
  `5375daa1c872`, database/schema `ok` và runtime role `restricted` ngày
  30/08/2026.
- Quyết toán trả phòng có preview và biên bản in A4; tiền phòng tính bao gồm ngày
  bắt đầu/ngày trả, chỉ số điện nước phải khớp biên bản, tổng cuối khóa bất biến.
  Tiền cọc bù công nợ được tạo receipt/allocation và hai hướng khấu trừ/hoàn cọc
  dùng ledger hiện có trong cùng transaction. Các luồng QR, nhắc nợ, đối soát,
  biên nhận và export đều dùng tổng cuối sau khi chốt.
- Migration `20260830_rental_final_settlements.sql` đã chạy trên Neon
  `staging-privacy` và production ngày 30/08/2026; cả 5 cờ schema, ownership,
  snapshot bất biến và quyền append-only đều `true`. Test mục tiêu đạt 8/8, toàn
  bộ test đạt 303/303; secret scan và `git diff --check` sạch. Modal đã kiểm tra
  trực quan ở desktop, không tràn ngang và cuộn nội bộ khi viewport thấp.
- Commit `bf07073` đã push lên `main`; GitHub Actions `33298052320` thành công.
  Deployment production `tro-bill-3yjtydgpk-dtung.vercel.app` ở trạng thái
  `Ready`; alias `tro-bill.vercel.app/api/health/ready` trả HTTP 200, revision
  `bf07073c69f2`, database/schema `ok` và runtime role `restricted` ngày
  30/08/2026.
- Claude đã push `776ea2e` cho trạng thái phòng. Review Codex bổ sung nguồn khách
  thuê cũ, server-authoritative status, chốt xung đột giữa hợp đồng/giữ chỗ/sửa,
  event append-only, chặn xóa/thêm khách vào phòng đang sửa, làm mới UI sau mọi
  thao tác, bỏ inline handler và khóa scroll modal. Test mới nâng bộ đầy đủ lên
  311/311 test thành công; syntax check và `git diff --check` cũng sạch.
- Migration `20260830_room_operational_statuses.sql` đã chạy trên Neon
  `staging-privacy` ngày 30/08/2026; production được kiểm tra lại bằng cùng SELECT.
  Cả hai môi trường đều đạt đủ 5 cờ bảng, unique active, liên kết lifecycle,
  ownership FK và quyền runtime.
- Commit review `ab7a952` đã push lên `main`; GitHub Actions `33309502867` thành
  công. Deployment production `tro-bill-ejn9hhys7-dtung.vercel.app` ở trạng thái
  `Ready`; alias `tro-bill.vercel.app/api/health/ready` trả HTTP 200, revision
  `ab7a9526a105`, database/schema `ok` và runtime role `restricted` ngày
  30/08/2026. Quét log lỗi 10 phút sau deploy không có bản ghi lỗi. Phiên Chrome
  đã hết đăng nhập nên phần UI có dữ liệu thật chờ người dùng smoke test.
- Runtime Logs ngày 30/08/2026 xác nhận `POST /api/deposits/transactions` lỗi
  PostgreSQL `42501`: code dùng `SELECT ... FOR UPDATE` trong khi ledger cọc cố
  ý chỉ cấp `SELECT/INSERT`. Hotfix thay row lock bằng advisory lock theo
  idempotency, giao dịch hoàn tác và số dư; không nới quyền `UPDATE`. Cùng đợt
  log có nhiều deadlock `PUT /api/state`, nên frontend xếp hàng autosave và
  server khóa tuần tự toàn-state theo `user_id` trước mọi row lock. Test mục tiêu
  đạt 30/30, bộ đầy đủ đạt 313/313, secret scan và `git diff --check` sạch; không
  có thay đổi schema/migration. Commit `8b9c652` đã push lên `main`; CI run
  `33322319575` thành công. Deployment production
  `tro-bill-k3g7jkyi4-dtung.vercel.app` ở trạng thái `Ready`; alias readiness trả
  revision `8b9c6527a47b`, database/schema `ok`, runtime role `restricted` và
  quét Runtime Logs sau phát hành không có lỗi. Chưa tự gửi lại payload tài chính
  vì nội dung ghi chú nói hoàn tiền nhưng `entryType=collection` là thu tiền.
- Chức năng nhiều khu/tòa nhà thêm bảng `properties`, `rooms.property_id`, CRUD
  user-scoped và UI tạo/sửa/xóa/lọc/chọn khu. Khu mặc định giữ tương thích dữ liệu
  cũ; trigger `rooms_assign_default_property` bảo vệ zero-downtime cho server cũ;
  import backup ánh xạ khu theo tài khoản đích. Địa chỉ hợp đồng và biên bản bàn
  giao được gợi ý từ khu của phòng thay vì chuỗi gắn cứng. Migration
  `20260830_multi_properties.sql` đã chạy trên Neon `staging-privacy` và
  production ngày 30/08/2026, đạt 6/6 cờ kiểm tra; production backfill 3 tài
  khoản và 8 phòng. Preview `tro-bill-ich3ee367-dtung.vercel.app` READY; phiên
  Preview chưa đăng nhập nên không dùng để kiểm tra dữ liệu thật.
- Commit `6aa82cc` đã push lên `main`; GitHub Actions `33323477587` thành công.
  Deployment production `tro-bill-b0vl39tjo-dtung.vercel.app` ở trạng thái
  `Ready`; alias `tro-bill.vercel.app/api/health/ready` trả HTTP 200, revision
  `6aa82cc1baa7`, database/schema `ok` và runtime role `restricted`. Bộ đầy đủ
  đạt 318/318 test, secret scan và `git diff --check` sạch. Smoke test production
  xác nhận 7/7 phòng hiển thị với badge khu, bộ lọc đúng, không tràn ngang và
  modal khóa scroll nền. Không tạo/xóa dữ liệu thử trên production.
- Mô hình vai trò đã thêm `account_memberships`, owner membership bất biến và ba
  vai trò quản lý/kế toán/người ghi điện nước. Chủ chỉ thêm tài khoản đã xác minh,
  bị giới hạn theo gói; thao tác thu hồi luôn khả dụng để bảo mật. Membership chưa
  cấp quyền xem dữ liệu chủ trọ cho đến khi có assignment ở hạng mục kế tiếp.
  Migration `20260830_account_roles.sql` đã chạy trên Neon `staging-privacy` và
  production ngày 31/08/2026, cả hai đạt 6/6 cờ bảng, constraint, trigger,
  backfill và quyền runtime. Bộ test hiện đạt 326/326, secret scan và
  `git diff --check` sạch. Commit `f94e452` và hotfix giao diện disabled
  `70ad7ea` đã push lên `main`; GitHub Actions `33346046457` và `33346736374`
  đều thành công. Deployment production `tro-bill-ptib58kbp-dtung.vercel.app`
  ở trạng thái `Ready`; alias readiness trả revision `70ad7eaa8595`,
  database/schema `ok` và runtime role `restricted`. Smoke test bằng tài khoản
  production xác nhận owner bất biến, gói Free hiển thị 0/0 nhân viên, form thêm
  nhân viên bị khóa đúng chính sách, nút disabled có opacity 0.5 và card không
  tràn ngang ở viewport 390x844. Không tạo membership thử trên production.
- Phân quyền nhân viên thêm `account_member_property_access` và
  `account_member_operation_access`; middleware chỉ đổi data scope sau khi xác
  minh actor, membership, khu và nghiệp vụ. State nhân viên lọc phòng theo khu,
  lược dữ liệu ngoài nghiệp vụ và chặn toàn bộ `PUT /api/state`; chi phí cấp tài
  khoản fail-closed nếu chưa được giao mọi khu. UI có workspace switcher, ma trận
  gán quyền và banner chỉ đọc; đổi cùng vai trò giữ nguyên assignment, đổi vai
  trò thật sự mới thu hồi quyền cũ. Migration
  `20260831_member_access_assignments.sql` đã chạy trên `staging-privacy` và
  production ngày 31/08/2026, cả hai đạt 6/6 cờ bảng/FK/check/quyền runtime.
  Preview cuối `tro-bill-ej2jf4ixe-dtung.vercel.app` READY với database/schema
  `ok`, runtime role `restricted`; dữ liệu test staging đã xóa đúng 2 user và
  xác nhận còn 0. Bộ đầy đủ đạt 340/340, secret scan sạch. Commit `0e75d72` đã
  push; CI `33377992578` thành công. Production deployment
  `tro-bill-emvbnftan-dtung.vercel.app` (`dpl_kbY7Mn8iQ7ASWimhcW3QQBMuJCDX`)
  READY; alias readiness trả revision `0e75d72ed3ee`, database/schema `ok`,
  runtime role `restricted`. Smoke test phiên production xác nhận reload vẫn
  đúng tài khoản, đủ 7 phòng, workspace riêng duy nhất, form nhân viên Free 0/0
  bị khóa, không tràn ngang; log error 10 phút đầu không có bản ghi.
- Audit nghiệp vụ mở rộng `data_audit_logs` hiện có cho biểu phí, dữ liệu/phát
  hành hóa đơn, tiền phòng/cọc, đối soát ngân hàng và toàn bộ vòng đời hợp đồng.
  Mọi log được ghi trước `COMMIT`, tách actor nhân viên khỏi account owner, chỉ
  lưu tên trường/mục đích an toàn và bỏ qua idempotent replay/no-op state. Không
  có migration mới. Preview `tro-bill-r7tef9yge-dtung.vercel.app` READY với
  staging database/schema `ok`; bộ phát hành cuối đạt 344/344 test và secret
  scan sạch. Commit tính năng `e4f2c46`, hotfix dependency CI `1dfcf13`; CI
  `33403227484` thành công. Production deployment
  `tro-bill-9oj3rrf6l-dtung.vercel.app`
  (`dpl_6T8NkBiSxDRoM9Y4joDuDesfNDZq`) READY; alias readiness HTTP 200 revision
  `1dfcf13872cd`, database/schema `ok`, runtime role `restricted`. Smoke test
  phiên đăng nhập tải được danh sách audit cùng actor/nhãn, không có console
  error hoặc tràn ngang; reload vẫn đúng `admin@trobill.local` và 7/7 phòng.
  Runtime error scan 10 phút đầu không có bản ghi.

## Việc chưa được xem là hoàn tất

1. Checkbox thay runtime role trong phần **An toàn dữ liệu và vận hành** vẫn mở.
   Code/migration đã tạo `tro_bill_runtime_sql`, nhưng không thu hồi
   `tro_bill_app` cho đến khi kiểm tra credential của deployment mới trên cả
   Preview và Production. Đây là thao tác từ xa có thể gây downtime; cần quyền
   rõ ràng và rollback plan.
2. `OPS_ALERT_WEBHOOK_URL` là kênh cảnh báo bổ sung tùy chọn; GitHub Issue và
   Vercel Runtime Logs vẫn là cơ chế mặc định. Không để cảnh báo tùy chọn này
   chặn tính năng sản phẩm.
3. Các mục phỏng vấn/pilot/pháp lý trong checklist cần đầu vào của người dùng;
   agent không được tự đánh dấu hoàn thành bằng code.
4. Google Play Billing chỉ cần khi thực sự bán subscription trong Android app.

## Quy trình tiếp quản không conflict

### Bắt đầu phiên

1. Đọc `AGENTS.md`, tài liệu này, `AI_DECISIONS.md` và phần checklist liên quan.
2. Chạy `git status --short`, `git branch --show-current`, `git log --oneline -8`
   và `git diff --stat`.
3. Nếu worktree bẩn, xác định các tệp/ý định đang dở trước khi sửa. Không tự dọn
   hay commit hộ.
4. Đối chiếu “Việc code tiếp theo” với code/test hiện tại; tài liệu có thể chậm
   hơn Git nếu một phiên trước bị ngắt giữa chừng.
5. Chuyển trạng thái bảng trên thành `Đang làm — <agent>/<phạm vi>` ngay trong
   thay đổi của phiên nếu công việc kéo dài hoặc sẽ bàn giao giữa chừng.

### Kết thúc phiên

1. Chạy test mục tiêu, `npm test`, `npm run check:secrets`, `git diff --check`.
2. Ghi migration theo từng môi trường và deployment revision đã thật sự xác minh.
3. Cập nhật bảng trạng thái, “mốc đã giao”, phần còn mở và **một bước tiếp theo**.
4. Nếu có quyết định mới, thêm vào `AI_DECISIONS.md`.
5. Commit nguyên tử; push/deploy chỉ khi được phép; để worktree sạch nếu bàn giao.

### Nếu cần làm song song

Không chia sẻ worktree. Tạo branch/worktree riêng cho từng agent, cập nhật từ
`origin/main` trước khi hợp nhất, chạy lại toàn bộ test sau khi resolve conflict
và hợp nhất qua PR. Không cho cả Codex và Claude “tiếp tục” cùng một tệp trên
`main` ở cùng thời điểm.

## Prompt bàn giao dùng ngay

Khi mở agent khác tại root repository, có thể dùng:

> Đọc toàn bộ `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DECISIONS.md` và phần
> liên quan trong `MONETIZATION_CHECKLIST.md`. Kiểm tra Git trước khi sửa, tiếp
> tục đúng “Việc code tiếp theo”, không đè thay đổi chưa commit. Chạy kiểm thử
> bắt buộc và cập nhật handoff/decision trước khi kết thúc.

Nếu chỉ muốn agent rà soát phiên trước, thêm: “Chưa sửa code; trước tiên báo lại
HEAD, worktree, thay đổi đã có, bằng chứng test/deploy và điểm chưa rõ.”
