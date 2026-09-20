import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectPdfFiles, extractPdfText, InputError, MAX_UPLOAD_BYTES } from "./files.js";
import { createJobStore } from "./jobs.js";
import { screenResume } from "./screen.js";

const MAX_JSON_BYTES = 100_000;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/sorting.css", ["sorting.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]]
]);

async function readRawBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new InputError("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  try {
    return JSON.parse((await readRawBody(request, MAX_JSON_BYTES)).toString("utf8"));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("请求体必须是有效的 JSON");
  }
}

async function readForm(request) {
  const contentType = request.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data;")) {
    throw new InputError("请使用 multipart/form-data 上传文件");
  }
  try {
    const body = await readRawBody(request, MAX_UPLOAD_BYTES);
    const parsed = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body
    });
    return await parsed.formData();
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("无法解析上传文件");
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(value));
}

export async function screenUploadedFiles(job, uploads, {
  collectFiles = collectPdfFiles,
  parsePdf = extractPdfText,
  screen = screenResume,
  onProgress = () => {}
} = {}) {
  const files = await collectFiles(uploads);
  const results = new Array(files.length);
  let cursor = 0;
  let completed = 0;
  onProgress({ type: "start", total: files.length, job: { id: job.id, title: job.title } });
  const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
    while (cursor < files.length) {
      const index = cursor++;
      const file = files[index];
      if (file.error) {
        results[index] = { fileName: file.name, status: "error", error: file.error };
      } else {
        try {
          const text = await parsePdf(file.data);
          const screening = await screen({ job, resume: { id: file.name, text } });
          results[index] = { fileName: file.name, status: "ok", screening };
        } catch (error) {
          results[index] = { fileName: file.name, status: "error", error: error.message };
        }
      }
      completed++;
      onProgress({ type: "item", index, completed, total: files.length, item: results[index] });
    }
  });
  await Promise.all(workers);
  const priority = { match: 0, review: 1, not_match: 2 };
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === "ok" ? -1 : 1;
    if (a.status === "error") return 0;
    return (priority[a.screening.recommendation] - priority[b.screening.recommendation]) ||
      ((b.screening.bonus?.earned ?? 0) - (a.screening.bonus?.earned ?? 0));
  });
  return {
    job: { id: job.id, title: job.title },
    total: results.length,
    counts: {
      match: results.filter((item) => item.status === "ok" && item.screening.recommendation === "match").length,
      review: results.filter((item) => item.status === "ok" && item.screening.recommendation === "review").length,
      not_match: results.filter((item) => item.status === "ok" && item.screening.recommendation === "not_match").length,
      error: results.filter((item) => item.status === "error").length
    },
    results
  };
}

export function createApp({ screen = screenResume, jobStore = createJobStore(),
  collectFiles = collectPdfFiles, parsePdf = extractPdfText } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        sendJson(response, 200, { jobs: await jobStore.list() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/jobs") {
        sendJson(response, 201, { job: await jobStore.create(await readJson(request)) });
        return;
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/);
      if (jobMatch && request.method === "PUT") {
        const job = await jobStore.update(jobMatch[1], await readJson(request));
        sendJson(response, job ? 200 : 404, job ? { job } : { error: "职位不存在" });
        return;
      }
      if (jobMatch && request.method === "DELETE") {
        const removed = await jobStore.remove(jobMatch[1]);
        sendJson(response, removed ? 200 : 404, removed ? { deleted: true } : { error: "职位不存在" });
        return;
      }
      if (request.method === "POST" && (url.pathname === "/api/screen-files" || url.pathname === "/api/screen-files/stream")) {
        const form = await readForm(request);
        const jobId = form.get("jobId");
        if (typeof jobId !== "string" || !jobId) throw new InputError("请选择职位");
        const job = await jobStore.get(jobId);
        if (!job) {
          sendJson(response, 404, { error: "职位不存在" });
          return;
        }
        if (url.pathname === "/api/screen-files/stream") {
          response.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no"
          });
          response.flushHeaders();
          const sendEvent = (event) => response.write(`${JSON.stringify(event)}\n`);
          try {
            const result = await screenUploadedFiles(job, form.getAll("files"), {
              collectFiles, parsePdf, screen, onProgress: sendEvent
            });
            sendEvent({ type: "complete", batch: result });
          } catch (error) {
            sendEvent({ type: "error", error: error.message });
          }
          response.end();
        } else {
          const result = await screenUploadedFiles(job, form.getAll("files"), { collectFiles, parsePdf, screen });
          sendJson(response, 200, result);
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/screen") {
        sendJson(response, 200, await screen(await readJson(request)));
        return;
      }
      if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
        const [name, contentType] = STATIC_FILES.get(url.pathname);
        const content = await readFile(path.join(PUBLIC_DIR, name));
        response.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
        });
        response.end(content);
        return;
      }
      sendJson(response, 404, { error: "接口不存在" });
    } catch (error) {
      const status = error instanceof InputError || error instanceof TypeError ? 400 : 502;
      sendJson(response, status, { error: error.message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => console.log(`Jev 简历筛选服务已启动：http://localhost:${port}`));
}
