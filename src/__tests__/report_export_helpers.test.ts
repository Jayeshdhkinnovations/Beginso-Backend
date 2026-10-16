import { csvCell, formatAnswer, buildQuestionColumns, rowCells, exportFilename, niceAxis, createQuestionTally, statusLabel } from "../utils/reportExport";

describe("csvCell", () => {
  it("guards formula injection but leaves plain numbers alone", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("@cmd")).toBe(`"'@cmd"`);
    expect(csvCell("-1+2")).toBe(`"'-1+2"`);
    expect(csvCell("-5")).toBe('"-5"');
    expect(csvCell("+919876543210")).toBe('"+919876543210"');
    expect(csvCell(null)).toBe('""');
  });

  it("neutralises everything that could be a formula", () => {
    const TAB = String.fromCharCode(9), CR = String.fromCharCode(13);
    for (const v of ["=1+1", "+SUM(1,1)", "-2+3", "@SUM(A1)", TAB + "=1+1", CR + "=1+1", TAB + "abc", "-", "+", "=", "-5a", "+91 98765"]) {
      expect(csvCell(v).startsWith(`"'`)).toBe(true);
    }
    expect(csvCell("1+1")).toBe('"1+1"');
    expect(csvCell("-5.25")).toBe('"-5.25"');
  });
});

describe("formatAnswer", () => {
  it("renders values as people read them", () => {
    expect(formatAnswer(["a", "b"])).toBe("a; b");
    expect(formatAnswer("data:image/png;base64,AAAA")).toBe("[drawn signature]");
    expect(formatAnswer("/api/uploads/file/u/f/ab12-cv%20final.pdf", "file_upload")).toBe("ab12-cv final.pdf");
    expect(formatAnswer({ street: "1 Main St", city: "Pune", zip: "" })).toBe("1 Main St, Pune");
    expect(formatAnswer(true)).toBe("Yes");
  });
});

describe("question columns", () => {
  const f = (label: string, type = "short_text", fieldId = label) => ({ label, type, fieldId });
  it("one column per question, duplicates numbered, forms share same-label columns", () => {
    const { columns, byForm } = buildQuestionColumns([
      { id: "a", fields: [f("Name"), f("Email"), f("Name", "short_text", "n2")] },
      { id: "b", fields: [f("Email"), f("Phone")] },
    ]);
    expect(columns).toEqual(["Name", "Email", "Name (2)", "Phone"]);
    expect(byForm.get("b")).toEqual(["Email", "Phone"]);
  });

  it("reads answers by label or field id and keeps unmatched ones in Other", () => {
    const fields = [f("Name", "short_text", "f1"), f("Colour", "checkbox", "f2")];
    const { columns, byForm } = buildQuestionColumns([{ id: "a", fields }]);
    const { cells, other } = rowCells({ Name: "Asha", f2: ["red", "blue"], "Old question": "legacy" }, fields, byForm.get("a")!, columns);
    expect(cells).toEqual(["Asha", "red; blue"]);
    expect(other).toBe("Old question: legacy");
  });
});

describe("misc", () => {
  it("builds a readable filename", () => {
    expect(exportFilename("Customer Feedback 2026!", new Date("2026-10-16T10:00:00Z"), "csv")).toBe("beginso-customer-feedback-2026-2026-10-16.csv");
    expect(exportFilename(undefined, new Date("2026-10-16T10:00:00Z"), "pdf")).toBe("beginso-all-forms-2026-10-16.pdf");
    expect(exportFilename("???", new Date("2026-10-16T10:00:00Z"), "pdf")).toBe("beginso-report-2026-10-16.pdf");
  });

  it("filename survives hostile titles", () => {
    const d = new Date("2026-10-16T10:00:00Z");
    const names = [
      exportFilename('Q1 "Survey" / 2026 🎉', d, "csv"),
      exportFilename("a\r\nSet-Cookie: x=1", d, "csv"),
      exportFilename("../../etc/passwd", d, "pdf"),
      exportFilename("x".repeat(500), d, "pdf"),
      exportFilename("🎉🎉", d, "csv"),
    ];
    expect(names[0]).toBe("beginso-q1-survey-2026-2026-10-16.csv");
    for (const n of names) expect(n).toMatch(/^beginso-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.(csv|pdf)$/);
    expect(names[3].length).toBeLessThan(80);
  });

  it("y-axis ticks are whole and evenly spaced", () => {
    expect(niceAxis(6).ticks).toEqual([0, 2, 4, 6]);
    expect(niceAxis(1).ticks).toEqual([0, 1]);
    expect(niceAxis(13).ticks).toEqual([0, 5, 10, 15]);
    for (const m of [1, 2, 3, 7, 9, 23, 101, 999]) {
      const { ticks, max } = niceAxis(m);
      expect(max).toBeGreaterThanOrEqual(m);
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
  });

  it("tallies choice questions and counts answered text", () => {
    const fields = [{ label: "Pick", type: "dropdown" }, { label: "Why", type: "long_text" }, { label: "Tools", type: "checkbox" }];
    const t = createQuestionTally(fields);
    t.add({ Pick: "A", Why: "x", Tools: ["a", "b"] });
    t.add({ Pick: "A", Tools: ["a"] });
    t.add({ Pick: "B", Why: "" });
    const [pick, why, tools] = t.summary();
    expect(pick).toMatchObject({ answered: 3, counts: [{ value: "A", count: 2 }, { value: "B", count: 1 }] });
    expect(why).toMatchObject({ answered: 1, counts: undefined });
    expect(tools.counts).toEqual([{ value: "a", count: 2 }, { value: "b", count: 1 }]);
  });

  it("labels statuses", () => {
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("completed", "Hired")).toBe("Hired");
    expect(statusLabel(undefined)).toBe("New");
  });
});
