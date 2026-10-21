# Hydro-Alert (web application)

Centralized class suspension announcements and live rainfall alerts for students, parents/guardians,
teachers and school administrators.

## Run it
1. Install Node.js 18 or newer (https://nodejs.org).
2. In this folder run:  node server.js   (no npm install needed, there are no dependencies)
3. Open http://localhost:3000

Demo accounts (created on first run in data/db.json):
- admin@hydroalert.ph / admin123 (School Administrator, can announce suspensions)
- teacher@hydroalert.ph / teacher123
- student@hydroalert.ph / student123
- parent@hydroalert.ph / parent123

New students, parents and teachers can register themselves. Administrators can only be created in the database.

## How it works
- The server reads real rainfall every 5 minutes from Open-Meteo (free, no API key) for the configured location.
  Orange alert = 15 mm/hr or more, Red alert = 30 mm/hr or more.
- When the level changes, the server saves the alert and pushes it instantly (Server-Sent Events) to every logged-in
  device: full-screen warning, siren, voice advisory and a browser notification.
- The School Administrator approves and announces suspensions by education level. Each user's dashboard says
  CLASSES SUSPENDED or Not affected for their own level.
- Admin tools on the Alert Center page: simulate rainfall (to demo without a storm) and change the monitored location.

## Settings (environment variables, all optional)
PORT, PLACE, LAT, LON (default Manila), WEBHOOK_URL (the server POSTs every alert and announcement here as JSON,
so you can connect an SMS or email service such as Semaphore, Twilio or an email API).

## Files
- server.js: backend (accounts, sessions, REST API, weather engine, live push, JSON database)
- public/: frontend (index.html, css/style.css, js/app.js)
- data/db.json: created automatically

## Before real use
Put it behind HTTPS (for example on Render or Railway), change the demo passwords, and move from the JSON file
to a real database (SQLite or MySQL) if many people will use it.
