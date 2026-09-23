import { formatMoney, totalsFor } from "./billing.ts";
import type { Invoice, Settings } from "./model.ts";

function pdfText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function line(font: "F1" | "F2", size: number, x: number, y: number, text: string): string {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${pdfText(text)}) Tj ET`;
}

export function renderInvoicePdf(invoice: Invoice, settings: Settings): Uint8Array {
  const totals = totalsFor(invoice);
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = 740;

  function freshPage(continued: boolean) {
    if (ops.length) pages.push(ops);
    ops = [];
    y = 740;
    ops.push(line("F2", 18, 54, y, "Horas"));
    y -= 22;
    ops.push(line("F1", 11, 54, y, continued ? `Invoice ${invoice.number}  continued` : `Invoice ${invoice.number}`));
    y -= 28;
  }

  function ensure(height: number) {
    if (y - height < 54) freshPage(true);
  }

  function text(font: "F1" | "F2", size: number, x: number, value: string) {
    ops.push(line(font, size, x, y, value));
  }

  freshPage(false);
  const from = [settings.businessName, settings.email, settings.address].filter(Boolean);
  text("F2", 10, 54, "From");
  y -= 14;
  if (from.length === 0) {
    text("F1", 10, 54, "Your business details are on the desk.");
    y -= 14;
  } else {
    for (const row of from) {
      text("F1", 10, 54, row);
      y -= 14;
    }
  }
  y -= 8;
  text("F2", 10, 54, "Bill to");
  y -= 14;
  for (const row of [invoice.clientName, invoice.clientEmail, invoice.clientAddress].filter(Boolean)) {
    text("F1", 10, 54, row);
    y -= 14;
  }
  y -= 8;
  const issued = new Date(invoice.issuedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  text("F1", 10, 54, `Issued ${issued}    ${invoice.status}    ${invoice.currency}`);
  y -= 22;
  text("F2", 9, 54, "Date");
  text("F2", 9, 130, "Job");
  text("F2", 9, 300, "Hours");
  text("F2", 9, 360, "Rate");
  text("F2", 9, 450, "Amount");
  y -= 8;
  ops.push("54 " + y + " m 540 " + y + " l S");
  y -= 16;

  for (const item of invoice.lines) {
    ensure(16);
    text("F1", 9, 54, item.date);
    text("F1", 9, 130, item.job.slice(0, 28));
    text("F1", 9, 300, item.hours.toFixed(2));
    text("F1", 9, 360, formatMoney(item.rate, invoice.currency));
    text("F1", 9, 450, formatMoney(item.amount, invoice.currency));
    y -= 14;
    if (item.comment) {
      ensure(14);
      text("F1", 8, 130, item.comment.slice(0, 80));
      y -= 12;
    }
  }

  y -= 8;
  ensure(52);
  ops.push("360 " + (y + 6) + " m 540 " + (y + 6) + " l S");
  text("F1", 10, 360, "Subtotal");
  text("F1", 10, 450, formatMoney(totals.subtotal, totals.currency));
  y -= 16;
  text("F1", 10, 360, `Tax ${invoice.taxPercent}%`);
  text("F1", 10, 450, formatMoney(totals.tax, totals.currency));
  y -= 16;
  text("F2", 11, 360, "Total");
  text("F2", 11, 450, formatMoney(totals.total, totals.currency));
  if (invoice.notes) {
    y -= 28;
    ensure(28);
    text("F2", 10, 54, "Notes");
    y -= 14;
    text("F1", 10, 54, invoice.notes.slice(0, 180));
  }
  pages.push(ops);
  return buildPdf(pages.map((page) => page.join("\n")));
}

function buildPdf(contents: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const objects: string[] = [];
  const pageIds: number[] = [];
  const contentIds: number[] = [];
  let nextId = 5;
  contents.forEach(() => {
    pageIds.push(nextId++);
    contentIds.push(nextId++);
  });
  const fontRegular = 3;
  const fontBold = 4;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[fontRegular] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[fontBold] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  contents.forEach((content, index) => {
    const pageId = pageIds[index];
    const contentId = contentIds[index];
    const bytes = encoder.encode(content);
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${bytes.length} >>\nstream\n${content}\nendstream`;
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = encoder.encode(body).length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const startxref = encoder.encode(body).length;
  body += `xref\n0 ${objects.length}\n`;
  body += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`;
  return encoder.encode(body);
}
