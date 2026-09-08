# Quy trình xử lý hóa đơn điện tử có sai sót

Ngày rà soát: 08/09/2026 (Asia/Ho_Chi_Minh)

Tài liệu này là runbook vận hành cho TrọBill, không thay thế kết luận của cơ quan
thuế, kế toán hoặc đơn vị tư vấn pháp lý. Bill nội bộ TrọBill không phải hóa đơn
điện tử thuế. Khi chưa có adapter và credential provider đã xác minh, **không**
được dùng API/database TrọBill để tự gắn trạng thái đã điều chỉnh hoặc thay thế.

## Mục tiêu và nguyên tắc

- Giữ nguyên hóa đơn gốc, external reference và toàn bộ lịch sử; không sửa/xóa
  âm thầm bản đã phát hành.
- Phân loại sai sót trước khi chọn biện pháp. Không mặc định mọi lỗi đều phải lập
  hóa đơn điều chỉnh hoặc thay thế.
- Một người có chuyên môn phải xác nhận cách xử lý, loại hóa đơn, nội dung chênh
  lệch, thỏa thuận với người mua và biểu mẫu cần nộp cho trường hợp cụ thể.
- Chỉ coi xử lý đã hoàn tất khi provider/cơ quan thuế trả bằng chứng xác nhận và
  quan hệ với hóa đơn gốc được đối chiếu.
- Retry kỹ thuật phải idempotent; callback cũ hoặc khác payload không được làm
  trạng thái quay ngược.

## Cổng phân loại nghiệp vụ

| Tình huống quan sát được | Nhánh xử lý dự kiến | Chốt chặn bắt buộc |
|---|---|---|
| Chỉ sai tên, địa chỉ, số tiền bằng chữ hoặc nội dung khác; không sai MST, số tiền, thuế suất, tiền thuế hoặc hàng hóa/dịch vụ | Thông báo sai sót, có thể không phải lập lại hóa đơn | Kế toán xác nhận đúng nhóm và biểu mẫu/thông báo hiện hành |
| Sai MST, số tiền, thuế suất, tiền thuế hoặc hàng hóa/dịch vụ không đúng quy cách/chất lượng | Chọn điều chỉnh **hoặc** thay thế | Kế toán xác nhận phương án, nội dung sai và hồ sơ với người mua |
| Hóa đơn không sai nhưng giá trị/khối lượng thay đổi khi thanh toán hoặc quyết toán | Lập chứng từ/hóa đơn cho phần chênh lệch theo nghiệp vụ thực tế | Không gắn nhãn đây là sửa lỗi hóa đơn gốc nếu bản chất là nghiệp vụ mới |
| Không đủ dữ liệu để xếp nhóm hoặc hoạt động hỗn hợp | Dừng ở `review_required` | Không gửi provider cho tới khi có kết luận bằng văn bản |

Nguồn Chính phủ dùng để xây cổng phân loại:

- [Nghị định 254/2026/NĐ-CP trên Cổng TTĐT Chính phủ](https://vanban.chinhphu.vn/?docid=218689&pageid=27160)
- [Toàn văn Nghị định 254/2026/NĐ-CP](https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-dinh-so-254-2026-nd-cp-ve-hoa-don-dien-tu-chung-tu-dien-tu-119260713164251972.htm)
- [Giải đáp của Cổng TTĐT Chính phủ về điều chỉnh hoặc thay thế](https://chinhsachonline.chinhphu.vn/giam-gia-tri-nghiem-thu-cong-trinh-lap-hoa-don-dieu-chinh-hay-thay-the-88990.htm)
- [Hướng dẫn xử lý sai sót HĐĐT từ máy tính tiền](https://xaydungchinhsach.chinhphu.vn/huong-dan-cach-xu-ly-sai-sot-hoa-don-dien-tu-tu-may-tinh-tien-119250819091442374.htm)

## Vai trò

| Vai trò | Trách nhiệm |
|---|---|
| Chủ workspace | Báo sai sót, cung cấp hồ sơ nguồn, duyệt nội dung kinh tế và nhận kết quả |
| Kế toán/đơn vị tư vấn | Phân loại, chọn thông báo/điều chỉnh/thay thế và xác nhận hồ sơ người mua |
| Provider HĐĐT | Tạo/ký/gửi tài liệu đúng contract, trả mã và trạng thái có thể xác minh |
| TrọBill support/adapter | Giữ idempotency, đối chiếu fingerprint, ghi event đã xác minh và điều tra lỗi kỹ thuật |

Admin TrọBill không tự thay vai trò kế toán và không được sửa trạng thái provider
bằng giao diện quản trị.

## Quy trình chuẩn

### 1. Mở hồ sơ sự cố và đóng băng bằng chứng

Ghi nhận workspace, kỳ/phòng, invoice ID nguồn, provider, số hóa đơn, mã tra cứu,
mã cơ quan thuế, thời điểm phát hành và mô tả sai sót. Đối chiếu
`source_fingerprint` với snapshot tiền kiểm đã dùng. Không ghi API key, mật khẩu,
cookie, CCCD hoặc raw callback vào ticket hỗ trợ.

Nếu chưa có `electronic_invoice_records` do provider xác nhận, dừng quy trình:
không được điều chỉnh một bill nội bộ như thể đó là HĐĐT thuế.

### 2. Phân loại với người có chuyên môn

Kế toán/đơn vị tư vấn chọn một trong bốn nhánh ở bảng trên, xác định nội dung sai,
giá trị chênh lệch, yêu cầu thỏa thuận với người mua và tài liệu/bảng kê liên quan.
Lưu mã tham chiếu hồ sơ rà soát; không lưu bản scan chứa dữ liệu cá nhân vào log.

### 3. Chuẩn bị yêu cầu provider

Adapter phải gửi đúng hóa đơn gốc, loại tác vụ, nội dung chênh lệch và idempotency
key riêng. Với thay thế, tài liệu mới phải giữ quan hệ tới hóa đơn bị thay thế;
với điều chỉnh, dấu và giá trị chênh lệch phải đúng kết luận nghiệp vụ. Không dùng
cùng provider event ID cho payload khác.

Trong giai đoạn chưa có adapter, chủ trọ/kế toán thao tác trực tiếp trên cổng của
provider. TrọBill chỉ đọc bằng chứng sau khi provider contract, cách xác thực và
mapping trạng thái đã được kiểm thử; không có nút giả lập bước này.

### 4. Nhận và đối chiếu kết quả

Adapter xác minh chữ ký/xác thực callback trước khi gọi
`recordProviderStatus`. Service phải kiểm tra workspace, hóa đơn nguồn,
`provider_document_id`, fingerprint, event ID, SHA-256 payload và thời điểm sự
kiện. Trạng thái hợp lệ của record gốc:

```text
issued ──> adjusted ──> replaced
   └───────────────> replaced
```

`cancelled` không phải lựa chọn mặc định để sửa sai; chỉ ghi khi contract/provider
và người có chuyên môn xác nhận đúng nghiệp vụ. Event đến trễ, quay ngược trạng
thái hoặc dùng lại ID với nội dung khác phải bị từ chối và mở incident.

### 5. Xác nhận hoàn tất

Chỉ đóng hồ sơ khi đủ các bằng chứng phù hợp trường hợp:

- trạng thái provider/cơ quan thuế thành công;
- số hóa đơn, mã tra cứu và mã cơ quan thuế của tài liệu kết quả;
- quan hệ điều chỉnh/thay thế với hóa đơn gốc;
- XML/PDF hoặc đường dẫn tải từ provider đã đối chiếu;
- thông báo cho người mua và hồ sơ thỏa thuận/bảng kê nếu áp dụng;
- lịch sử TrọBill không có event quay ngược hoặc trùng sai payload.

TrọBill hiện đã lưu được mã và trạng thái append-only, nhưng chưa lưu XML/PDF,
quan hệ record kết quả hay hồ sơ thỏa thuận. Vì vậy adapter production chưa được
bật và các bằng chứng này vẫn được quản lý tại provider cho tới khi contract được
chốt.

## Xử lý sự cố kỹ thuật

- **Timeout sau khi gửi:** tra cứu bằng idempotency/external reference trước khi
  retry; không phát hành lại với ID mới khi chưa biết kết quả lần đầu.
- **Event trùng hợp lệ:** trả replay, không tạo event hoặc record thứ hai.
- **Event ID trùng nhưng hash khác:** trả
  `ELECTRONIC_INVOICE_PROVIDER_EVENT_MISMATCH`, cách ly callback và điều tra.
- **Event cũ hơn mốc mới nhất:** trả `ELECTRONIC_INVOICE_EVENT_OUT_OF_ORDER`,
  không ghi đè trạng thái.
- **Sai workspace/fingerprint/reference:** dừng, không tự sửa khóa và không ghép
  tài liệu vào hóa đơn khác.
- **Provider báo lỗi/rejected:** giữ hóa đơn gốc và toàn bộ event, chuyển lại cho
  kế toán/provider xử lý; không tự coi bill TrọBill là tài liệu thay thế.

## Điều kiện để tự động hóa trong TrọBill

Chỉ thêm nút điều chỉnh/thay thế sau khi đủ tất cả:

1. API contract và sandbox hiện hành của provider;
2. credential riêng từng workspace trong secret store;
3. mapping loại sai sót, request/response và quan hệ tài liệu được kế toán duyệt;
4. chữ ký webhook, idempotency và retry được kiểm thử;
5. XML/PDF và bằng chứng người mua có nơi lưu/tra cứu phù hợp;
6. E2E sandbox bao phủ timeout, duplicate, out-of-order, rejected và thành công;
7. lần production đầu được người có chuyên môn kiểm tra thủ công.

