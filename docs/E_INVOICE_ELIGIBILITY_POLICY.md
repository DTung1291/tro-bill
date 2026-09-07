# Chính sách xác định nhu cầu hóa đơn điện tử trong TrọBill

Ngày rà soát: 07/09/2026 (Asia/Ho_Chi_Minh)

Tài liệu này là quy tắc sản phẩm để tránh phát hành sai, không thay thế kết luận
của cơ quan thuế, kế toán hoặc đơn vị tư vấn pháp lý cho từng chủ trọ.

## Kết luận sản phẩm

TrọBill **không bật hóa đơn điện tử mặc định cho mọi tài khoản**. Hóa đơn tiền
phòng nội bộ, link thanh toán và biên nhận của TrọBill không phải hóa đơn điện tử
thuế. Tính năng phát hành chỉ được bật cho một workspace sau khi chủ trọ khai báo
hồ sơ pháp lý, đã đăng ký sử dụng HĐĐT và hoàn tất xác minh provider.

## Ma trận trường hợp

| Chủ thể và hoạt động | Nhu cầu HĐĐT trong TrọBill | Quy tắc áp dụng |
|---|---|---|
| Hộ/cá nhân chỉ cho thuê bất động sản dài hạn | Không bắt buộc theo Điều 7 Nghị định 254/2026; có thể không bật | Tiếp tục dùng hợp đồng, chứng từ thanh toán và hồ sơ khai thuế; chỉ bật tự nguyện khi đã đăng ký hợp pháp |
| Hộ/cá nhân cho thuê dài hạn nhưng muốn cấp HĐĐT | Tự nguyện | Phải có đăng ký được chấp nhận, provider/credential riêng và kế toán xác nhận mẫu/nghiệp vụ |
| Hộ/cá nhân kinh doanh dịch vụ lưu trú | Không dùng miễn trừ “cho thuê bất động sản” một cách tự động | Xét ngưỡng doanh thu và đăng ký thuế; trên 1 tỷ đồng/năm thuộc diện bắt buộc theo hướng dẫn 2026 |
| Doanh nghiệp/tổ chức kinh tế cung cấp dịch vụ thuê/lưu trú | Thường thuộc diện phải lập HĐĐT khi cung cấp dịch vụ | Bắt buộc xác minh loại hóa đơn, mã/không mã, thời điểm lập và chữ ký với kế toán/provider |
| Hoạt động hỗn hợp: thuê dài hạn + lưu trú/dịch vụ khác | Cần rà soát riêng | Không áp một cờ cho toàn tài khoản; phải phân loại hoạt động/dòng hóa đơn và có xác nhận chuyên môn |
| Người thuê là doanh nghiệp yêu cầu chứng từ | Không tự biến chủ trọ thành đối tượng phát hành | Chủ trọ cá nhân có thể dùng bộ hồ sơ thuê tài sản theo quy định; nếu muốn HĐĐT thì đi qua luồng tự nguyện/đăng ký |
| Tiền đặt cọc chỉ để bảo đảm thực hiện hợp đồng | Không phát hành HĐĐT tại thời điểm thu cọc | Khi cọc được khấu trừ thành tiền dịch vụ, xử lý theo nghĩa vụ của khoản dịch vụ tương ứng |

“Dài hạn” và “lưu trú” ở bảng trên là bản chất hoạt động đã đăng ký/được cơ quan
thuế xác định, không được suy đoán chỉ từ số ngày trong hợp đồng.

## Dữ liệu phải có trước khi bật tính năng

Mỗi workspace cần hồ sơ có hiệu lực và được audit:

- loại chủ thể: cá nhân cho thuê BĐS, hộ kinh doanh, doanh nghiệp/tổ chức hoặc
  trường hợp khác;
- loại hoạt động: cho thuê BĐS, dịch vụ lưu trú hoặc hỗn hợp;
- mã số thuế và địa chỉ kinh doanh/địa chỉ bất động sản;
- doanh thu năm dự kiến/thực tế theo band `<= 500 triệu`, `> 500 triệu đến
  1 tỷ`, `> 1 tỷ` hoặc `chưa xác định`;
- trạng thái đăng ký HĐĐT: chưa đăng ký, có mã, không có mã, từng lần phát sinh;
- provider, tenant/account ID phía provider và ngày xác minh credential;
- loại hóa đơn, ký hiệu/mẫu số được phép, phương thức ký;
- căn cứ xác nhận: số/ngày văn bản chấp nhận của cơ quan thuế hoặc biên bản rà
  soát của kế toán/đơn vị tư vấn;
- ngày hiệu lực, ngày hết hiệu lực và người xác nhận.

Không lưu khóa API trong state/frontend/database nghiệp vụ. Credential phải nằm
trong secret store theo môi trường; database chỉ giữ opaque credential reference.

## Trạng thái quyết định của hệ thống

- `review_required`: mặc định hoặc thiếu dữ liệu; không cho phát hành.
- `not_required`: không thuộc diện bắt buộc; vẫn giữ hóa đơn nội bộ/biên nhận.
- `voluntary_ready`: không bắt buộc nhưng đã đăng ký và xác minh để phát hành.
- `required_not_ready`: thuộc diện bắt buộc nhưng chưa đủ đăng ký/provider; cảnh
  báo rõ và không giả lập HĐĐT bằng bill TrọBill.
- `required_ready`: đã xác minh đủ điều kiện; cho phép tạo draft/phát hành theo
  quyền và audit.
- `suspended`: đăng ký, chữ ký hoặc credential hết hiệu lực; ngừng phát hành mới,
  vẫn cho tra cứu/export hóa đơn cũ.

Mọi thay đổi trạng thái phải append-only/audit, có người thực hiện, lý do, căn cứ
và thời gian. Không tự hạ `required_*` xuống `not_required` khi doanh thu giảm nếu
chưa có rà soát cho kỳ mới.

## Luồng vận hành tối thiểu

1. Chủ trọ khai báo hồ sơ và tải/ghi tham chiếu căn cứ, CCCD tiếp tục áp dụng quy
   tắc che và nhật ký xem hiện có.
2. Hệ thống chỉ đề xuất trạng thái; owner xác nhận và kế toán/admin tuân thủ rà
   soát trước khi cấp quyền phát hành.
3. Kết nối provider được thử trên sandbox, kiểm tra quyền đúng mã số thuế, mẫu số,
   ký hiệu và chữ ký.
4. Lần phát hành production đầu tiên phải được kế toán duyệt thủ công. Sau đó mới
   cho phép luồng thường, vẫn có idempotency và audit.
5. Mỗi năm hoặc khi đổi chủ thể, hoạt động, doanh thu band, đăng ký hay provider,
   workspace trở lại `review_required` cho đến khi xác minh lại.

## Nguồn chính thức

- [Toàn văn Nghị định 254/2026/NĐ-CP](https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-dinh-so-254-2026-nd-cp-ve-hoa-don-dien-tu-chung-tu-dien-tu-119260713164251972.htm)
- [Cục Thuế giới thiệu điểm mới về đối tượng và trường hợp không phải dùng HĐĐT](https://xaydungchinhsach.chinhphu.vn/nhung-diem-moi-cua-nghi-dinh-254-2026-nd-cp-va-thong-tu-91-2026-tt-btc-ve-hoa-don-dien-tu-chung-tu-dien-tu-119260717143502375.htm)
- [Cục Thuế xác nhận hộ nhỏ vẫn có quyền dùng HĐĐT tự nguyện](https://xaydungchinhsach.chinhphu.vn/thong-tin-ve-su-dung-hoa-don-dien-tu-cua-ho-kinh-doanh-co-doanh-thu-duoi-500-trieu-dong-nam-119260417170447357.htm)
- [Thủ tục tổ chức khai/nộp thuế thay cá nhân cho thuê BĐS](https://xaydungchinhsach.chinhphu.vn/huong-dan-thu-tuc-khai-thue-voi-to-chuc-khai-thue-thay-nop-thue-thay-cho-ca-nhan-co-bat-dong-san-cho-thue-119260530080322333.htm)
- [Cục Thuế hướng dẫn cá nhân cho thuê BĐS khai thuế năm](https://xaydungchinhsach.chinhphu.vn/cuc-thue-huong-dan-ke-khai-thue-voi-hoat-dong-cho-thue-bat-dong-san-119260317154243038.htm)

