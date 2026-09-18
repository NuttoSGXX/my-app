# ตารางคิวเซสชัน (Vercel)

โครงสร้าง
- index.html       หน้าเว็บ (ลูกค้าดู / เจ้าของแก้ไข)
- api/schedule.js  ฟังก์ชันฝั่งเซิร์ฟเวอร์ (อ่าน/บันทึกตาราง + ตรวจรหัสผ่าน)
- package.json

ตั้งค่าบน Vercel (ทำครั้งเดียว)
1. อัปโหลดโฟลเดอร์นี้ขึ้น GitHub แล้วสร้างโปรเจกต์ใหม่บน Vercel จาก repo นั้น (ไม่ต้องตั้งค่า Build ใดๆ)
2. ในโปรเจกต์บน Vercel เพิ่มฐานข้อมูล Redis: แท็บ Storage (หรือ Marketplace) -> Upstash for Redis -> สร้าง -> Connect to Project
   ระบบจะเพิ่มตัวแปร KV_REST_API_URL และ KV_REST_API_TOKEN (หรือ UPSTASH_REDIS_REST_URL และ UPSTASH_REDIS_REST_TOKEN) ให้เอง โค้ดรองรับทั้งสองชื่อ
3. Settings -> Environment Variables -> เพิ่ม ADMIN_PIN = รหัสผู้ดูแลที่ต้องการ
4. Redeploy หนึ่งครั้งให้ตัวแปรมีผล

วิธีใช้
- กด "BY DM BANK" มุมล่างซ้าย 8 ครั้ง -> ใส่รหัส -> คลิกที่วันเพื่อแก้ไข
- กดบันทึกแล้วข้อมูลขึ้นให้ลูกค้าเห็นทันที ไม่ต้องอัปโหลดใหม่
- ถ้าไม่ได้ตั้ง ADMIN_PIN เซิร์ฟเวอร์จะไม่ยอมให้แก้ไขเลย (ตั้งใจให้เป็นแบบนี้)
