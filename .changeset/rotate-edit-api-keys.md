---
"server": minor
"web": minor
---

API keys can be rotated and edited from the Keys page. `POST /admin/keys/:id/rotate` issues a new secret for the same key (id, limits and usage history are kept; the old secret stops working at once, the new one is shown once). A new Edit dialog changes a key's name, allowed models and expiry.
