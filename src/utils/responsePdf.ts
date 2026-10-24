// The PDF for a chosen set of responses: one section per response, every question of its form with the answer under it.
// Kept apart from report.service.ts (which streams the CSV and the analytics PDF) so the layout can be tested without Mongo.
import { buildAnswerKeyMap } from "./answerKeys";
import { formatAnswer, readAnswer, statusLabel, type ExportField } from "./reportExport";

export interface PdfForm {
  title: string;
  fields: (ExportField & { pageId?: string; deleted?: boolean; order?: number })[];
  pages: { id: string; order: number; title?: string }[];
}

export interface PdfResponse {
  id: string;
  formId: string;
  reference?: string;
  status?: string;
  stageName?: string | null;
  email?: string | null;
  submittedAt: Date;
  answers: Record<string, unknown>;
  scoreAverage?: number | null;
  scoreCount?: number;
}

const COLOR = { ink: "#0F172A", body: "#334155", muted: "#64748B", faint: "#94A3B8", line: "#E2E8F0", card: "#F8FAFC", brand: "#1D4ED8" };
const LEFT = 40;
const WIDTH = 515;
const BOTTOM = 770; // content stops here; the footer sits below it
const TOP = 40;

// Helvetica (built into PDFKit) draws Latin-1 and a few typographic marks; anything else would come out as another character.
const MAPPED: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", "•": "-", "€": "EUR", "™": "(TM)", " ": " " };
export const pdfSafe = (text: string): string =>
  Array.from(text.replace(/\r\n?/g, "\n"))
    .map((ch) => MAPPED[ch] ?? (/[\n -~¡-ÿ]/.test(ch) ? ch : "?"))
    .join("");

/** The lines of one answer: a list answer (checkboxes) gets one line per choice, everything else is its readable text. */
export const answerLines = (value: unknown, type: string): string[] => {
  // An uploaded file is shown as its name and the link to it: the spreadsheet wants only the name, a reader of the PDF wants the link.
  if (type === "file_upload" || type === "image_upload") {
    const one = (v: unknown): string[] => {
      if (typeof v === "string") return v.trim() ? [v.trim()] : [];
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const name = typeof o.fileName === "string" ? o.fileName : typeof o.name === "string" ? o.name : "";
        const url = typeof o.url === "string" ? o.url : /^https?:/.test(name) ? name : "";
        return [...(name && name !== url ? [formatAnswer(v, type)] : []), ...(url ? [url] : [])];
      }
      return [];
    };
    return (Array.isArray(value) ? value : [value]).flatMap(one);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => formatAnswer(v, type)).filter((s) => s !== "");
    return items.length > 0 ? items.map((s) => `- ${s}`) : [];
  }
  const text = formatAnswer(value, type).trim();
  return text === "" ? [] : text.split("\n");
};

const dateText = (d: Date): string => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;

/** The questions of a form in reading order, grouped by the form's pages. A question without a page falls into a final group. */
export const groupFieldsByPage = (form: PdfForm): { title: string; fields: PdfForm["fields"] }[] => {
  const active = form.fields.filter((f) => !f.deleted);
  const pages = [...form.pages].sort((a, b) => a.order - b.order);
  const groups = pages.map((p, i) => ({
    title: pages.length > 1 ? p.title?.trim() || `Page ${i + 1}` : "",
    fields: active.filter((f) => f.pageId === p.id),
  }));
  const placed = new Set(groups.flatMap((g) => g.fields));
  const rest = active.filter((f) => !placed.has(f));
  if (rest.length > 0) groups.push({ title: groups.length > 0 ? "Other questions" : "", fields: rest });
  return groups.filter((g) => g.fields.length > 0);
};

export function drawResponsesPdf(doc: PDFKit.PDFDocument, responses: PdfResponse[], forms: Map<string, PdfForm>): void {
  const text = (s: string, x: number, y: number, o: PDFKit.Mixins.TextOptions = {}) => doc.text(pdfSafe(s), x, y, o);
  const height = (s: string, w: number) => doc.heightOfString(pdfSafe(s), { width: w });

  responses.forEach((r, index) => {
    if (index > 0) doc.addPage();
    const form = forms.get(r.formId) ?? { title: "Form", fields: [], pages: [] };
    const keys = buildAnswerKeyMap(form.fields);
    const fields = form.fields.map((f) => ({ ...f, answerKey: keys.get(f) }));
    const groups = groupFieldsByPage({ ...form, fields });
    const answered = fields.filter((f) => !f.deleted && answerLines(readAnswer(r.answers, f).value, f.type).length > 0).length;
    const total = fields.filter((f) => !f.deleted).length;

    // The head repeated on a page the response runs on to.
    const runningHead = () => {
      doc.fillColor(COLOR.muted).fontSize(8).font("Helvetica");
      text(`${form.title}  ·  Response ${r.reference || r.id}  (continued)`, LEFT, TOP - 14, { width: WIDTH, lineBreak: false });
      return TOP + 6;
    };
    let y = TOP;
    const ensure = (needed: number) => {
      if (y + needed <= BOTTOM) return;
      doc.addPage();
      y = runningHead();
    };

    // --- brand line, form title, respondent ---
    doc.fillColor(COLOR.brand).fontSize(11).font("Helvetica-Bold");
    text("BEGINSO", LEFT, y, { lineBreak: false });
    doc.fillColor(COLOR.faint).fontSize(9).font("Helvetica");
    text(`Response ${r.reference || r.id}`, LEFT, y + 2, { width: WIDTH, align: "right", lineBreak: false });
    y += 26;
    doc.fillColor(COLOR.ink).fontSize(18).font("Helvetica-Bold");
    const titleH = height(form.title, WIDTH);
    text(form.title, LEFT, y, { width: WIDTH });
    y += titleH + 4;
    doc.fillColor(COLOR.muted).fontSize(10).font("Helvetica");
    text(r.email || "No email given", LEFT, y, { width: WIDTH, lineBreak: false });
    y += 22;

    // --- the facts card ---
    const facts: [string, string][] = [
      ["Reference", r.reference || "-"],
      ["Stage", statusLabel(r.status, r.stageName)],
      ["Submitted", dateText(r.submittedAt)],
      ["Answered", `${answered} of ${total} questions`],
    ];
    if (r.scoreAverage !== null && r.scoreAverage !== undefined && (r.scoreCount ?? 0) > 0) {
      facts.push(["Score", `${r.scoreAverage.toFixed(1)} (${r.scoreCount} reviewer${r.scoreCount === 1 ? "" : "s"})`]);
    }
    const cols = 2;
    const cellW = (WIDTH - 24) / cols;
    const rows = Math.ceil(facts.length / cols);
    const cardH = 16 + rows * 34;
    doc.roundedRect(LEFT, y, WIDTH, cardH, 6).fillAndStroke(COLOR.card, COLOR.line);
    facts.forEach(([label, value], i) => {
      const cx = LEFT + 12 + (i % cols) * cellW;
      const cy = y + 10 + Math.floor(i / cols) * 34;
      doc.fillColor(COLOR.faint).fontSize(7.5).font("Helvetica-Bold");
      text(label.toUpperCase(), cx, cy, { width: cellW - 8, lineBreak: false });
      doc.fillColor(COLOR.ink).fontSize(10).font("Helvetica");
      text(value, cx, cy + 12, { width: cellW - 8, lineBreak: false, ellipsis: true });
    });
    y += cardH + 18;

    // --- every question, with its answer under it ---
    const drawQuestion = (label: string, lines: string[], index: number) => {
      const answer = lines.join("\n");
      const labelText = `${index}. ${label || "Untitled question"}`;
      doc.fontSize(9).font("Helvetica-Bold");
      const labelH = height(labelText, WIDTH - 8);
      doc.fontSize(10).font("Helvetica");
      // A long answer may run on to the next page; its label never sits alone at the foot of one.
      const firstLines = Math.min(lines.length, 3);
      const need = labelH + 4 + (answer ? Math.min(height(answer, WIDTH - 8), firstLines * 14 + 4) : 14) + 14;
      ensure(need);
      doc.fillColor(COLOR.body).fontSize(9).font("Helvetica-Bold");
      text(labelText, LEFT + 4, y, { width: WIDTH - 8 });
      y += labelH + 4;
      if (lines.length === 0) {
        doc.fillColor(COLOR.faint).fontSize(10).font("Helvetica-Oblique");
        text("No answer", LEFT + 4, y, { width: WIDTH - 8, lineBreak: false });
        y += 14;
      } else {
        doc.fillColor(COLOR.ink).fontSize(10).font("Helvetica");
        for (const line of lines) {
          const lh = Math.max(height(line || " ", WIDTH - 8), 12);
          ensure(lh);
          doc.fillColor(COLOR.ink).fontSize(10).font("Helvetica");
          text(line || " ", LEFT + 4, y, { width: WIDTH - 8 });
          y += lh + 1;
        }
      }
      y += 6;
      doc.moveTo(LEFT, y).lineTo(LEFT + WIDTH, y).strokeColor(COLOR.line).lineWidth(0.5).stroke();
      y += 8;
    };

    let n = 0;
    for (const group of groups) {
      if (group.title) {
        ensure(40);
        doc.fillColor(COLOR.brand).fontSize(11).font("Helvetica-Bold");
        text(group.title, LEFT, y, { width: WIDTH, lineBreak: false, ellipsis: true });
        y += 18;
      }
      for (const f of group.fields) {
        n += 1;
        drawQuestion(f.label, answerLines(readAnswer(r.answers, f).value, f.type), n);
      }
      y += 6;
    }

    // Answers filed under a question that has since been deleted from the form: still the person's words, so they are kept.
    const claimed = new Set<string>();
    for (const f of fields) for (const k of [f.answerKey ?? f.label, f.fieldId, f._id ? String(f._id) : undefined]) if (k) claimed.add(k);
    const extra = Object.entries(r.answers).filter(([k, v]) => !claimed.has(k) && k !== "_id" && answerLines(v, "").length > 0);
    if (extra.length > 0) {
      ensure(40);
      doc.fillColor(COLOR.brand).fontSize(11).font("Helvetica-Bold");
      text("Answers to questions no longer in the form", LEFT, y, { width: WIDTH, lineBreak: false });
      y += 18;
      for (const [k, v] of extra) {
        n += 1;
        drawQuestion(k, answerLines(v, ""), n);
      }
    }
  });
}

/** Page X of Y and the form on every page; drawn last, inside the bottom margin, with the auto page break switched off while it does. */
export function drawPdfFooter(doc: PDFKit.PDFDocument, left: string): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const original = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(LEFT, 800).lineTo(LEFT + WIDTH, 800).strokeColor(COLOR.line).lineWidth(0.5).stroke();
    doc.fillColor(COLOR.faint).fontSize(8).font("Helvetica");
    doc.text(pdfSafe(left), LEFT, 808, { width: 380, lineBreak: false, ellipsis: true });
    doc.text(`Page ${i + 1} of ${range.count}`, LEFT + 400, 808, { width: 115, align: "right", lineBreak: false });
    doc.page.margins.bottom = original;
  }
}
