// Which responses the snapshot treats as documents to convert, what it names them, and how it tidies the result.
import { describe, expect, it } from "vitest";
import { documentFormat, documentHasText, documentName, isTextual, tidyDocument } from "../src/services/snapshot-core";

describe("documentFormat", () => {
  it.each([
    ["application/pdf", "/x", ".pdf"],
    ["Application/PDF; charset=binary", "/x", ".pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "/x", ".docx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "/x", ".xlsx"],
    ["application/vnd.ms-excel", "/x", ".xls"],
    ["application/vnd.oasis.opendocument.text", "/x", ".odt"],
    ["application/octet-stream", "/reports/annual-2025.PDF", ".pdf"],
    ["binary/octet-stream", "/data/sheet.xlsx", ".xlsx"],
    ["", "/files/menu.pdf", ".pdf"],
  ])("%s %s -> %s", (type, path, ext) => expect(documentFormat(type, path)?.ext).toBe(ext));

  it.each([
    ["text/html", "/a.pdf"],
    ["image/png", "/a.png"],
    ["application/octet-stream", "/download"],
    ["application/zip", "/a.pdf"],
    ["application/json", "/a.json"],
  ])("not a document: %s %s", (type, path) => expect(documentFormat(type, path)).toBeNull());

  it("a document is never also treated as a text page (empty type + .pdf goes to the converter)", () => {
    expect(isTextual("")).toBe(true);
    expect(documentFormat("", "/x.pdf")?.ext).toBe(".pdf");
  });
});

describe("documentName", () => {
  it.each([
    ["/reports/annual%20report.pdf", ".pdf", "annual report.pdf"],
    ["/download", ".pdf", "download.pdf"],
    ["/", ".docx", "document.docx"],
    ["/a/../<evil>.pdf", ".pdf", "_evil_.pdf"],
    ["/%E0%A4%A", ".pdf", "_E0_A4_A.pdf"],
  ])("%s -> %s", (path, ext, name) => expect(documentName(path, ext)).toBe(name));

  it("caps long names", () => expect(documentName(`/${"a".repeat(500)}.pdf`, ".pdf").length).toBeLessThanOrEqual(124));
});

describe("tidyDocument", () => {
  it("drops the heading the converter adds and tidies the rest", () => {
    expect(tidyDocument("# report.pdf\r\n\r\n\r\n\r\n## Page 1\r\nHello   world", "report.pdf")).toBe("## Page 1\nHello world");
  });
  it("keeps a first heading that is the document's own", () => {
    expect(tidyDocument("# Annual Report\nText", "report.pdf")).toBe("# Annual Report\nText");
  });
});

describe("documentHasText", () => {
  it("a form-only PDF (page headings, nothing else) has no text", () => {
    expect(documentHasText("## Contents\n### Page 1\n\n### Page 2\n\n### Page 3")).toBe(false);
  });
  it("an empty table skeleton has no text", () => expect(documentHasText("| | |\n|---|---|\n| | |")).toBe(false));
  it("a one-line PDF has text", () => expect(documentHasText("## Contents\n### Page 1\nDummy PDF file")).toBe(true));
  it("stray page numbers are not text", () => expect(documentHasText("### Page 1\n1\n### Page 2\n2")).toBe(false));
  it("a spreadsheet with numbers has text", () => expect(documentHasText("| id | 2012 | 28322.19 |\n| 2128 | 456 | Jane |")).toBe(true));
});
