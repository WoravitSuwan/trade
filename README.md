# trade

ระบบล็อกอิน / สมัครสมาชิก (Node.js + Express + SQLite)

## เริ่มใช้งาน

ต้องใช้ Node.js 22.13 ขึ้นไป (ใช้ SQLite ที่มากับ Node ในตัว `node:sqlite` ไม่ต้องติดตั้งฐานข้อมูลเพิ่ม)

```bash
npm install
npm start          # เปิด http://localhost:3000
npm test           # รันเทสต์
```

ตัวแปรสภาพแวดล้อม

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
|---|---|---|
| `PORT` | `3000` | พอร์ตของเซิร์ฟเวอร์ |
| `DB_FILE` | `data/app.db` | ไฟล์ฐานข้อมูล SQLite |
| `NODE_ENV` | – | ตั้งเป็น `production` เพื่อให้คุกกี้เป็น `Secure` (ต้องใช้ HTTPS) |

## หน้าเว็บ

| เส้นทาง | คำอธิบาย |
|---|---|
| `/login` | เข้าสู่ระบบ (ด้วยชื่อผู้ใช้หรืออีเมล) |
| `/register` | สมัครสมาชิก |
| `/dashboard` | หน้าหลักหลังล็อกอิน (ต้องล็อกอินก่อน) |

## API

ทุก `POST` ต้องส่ง `Content-Type: application/json`

| Method | Path | Body | ผลลัพธ์ |
|---|---|---|---|
| POST | `/api/register` | `{ username, email, password, confirmPassword }` | `201` + ตั้งคุกกี้ session |
| POST | `/api/login` | `{ identifier, password }` | `200` + ตั้งคุกกี้ session |
| POST | `/api/logout` | `{}` | ลบ session |
| GET | `/api/me` | – | ข้อมูลผู้ใช้ที่ล็อกอินอยู่ หรือ `401` |

กฎการสมัคร: ชื่อผู้ใช้ 3-30 ตัว (`a-z 0-9 _`), อีเมลต้องถูกรูปแบบ, รหัสผ่าน 8-128 ตัวและต้องมีทั้งตัวอักษรและตัวเลข
ชื่อผู้ใช้และอีเมลห้ามซ้ำ (ไม่สนตัวพิมพ์เล็ก/ใหญ่)

## ความปลอดภัย

- เก็บรหัสผ่านด้วย **scrypt** + salt สุ่มต่อผู้ใช้ และเทียบแบบ constant-time
- Session token สุ่ม 256 บิต เก็บในฐานข้อมูลเป็น SHA-256 hash เท่านั้น อายุ 7 วัน
- คุกกี้ `HttpOnly` + `SameSite=Lax` (+ `Secure` ใน production)
- ป้องกัน CSRF: API ที่เปลี่ยนสถานะรับเฉพาะ JSON
- จำกัดการลองล็อกอิน/สมัคร 20 ครั้งต่อ 15 นาทีต่อ IP
- ไม่บอกว่าชื่อผู้ใช้มีอยู่หรือไม่ตอนล็อกอินผิด (ข้อความและเวลาตอบสนองเท่ากัน)
- Security headers (CSP, X-Frame-Options, nosniff)

## โครงสร้าง

```
server.js            จุดเริ่มเซิร์ฟเวอร์
src/app.js           routes ของ Express
src/auth.js          hash รหัสผ่าน, session, validation
src/db.js            สร้างตาราง SQLite
public/              หน้า HTML, CSS, JS ฝั่งเบราว์เซอร์
test/auth.test.js    เทสต์ (node:test)
```
