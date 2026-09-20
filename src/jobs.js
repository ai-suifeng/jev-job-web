import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateInput } from "./screen.js";

function normalizeJob(value) {
  const job = {
    title: value?.title?.trim(),
    requirements: value?.requirements?.map((item) => ({
      id: item?.id?.trim(),
      text: item?.text?.trim(),
      required: item?.required ?? true,
      ...(item?.bonusPoints === undefined ? {} : { bonusPoints: item.bonusPoints }),
      ...(item?.levels === undefined ? {} : { levels: item.levels.map((level) => level.trim()) })
    }))
  };
  validateInput({ job, resume: { text: "用于验证岗位配置的占位文本" } });
  if (job.title.length > 120 || job.requirements.some((item) => item.text.length > 500)) {
    throw new TypeError("职位名称最多 120 字，单条条件最多 500 字");
  }
  return job;
}

export function createJobStore(filePath = path.join(process.cwd(), "data", "jobs.json")) {
  let mutation = Promise.resolve();

  async function readJobs() {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeJobs(jobs) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(jobs, null, 2), { mode: 0o600 });
    await rename(temporary, filePath);
  }

  function change(operation) {
    const next = mutation.then(operation);
    mutation = next.catch(() => {});
    return next;
  }

  return {
    async list() {
      await mutation;
      return readJobs();
    },
    async get(id) {
      await mutation;
      return (await readJobs()).find((job) => job.id === id) ?? null;
    },
    create(value) {
      const job = normalizeJob(value);
      return change(async () => {
        const jobs = await readJobs();
        const now = new Date().toISOString();
        const saved = { ...job, id: randomUUID(), createdAt: now, updatedAt: now };
        jobs.push(saved);
        await writeJobs(jobs);
        return saved;
      });
    },
    update(id, value) {
      const job = normalizeJob(value);
      return change(async () => {
        const jobs = await readJobs();
        const index = jobs.findIndex((item) => item.id === id);
        if (index < 0) return null;
        const saved = { ...jobs[index], ...job, updatedAt: new Date().toISOString() };
        jobs[index] = saved;
        await writeJobs(jobs);
        return saved;
      });
    },
    remove(id) {
      return change(async () => {
        const jobs = await readJobs();
        const remaining = jobs.filter((item) => item.id !== id);
        if (remaining.length === jobs.length) return false;
        await writeJobs(remaining);
        return true;
      });
    }
  };
}
