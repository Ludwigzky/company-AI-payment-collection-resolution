# DeepSeek 接入说明

本说明对应企业回款 Demo 的服务端 AI 接入，核对日期为 2026 年 11 月 10 日。业务顺序仍为设备销售、安装或维保，一般企业应收账款，工程结算。固定规则负责基础分流与条件，DeepSeek 仅生成独立标注的补充内容。

## 使用行为与数据流

1. 初次进入或切换虚构示例，在浏览器内生成规则预览，不调用付费模型。
2. 点击“使用 AI 生成”后，浏览器将本次表单数据作为 JSON 提交到同源 `POST /api/plan`。
3. 服务端验证输入并先生成固定规则方案，再向固定 DeepSeek 地址发送经过白名单筛选的案情、规则方案及相关来源摘要。
4. 模型返回经服务端校验后，作为 `plan.ai` 展示；固定规则仍保留。校验或调用失败时，返回规则方案和明确的回退原因。
5. 复制、文本导出及打印内容保留 AI 标识与人工复核提示。项目不自动发送函件、投诉或程序申请。

可发送的案情字段为金额、约定付款到期日、问题描述、双方名称（选填）、业务类型、主体类型、债权人规模、验收状态、争议解决约定、已有受理情况、问题标签及材料勾选。客户端提供的密钥、端点、模型和任意额外属性不会转发。名称和描述均视为未经核实的用户数据，不作为改变模型指令的依据。

本演示不保存历史案例，不记录案情或上游原始错误日志。浏览器中的当前结果及用户自行保存的导出文件仍可能含用户输入。DeepSeek 是外部数据处理方；本项目不承诺其数据保留政策，实际使用前应核对其适用条款及企业要求。

## 配置与部署

| 变量 | 位置与作用 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 部署时仅配置为 Sites runtime Secret，服务端运行时读取；不写入仓库、前端、构建资源或文档 |
| `DEEPSEEK_MODEL` | 可选服务端配置，默认 `deepseek-flash`；不得由浏览器请求指定 |

本机 `server.mjs` 只从进程环境读取上述变量，不加载 `.env`。`.env.example` 的密钥为空，仅用于说明变量名；复制或编辑 `.env` 不会自动配置本机服务。未提供密钥时，健康检查报告 `configured: false`，生成接口返回规则方案。不要将真实密钥写入文件、命令行参数或聊天。

模型调用使用原生 `fetch`，无 SDK。构建依赖为 `esbuild@0.28.2`，通过 `npm ci` 安装。

```powershell
npm ci
npm run dev
```

部署使用 `npm run build` 生成的 `dist/server/index.js`，其中内嵌 `index.html`、`styles.css`、`app.js`、`engine.js`、`sources.js` 和 `favicon.svg` 六项公开资源。Worker 不开放目录浏览，不提供 `src/`、服务端代码或 `.env`；只有明确列出的公开资源可由静态路径获取。Secret 在运行时注入，不内嵌到 Worker 包。现有站点私有访问边界保持有效，同源检查不替代平台访问控制。

## HTTP 接口

### `GET /api/health`

返回服务端配置状态，不访问 DeepSeek，不验证密钥有效性、余额或真实生成能力：

```json
{"provider":"DeepSeek","configured":true,"model":"deepseek-flash"}
```

### `POST /api/plan`

要求 `Content-Type: application/json`，请求体最多 32KB。示例使用虚构数据：

```json
{
  "amount": 328000,
  "dueDate": "2026-08-12",
  "issueText": "虚构演示：设备已交付，对方反馈运行不稳定，故障原因与验收状态仍需核实。",
  "projectType": "equipment",
  "issueTypes": ["repair", "acceptance"],
  "debtorType": "enterprise",
  "creditorSize": "unknown",
  "acceptanceStatus": "disputed",
  "disputeClause": "unknown",
  "disputeAccepted": "unknown",
  "evidence": ["contract", "delivery", "invoice"]
}
```

成功响应外层为 `{"plan": ...}`。有 AI 时 `plan.generation.mode` 为 `ai`，同时包含 `provider`、`model` 和单独的 `plan.ai`；回退时 `mode` 为 `rules`，附可展示的 `reason`，不含 AI 建议。回退仍为 HTTP 200，调用方应读取 `generation.mode`。

无效输入或 JSON 返回 400，跨站请求返回 403，未知接口返回 404，不支持的方法返回 405，超大请求返回 413，未预期内部错误返回通用 500。API 不提供跨域 CORS 放行；明确的跨源 `Origin` 和 `Sec-Fetch-Site: cross-site` 会被拒绝。响应带 `Cache-Control: no-store`。

## 固定模型请求

服务端固定使用 `POST https://api.deepseek.com/chat/completions`，以运行时密钥构造 Bearer 鉴权头，禁止重定向。请求体包含：

上游请求采用 `redirect: 'manual'`，遇到 3xx 即回退，不跟随 `Location`，也不向新地址转发密钥。Workers 不支持标准 Fetch 的 `redirect: 'error'`；兼容处理及重定向测试应保留。[Cloudflare Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)

```json
{
  "model": "deepseek-flash",
  "messages": [
    {"role": "system", "content": "中文任务要求、JSON 字段说明与完整格式示例"},
    {"role": "user", "content": "经筛选的本次案情、固定规则与来源摘要"}
  ],
  "thinking": {"type": "disabled"},
  "response_format": {"type": "json_object"},
  "max_tokens": 3000,
  "stream": false
}
```

默认模型 `deepseek-flash` 当前对应 DeepSeek-V4.1-Flash-1017。显式关闭 thinking，避免使用默认开启的思考模式。JSON 模式同时要求提示中包含 JSON 指令与格式示例；接口即使返回 `finish_reason: stop`，内容仍可能为空格，仍须解析和字段校验。官方说明见 [首调指南](https://api-docs.deepseek.com/)、[聊天接口](https://api-docs.deepseek.com/api/create-chat-completion/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/) 和 [JSON 输出](https://api-docs.deepseek.com/guides/json_mode/)。

服务端整体等待上限为 45 秒，非流式上游响应最多读取 128KB，同一进程或 Worker 实例最多同时处理 2 个模型调用。这是 Demo 的本地保护，不是账号级全局限流。无自动重试，每次用户提交最多发起一次模型请求；用户再次点击可能产生新的付费调用。浏览器最长等待 65 秒，修改输入或取消等待不保证已发出的上游调用停止计费。

## AI 输出 schema 与校验

模型只能返回以下结构，服务端从允许字段重建新对象，额外字段不会交给浏览器：

```json
{
  "analysis": "根据用户填报说明当前问题，保留待核实事项。",
  "strategy": "建议的核对与协商顺序。",
  "recommendations": [
    {
      "track": "business",
      "advice": "对该轨道的补充建议。",
      "steps": ["核对双方资料后提出可逐项确认的协商安排。"],
      "sourceIds": ["civil-code"]
    }
  ],
  "followUpQuestions": ["双方是否已书面确认待付金额？"],
  "communicationDraft": "供人工核查后使用的商务沟通草稿。"
}
```

| 字段 | 服务端边界 |
| --- | --- |
| `analysis` | 非空字符串，最多 1800 个 JavaScript 字符长度单位 |
| `strategy` | 非空字符串，最多 1000 |
| `recommendations` | 1–4 项；轨道只能为 `repair`、`business`、`legal`、`complaint`，须已存在于基础规则动作中且不重复 |
| `recommendations[].advice` | 非空字符串，最多 1000 |
| `recommendations[].steps` | 1–5 项，每项非空且最多 400 |
| `recommendations[].sourceIds` | 1–5 个不重复 ID，每项最多 64；须存在于固定来源目录且属于对应基础动作的来源白名单 |
| `followUpQuestions` | 0–6 项，每项非空且最多 200 |
| `communicationDraft` | 非空字符串，最多 2400 |

上述为接受上限，提示另要求更精简的内容，以便在 3000 tokens 内完整输出。只有 `finish_reason` 为 `stop` 且内容通过 JSON、字段、长度、来源和内容检查才接受；截断、空白、缺失字段、未知轨道或来源均回退规则。

文本检查会拒绝控制字符、凭证相关文本、模型自造链接及法条编号、确定性回款保证、部分未经核实的责任或时效结论，以及不当催收表达。服务端不向浏览器转发隐藏思考、工具或其他额外字段。此类校验是保守防护，不能证明建议准确、法律适用正确或内容已经人工审核。

AI 不能修改原始金额、逾期天数、日期、固定动作、程序及投诉核验条件；来源链接由固定目录提供。目录是固定资料来源，不是实时法律检索。合同、历史版本、地区规则、时效、管辖及程序条件仍须结合材料复核。

## 失败与错误处理

| 情况 | Demo 行为 |
| --- | --- |
| 未配置密钥 | 返回规则方案，提示尚未配置 AI |
| 本进程或实例已有 2 个活跃模型调用，或上游 429 | 返回规则方案，提示繁忙 |
| 网络错误、上游非成功状态或禁止的重定向 | 返回规则方案，提示服务暂不可用 |
| 45 秒整体超时 | 中止等待并返回规则方案，提示超时 |
| 响应过大、解析失败、输出不完整或校验未通过 | 返回规则方案，提示 AI 结果未通过校验 |

服务端不读取或暴露上游非成功响应的原始错误体，也不自动重试。官方错误码包含 400（格式）、401（鉴权）、402（余额）、422（参数）、429（限流）、500（服务异常）和 503（繁忙）；本项目不把这些诊断或账号信息直接展示给终端用户。[官方错误说明](https://api-docs.deepseek.com/quick_start/error_codes/)

官方当前列出的账号并发上限为 Flash 2500、Pro 500；其返回 429 的规则与 Demo 的实例内保护不同。非流请求可能先返回空行，不能把提前出现的空白视为完整响应。[官方限流与连接说明](https://api-docs.deepseek.com/quick_start/rate_limit/)

## 验证方法与当前状态

运行自动化检查：

```powershell
npm test
npm run check
npm run build
```

`npm test` 包含 Worker 构建及规则、AI 模拟上游、API 和 Worker 边界测试；数量以终端输出为准。重点包括正常 schema、超时、各类上游错误、恶意输入、来源白名单、输出截断、异常 JSON、空白内容、正文大小限制和规则回退。模拟测试不消耗模型额度，也不证明真实生成质量。

本机服务启动后检查健康接口；若服务实际使用后续端口，请替换地址：

```powershell
Invoke-RestMethod 'http://127.0.0.1:4173/api/health'
```

配置真实性可在受控服务端环境用 Bearer 鉴权请求 `GET https://api.deepseek.com/models`，确认 HTTP 状态及 `data` 中的模型 ID；不要输出请求头或密钥。该接口不生成内容，成功不证明余额充足或完整聊天流程可用。[官方模型列表接口](https://api-docs.deepseek.com/api/list-models/)

截至 2026 年 11 月 10 日，`npm test` 的 101 项测试（含打包后的 Worker 测试）及 `npm run check` 已通过；另已完成真实 `GET /models` 鉴权检查及一次虚构设备案例的完整生成验证：HTTP 200、`finish_reason: stop`、`generation.mode: ai`，4 轨建议通过 schema 与来源 ID 校验。该单例不代表其他场景质量、法律准确率或生产可用性均已验证。

复验真实生成时，应使用虚构数据在站点点击“使用 AI 生成”，确认 `generation.mode` 为 `ai`、分析及分轨内容完整、来源均来自固定目录，并核对复制和导出保留 AI 标识。若回退，应按页面提示记录非敏感状态，修正后再由人工决定是否重试。

浏览器 QA 仍待完成：首次与切换示例不调用模型、配置状态提示、生成等待、修改输入、AI 成功与回退、键盘和移动端交互、复制、下载、打印及响应式排版。页面及导出中的法律表达仍需专业复核；技术检查不等于真实案件准确率或回款效果验证。
