noddle landing page — self-contained bundle
==========================================
- landing.html         : toàn bộ trang (HTML + CSS + JS inline, không phụ thuộc ngoài)
- landing-assets/      : hình ảnh (GIF hero, poster demo, 5 SVG use-case)

Deploy: copy cả landing.html và thư mục landing-assets/ vào cùng một thư mục
tĩnh bất kỳ (nginx, S3, GitHub Pages, public/ của Vite/Next...). Mở landing.html là chạy.

Lưu ý duy nhất: section "Live demo" nhúng iframe /embed/baf7b1fa3edf — chỉ hoạt động
khi được serve cùng origin với backend noddle. Ở project khác, sửa src iframe trong
landing.html (tìm "/embed/") thành URL đầy đủ của noddle, hoặc bỏ nút play (poster
tĩnh vẫn hiển thị đẹp).
