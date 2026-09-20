import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import yauzl from "yauzl";

export class InputError extends Error {}
class LimitError extends InputError {}

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 60 * 1024 * 1024;
const MAX_PAGES = 20;
const PDFJS_MODULE_URL = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const CMAP_URL = fileURLToPath(new URL("../../cmaps/", PDFJS_MODULE_URL));
const STANDARD_FONT_URL = fileURLToPath(new URL("../../standard_fonts/", PDFJS_MODULE_URL));
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function fileName(name) {
  return path.posix.basename(String(name).replaceAll("\\", "/"));
}

function zipEntryName(entry) {
  const raw = entry.fileNameRaw;
  if ((entry.generalPurposeBitFlag & 0x800) || !Buffer.isBuffer(raw) || !raw.some((byte) => byte > 127)) {
    return entry.fileName;
  }
  try {
    // Some ZIP creators store UTF-8 names without setting the format's UTF-8 flag.
    const decoded = UTF8_DECODER.decode(raw).replaceAll("\\", "/");
    return yauzl.validateFileName(decoded) ? entry.fileName : decoded;
  } catch {
    return entry.fileName;
  }
}

async function readLimited(stream, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy();
      throw new InputError("压缩包中的 PDF 超过 8 MB 限制");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function expandZip(buffer, archiveName) {
  let zip;
  try {
    zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true });
  } catch {
    throw new InputError(`无法打开 ZIP：${archiveName}`);
  }
  const files = [];
  let total = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      const entryName = zipEntryName(entry);
      if (entryName.endsWith("/") || entryName.startsWith("__MACOSX/") ||
          !entryName.toLowerCase().endsWith(".pdf")) continue;
      if (entry.uncompressedSize > MAX_PDF_BYTES) {
        files.push({ name: `${archiveName} / ${fileName(entryName)}`, error: "PDF 超过 8 MB 限制" });
        continue;
      }
      total += entry.uncompressedSize;
      if (total > MAX_EXTRACTED_BYTES) throw new LimitError("ZIP 解压后总大小超过 60 MB 限制");
      try {
        const stream = await zip.openReadStreamPromise(entry);
        const data = await readLimited(stream, MAX_PDF_BYTES);
        files.push({ name: `${archiveName} / ${fileName(entryName)}`, data });
      } catch (error) {
        files.push({ name: `${archiveName} / ${fileName(entryName)}`, error: error.message });
      }
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`ZIP 内容损坏：${archiveName}`);
  } finally {
    zip.close();
  }
  if (files.length === 0) throw new InputError(`ZIP 中没有 PDF：${archiveName}`);
  return files;
}

export async function collectPdfFiles(uploads) {
  if (!Array.isArray(uploads) || uploads.length === 0) throw new InputError("请上传 PDF 或 ZIP 文件");
  const files = [];
  for (const upload of uploads) {
    if (!upload || typeof upload.name !== "string" || typeof upload.arrayBuffer !== "function") {
      throw new InputError("上传文件格式无效");
    }
    const name = fileName(upload.name);
    const size = Number(upload.size);
    if (!Number.isFinite(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
      throw new InputError(`文件为空或超过 40 MB：${name}`);
    }
    const data = Buffer.from(await upload.arrayBuffer());
    if (name.toLowerCase().endsWith(".pdf")) {
      files.push(data.length > MAX_PDF_BYTES
        ? { name, error: "PDF 超过 8 MB 限制" }
        : { name, data });
    } else if (name.toLowerCase().endsWith(".zip")) {
      try {
        for (const file of await expandZip(data, name)) files.push(file);
      } catch (error) {
        if (error instanceof LimitError) throw error;
        files.push({ name, error: error.message });
      }
    } else {
      throw new InputError(`仅支持 PDF 或 ZIP：${name}`);
    }
  }
  return files;
}

export async function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString() !== "%PDF-") {
    throw new InputError("文件不是有效的 PDF");
  }
  let loadingTask;
  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_URL
    });
    const document = await loadingTask.promise;
    if (document.numPages > MAX_PAGES) throw new InputError(`PDF 超过 ${MAX_PAGES} 页限制`);
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = "";
      let previousY;
      let previousText = "";
      for (const item of content.items) {
        if (typeof item.str !== "string" || !item.str) continue;
        const currentY = item.transform?.[5];
        if (previousY !== undefined && currentY !== undefined && Math.abs(currentY - previousY) > 3) {
          pageText += "\n";
        } else if (/[A-Za-z0-9]$/.test(previousText) && /^[A-Za-z0-9]/.test(item.str)) {
          pageText += " ";
        }
        pageText += item.str;
        if (item.hasEOL) pageText += "\n";
        previousY = currentY;
        previousText = item.hasEOL ? "" : item.str;
      }
      pages.push(pageText.trim());
    }
    const text = pages.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 20) throw new InputError("PDF 未提取到足够可用文字；扫描件需要 OCR，文字型 PDF 请检查字体编码");
    if (text.length > 12_000) throw new InputError("简历文本超过 12,000 字符限制");
    return text;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("PDF 无法解析，可能已损坏或加密");
  } finally {
    if (loadingTask) await loadingTask.destroy();
  }
}
