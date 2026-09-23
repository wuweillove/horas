# Horas

Horas is a free freelancer desk. Track time on separate jobs, keep clients and hourly rates, export CSV, and draft PDF invoices from the hours you already worked.

Each person uses their own browser. When Google Drive is connected, that person’s hours and invoices are saved in a `Horas` folder in **their** Drive. The app only asks for `drive.file`, so it can see files it created and nothing else in the account.

## Use it locally

```bash
npm install
npm test
npm run dev
```

Open the URL Vite prints. `npm run build` writes a static site to `dist/`. Publish that folder on any static host. Pages are relative, so the site can live at a domain root or in a subpath.

## Sign in

Sign in with Google appears after `window.HORAS_GOOGLE_CLIENT_ID` in `public/config.js` has the app’s public OAuth client id. Until then the button stays off the card. Once it is set, signing in saves that account’s hours in a `Horas` folder in their Drive.

## What the desk does

- Clock in and out, including one running timer at a time
- Breaks that pause the clock and stay off the invoice
- Manual blocks, including overnight
- Separate jobs that may overlap
- Clients, a rate on the client, and an optional rate on the job
- Billable and non-billable hours
- CSV for the period you are looking at
- Invoices in draft, sent, or paid, with tax and currency
- PDF download, and save that PDF to Drive when Drive is on
- A local copy in the browser, plus the Drive file after you connect
