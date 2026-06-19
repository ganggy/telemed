# Telemed Executive Dashboard

ระบบ dashboard แยกสำหรับผู้บริหาร ใช้ดูภาพรวมบริการ Telemed จากฐานข้อมูล HOSxP โดยอ้างอิงเงื่อนไข select เดิมจาก `fdh_rect`

- Frontend: React + Vite
- Backend: Express + MySQL
- Default frontend port: `3517`
- Default backend port: `3516`

## เงื่อนไขข้อมูล Telemed

ระบบนับ visit เป็น Telemed เมื่อพบอย่างใดอย่างหนึ่ง:

- `s_drugitems.nhso_adp_code = TELMED`
- `ovstist.export_code = 5`

สถานะความพร้อมของรายการเช็คเฉพาะการปิดสิทธิ์ `Close EP` ไม่ได้นำการขอ authen/PP มาเป็นเงื่อนไขประกอบ

## ติดตั้งบน Ubuntu เครื่อง 192.168.2.202

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

```bash
cd /opt
sudo git clone https://github.com/ganggy/telemed.git
sudo chown -R $USER:$USER /opt/telemed
cd /opt/telemed
npm install
cp .env.example .env
nano .env
```

ตั้งค่า `.env` ให้ชี้ฐานข้อมูล HOSxP จริง:

```env
HOSXP_HOST=192.168.2.xxx
HOSXP_USER=opd
HOSXP_PASSWORD=opd
HOSXP_DB=hos
TELEMED_PORT=3516
```

ถ้า build หน้าเว็บเพื่อใช้งานผ่าน host หรือ IP อื่น ให้กำหนด API endpoint ตอน build ได้ เช่น:

```bash
VITE_API_BASE_URL=http://192.168.2.202:3516 npm run build
```

ถ้าไม่ได้กำหนด ระบบจะเรียก API ที่ host เดียวกับหน้าเว็บและ port `3516` อัตโนมัติ

ทดสอบ build:

```bash
npm run build
```

## รันแบบ production ด้วย systemd

สร้าง backend service:

```bash
sudo tee /etc/systemd/system/telemed-api.service > /dev/null <<'EOF'
[Unit]
Description=Telemed Dashboard API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/telemed
Environment=NODE_ENV=production
ExecStart=/usr/bin/npx tsx server/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

ติดตั้ง static server สำหรับ frontend:

```bash
sudo npm install -g serve
sudo tee /etc/systemd/system/telemed-web.service > /dev/null <<'EOF'
[Unit]
Description=Telemed Dashboard Web
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/telemed
ExecStart=/usr/bin/serve -s dist -l 3517
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

เปิดใช้งาน:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telemed-api telemed-web
sudo systemctl status telemed-api
sudo systemctl status telemed-web
```

เปิด firewall ถ้าใช้ `ufw`:

```bash
sudo ufw allow 3516/tcp
sudo ufw allow 3517/tcp
```

เข้าใช้งาน:

```text
http://192.168.2.202:3517
```

ตรวจ API:

```bash
curl "http://localhost:3516/api/health"
curl "http://localhost:3516/api/telemed/summary"
```

## รันด้วย PM2

```bash
cd /opt/telemed
npm install
npm run build
pm2 start "npx tsx server/index.ts" --name telemed-api
pm2 start "serve -s dist -l 3517" --name telemed-web
pm2 save
pm2 startup
```

ถ้ามี process เดิมอยู่แล้วหลัง `git pull` ให้ใช้:

```bash
cd /opt/telemed
git pull
npm install
npm run build
pm2 restart telemed-api
pm2 restart telemed-web
pm2 save
```

## อัปเดตระบบ

```bash
cd /opt/telemed
git pull
npm install
npm run build
sudo systemctl restart telemed-api telemed-web
```
