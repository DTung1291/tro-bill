# Khảo sát nhà cung cấp hóa đơn điện tử cho TrọBill

Ngày rà soát: 07/09/2026 (Asia/Ho_Chi_Minh)

## Kết luận ngắn

Ưu tiên làm việc với **MISA meInvoice** để xin tài khoản sandbox và báo giá API.
Tài liệu công khai của MISA mô tả REST API/JSON, có môi trường test và production,
và bao phủ tạo, ký, phát hành, gửi, tải, xem cùng xử lý sai sót. **VNPT Invoice**
là phương án đối chứng bắt buộc khi lấy báo giá: có tích hợp hệ thống và dịch vụ
publish/status/email, nhưng giao diện công khai quan sát được chủ yếu là SOAP theo
tenant và chưa đủ thông tin để chốt kiến trúc mới. **Viettel S-Invoice** được giữ
làm phương án thứ ba; trang chính thức xác nhận khả năng tích hợp nhưng chưa công
khai đủ đặc tả API/sandbox để bắt đầu code an toàn.

Chưa chọn nhà cung cấp và chưa tích hợp production ở bước này. Cần nhận tài liệu
API hiện hành, sandbox, báo giá bằng văn bản và điều khoản xử lý dữ liệu trước.

## Yêu cầu pháp lý ảnh hưởng đến thiết kế

Nghị định 254/2026/NĐ-CP có hiệu lực từ 01/07/2026 yêu cầu hóa đơn điện tử đúng
định dạng chuẩn, phản ánh trung thực nghiệp vụ và đăng ký sử dụng trước khi phát
hành. Khi một nền tảng tham gia lập hóa đơn tích hợp, người bán và đơn vị tích hợp
phải xác định trách nhiệm và thông báo cơ quan thuế theo quy định. Vì vậy:

- Mỗi chủ trọ phải dùng hồ sơ thuế, đăng ký hóa đơn và credential của chính họ;
  TrọBill không được phát hành mọi hóa đơn bằng một danh tính thuế dùng chung.
- Nút “Phát hành” phải là thao tác có chủ đích, có quyền và audit; không tự phát
  hành chỉ vì hóa đơn tiền phòng nội bộ đã được tạo.
- Phải lưu external reference, mã cơ quan thuế/mã tra cứu, trạng thái, XML/PDF và
  quan hệ điều chỉnh/thay thế; không cho sửa âm thầm hóa đơn đã phát hành.
- Theo hướng dẫn hiện hành, hộ/cá nhân kinh doanh có thu nhập từ cho thuê bất động
  sản nằm trong nhóm trường hợp không bắt buộc sử dụng hóa đơn điện tử. Việc xác
  định chủ trọ nào cần phát hành phải là hạng mục nghiệp vụ riêng, không suy ra chỉ
  từ việc họ dùng TrọBill.

Nguồn pháp lý chính thức:

- [Nghị định 254/2026/NĐ-CP trên Cổng TTĐT Chính phủ](https://vanban.chinhphu.vn/?docid=218689&pageid=27160&typegroupid=4)
- [Tóm tắt điểm mới Nghị định 254/2026 và Thông tư 91/2026](https://xaydungchinhsach.chinhphu.vn/nhung-diem-moi-cua-nghi-dinh-254-2026-nd-cp-va-thong-tu-91-2026-tt-btc-ve-hoa-don-dien-tu-chung-tu-dien-tu-119260717143502375.htm)

## So sánh nhà cung cấp

| Tiêu chí | MISA meInvoice | VNPT Invoice | Viettel S-Invoice |
|---|---|---|---|
| Bằng chứng API công khai | RESTful API, ESB, JSON | Tích hợp ERP/CRM; public demo có SOAP publish/status/email | Xác nhận tích hợp phần mềm kế toán/bán hàng/quản lý |
| Môi trường thử | Công khai test và production riêng | Có host demo theo tenant; quy trình cấp sandbox chưa công khai rõ | Chưa tìm thấy sandbox/spec công khai đủ dùng |
| Nghiệp vụ quan sát được | Tạo, ký, phát hành, gửi, tải, xem, xử lý sai sót | Publish, lấy trạng thái, gửi email, rollback/remove và ký theo danh sách service | Hơn 30 tính năng theo giới thiệu, chưa đủ contract kỹ thuật công khai |
| Xác thực quan sát được | Bearer token + mã số thuế công ty | SOAP cũ truyền user/password; service list cũng có biến thể token | Chưa xác minh contract API |
| Độ phù hợp với backend TrọBill | Cao nhất: Node.js gọi REST/JSON trực tiếp | Trung bình: cần adapter SOAP/XML và xác minh API hiện hành | Chưa đánh giá được trước khi nhận tài liệu |
| Giá/API | Cần báo giá chính thức; có đăng ký dùng thử | Phí tích hợp tách khỏi phí dịch vụ; bảng công khai là bài 2019 nên không dùng để dự toán 2026 | Cần báo giá và chính sách đối tác |
| Kết luận | Shortlist số 1 để làm proof of concept | Shortlist số 2 để đối chứng giá/SLA/phủ địa phương | Dự phòng, chỉ nâng hạng khi có sandbox và đặc tả |

Nguồn nhà cung cấp chính thức:

- [MISA dành cho nhà phát triển](https://www.meinvoice.vn/developer/)
- [Tài liệu tích hợp MISA meInvoice](https://doc.meinvoice.vn/about/)
- [Ví dụ API tạo, ký và phát hành hóa đơn MISA](https://doc.meinvoice.vn/api/Document/InvoiceCodePublishing.html)
- [Đăng ký dùng thử MISA meInvoice](https://www.meinvoice.vn/dang-ky-dung-thu/)
- [VNPT mô tả giải pháp và chi phí tích hợp](https://vnpt.vn/doanh-nghiep/tu-van/giai-phap-tich-hop-hoa-don-dien-tu-cung-vnpt.html)
- [VNPT Invoice public demo PublishService](https://aquavn-tt78admindemo.vnpt-invoice.com.vn/publishservice.asmx)
- [Viettel giới thiệu khả năng tích hợp S-Invoice](https://solutions.viettel.vn/vi/dang-ky-hoa-don-dien-tu-viettel)

## Câu hỏi bắt buộc gửi cả hai nhà cung cấp shortlist

1. API contract và quy định hiện hành đã hỗ trợ Nghị định 254/2026/NĐ-CP,
   Thông tư 91/2026/TT-BTC chưa? Có versioning và changelog không?
2. Có sandbox riêng, dữ liệu mẫu, giới hạn request, IP allowlist, webhook ký số
   và cách xoay vòng/revoke credential không?
3. Mô hình SaaS nhiều chủ trọ: mỗi mã số thuế tự ủy quyền ra sao; nhà cung cấp có
   chương trình đối tác/aggregator hay bắt buộc hợp đồng riêng từng chủ trọ?
4. API có đủ draft, ký/phát hành, tra cứu trạng thái, tải XML/PDF, gửi khách,
   điều chỉnh, thay thế và hủy/thông báo sai sót không?
5. Có external reference/idempotency để retry mà không phát hành trùng không?
   Webhook retry, chữ ký webhook và thời gian giữ event là gì?
6. Bảng giá 2026 gồm phí khởi tạo, API/tích hợp, chữ ký số, mỗi hóa đơn, lưu trữ,
   SMS/email và phí hỗ trợ; có mức tối thiểu cho từng mã số thuế không?
7. SLA, hỗ trợ sự cố, export toàn bộ dữ liệu, thời hạn lưu trữ, vị trí xử lý dữ
   liệu và điều khoản khi chấm dứt dịch vụ là gì?

## Cổng quyết định trước khi code adapter

Chỉ bắt đầu proof of concept sau khi một nhà cung cấp đáp ứng đủ:

- sandbox và API contract hiện hành bằng văn bản;
- mô hình ủy quyền nhiều tenant không chia sẻ credential;
- đủ luồng phát hành, trạng thái, XML/PDF và điều chỉnh/thay thế;
- idempotency hoặc cơ chế chống phát hành trùng được kiểm chứng;
- báo giá/SLA chấp nhận được và điều khoản dữ liệu được rà soát;
- kế toán hoặc đơn vị tư vấn pháp lý duyệt mapping nghiệp vụ đầu tiên.

