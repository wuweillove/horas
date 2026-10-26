import { formatMoney, formatWorkSpan, totalsFor } from "./billing.ts";
import type { Invoice, Settings } from "./model.ts";

function pdfText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replaceAll("\u2212", "-")
    .replaceAll("\u00A0", " ")
    .replaceAll("·", "\u0001")
    .replaceAll("–", "\u0002")
    .replaceAll("—", "\u0003")
    .replace(/[^\x20-\x7E\u0001\u0002\u0003]/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("\u0001", "\\267")
    .replaceAll("\u0002", "\\226")
    .replaceAll("\u0003", "\\227");
}

const GLYPH: Record<string, number> = {
  " ": 278,
  ".": 278,
  ",": 278,
  ":": 278,
  ";": 278,
  "-": 333,
  "/": 278,
  "%": 889,
  "·": 278,
  "–": 556,
  "—": 1000,
  $: 556,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
};

function measure(value: string, size: number): number {
  const plain = value.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\x20-\x7E]/g, " ");
  let units = 0;
  for (const ch of plain) units += GLYPH[ch] ?? 500;
  return (units / 1000) * size;
}

function line(font: "F1" | "F2", size: number, x: number, y: number, text: string): string {
  return `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(text)}) Tj ET`;
}

function wrapWidth(value: string, size: number, maxWidth: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0 || maxWidth <= 0) return [];
  const rows: string[] = [];
  let current = "";
  const push = (text: string) => {
    if (text) rows.push(text);
  };
  for (const word of words) {
      if (measure(word, size) > maxWidth) {
      push(current);
      current = "";
      let piece = "";
      for (const ch of word) {
        const next = piece + ch;
        if (piece && measure(next, size) > maxWidth) {
          const splitAt = Math.max(piece.lastIndexOf("@"), piece.lastIndexOf("."), piece.lastIndexOf("-"), piece.lastIndexOf("/"));
          if (splitAt > 1) {
            push(piece.slice(0, splitAt + 1));
            piece = piece.slice(splitAt + 1) + ch;
          } else {
            push(piece);
            piece = ch;
          }
        } else piece = next;
      }
      current = piece;
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (current && measure(next, size) > maxWidth) {
      push(current);
      current = word;
    } else current = next;
  }
  push(current);
  return rows;
}

function fitLine(value: string, size: number, maxWidth: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (measure(clean, size) <= maxWidth) return clean;
  let cut = clean;
  while (cut.length > 1 && measure(`${cut}...`, size) > maxWidth) cut = cut.slice(0, -1).trimEnd();
  return `${cut}...`;
}

export function renderInvoicePdf(invoice: Invoice, settings: Settings): Uint8Array {
  const totals = totalsFor(invoice);
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = 748;
  const left = 48;
  const right = 564;
  const workX = 138;
  const hoursRight = 470;

  function freshPage(continued: boolean) {
    if (ops.length) pages.push(ops);
    ops = [];
    y = 748;
    ops.push("0.78 G");
    ops.push("0.7 w");
    if (!continued) return;
    ink();
    text("F2", 11, left, invoice.number);
    textRight("F1", 9, right, "Continued");
    y -= 16;
    rule();
    y -= 18;
    columns();
  }

  function ensure(height: number) {
    if (y - height < 56) freshPage(true);
  }

  function ink(gray = 0) {
    ops.push(`${gray} g`);
  }

  function text(font: "F1" | "F2", size: number, x: number, value: string) {
    ops.push(line(font, size, x, y, value));
  }

  function textRight(font: "F1" | "F2", size: number, edge: number, value: string) {
    text(font, size, edge - measure(value, size), value);
  }

  function rule() {
    ops.push(`${left} ${y.toFixed(2)} m ${right} ${y.toFixed(2)} l S`);
  }

  function columns() {
    ink(0.4);
    text("F1", 8, left, "DATE");
    text("F1", 8, workX, "WORK");
    textRight("F1", 8, hoursRight, "HOURS");
    textRight("F1", 8, right, "AMOUNT");
    y -= 6;
    rule();
    y -= 16;
    ink();
  }

  freshPage(false);
  const money = formatMoney(totals.total, totals.currency);
  const blockWidth = Math.max(measure("TOTAL", 8), measure(money, 16));
  const nameMax = right - left - blockWidth - 20;
  const nameLines = wrapWidth(invoice.clientName, 16, nameMax).slice(0, 3);
  const issued = new Date(invoice.issuedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const span = formatWorkSpan(invoice.periodStart, invoice.periodEnd);
  const status = invoice.status.slice(0, 1).toUpperCase() + invoice.status.slice(1);
  const metaLines = wrapWidth([issued, span, status].filter(Boolean).join("  ·  "), 9, nameMax);

  ink(0.4);
  text("F1", 9, left, "HORAS");
  textRight("F1", 9, right, invoice.number);
  y -= 22;
  ink();
  text("F2", 16, left, nameLines[0] ?? invoice.clientName);
  ink(0.4);
  textRight("F1", 8, right, "TOTAL");
  y -= 18;
  ink();
  textRight("F2", 16, right, money);
  if (nameLines.length > 1) text("F2", 16, left, nameLines[1]);
  else if (metaLines[0]) {
    ink(0.35);
    text("F1", 9, left, metaLines[0]);
  }
  y -= nameLines.length > 1 ? 18 : 14;
  for (const extra of nameLines.slice(2)) {
    ink();
    text("F2", 16, left, extra);
    y -= 18;
  }
  const restMeta = nameLines.length > 1 ? metaLines : metaLines.slice(1);
  for (const extra of restMeta) {
    ink(0.35);
    text("F1", 9, left, extra);
    y -= 12;
  }
  y -= 2;
  rule();
  y -= 18;

  const from = [settings.businessName, settings.email, settings.address].filter(Boolean);
  const bill = [invoice.clientEmail, invoice.clientAddress].filter(Boolean);
  const fromLines = from.flatMap((part) => wrapWidth(part, 10, 250));
  const billLines = bill.flatMap((part) => wrapWidth(part, 10, 228));
  if (fromLines.length > 0 || billLines.length > 0) {
    ensure(20 + Math.max(fromLines.length, billLines.length) * 13);
    ink(0.4);
    if (fromLines.length > 0) text("F1", 8, left, "FROM");
    if (billLines.length > 0) text("F1", 8, 320, "BILL TO");
    y -= 13;
    ink();
    const rows = Math.max(fromLines.length, billLines.length);
    for (let index = 0; index < rows; index += 1) {
      if (fromLines[index]) text("F1", 10, left, fromLines[index]);
      if (billLines[index]) text("F1", 10, 320, billLines[index]);
      y -= 13;
    }
    y -= 4;
    rule();
    y -= 18;
  }

  columns();

  for (const item of invoice.lines) {
    const hoursText = item.hours.toFixed(2);
    const amountText = formatMoney(item.amount, invoice.currency);
    const jobMax = Math.max(48, hoursRight - measure(hoursText, 9) - workX - 14);
    const notes = invoice.showWork === false ? [] : wrapWidth(item.comment, 8, jobMax);
    ensure(18 + Math.min(notes.length, 2) * 11);
    text("F1", 9, left, item.date);
    text("F1", 9, workX, fitLine(item.job, 9, jobMax));
    textRight("F1", 9, hoursRight, hoursText);
    textRight("F1", 9, right, amountText);
    y -= 12;
    for (const note of notes) {
      if (y - 11 < 56) freshPage(true);
      ink(0.35);
      text("F1", 8, workX, note);
      y -= 11;
    }
    ink();
    y -= 4;
    rule();
    y -= 14;
  }

  y -= 6;
  const sums: [string, string, boolean][] = [
    ["Subtotal", formatMoney(totals.subtotal, totals.currency), false],
    ...(invoice.adjustments ?? []).map((item) => [item.label, formatMoney(item.amount, totals.currency), false] as [string, string, boolean]),
    [`Tax ${invoice.taxPercent}%`, formatMoney(totals.tax, totals.currency), false],
    ["Total", formatMoney(totals.total, totals.currency), true],
  ];
  ensure(sums.length * 16 + 8);
  for (const [label, amount, strong] of sums) {
    const labelSize = strong ? 11 : 10;
    const labelText = fitLine(label, labelSize, right - measure(amount, labelSize) - 16 - 360);
    if (strong) {
      y -= 2;
      ops.push(`360 ${y.toFixed(2)} m ${right} ${y.toFixed(2)} l S`);
      y -= 16;
      text("F2", 11, 360, labelText);
      textRight("F2", 11, right, amount);
    } else {
      text("F1", 10, 360, labelText);
      textRight("F1", 10, right, amount);
      y -= 15;
    }
  }
  if (invoice.notes) {
    y -= 22;
    ensure(28);
    ink(0.4);
    text("F1", 8, left, "NOTE");
    y -= 13;
    ink();
    for (const row of wrapWidth(invoice.notes, 10, right - left)) {
      ensure(12);
      text("F1", 10, left, row);
      y -= 12;
    }
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
  objects[fontRegular] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[fontBold] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
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
