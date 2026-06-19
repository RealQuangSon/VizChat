# VizChat

VizChat là tiện ích mở rộng trình duyệt dành cho các dashboard phân tích học tập (Learning Analytics Dashboards). Công cụ này bổ sung lớp hội thoại AI để giải thích biểu đồ, bối cảnh dữ liệu và các tín hiệu quan sát được ngay trên trang web.

Repo này là bản phát triển từ dự án gốc [VizChat-pub](https://github.com/LinxZhao/VizChat-pub) của Lixiang Yan và Linxuan Zhao, Monash University.

## Tổng quan

VizChat kết hợp mô hình AI đa phương thức và RAG (Retrieval-Augmented Generation) để tạo câu trả lời dựa trên ngữ cảnh đang hiển thị. Mục tiêu là giúp người dùng hiểu nhanh hơn các dashboard học tập phức tạp mà không cần rời khỏi trang.

Kiến trúc chính của hệ thống gồm:

- Cơ sở tri thức để lưu ngữ cảnh dưới dạng vector embeddings.
- Lớp tổng hợp prompt để tạo truy vấn phù hợp với phần dashboard đang xem.
- Mô-đun sinh phản hồi để trả lời và giải thích theo ngữ cảnh.

## Tính năng

- Hỏi đáp trực tiếp trên dashboard đang mở.
- Chỉ phân tích phần nội dung hiện đang hiển thị trên màn hình.
- Hỗ trợ tải tài liệu PDF ở phần cài đặt để làm nguồn tham chiếu.
- Chạy dưới dạng extension, phù hợp cho nghiên cứu và thử nghiệm học thuật.

## Yêu cầu

- Windows.
- Google Chrome hoặc Chromium.
- Node.js 21.7.2 trở lên.
- npm 10.5.0 trở lên.

## Cài đặt

### Cách 1: Dùng bản đã biên dịch

1. Tải gói phát hành từ trang Releases của dự án.
2. Giải nén file tải về.
3. Mở Chrome và truy cập chrome://extensions/.
4. Bật Developer mode.
5. Kéo thư mục extension đã giải nén vào trang Extensions.
6. Mở phần Details và ghim extension lên thanh công cụ nếu cần.
7. Vào Options, mở tab Advanced và nhập OpenAI API Key của bạn.
8. Tải lại dashboard học tập, sau đó bấm biểu tượng VizChat để bắt đầu.

### Cách 2: Biên dịch từ mã nguồn

```bash
git clone <your-fork-or-repo-url>
cd VizChat-pub-main
npm install
npm run build
```

Sau khi build xong, dùng thư mục build/ để nạp extension vào trình duyệt theo các bước ở Cách 1.

## Phát triển

```bash
npm run dev
```

Lệnh này tạo bản build phục vụ phát triển cục bộ.

## Trích dẫn

Nếu sử dụng cho mục đích học thuật, vui lòng trích dẫn:

```bibtex
@inproceedings{yan2024vizchat,
  title={VizChat: Enhancing Learning Analytics Dashboards with Contextualised Explanations using Multimodal Generative AI Chatbots},
  author={Yan, Lixiang and Zhao, Linxuan and Echeverria, Vanessa and Jin, Yueqiao and Alfredo, Riordan and Gasevic, Dragan and Martinez-Maldonado, Roberto},
  booktitle={Proceedings of the 25th International Conference on Artificial Intelligence Education},
  year={2024},
  organization={Springer}
}
```

## Ghi nhận

- Dự án gốc: [VizChat-pub](https://github.com/LinxZhao/VizChat-pub).
- Nền tảng kế thừa ý tưởng và cấu trúc từ [chatGPTBox](https://github.com/josStorer/chatGPTBox).
