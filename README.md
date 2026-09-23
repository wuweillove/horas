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

Sign in with Google. Horas then keeps that account’s hours in a `Horas` folder in their Drive, and only in files the app creates. The account email stays in the corner until you sign out.

The public OAuth client id lives in `public/config.js` as `window.HORAS_GOOGLE_CLIENT_ID`. It is not a secret. The Google client’s authorized JavaScript origins must include the site origin.

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
