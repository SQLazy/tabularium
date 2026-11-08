// Tables from documents (markdown from the converter) and CSV files, and the tidying every table goes through.
import { describe, expect, it } from "vitest";
import { TABLE_LIMITS, csvTable, finishTables, markdownTables, type RawTable } from "../src/services/snapshot-core";

const raw = (rows: [string[], boolean][], caption = ""): RawTable => ({
  caption,
  rows: rows.map(([cells, header]) => ({ cells: cells.map((text) => ({ text, span: 1 })), header })),
});

describe("finishTables", () => {
  it("uses a header row when the source marks one", () => {
    const [t] = finishTables([raw([[["Name", "Height"], true], [["Burj Khalifa", "828"], false]], "Tallest")], 10);
    expect(t).toEqual({ caption: "Tallest", headers: ["Name", "Height"], rows: [["Burj Khalifa", "828"]] });
  });
  it("has no headers when no row is marked", () => {
    const [t] = finishTables([raw([[["a", "b"], false], [["c", "d"], false]])], 10);
    expect(t.headers).toEqual([]);
    expect(t.rows).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("collapses whitespace and decodes entities", () => {
    const [t] = finishTables([raw([[["  Fish &amp;\n chips ", "x"], false], [["y", "z"], false]])], 10);
    expect(t.rows[0][0]).toBe("Fish & chips");
  });
  it("keeps colspans as empty cells so columns line up", () => {
    const t: RawTable = { caption: "", rows: [{ cells: [{ text: "Total", span: 2 }, { text: "9", span: 1 }], header: false }, { cells: [{ text: "a", span: 1 }, { text: "b", span: 1 }, { text: "c", span: 1 }], header: false }] };
    expect(finishTables([t], 10)[0].rows[0]).toEqual(["Total", "", "9"]);
  });
  it.each([
    ["one row", raw([[["a", "b"], false]])],
    ["one column", raw([[["a"], false], [["b"], false]])],
    ["only empty rows", raw([[["", ""], false], [[" ", ""], false]])],
  ])("drops a layout table: %s", (_w, t) => expect(finishTables([t], 10)).toEqual([]));
  it("stops at max tables and caps rows", () => {
    const big = raw(Array.from({ length: TABLE_LIMITS.MAX_ROWS + 50 }, (_, i) => [[String(i), "x"], false] as [string[], boolean]));
    const out = finishTables([big, big, big], 2);
    expect(out).toHaveLength(2);
    expect(out[0].rows).toHaveLength(TABLE_LIMITS.MAX_ROWS);
  });
});

describe("markdownTables", () => {
  it("reads the converter's tables, with the header and the heading before it", () => {
    const md = "## Sheet1\n\n| id | name | year |\n|---|---|---|\n| 1 | Jane | 2012 |\n| 2 | John | 2013 |\n\nAfter.";
    const [t] = finishTables(markdownTables(md), 10);
    expect(t).toEqual({ caption: "Sheet1", headers: ["id", "name", "year"], rows: [["1", "Jane", "2012"], ["2", "John", "2013"]] });
  });
  it("keeps escaped pipes inside a cell", () => {
    const [t] = finishTables(markdownTables("| a | b |\n|---|---|\n| x \\| y | z |"), 10);
    expect(t.rows[0]).toEqual(["x | y", "z"]);
  });
  it("two tables separated by text stay two tables", () => {
    const md = "| a | b |\n|--|--|\n| 1 | 2 |\n\ntext\n\n| c | d |\n|--|--|\n| 3 | 4 |";
    expect(finishTables(markdownTables(md), 10)).toHaveLength(2);
  });
  it("no tables in prose", () => expect(finishTables(markdownTables("# Title\n\nJust text | with a pipe."), 10)).toEqual([]));
});

describe("csvTable", () => {
  it("reads quotes, doubled quotes, commas and newlines inside quotes", () => {
    const csv = 'name,quote,city\r\n"Smith, Jo","She said ""hi""",Paris\n"Lee","line one\nline two",Rome\n';
    const [t] = finishTables([csvTable(csv)], 10);
    expect(t.headers).toEqual(["name", "quote", "city"]);
    expect(t.rows).toEqual([["Smith, Jo", 'She said "hi"', "Paris"], ["Lee", "line one line two", "Rome"]]);
  });
  it("a file without a final newline keeps its last row", () => {
    expect(finishTables([csvTable("a,b\n1,2")], 10)[0].rows).toEqual([["1", "2"]]);
  });
});
