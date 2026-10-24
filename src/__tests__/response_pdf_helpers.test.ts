import { answerLines, groupFieldsByPage, pdfSafe } from "../utils/responsePdf";

describe("responsePdf helpers", () => {
  it("a list answer is one line per choice; an empty answer has no lines", () => {
    expect(answerLines(["Drama", "Comedy"], "checkbox")).toEqual(["- Drama", "- Comedy"]);
    expect(answerLines("", "short_text")).toEqual([]);
    expect(answerLines(undefined, "short_text")).toEqual([]);
    expect(answerLines("line one\nline two", "long_text")).toEqual(["line one", "line two"]);
    expect(answerLines(true, "yes_no")).toEqual(["Yes"]);
  });

  it("questions are grouped by the form's pages in page order; deleted ones are left out; a page-less one goes last", () => {
    const groups = groupFieldsByPage({
      title: "F",
      pages: [{ id: "p2", order: 1, title: "Second" }, { id: "p1", order: 0, title: "First" }],
      fields: [
        { label: "B", type: "short_text", pageId: "p2" },
        { label: "A", type: "short_text", pageId: "p1" },
        { label: "Gone", type: "short_text", pageId: "p1", deleted: true },
        { label: "Loose", type: "short_text" },
      ],
    });
    expect(groups.map((g) => [g.title, g.fields.map((f) => f.label)])).toEqual([
      ["First", ["A"]],
      ["Second", ["B"]],
      ["Other questions", ["Loose"]],
    ]);
  });

  it("a one-page form has no page heading", () => {
    const groups = groupFieldsByPage({ title: "F", pages: [{ id: "p1", order: 0, title: "P" }], fields: [{ label: "A", type: "short_text", pageId: "p1" }] });
    expect(groups[0].title).toBe("");
  });

  it("text the built-in font cannot draw is swapped for something readable", () => {
    expect(pdfSafe("It’s “fine” – ok…")).toBe("It's \"fine\" - ok...");
    expect(pdfSafe("café")).toBe("café");
    expect(pdfSafe("ગુજરાતી")).toBe("???????");
  });
});

describe("uploaded files in the PDF", () => {
  it("shows the link, and the file name above it when there is one", () => {
    expect(answerLines("https://drive.google.com/file/d/abc/view", "file_upload")).toEqual(["https://drive.google.com/file/d/abc/view"]);
    expect(answerLines({ name: "poster.png", url: "https://x.test/u/poster.png" }, "image_upload")).toEqual(["poster.png", "https://x.test/u/poster.png"]);
    expect(answerLines("", "file_upload")).toEqual([]);
  });
});
