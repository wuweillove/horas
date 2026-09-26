# Horas

Horas is a free freelancer desk. Track time on separate jobs, keep clients and hourly rates, export CSV, and draft PDF invoices from the hours you already worked.

Hours stay in the browser. When you sign in with Google, the site also keeps a copy in your Google account so another browser can open the same desk. Download a JSON backup any time.

On a phone, add Horas to the home screen. It opens full screen, and the last copy still opens if the network is down.

## Use it locally

```bash
npm install
npm test
npm run dev
```

Open the URL Vite prints. `npm run build` writes a static site to `dist/`. Publish that folder on any static host. Pages are relative, so the site can live at a domain root or in a subpath.

## What the desk does

- Clock in and out, including one running timer at a time
- Breaks that pause the clock and stay off the invoice
- Manual blocks, including overnight
- Separate jobs that may overlap
- Clients, a rate on the client, and an optional rate on the job
- Billable and non-billable hours
- CSV for the period you are looking at
- Invoices in draft, sent, or paid, with tax and currency
- PDF download
- A local copy in the browser, a hidden copy in your Google account when you sign in, and a JSON backup you can download
