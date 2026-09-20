import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import yazl from "yazl";
import { collectPdfFiles, extractPdfText } from "../src/files.js";
import { createJobStore } from "../src/jobs.js";
import { createApp, screenUploadedFiles } from "../src/server.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "jev-resume-test-"));
after(() => rm(directory, { recursive: true, force: true }));

async function makePdf(lines) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, index) => page.drawText(line, { x: 40, y: 780 - index * 25, font, size: 13 }));
  return Buffer.from(await pdf.save());
}

async function makeZip(entries) {
  const zip = new yazl.ZipFile();
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function makeCidPdf() {
  const content = `BT /F1 14 Tf 50 700 Td <${"6D4B8BD5".repeat(12)}> Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const jobInput = {
  title: "Java 高级开发",
  requirements: [
    { id: "years", text: "至少 5 年 Java 开发经验", required: true },
    { id: "company", text: "指定企业任职", required: false, bonusPoints: 10 }
  ]
};

test("job configuration persists and supports edits and removal", async () => {
  const store = createJobStore(path.join(directory, "jobs.json"));
  const created = await store.create(jobInput);
  assert.equal((await store.list())[0].title, jobInput.title);
  const reopened = createJobStore(path.join(directory, "jobs.json"));
  assert.equal((await reopened.get(created.id)).requirements.length, 2);
  const updated = await reopened.update(created.id, { ...jobInput, title: "Java 架构师" });
  assert.equal(updated.title, "Java 架构师");
  assert.equal(await store.remove(created.id), true);
  assert.deepEqual(await reopened.list(), []);
});

test("extracts text from a real PDF and identifies image-only PDFs", async () => {
  const pdf = await makePdf(["Java backend developer with 7 years experience", "Launched payment platform in 2023"]);
  const text = await extractPdfText(pdf);
  assert.match(text, /7 years experience/);
  assert.match(text, /Launched payment platform/);
  await assert.rejects(extractPdfText(await makePdf([])), /OCR/);
});

test("extracts Chinese text from a PDF that needs a predefined CMap", async () => {
  assert.equal(await extractPdfText(makeCidPdf()), "测试".repeat(12));
});

test("reads PDFs within ZIP and ignores non-PDF entries", async () => {
  const pdf = await makePdf(["Java backend developer with 7 years experience"]);
  const zip = await makeZip([["candidates/resume.pdf", pdf], ["notes.txt", Buffer.from("skip")]]);
  const files = await collectPdfFiles([new File([zip], "candidates.zip", { type: "application/zip" })]);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "candidates.zip / resume.pdf");
  assert.match(await extractPdfText(files[0].data), /Java backend/);
});

test("decodes UTF-8 ZIP file names when the UTF-8 flag is missing", async () => {
  const zip = await makeZip([["简历-张三.pdf", makeCidPdf()]]);
  for (const [signature, offset] of [["504b0304", 6], ["504b0102", 8]]) {
    const position = zip.indexOf(Buffer.from(signature, "hex"));
    assert.notEqual(position, -1);
    zip.writeUInt16LE(zip.readUInt16LE(position + offset) & ~0x800, position + offset);
  }
  const files = await collectPdfFiles([new File([zip], "resumes.zip")]);
  assert.equal(files[0].name, "resumes.zip / 简历-张三.pdf");
});

test("accepts and screens 100 text PDFs from one ZIP", async () => {
  const pdf = await makePdf(["Java backend developer with 7 years experience"]);
  const entries = Array.from({ length: 100 }, (_, index) => [`resumes/candidate-${index + 1}.pdf`, pdf]);
  const zip = await makeZip(entries);
  const upload = new File([zip], "resumes.zip", { type: "application/zip" });
  const files = await collectPdfFiles([upload]);
  assert.equal(files.length, 100);
  assert.match(await extractPdfText(files[99].data), /Java backend/);

  let processed = 0;
  const batch = await screenUploadedFiles({ id: "job-1", title: "Java 高级开发" }, [upload], {
    parsePdf: async () => "Java backend developer with 7 years experience",
    screen: async () => { processed++; return { recommendation: "match", requirements: [] }; }
  });
  assert.equal(processed, 100);
  assert.equal(batch.total, 100);
  assert.deepEqual(batch.counts, { match: 100, review: 0, not_match: 0, error: 0 });
});

test("a damaged ZIP is reported alongside a valid PDF", async () => {
  const pdf = await makePdf(["Java backend developer with 7 years experience"]);
  const files = await collectPdfFiles([
    new File([Buffer.from("bad archive")], "damaged.zip"),
    new File([pdf], "good.pdf")
  ]);
  assert.match(files[0].error, /无法打开 ZIP/);
  assert.equal(files[1].name, "good.pdf");
});

test("HTTP upload screens all valid PDFs and keeps per-file errors", async () => {
  const store = createJobStore(path.join(directory, "http-jobs.json"));
  const app = createApp({
    jobStore: store,
    screen: async ({ resume }) => ({
      recommendation: "match", requirements: [], model: "test-model",
      bonus: { earned: resume.id.includes("batch") ? 10 : 0, possible: 10 }
    })
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Jev 人才筛选工作台/);
    const created = await fetch(`${base}/api/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(jobInput)
    });
    assert.equal(created.status, 201);
    const { job } = await created.json();
    const pdf = await makePdf(["Java backend developer with 7 years experience"]);
    const zip = await makeZip([["good.pdf", pdf], ["bad.pdf", Buffer.from("not-a-pdf")]]);
    const form = new FormData();
    form.append("jobId", job.id);
    form.append("files", new File([pdf], "single.pdf", { type: "application/pdf" }));
    form.append("files", new File([zip], "batch.zip", { type: "application/zip" }));
    const screened = await fetch(`${base}/api/screen-files`, { method: "POST", body: form });
    assert.equal(screened.status, 200);
    const result = await screened.json();
    assert.deepEqual(result.counts, { match: 2, review: 0, not_match: 0, error: 1 });
    assert.equal(result.results[0].fileName, "batch.zip / good.pdf");
    assert.match(result.results[2].error, /有效的 PDF/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("streaming upload reports each completed resume and the final sorting result", async () => {
  const job = { id: "stream-job", ...jobInput };
  const app = createApp({
    jobStore: { get: async (id) => id === job.id ? job : null },
    parsePdf: async () => "Java backend developer with 7 years experience",
    screen: async ({ resume }) => {
      if (resume.id === "broken.pdf") throw new Error("模拟筛选失败");
      await new Promise((resolve) => setTimeout(resolve, resume.id === "match.pdf" ? 25 : 5));
      return { recommendation: resume.id === "match.pdf" ? "match" : "not_match", requirements: [] };
    }
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const form = new FormData();
    form.append("jobId", job.id);
    for (const name of ["match.pdf", "not-match.pdf", "broken.pdf"]) {
      form.append("files", new File([Buffer.from("%PDF-test")], name));
    }
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/screen-files/stream`, {
      method: "POST", body: form
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "start");
    assert.equal(events[0].total, 3);
    assert.deepEqual(events.slice(1, -1).map((event) => event.completed), [1, 2, 3]);
    assert.deepEqual(events.slice(1, -1).map((event) => event.type), ["item", "item", "item"]);
    assert.equal(events.at(-1).type, "complete");
    assert.deepEqual(events.at(-1).batch.counts, { match: 1, review: 0, not_match: 1, error: 1 });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
