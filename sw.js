// TrọBill không còn dùng service worker (đã chuyển sang app động, luôn gọi server).
// File này cố ý là bản "tự hủy": mọi trình duyệt còn giữ SW cũ, khi nạp lại sw.js
// sẽ chạy đoạn này -> xóa toàn bộ cache cũ, gỡ chính nó, rồi reload sang bản mới.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.navigate(c.url));
  })());
});

// Không cache gì nữa — luôn đi thẳng ra mạng.
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
