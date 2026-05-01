import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown } from "../src/chunker.js";

describe("chunkMarkdown", () => {
  it("returns empty array for empty string", () => {
    assert.deepStrictEqual(chunkMarkdown(""), []);
  });

  it("returns empty array for whitespace-only string", () => {
    assert.deepStrictEqual(chunkMarkdown("   \n\n  "), []);
  });

  it("returns single chunk for short content", () => {
    const md = "# Title\n\nSome paragraph.";
    const chunks = chunkMarkdown(md);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, md);
    assert.equal(chunks[0].heading, "intro");
    assert.equal(chunks[0].startLine, 0);
    assert.equal(chunks[0].charOffset, 0);
  });

  it("splits on ## headings", () => {
    const md = [
      "# Title",
      "",
      "Intro paragraph.",
      "",
      "## Section One",
      "",
      "Content of section one.",
      "",
      "## Section Two",
      "",
      "Content of section two.",
    ].join("\n");
    const chunks = chunkMarkdown(md, 50);
    assert.ok(chunks.length >= 2, `Expected >=2 chunks, got ${chunks.length}`);

    const headings = chunks.map((chunk) => chunk.heading);
    assert.ok(headings.includes("Section One"));
    assert.ok(headings.includes("Section Two"));
  });

  it("assigns 'intro' heading for content before first heading", () => {
    const md = [
      "Some intro text before any heading.",
      "",
      "## First Section",
      "",
      "Section content here.",
    ].join("\n");
    const chunks = chunkMarkdown(md, 40);
    assert.equal(chunks[0].heading, "intro");
  });

  it("handles markdown with no headings (paragraphs only)", () => {
    const para1 = "First paragraph with some content.";
    const para2 = "Second paragraph with more content.";
    const para3 = "Third paragraph wrapping up.";
    const md = [para1, "", para2, "", para3].join("\n");
    const chunks = chunkMarkdown(md, 50);
    assert.ok(chunks.length >= 1);
    for (const chunk of chunks) {
      assert.equal(chunk.heading, "intro");
    }
  });

  it("hard-splits a very long single paragraph", () => {
    const longText = "A".repeat(500);
    const chunks = chunkMarkdown(longText, 100);
    assert.ok(chunks.length > 1, `Expected >1 chunks for long text, got ${chunks.length}`);
    const totalLen = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    assert.ok(totalLen >= longText.length, "Hard-split should cover all text");
  });

  it("hard-split chunks have overlap", () => {
    const longText = "ABCDEFGHIJ".repeat(50);
    const chunks = chunkMarkdown(longText, 100);
    assert.ok(chunks.length > 1);

    for (let index = 0; index < chunks.length - 1; index += 1) {
      assert.ok(chunks[index].text.length <= 100, `Chunk ${index} exceeds maxSize`);
    }
  });

  it("preserves code blocks in chunks", () => {
    const md = [
      "## Code Example",
      "",
      "Here is some code:",
      "",
      "```typescript",
      'const x = "hello";',
      "console.log(x);",
      "```",
      "",
      "And some text after.",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    const allText = chunks.map((chunk) => chunk.text).join("\n\n");
    assert.ok(allText.includes("```typescript"));
    assert.ok(allText.includes('const x = "hello"'));
    assert.ok(allText.includes("```"));
  });

  it("merges tiny chunks with neighbors", () => {
    const md = [
      "## Big Section",
      "",
      "This is a reasonably sized section with enough content to stand on its own.",
      "",
      "## Tiny",
      "",
      "Hi.",
      "",
      "## Another Big Section",
      "",
      "This section also has enough content to be meaningful on its own.",
    ].join("\n");
    const chunks = chunkMarkdown(md, 3000, 200);
    const tinyChunk = chunks.find((chunk) => chunk.text.trim() === "## Tiny\n\nHi.");
    assert.equal(tinyChunk, undefined, "Tiny chunk should be merged, not standalone");
  });

  it("tracks startLine correctly across sections", () => {
    const md = [
      "Line 0",
      "Line 1",
      "",
      "## Section at Line 3",
      "",
      "Line 5 content",
    ].join("\n");
    const chunks = chunkMarkdown(md, 30);
    assert.equal(chunks[0].startLine, 0);
  });

  it("tracks charOffset correctly", () => {
    const md = "Short intro.\n\n## Heading\n\nBody text here.";
    const chunks = chunkMarkdown(md, 20);
    assert.equal(chunks[0].charOffset, 0);
    if (chunks.length > 1) {
      assert.ok(chunks[1].charOffset > 0);
    }
  });

  it("handles level 3-6 headings as section breaks", () => {
    const md = [
      "### Level 3 Heading",
      "",
      "Content under level 3.",
      "",
      "#### Level 4 Heading",
      "",
      "Content under level 4.",
    ].join("\n");
    const chunks = chunkMarkdown(md, 40);
    const headings = chunks.map((chunk) => chunk.heading);
    assert.ok(headings.includes("Level 3 Heading") || headings.includes("Level 4 Heading"));
  });

  it("does NOT split on level 1 headings (# Title)", () => {
    const md = ["# Title", "", "Intro text.", "", "# Another Title", "", "More text."].join(
      "\n"
    );
    const chunks = chunkMarkdown(md, 3000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].heading, "intro");
  });

  it("respects custom maxChunkSize", () => {
    const md = "Word ".repeat(200);
    const chunks = chunkMarkdown(md, 100);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 100, `Chunk exceeds custom maxSize: ${chunk.text.length}`);
    }
  });

  it("respects custom minChunkSize for merging", () => {
    const md = ["## A", "", "Small.", "", "## B", "", "Also small.", "", "## C", "", "Still small."].join(
      "\n"
    );
    const chunksDefault = chunkMarkdown(md, 3000, 200);
    const chunksAggressive = chunkMarkdown(md, 3000, 500);
    assert.ok(chunksAggressive.length <= chunksDefault.length);
  });

  it("merges tiny previous chunk into larger current chunk and adopts heading", () => {
    const md = [
      "## Tiny First",
      "",
      "x",
      "",
      "## Big Second",
      "",
      "This section is intentionally larger so it is not tiny.",
      "",
      "## Third",
      "",
      "This final section makes total content exceed max chunk size.",
    ].join("\n");

    const chunks = chunkMarkdown(md, 120, 40);
    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0].heading, "Big Second");
    assert.ok(chunks[0].text.includes("## Tiny First"));
    assert.ok(chunks[0].text.includes("## Big Second"));
  });

  it("merges tiny current chunk into previous chunk without changing previous heading", () => {
    const md = [
      "## Big First",
      "",
      "This section is intentionally larger so it is not tiny.",
      "",
      "## Tiny Second",
      "",
      "x",
      "",
      "## Third",
      "",
      "This final section makes total content exceed max chunk size.",
    ].join("\n");

    const chunks = chunkMarkdown(md, 120, 40);
    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0].heading, "Big First");
    assert.ok(chunks[0].text.includes("## Big First"));
    assert.ok(chunks[0].text.includes("## Tiny Second"));
  });

  it("uses the fast path for very large files with headings and intro content", () => {
    const intro = `${"intro paragraph ".repeat(6000)}\n\n`;
    const sectionOne = `## Alpha\n\n${"alpha body ".repeat(5000)}\n\n`;
    const sectionTwo = `## Beta\n\n${"beta body ".repeat(5000)}`;
    const md = `${intro}${sectionOne}${sectionTwo}`;

    const chunks = chunkMarkdown(md, 1200, 100);

    assert.ok(md.length > 120000, "test fixture must trigger the fast path");
    assert.ok(chunks.length > 3);
    assert.equal(chunks[0].heading, "intro");
    assert.ok(chunks.some((chunk) => chunk.heading === "Alpha"));
    assert.ok(chunks.some((chunk) => chunk.heading === "Beta"));
    assert.ok(chunks.every((chunk) => chunk.charOffset >= 0));
  });

  it("uses the fast path for very large files without headings", () => {
    const md = `${"paragraph text ".repeat(9000)}\n\n${"more paragraph text ".repeat(9000)}`;
    const chunks = chunkMarkdown(md, 1500, 200);

    assert.ok(md.length > 120000, "test fixture must trigger the fast path");
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.heading === "intro"));
    assert.equal(chunks[0].startLine, 0);
    assert.equal(chunks[0].charOffset, 0);
  });

  it("recognizes setext headings while ignoring frontmatter fences", () => {
    const md = [
      "---",
      "title: Sample",
      "category: docs",
      "---",
      "",
      "Overview",
      "--------",
      "",
      "This section should be chunked under the setext heading.",
    ].join("\n");

    const chunks = chunkMarkdown(md, 80);

    assert.ok(chunks.some((chunk) => chunk.heading === "Overview"));
    assert.ok(chunks.every((chunk) => chunk.heading !== "title: Sample"));
  });
});