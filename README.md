# Jev 简历筛选工作台

一个本地运行的 HR 简历初筛工具。定义职位与招聘要求后，上传 PDF 简历或 ZIP 压缩包，系统会调用 [TypeSafe Jev](https://docs.typesafe.ai/api.md) 逐条判断，并把简历分到“建议匹配、条件不符、人工复核、处理失败”四个区域。点击任意简历可查看原文证据和每条判断。

> 适合做初筛与排序，不应作为自动拒绝候选人的唯一依据。最终决定请由招聘人员复核。

## 主要功能

- 职位配置：必要条件、偏好条件、二元加分项和按等级评分的加分项。
- 批量上传：支持多个文字型 PDF 或包含 PDF 的 ZIP，筛选过程逐份显示进度。
- 分拣工作台：已完成的简历自动进入对应区域；加分只影响同一结果区域内的排序。
- 可追溯结果：展示逐条判断、分数和从简历中定位到的原文片段。
- 中文文件支持：可提取需要 CMap 的中文 PDF；兼容未正确标记 UTF-8 的 ZIP 文件名。

## 快速开始

### 1. 准备环境

需要 [Node.js](https://nodejs.org/) **22.13 或更高版本**，以及 TypeSafe 官方 Jev API Key。

```bash
git clone https://github.com/ai-suifeng/jev-job-web.git
cd jev-job-web
npm install
cp .env.example .env
```

编辑 `.env`，填入自己的官方 Key：

```ini
JEV_KEY=你的_TypeSafe_Jev_API_Key
```

也可以使用环境变量 `TYPESAFE_API_KEY`。`OPEN_ROUTER_JEV_KEY` 不会被本项目读取。

### 2. 启动

```bash
npm start
```

打开 [http://localhost:3000](http://localhost:3000)。服务只监听 `127.0.0.1`，不会自动暴露到局域网或公网。

首次进入后，可以点击“加载 Java 示例”，按实际岗位修改并保存；也可以直接新建职位。

## 使用方式

1. 配置职位。把决定是否进入下一轮的要求设为“必要条件”；把用于同类候选人排序的条件设为“加分项”。
2. 选择职位，拖入 PDF 或 ZIP，点击“开始筛选”。
3. 观察逐份进度。每份简历完成后会自动落入对应的分拣区。
4. 点击简历卡片，查看匹配原因、必要条件结论、加分及引用的简历原文。

### 结果规则

| 结果 | 判断方式 |
| --- | --- |
| 建议匹配 | 所有必要条件均满足 |
| 条件不符 | 至少一条必要条件明确不满足 |
| 人工复核 | 信息不足、判断概率低或无法定位证据 |
| 加分 | 只用于相同分拣区内的排序，不改变必要条件结论 |

例如，“5 年 Java 经验”和“有上线项目”可以设为必要条件；“在指定企业正式任职”“复杂系统设计与优化”可设为加分项。评分等级应写清职责、系统规模、技术难点和结果，减少模型猜测。

## 文件限制与 PDF 支持

- 支持文字型 PDF 和 ZIP；扫描件、加密或损坏的 PDF 无法直接提取文字。
- 一次上传总量不超过 40 MB；单份 PDF 不超过 8 MB、20 页和 12,000 个提取字符。
- ZIP 中 PDF 解压后的总量不超过 60 MB；不限制简历份数。
- 中文文字型 PDF 使用 PDF.js CMap 提取文字。扫描件需先经过 OCR。

## 数据与密钥

- `.env`、本地职位数据 `data/`、上传文件、运行结果和浏览器调试产物都在 `.gitignore` 中，不会随代码提交。
- 上传的 PDF 不落盘；提取出的简历文字会发送到 TypeSafe 官方 API 进行判断。请在使用前确认公司的候选人数据处理政策。
- 请勿把真实 API Key 写进源码、README、Issue、截图或提交记录。用 `.env.example` 作为配置模板。
- 职位配置保存在本地 `data/jobs.json`，文件权限为仅当前用户可读写。

## 开发与测试

```bash
npm test
```

测试使用模拟的 Jev 响应，不会消耗 API Key。它覆盖职位持久化、PDF 文字提取、ZIP 展开、中文文件名、100 份简历批处理、流式进度以及筛选逻辑。

## HTTP 接口

- `GET/POST /api/jobs`：查询或创建职位。
- `PUT/DELETE /api/jobs/:id`：更新或删除职位。
- `POST /api/screen-files/stream`：接收 `multipart/form-data`（`jobId`、一个或多个 `files`），通过 NDJSON 逐份返回进度和结果。
- `POST /api/screen-files`：返回一次性 JSON 批处理结果。
- `POST /screen`：传入文本简历，格式见 [example.json](./example.json)。

实现参考：[TypeSafe Score](https://docs.typesafe.ai/primitives/score.md)、[PDF.js Node 示例](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs) 和 [yauzl ZIP 文档](https://github.com/thejoshwolfe/yauzl/blob/master/README.md)。
