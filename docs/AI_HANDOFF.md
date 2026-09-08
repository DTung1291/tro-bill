# Bàn giao công việc AI — TrọBill

Tài liệu này chỉ lưu **trạng thái vận hành hiện tại** để agent kế tiếp bắt đầu
đúng chỗ. Các lý do bền vững nằm trong `AI_DECISIONS.md`; quy tắc bắt buộc nằm
trong `../AGENTS.md`.

## Trạng thái hiện tại

| Trường | Giá trị |
|---|---|
| Cập nhật lần cuối | 08/09/2026 (Asia/Ho_Chi_Minh) |
| Trạng thái | Sẵn sàng bàn giao — schema Preview đã đủ; E2E thật còn chờ credential A/B |
| Branch chuẩn | `main` |
| Worktree kỳ vọng | Sạch sau commit tài liệu runner E2E; luôn xác minh bằng Git trước khi sửa |
| Phần ứng dụng phát hành gần nhất | `ac14d1c` — từ chối event webhook trùng ID nhưng khác loại hoặc payload trước khi chạm payment |
| Việc code tiếp theo | Chọn hai workspace thử nghiệm độc lập, cấu hình credential A/B trong GitHub Environment `Preview` và chạy workflow E2E |
| Việc vận hành còn mở | Environment `Preview` thiếu credential A/B; `OPS_ALERT_WEBHOOK_URL` vẫn tùy chọn |

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
dùng chung retention/least privilege của nhật ký dữ liệu. Dashboard theo khu đã
phát hành: dashboard lọc phòng và tổng tiền theo khu; chi phí có thể gắn khu
hoặc để chung; nhân viên được lọc chi phí theo assignment. Dữ liệu chi phí cũ
được giữ là chi phí chung, không tự phân bổ. Migration
`20260831_dashboard_property_expenses.sql` đã chạy trên Neon `staging-privacy`
và production, cả hai đạt 5/5 cờ cột, ownership FK, index, quyền runtime và toàn
vẹn tham chiếu. Preview và production đã kiểm tra desktop/mobile cùng dữ liệu
thật. Hạng mục nhiều tài khoản ngân hàng nhận tiền theo khu đã phát hành:
schema/API/UI hoàn tất; migration staging/production đều đạt 7/7 cờ, Preview đã
qua kiểm thử desktop/mobile/VietQR và production smoke test sạch. Hạng mục quản
lý tài sản/nội thất theo phòng cũng đã phát hành: schema/API/UI/export, lưu trữ
mềm và liên kết biên bản bàn giao hoàn tất; migration hai môi trường, Preview
E2E và production smoke đều đạt. Cổng khách thuê gửi yêu cầu sửa chữa đã phát
hành: portal gắn hợp đồng, token chỉ lưu hash, public UI tối thiểu, request
append-only, idempotency/rate limit/audit và export hoàn tất. Phân công và theo
dõi trạng thái yêu cầu cũng đã phát hành: owner giao đúng nhân viên theo khu và
nghiệp vụ, staff chỉ thấy việc của mình, event append-only và audit tách
actor/subject. Chi phí sửa chữa cũng đã phát hành: dòng chi dùng sổ
`expense_entries`, khóa đúng owner/khu, gắn snapshot yêu cầu/phòng, có
idempotency và audit; staff không nhận số tiền. Migration
`20260905_tenant_maintenance_expenses.sql` trên staging `br-ancient-wave-azwc43to`
và production `br-fancy-star-azyclc1h` đều đạt 6/6 cờ. Preview
`tro-bill-kb9imi28w-dtung.vercel.app` đã xác nhận ghi 123.456 đ, dashboard tăng
300.000 đ lên 423.456 đ và báo cáo hiện đúng nguồn. E2E phát hiện rồi sửa bước
normalize frontend từng làm mất metadata sau reload; bản sửa giữ mã yêu cầu,
snapshot phòng và trạng thái chỉ đọc. Trang chi phí cùng popup ghi chi phí đạt
390×844, không tràn ngang và khóa scroll nền. Dữ liệu E2E đã dọn trên đúng
branch staging với guard: 1 tenant, 2 contract, 1 portal, 2 request, 1 expense
và 7 audit liên quan; kết quả sau cleanup đều 0, `rent_start_date` A101 trở về
trống và dashboard trở lại 300.000 đ chi phí, console sạch. Commit `6f0ec26` đã
push `main`; CI `34006992069` thành công. Migration production trên
`br-fancy-star-azyclc1h` đạt 6/6 cờ (hai lần nhập guard đầu lỗi cú pháp đã
rollback, lần dán nguyên văn sau đó commit thành công). Deployment production
`dpl_3DXvg5Kfitzin892JFNX1pTyd7NZ` ready; alias `tro-bill.vercel.app` trả
revision `6f0ec26e2d31`, database/schema `ok`, runtime role `restricted`, asset
pins `style 115 / api 108 / app 119`; endpoint mới trả 401 khi chưa đăng nhập và
không có runtime error trong log sau deploy. Báo cáo tài chính tổng hợp, cơ cấu
doanh thu/cọc, lấp đầy, xuất Excel/PDF và báo cáo doanh thu năm đều đã phát hành.
Nền tảng hồ sơ hóa đơn điện tử theo workspace đã phát hành; bước tiếp theo phụ
thuộc sandbox/API contract hiện hành của nhà cung cấp để triển khai adapter
đồng bộ draft idempotent, lưu external reference và trạng thái.

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

- Neon Preview branch `staging-privacy` (`br-ancient-wave-azwc43to`) đã được bổ
  sung `20260907_electronic_invoice_profiles.sql` và
  `20260907_electronic_invoice_preflight.sql` ngày 08/09/2026. Kết quả xác minh
  lần lượt đạt 5/5 cờ bảng/constraint/quyền/ownership và 3/3 cờ tên pháp lý,
  constraint, least privilege. Deployment
  `tro-bill-6n5t42b90-dtung.vercel.app` (`dpl_ETjou2z1n334KgES4wLSDdUxKDiJ`)
  sau migration trả HTTP 200, revision `e461a33964cb`, database/schema `ok` và
  runtime role `restricted`. Không chạy lại hai migration này; bước kế tiếp là
  cấu hình credential cho hai tài khoản test độc lập rồi chạy workflow staging.
- `e461a33`: readiness staging có chẩn đoán tên migration theo 19 nhóm schema;
  production chỉ giữ trạng thái tổng quát. Runner E2E chấp nhận health 503 để
  hiện đúng danh sách rồi dừng trước login/ghi. CI `34196632098`, test mục tiêu
  17/17, bộ đầy đủ 445/445 và secret scan sạch. Preview
  `tro-bill-6n5t42b90-dtung.vercel.app` (`dpl_ETjou2z1n334KgES4wLSDdUxKDiJ`)
  READY; readiness được bảo vệ trả revision `e461a33964cb`, database `ok`, runtime
  `restricted` và thiếu đúng `20260907_electronic_invoice_profiles.sql` cùng
  `20260907_electronic_invoice_preflight.sql`. Production cùng revision vẫn
  database/schema `ok`, runtime `restricted`.
- `1e5549b`: runner staging mở rộng sang hai workspace độc lập. Nó tạo marker ở
  A, bắt B không được đọc marker, mô phỏng cookie B với context A phải nhận
  `409 SESSION_ACCOUNT_CHANGED`, rồi dùng lại cookie A để chứng minh phiên không
  bị tráo trước cleanup. Workflow nhận bốn secret credential A/B từ Environment
  `Preview`, không ghi secret vào argument/log. CI `34195747607`, test mục tiêu
  9/9, bộ đầy đủ 443/443 và secret scan sạch. Chưa chạy từ xa vì schema Preview
  và credential vẫn chưa sẵn sàng.
- `c3b4350`: thêm `SECURITY.md` và phần triage trong `OPERATIONS.md`; báo cáo lỗ
  hổng đi qua GitHub Private Vulnerability Reporting, không dùng Issue công khai
  cho cookie/CCCD/dữ liệu khách. Không tự hứa SLA khi chưa có lịch trực. API
  GitHub xác nhận kênh đã bật (`enabled=true`) ngày 08/09/2026. CI
  `34195225880`, 443/443 test, secret scan và diff check sạch. Checklist hỗ trợ
  tổng thể vẫn mở vì cần email hỗ trợ chính thức và SLA do chủ sản phẩm duyệt.
- `c2997b2` + `92423bc`: thêm runner E2E staging và workflow chạy thủ công dùng
  GitHub Environment `Preview`. Runner từ chối alias production/HTTP không an
  toàn/health khác staging, xác minh cookie HttpOnly + account context, chỉ tạo
  và cleanup khu có marker UUID của chính lượt chạy; không lập bill, webhook
  hoặc giao dịch tiền thật. CI `34194518229` và `34194681465` thành công; bộ đầy
  đủ đạt 442/442 test, secret scan sạch. Preview
  `tro-bill-bykzho8w1-dtung.vercel.app` (`dpl_C5DKr2LHfG3JJbEPgVyRkCadwMVG`)
  READY nhưng readiness qua Vercel CLI trả đúng `environment=staging`, database
  `ok`, runtime `restricted` và schema `migration-required`; Deployment
  Protection vẫn bật. Environment `Preview` chưa có hai credential E2E nên chưa
  chạy workflow thật và checklist vẫn mở.
- `ac14d1c`: webhook thanh toán subscription giờ chỉ coi event ID là retry hợp
  lệ khi `event_type` và SHA-256 của raw payload trùng bản đã lưu. Event ID cũ
  nhưng nội dung khác trả `409 WEBHOOK_EVENT_PAYLOAD_MISMATCH`, không lookup hay
  kích hoạt payment lần nữa; attempt vẫn được ghi nhận để đối soát. Tài liệu
  contract và regression test đã cập nhật. Production revision
  `ac14d1ccb3ff` trả database/schema `ok`, runtime role `restricted`; CI
  `34193887394`, 437/437 test, secret scan và diff check sạch. Checklist thanh
  toán tự động vẫn mở vì chưa có adapter provider thật và giao dịch pilot.
- `3daf767`: phát hành `/refund-policy.html` cho giai đoạn pilot, tách rõ khoản
  thanh toán subscription khỏi tiền thuê/cọc đi thẳng chủ trọ và mô tả đúng
  workflow yêu cầu hoàn/chuyển nhầm hiện có. Link xuất hiện ở landing, quick
  start, Cài đặt, popup đơn và popup yêu cầu hoàn. Terms/privacy tăng phiên bản
  lên `2026-09-08`, nên tài khoản cũ phải xác nhận lại; privacy sửa danh sách
  provider hiện tại thành Neon, Vercel và Brevo, với Resend chỉ là lựa chọn về
  sau. Tài liệu vẫn ghi rõ chưa đủ để mở bán cho tới khi có pháp nhân, kênh hỗ
  trợ/SLA và rà soát pháp lý. Production revision `3daf767b2024`, ba trang trả
  HTTP 200, database/schema `ok`, runtime role `restricted`; CI `34179242211`,
  436/436 test, secret scan và diff check sạch.
- `d5adcd7`: bổ sung middleware entitlement dùng dữ liệu `subscriptions` +
  `plans` phía server cho các API ghi vận hành cũ: thanh toán/cọc, gửi và lên
  lịch email hóa đơn, ảnh chỉ số, đối soát, kênh thanh toán, tài khoản nhận tiền
  và hồ sơ HĐĐT. Gói hết trial/ân hạn trả `SUBSCRIPTION_READ_ONLY`; giới hạn
  phòng được chặn trước khi state xóa/ghi và giới hạn nhân viên được chặn trước
  INSERT. Các ngoại lệ cần thiết vẫn dùng được khi hết hạn: xem/xuất/xóa tài
  khoản, mua/gia hạn hoặc yêu cầu hoàn tiền, thu hồi link, hủy lịch gửi, tắt
  kênh thanh toán và xóa nhân viên. Webhook/public submission vẫn append để
  không làm mất bằng chứng giao dịch hay yêu cầu khách. Production revision
  `d5adcd7282d4` trả HTTP 200, database/schema `ok`, runtime role `restricted`;
  CI `34178776243`, 433/433 test, secret scan và diff check sạch.
- `eab951b`: luồng nhập dữ liệu trong Cài đặt nhận CSV UTF-8 xuất từ Excel hoặc
  JSON, có tải file CSV mẫu và preview trước khi ghi. Chế độ mặc định là gộp,
  tạo lại ID phòng/khách và ánh xạ billing; thay thế yêu cầu xác nhận riêng. File
  có khách phải xác nhận quyền xử lý dữ liệu cá nhân. Bộ kiểm tra chặn file quá
  5 MB, hơn 500 phòng/2.000 khách, dữ liệu bắt buộc sai, ID trùng, CCCD đã che
  và phòng trùng tên trong cùng khu. Khu được nêu trong file phải tồn tại; import
  không tự tạo khu. UI chỉ báo thành công sau PUT/GET server và chỉ rollback
  client khi PUT chưa lưu. Production revision `eab951bd939e`, database/schema
  `ok`, runtime role `restricted`; CI `34177957306`, 429/429 test, secret scan
  và diff check sạch. Asset pins `style 126 / data-import 1 / app 131`.
- `e2bb6b2`: hướng dẫn bắt đầu nhanh `/huong-dan` đã phát hành với năm bước từ
  tạo phòng đến ghi nhận thanh toán. Generator phía trình duyệt tạo file JSON
  ba phòng theo tháng hiện tại, UUID mới mỗi lượt, không có khách/CCCD/điện
  thoại/email/tài khoản ngân hàng; chỉ tải xuống và không tự ghi dữ liệu. Trang
  cảnh báo import hiện thay toàn bộ phòng, yêu cầu dùng tài khoản trống hoặc
  Production revision `e2bb6b2fcad2` trả 200 cho HTML/CSS/JS, readiness
  database/schema `ok`, runtime role `restricted`; CI `34176436306`, 422/422
  test và secret scan sạch. Asset app pin `130`.
- `872b26d` + `feda8ca`: landing page `/gioi-thieu` đã phát hành với nội dung
  bám đúng chức năng hiện có, responsive CSS, thông báo bill nội bộ chưa phải
  HĐĐT thuế và liên kết pháp lý. Bảng giá gọi `GET /api/public/plans`, chỉ trả
  các gói `active + public` từ server và render bằng DOM/text an toàn; API
  `/api/plans` trong ứng dụng vẫn yêu cầu đăng nhập. Kiểm tra production xác
  nhận landing và API đều HTTP 200, bảng giá live chỉ có Free 0 đ / 10 phòng,
  không suy đoán giá trả phí. CI `34175028079` thành công, bộ đầy đủ đạt 418/418
  và secret scan sạch.
- `b2b7257`: migration `20260907_disable_legacy_runtime_logins.sql`, runbook và
  regression test đã phát hành để hoàn tất runtime least privilege. Migration
  chạy trên staging `br-ancient-wave-azwc43to` rồi production
  `br-fancy-star-azyclc1h`, cả hai đạt 3/3 cờ: `tro_bill_runtime_sql` hạn chế
  quyền, không còn login runtime cũ và không còn membership `neon_superuser`.
  `tro_bill_runtime` ở hai môi trường đã chuyển `NOLOGIN`, 0 session và được giữ
  làm mẫu grant. `tro_bill_app` chỉ tồn tại ở staging, do Neon Console bảo vệ nên
  đã xóa qua trang Roles sau audit xác nhận 0 ownership, 0 role con và 0 session;
  production không có role này. Readiness staging/production đều `ok`, health
  monitor production `34134850555` thành công. Bộ test đạt 415/415, CI
  `34132579296`, secret scan và diff check sạch.
- `e004fba`: tiền kiểm HĐĐT provider-neutral đã phát hành. Endpoint owner-only
  dựng snapshot tối thiểu từ hóa đơn, tổng thanh toán, hợp đồng giao kỳ và hồ sơ
  HĐĐT; không trả CCCD/điện thoại/email/credential, không tự đoán khi nhiều hợp
  đồng và luôn khóa `dispatchAllowed=false`. Snapshot tách các dòng tiền chuẩn,
  đối soát tổng VND và có fingerprint SHA-256 ổn định để adapter tương lai chống
  gửi sai nguồn. Migration `20260907_electronic_invoice_preflight.sql` đã chạy
  trên Neon staging `br-twilight-frog-az35125t` và production
  `br-fancy-star-azyclc1h`, cả hai đạt 3/3 cờ tên pháp lý, constraint và quyền
  runtime không DELETE. Bộ đầy đủ đạt 414/414; CI `34094777689` thành công.
  Production revision `e004fbadb8bf` từng báo thiếu migration trong khoảng deploy
  trước schema; sau khi migration production hoàn tất, readiness trả HTTP 200,
  database/schema `ok`, runtime role `restricted` và health monitor thủ công
  `34129697639` thành công. Mục đồng bộ provider vẫn để mở.
- `c650d6f`: hotfix layout **Tài khoản nhận tiền theo khu** ghi đè card chung từ
  flex sang block 100%, nên danh sách tài khoản và phần gán khu không còn co lại
  cạnh nhau. CSS pin tăng `124 -> 125` và có regression test. Toàn bộ 414/414
  test, secret scan, diff check và CI `34130498700` đều đạt. Production
  deployment `dpl_7gB7wsALdqQjoQ5SqHLinfqYnHEV` READY, alias trả revision
  `c650d6fae418` với database/schema `ok`, runtime role `restricted`. Smoke test
  dữ liệu thật xác nhận desktop hai phần rộng toàn card, mobile 390×844 không
  tràn ngang, combobox nằm trong viewport và console sạch.
- `245f984`: hồ sơ HĐĐT owner-only theo workspace đã phát hành, gồm loại chủ
  thể, hoạt động, nhóm doanh thu, MST/địa chỉ, đăng ký, provider dự kiến, ngày
  hiệu lực và căn cứ rà soát. Server tự suy trạng thái, bắt chủ xác nhận trước
  khi lưu, xóa xác minh provider/reviewer cũ khi hồ sơ đổi; UI không nhận API
  key/mật khẩu và ghi rõ bill nội bộ chưa phải HĐĐT thuế. Audit chỉ giữ tên
  trường, export tài khoản có hồ sơ, runtime không có quyền DELETE. Migration
  `20260907_electronic_invoice_profiles.sql` chạy trên Neon staging
  `br-twilight-frog-az35125t` và production `br-fancy-star-azyclc1h`, cả hai
  đạt 5/5 cờ. CI `34092666303`, 407/407 test; Production deployment
  `dpl_Dg1XmfaB7WLz1qEaEZnA6nwJYYhW` trả revision `245f984e7c56`, readiness
  database/schema `ok`, runtime role `restricted`, asset pins `style 123 / api
  111 / app 128`. Smoke test owner xác nhận hồ sơ mặc định, provider disabled,
  không tràn ngang desktop và console/Runtime Logs sạch; không ghi dữ liệu test
  vào tài khoản production. Đồng bộ provider vẫn chưa hoàn tất.
- Chính sách đối tượng HĐĐT ngày 07/09/2026:
  `docs/E_INVOICE_ELIGIBILITY_POLICY.md` tách cho thuê BĐS dài hạn khỏi dịch vụ
  lưu trú, cá nhân/hộ khỏi doanh nghiệp, tự nguyện khỏi bắt buộc, và tiền cọc khỏi
  doanh thu dịch vụ. Mặc định mọi workspace là `review_required`; bill/link/biên
  nhận TrọBill không phải HĐĐT thuế. Chỉ bật phát hành sau khi có đăng ký, provider,
  credential riêng, mẫu/ký hiệu/chữ ký và căn cứ được kế toán/pháp lý xác nhận.
- Khảo sát HĐĐT ngày 07/09/2026: `docs/E_INVOICE_PROVIDER_SURVEY.md` đối chiếu
  MISA meInvoice, VNPT Invoice và Viettel S-Invoice bằng nguồn chính thức. MISA
  là shortlist kỹ thuật số 1 nhờ REST/JSON cùng test/production công khai; VNPT
  là đối chứng báo giá/SLA nhưng phải xác nhận contract mới thay public SOAP cũ;
  Viettel là dự phòng khi có sandbox/spec. Chưa chọn provider hoặc viết adapter
  trước khi có tài liệu 2026, ủy quyền nhiều tenant, sandbox, báo giá và rà soát
  dữ liệu/pháp lý. Hạng mục tiếp theo là xác định chủ trọ nào thật sự cần HĐĐT.
- `26661c4` + `b049670`: báo cáo doanh thu năm có đủ 12 tháng, bảng theo
  khu/địa điểm, cơ cấu hóa đơn và đối soát về tổng cùng bộ lọc. Excel có sheet
  “Đối chiếu doanh thu năm”, PDF có phần kê khai và cảnh báo không tự tính nghĩa
  vụ thuế. Preview `dpl_4kWC9uLwVSqLkAmmUwV8pQnGNy9g` qua desktop, breakpoint
  mobile, lọc khu và xuất Excel. Production
  `dpl_3kGfoQsRYzVLwyMRaXtrbKgZphEm` trả revision `b049670321ca`, đối soát dữ
  liệu thật 99.166.710 đ, 21 hóa đơn, 3/12 tháng và khớp 100%; asset pins
  `style 122 / api 110 / financial-report-export 2 / app 127`, CI
  `34073770384`, 399/399 test, console/Runtime Logs sạch. Không có migration.
- `a17ac03`: xuất đúng snapshot báo cáo đang lọc thành workbook `.xlsx` OOXML
  có sheet tổng hợp/chi tiết phòng và mẫu PDF A4 ngang nhiều trang. Preview
  `dpl_21hwneWZTwT42hupP5DbXkJeqPBn` qua E2E desktop/mobile; QA bằng Chrome với
  48 phòng tạo 3 trang, tiêu đề bảng lặp và trích xuất đủ 48/48 dòng. Production
  `dpl_2MsTWXySpWTbUZWXeCZF9bUYTo76` trả revision `a17ac0329304`,
  database/schema `ok`, runtime role `restricted`, asset pins
  `style 120 / api 110 / financial-report-export 1 / app 126`; bộ lọc thật Q3
  phòng 403 và nút Excel/PDF hoạt động, CI `34044949466`, 396/396 test, console
  và Runtime Logs sạch. Không có migration hoặc dependency mới.
- `feda910` + hotfix `9c3461e`: báo cáo lấp đầy theo ngày-phòng đã quan sát,
  chuỗi trống dài nhất/cuối kỳ và lọc kỳ/khu/phòng. Preview
  `dpl_3NkxKRKjMFqjSDNVFNm4nabtXEwc` qua E2E; Production
  `dpl_DxYifFP3JUUqXkVvD6p17XBwJ7nw` trả revision `9c3461ec4a63`,
  database/schema `ok`, runtime role `restricted`, asset pins
  `style 119 / api 110 / app 125`. Production đối soát tháng 9 là 42/42
  ngày-phòng (100%), Q3 là 436/476 (91,6%); CI `34044169080`, 393/393 test,
  console và Runtime Logs sạch. Không có migration mới.
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
- Dashboard theo khu thêm `expense_entries.property_id` nullable với ownership
  FK; `NULL` tiếp tục là chi phí chung và không bị gán giả vào khu mặc định.
  Migration `20260831_dashboard_property_expenses.sql` đã chạy trên
  `staging-privacy` và production ngày 01/09/2026, cả hai đạt 5/5 cờ xác minh.
  Preview `tro-bill-enmw8xy0m-dtung.vercel.app` được thử với hai khu, hai phòng,
  chi phí chung và chi phí riêng; tổng tất cả khu và từng khu đều đúng, viewport
  desktop/mobile không tràn ngang và console sạch. Bộ đầy đủ đạt 347/347, secret
  scan sạch; commit `c0858ca` đã push, CI `33431637140` thành công. Production
  deployment `tro-bill-gqf9auib8-dtung.vercel.app`
  (`dpl_DGFEePEjiRvbRq9zk5ysEsozFz4D`) READY; alias readiness trả revision
  `c0858ca10e12`, database/schema `ok`, runtime role `restricted`. Smoke test
  tài khoản thật xác nhận bộ lọc nhận đúng khu `Khu Trọ Vũ Hữu (7)` và không có
  lỗi console; không ghi dữ liệu thử trên production.
- Tài khoản nhận tiền theo khu đã phát hành production. Bảng
  `rent_bank_accounts` giữ danh mục theo chủ, một mặc định; khu để `NULL` kế
  thừa mặc định hoặc tham chiếu tài khoản cùng chủ. Kênh SePay/giao dịch ngân
  hàng giữ `bank_account_id`; đối soát chặn tự động lẫn thủ công khi hóa đơn dùng
  tài khoản khác. QR, email, link công khai, hợp đồng và mẫu tin nhắn đều lấy tài
  khoản hiệu lực theo khu, còn `settings.bank_*` được giữ đồng bộ để tương thích.
  Migration `20260901_property_bank_accounts.sql` đã chạy trên Neon
  `staging-privacy` và production ngày 01/09/2026; cả hai đạt 7/7 cờ
  bảng/FK/backfill/index/quyền runtime/ownership. Bộ đầy đủ hiện đạt 354/354;
  secret scan và diff check sạch.
  Preview mới nhất `tro-bill-3jbffmhk2-dtung.vercel.app`
  (`dpl_8VTjESz1R8fgtWZLdvzKKmAcvsTC`) READY, readiness staging trả database,
  schema `ok` và runtime role `restricted`. API E2E bằng user test staging đã
  tạo VCB mặc định, MB riêng cho khu B,
  xác nhận `settings.bank_*` đồng bộ, đọc lại assignment và cập nhật tài khoản
  thành công. Hai hóa đơn kỳ `2026-09` xác nhận phòng A101 ở khu mặc định nhận
  `bankAccountId=1`, phòng B201 ở khu B nhận `bankAccountId=2`. E2E phát hiện và
  sửa `loadState()` làm rơi `rentBankAccountId`; sau hotfix Khu B hiển thị đúng
  MB qua reload. Desktop và mobile 390px không tràn, SePay liệt kê đủ hai tài
  khoản, QR A101 dùng VCB/đúng số tiền, QR B201 dùng MB/đúng số tiền và console
  sạch. Commit `42f438e` đã push; CI `33467448343` thành công. Production
  deployment `tro-bill-p7unxgbia-dtung.vercel.app`
  (`dpl_HYknWy6c4e3HizrGufxKk392T7Qr`) READY; alias chính trả revision
  `42f438e2c5cb`, database/schema `ok`, runtime role `restricted`. Smoke test
  tài khoản thật xác nhận backfill ICB mặc định, khu hiện tại kế thừa đúng,
  SePay dùng đúng tài khoản; desktop/mobile 390px không tràn, console và runtime
  error scan sạch.
- Quản lý tài sản/nội thất theo phòng đã phát hành production. Migration
  `20260901_room_assets.sql` đã chạy đúng Neon branch `staging-privacy`
  (`br-ancient-wave-azwc43to`) ngày 01/09/2026 và đạt 5/5 cờ bảng, index, quyền
  runtime và ownership. Test mục tiêu đạt 7/7; toàn bộ 361 test, secret scan và
  diff check sạch. Preview hotfix `tro-bill-j23o2avuc-dtung.vercel.app`
  (`dpl_EiZDaG9Ka16SPczcikvKMCDR5dBv`) READY. E2E bằng user test staging đã tạo
  tài sản, cập nhật và chuyển A101 sang B201, ngừng dùng có lý do rồi khôi phục;
  nội dung mặc định biên bản bàn giao lấy đúng tài sản đang hoạt động. E2E phát
  hiện confirm khôi phục bị nằm dưới modal động do cùng z-index 1300; đã tăng
  `#confirm-modal` lên 1500 và kiểm tra trực quan popup đúng lớp. Desktop 1242px
  và mobile 390×844 không tràn, nền khóa scroll và console sạch. Migration
  production đã chạy đúng branch `br-fancy-star-azyclc1h` và cũng đạt 5/5 cờ.
  Commit `300c178` đã push, CI `33483586344` thành công. Deployment production
  `tro-bill-12p0kiwct-dtung.vercel.app`
  (`dpl_2oVEaKGSzXfjmJj2PqmmsoL34NcV`) READY và alias `tro-bill.vercel.app`
  trả revision `300c178874d9`, database/schema `ok`, runtime role `restricted`.
  Static pins đúng `style 112 / api 105 / app 115`; bảng production có 0 tài
  sản và 0 tham chiếu active lỗi; Runtime Errors 30 phút không có lỗi.
- Cổng báo sửa theo hợp đồng đã phát hành ở commit `1ee0873`. Migration
  `20260901_tenant_maintenance_requests.sql` đạt 6/6 cờ trên Neon
  `staging-privacy` và production. Preview E2E đã tạo portal, gửi
  `YC-2026-000001`, đọc lại ở hồ sơ chủ trọ, xác minh token hash/audit tối giản
  rồi xóa sạch contract/portal/request/audit test. Desktop và mobile 390×844
  không tràn, public URL xóa fragment và không lộ tenant. Toàn bộ test đạt
  369/369, secret scan/diff sạch; CI `33938079089` thành công. Deployment
  production `tro-bill-c22zved4e-dtung.vercel.app`
  (`dpl_5RDnEKqLK9t1wWb2KQZ8dXXjCHYK`) READY; alias chính trả revision
  `1ee0873bad8e`, database/schema `ok`, runtime role `restricted`, static pins
  `style 113 / api 106 / app 116`. Token giả trả 404 có mã ổn định, desktop và
  mobile không tràn; Runtime Logs của deployment không có error/fatal.
- Phân công và theo dõi yêu cầu sửa chữa đã phát hành ở commit `d952d9c`.
  Migration `20260905_tenant_maintenance_workflow.sql` chạy đúng Neon staging
  `br-ancient-wave-azwc43to` và production `br-fancy-star-azyclc1h`, cả hai đạt
  6/6 cờ bảng, index, membership FK, least privilege và ownership. Preview
  `tro-bill-cwembbugw-dtung.vercel.app` đã qua E2E: owner phân công cho manager
  chỉ có quyền `rooms` tại Khu trọ chính; staff chỉ thấy A101, không thấy B201,
  chuyển đủ `new -> acknowledged -> in_progress -> resolved`; owner đọc lại đủ
  4 sự kiện, audit ghi actor owner/staff và subject owner. Popup desktop/mobile
  390×844 không tràn, nền khóa scroll. User, contract, request và audit test đã
  dọn về 0; owner trở lại Free. Bộ đầy đủ đạt 377/377, secret scan/diff sạch; CI
  `33954279257` thành công. Production deployment
  `tro-bill-bx25wn0bk-dtung.vercel.app`
  (`dpl_3z9ANi3LJWGvQUgeiWKqZcQHoVgJ`) READY; alias readiness HTTP 200 revision
  `d952d9c36f3b`, database/schema `ok`, runtime role `restricted`, asset pins
  `style 114 / api 107 / app 117`. Endpoint công việc trả 401 khi chưa đăng nhập;
  Runtime Logs đầu phát hành chỉ có readiness 200, không có error/fatal.
- Báo cáo tài chính tháng đã phát hành ở commit `ea8cfa2`. Endpoint
  `/api/financial-reports/monthly` tổng hợp hóa đơn, dòng tiền, công nợ cuối kỳ
  và chi phí trên server theo `Asia/Ho_Chi_Minh`; lợi nhuận tiền mặt dùng thực
  thu trừ chi phí, loại cọc chuyển bù nợ khỏi dòng tiền tháng và không cộng lại
  nợ cũ. Staff cần nghiệp vụ `overview`, chỉ nhận các khu được giao; chi phí
  chung chỉ hiện khi được giao toàn bộ khu. Preview
  `tro-bill-a1pvogbp8-dtung.vercel.app`
  (`dpl_ALZKa7MdV26hihXVEpEg3WG4wAua`) đã đối chiếu dữ liệu staging, đổi tháng,
  làm mới, desktop/mobile 390×844 và console đều đạt. Bộ test đầy đủ 388/388;
  CI `34007985181` thành công. Production
  `tro-bill-pyr6eqfs7-dtung.vercel.app`
  (`dpl_7jWGwCJAWgHTByyzex2fjZzaM3rq`) READY; alias chính trả revision
  `ea8cfa2af7ed`, database/schema `ok`, runtime role `restricted`, pins
  `style 116 / api 109 / app 120`; endpoint chưa đăng nhập trả 401 và error log
  15 phút sau phát hành sạch.
- Bộ lọc báo cáo tài chính đã phát hành qua commit `70efe84` và bản chỉnh nhãn
  `41314eb`. Endpoint `/api/financial-reports/summary` nhận tháng/quý/năm,
  khu/phòng; xác thực ownership và assignment trước truy vấn. Khoảng kỳ giữ cùng
  định nghĩa D-026; chi phí khu chỉ lấy dòng gắn trực tiếp, chi phí phòng chỉ lấy
  dòng sửa chữa có snapshot phòng, không phân bổ chi phí chung. Preview
  `tro-bill-qf9llywns-dtung.vercel.app` (`dpl_8LRmBhgi8U4wvTuDFuSvRHFcokHs`)
  đã kiểm tra staging với tháng/quý/năm, hai khu/hai phòng, đổi khu xóa room
  filter không phù hợp và mobile 390×844 không tràn; console sạch. Preview cuối
  `tro-bill-540ekhx1v-dtung.vercel.app` (`dpl_8HEGdEZpA91TPrXfj8mfDWT1uD32`)
  READY. Bộ test đầy đủ đạt 391/391, secret scan/diff sạch; CI `34020348803`
  thành công. Production `tro-bill-9k02yv083-dtung.vercel.app`
  (`dpl_DGyEWXpzK1LzCnkkm3DxoXe8mkL8`) READY; alias chính trả revision
  `41314eb84b01`, database/schema `ok`, runtime role `restricted`, pins
  `style 117 / api 110 / app 122`. Production đã smoke test phòng 101 và quý
  III/2026 bằng dữ liệu thật, console sạch; endpoint chưa đăng nhập trả 401 và
  Runtime Logs sau phát hành không có error. Không có migration cho hạng mục này.
- Cơ cấu doanh thu và tiền cọc đã phát hành ở commit `679995e`. Báo cáo dùng
  snapshot chi tiết hiệu lực để tách tiền thuê, điện, nước, dịch vụ, giảm giá,
  phụ thu, phí chậm và phần legacy chưa phân loại; tổng các nhóm ròng đối soát
  về doanh thu hóa đơn. Ledger cọc được tổng hợp riêng theo thu/hoàn/khấu trừ,
  đảo giao dịch được quy về loại gốc và khấu trừ không tính là tiền mới nhận.
  Preview `tro-bill-kgh0234o3-dtung.vercel.app`
  (`dpl_FLHJwv1vedLYkMNMW5sQZspbhCsT`) đã kiểm tra tháng/quý, hai khu/phòng và
  mobile 390×844 không tràn ngang. Bộ đầy đủ đạt 391/391, secret scan/diff sạch;
  CI `34020839977` thành công. Artifact Preview được promote nguyên trạng thành
  Production `tro-bill-1rbj6013z-dtung.vercel.app`
  (`dpl_HrJxgfaQHaw7zdQxUNt5ABtPS4YK`); alias chính trả revision
  `679995ecb255`, database/schema `ok`, runtime role `restricted`, pins
  `style 118 / api 110 / app 123`. Production đã đối soát toàn khu và phòng 101
  bằng dữ liệu thật, console sạch; endpoint chưa đăng nhập trả 401 và Runtime
  Logs không có lỗi. Không có migration cho hạng mục này.

## Việc chưa được xem là hoàn tất

1. `OPS_ALERT_WEBHOOK_URL` là kênh cảnh báo bổ sung tùy chọn; GitHub Issue và
   Vercel Runtime Logs vẫn là cơ chế mặc định. Không để cảnh báo tùy chọn này
   chặn tính năng sản phẩm.
2. Các mục phỏng vấn/pilot/pháp lý trong checklist cần đầu vào của người dùng;
   agent không được tự đánh dấu hoàn thành bằng code.
3. Google Play Billing chỉ cần khi thực sự bán subscription trong Android app.
4. Đồng bộ HĐĐT thật vẫn cần API contract/sandbox 2026, mô hình credential theo
   workspace và người có thẩm quyền duyệt mapping kế toán/pháp lý. Tiền kiểm hiện
   chỉ dựng snapshot nội bộ và cố ý không gửi dữ liệu ra nhà cung cấp.

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
