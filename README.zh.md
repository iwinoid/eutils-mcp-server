# eutils-mcp-server

中文 · [English](README.md)

把 NCBI 的九个 Entrez 编程接口（E-utilities）包装成 MCP 工具，供大模型调用。

底层 API 见 NCBI 的 [E-utilities 手册](https://www.ncbi.nlm.nih.gov/books/NBK25501/)。

## 适用 / 不适用

适用：让模型检索和阅读生物医学数据。覆盖文献、序列、基因、结构、物种分类，并能在这些库之间跳转。

适用：你要的是答案，不是数据集。例如"找 2024 年 CRISPR 递送的文章，给我摘要"。

不适用：批量下载。要几百万条记录，请下载 [PubMed 本地副本](https://www.nlm.nih.gov/databases/download/pubmed_medline.html)。本服务遵守 NCBI 限流，大任务要跑几天。

不适用：修改任何数据。本服务只读，NCBI 也没有开放写接口。

## 安装

```console
npm install
npm run build
```

需要 Node.js 18 或更高版本。

## 配置

三个环境变量都可选。NCBI 要求自动化客户端表明身份。API key 能提高限流上限。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `NCBI_API_KEY` | 未设置 | 把上限从每秒 3 次提到每秒 10 次。在 [NCBI 账户](https://www.ncbi.nlm.nih.gov/account/)的设置页申请。 |
| `NCBI_EMAIL` | 未设置 | 随每个请求发送的联系邮箱。NCBI 封 IP 前会先通知你。 |
| `NCBI_TOOL` | `eutils-mcp-server` | 在 NCBI 日志里标识本软件的名字。 |

把值写进 MCP 宿主配置的 `env` 块。或者放在项目根目录的 `.env` 文件里，用 `--env-file-if-exists` 启动：

```console
node --env-file-if-exists=.env dist/index.js
```

`npm start` 和 `npm run dev` 会自动带上该 flag。文件不存在时 Node 打印 `not found. Continuing without it.`，然后继续启动，所以缺少 `.env` 不会导致启动失败。路径按工作目录解析。如果宿主在别处启动服务，请改用绝对路径。

`.gitignore` 排除了 `.env`，但没有排除宿主配置文件。提交前请检查该文件。

设置 `NCBI_EMAIL` 和 `NCBI_TOOL` 后，发邮件到 <eutilities@ncbi.nlm.nih.gov> 注册这两个值。只带参数不注册，不算符合 NCBI 使用政策。

同时向该地址申请订阅 Entrez Utilities 公告邮件列表。这是 NCBI 唯一会通报已知缺陷的渠道。[NCBI Insights 博客](https://ncbiinsights.ncbi.nlm.nih.gov/tag/e-utilities/)只发计划变更。[E-utilities 手册](https://www.ncbi.nlm.nih.gov/books/NBK25501/)里的变更记录停在 2015 年。

### 客户端配置

把下面内容加入 MCP 宿主配置，例如 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "eutils": {
      "command": "node",
      "args": ["/absolute/path/to/E-utilities/dist/index.js"],
      "env": {
        "NCBI_API_KEY": "your-key",
        "NCBI_EMAIL": "you@example.com",
        "NCBI_TOOL": "eutils-mcp-server"
      }
    }
  }
}
```

不想把 key 写进宿主配置，就改从 `.env` 读取：

```json
{
  "mcpServers": {
    "entrez": {
      "command": "node",
      "args": ["--env-file-if-exists=/absolute/path/to/E-utilities/.env", "/absolute/path/to/E-utilities/dist/index.js"]
    }
  }
}
```

## 快速开始

先查一批文献：

```console
npm run call eutils_esearch '{"db":"pubmed","term":"CRISPR delivery AND 2024[pdat]","retmax":3}'
```

服务端返回命中数、UID 列表、翻译后的查询，以及一个 History 句柄：

```text
# ESearch: `CRISPR delivery AND 2024[pdat]`

Database **pubmed** matched **412** records. Showing 3 starting at 0.

## UIDs

40123456, 40123457, 40123458

## History handle

{"db":"pubmed","web_env":"MCID_6aa2...","query_key":"1"}
```

命中数会随 PubMed 增长而变化。确认你看到命中数和三个 UID 即可。

要让模型调用，就启动服务端，由宿主调用这些工具。

## 工具

共 11 个工具。每个工具都接受 `response_format`，取值为 `"markdown"` 或 `"json"`，默认 markdown。每个工具都声明 `readOnlyHint: true` 和 `destructiveHint: false`。

| 工具 | 用途 |
|---|---|
| `eutils_einfo` | 列出数据库，或描述单个库的可搜字段、链接、记录数 |
| `eutils_esearch` | 检索数据库，返回 UID 和 History 句柄 |
| `eutils_epost` | 把 UID 列表上传到 NCBI History 服务器 |
| `eutils_esummary` | 取一批 UID 的摘要：标题、作者、期刊、日期 |
| `eutils_efetch` | 取完整记录：PubMed 摘要、FASTA 序列及其他格式 |
| `eutils_elink` | 跨库跳转，例如 pubmed 到 pmc，或 gene 到 protein |
| `eutils_egquery` | 一次统计多个库的命中数 |
| `eutils_espell` | 给出拼写建议 |
| `eutils_ecitmatch` | 把格式化引文解析成 PMID |
| `eutils_search_then_fetch` | 一次调用完成检索加下载 |
| `eutils_link_then_fetch` | 一次调用完成跳转加下载目标记录 |

### 处理大数据集

服务端不保存状态。History 句柄作为普通值传递，原样回传即可。

```text
eutils_esearch(db="pubmed", term="...", retmax=0, usehistory=true)
  -> { total: 16896, history: { db, web_env, query_key } }

eutils_efetch(history={...}, retstart=0,   retmax=500)
eutils_efetch(history={...}, retstart=500, retmax=500)
```

## 限流

超限会被 NCBI 封 IP。所有请求（含分批请求）共用一个令牌桶。

- 无 API key：每秒 3 次
- 有 API key：每秒 10 次

NCBI 要求大任务放在周末。工作日请放在美东时间 21:00 到次日 05:00。

## 限制

- **只覆盖 Entrez。** 服务端读的是 Entrez 已索引的数据。Entrez 之外的数据取不到。
- **`retmax` 上限。** `eutils_esearch` 最多 10,000 条。`eutils_esummary` 和 `eutils_efetch` 每次最多 500 条。更大的 UID 列表会自动切成每批 500 条，响应里用 `batches` 标明批数。
- **PubMed 和 PMC 上限。** ESearch 只能取到结果集的前 10,000 条。更大的集合请加日期条件分段。
- **截断。** 响应超过 25,000 字符会被截断。截断消息会说明如何翻页或收窄查询。
- **响应体积上限。** 响应体超过 5 MB 时客户端会放弃读取。
- **仅支持 stdio。** 没有 HTTP 传输。若要增加，请绑定 `127.0.0.1` 并校验 `Origin` 和 `Host` 请求头。
- **EGQuery 覆盖范围。** EGQuery 本身不可达，所以 `eutils_egquery` 只覆盖 12 个库，不是 38 个。详见下节。

## 已知上游故障：EGQuery

NCBI 的 `egquery.fcgi` 返回 HTTP 301，跳转到 `ext-http-eutils.linkerd.ncbi.nlm.nih.gov`。该主机没有发布到公网 DNS。

两个独立的 DNSSEC 验证解析器（Cloudflare 和 Google）都对该域名返回 NXDOMAIN。对照查询 `eutils.ncbi.nlm.nih.gov` 则正常解析。

试过的所有参数组合都会跳转：GET 和 POST，带或不带 `retmode`、`retmax`、`tool`、`email`、浏览器 User-Agent，以及 HTTP/1.0。

带 API key 也没用。同一次会话里，带有效 key 的 `esearch` 返回 200，而 `egquery` 仍返回 301。带语法无效的 key 时，`egquery` 返回 `400 API key invalid`。这个结果说明 NCBI 在路由之前先校验密钥。所以该跳转不是凭据或限流决策。

运行 `npm run doctor` 可以在你自己的网络上复现这个结论。完整证据链，以及构建本服务期间发现的其他上游缺陷，见 [docs/upstream-issues.md](docs/upstream-issues.md)。

### 服务端的处理

`eutils_egquery` 先试真正的 EGQuery。只有网络故障才触发降级。降级后用 ESearch 统计 12 个常用库的命中数。结果里带标记：

```json
{ "degraded": true, "degraded_reason": "...", "databases_searched": 12 }
```

看到 `degraded: true`，就要理解为"这是子集，不是全部 38 个库"。校验错误不会触发降级，所以一次错误查询不会白白多打 12 个请求。

降级是惰性的。NCBI 修好该接口后，真正的 EGQuery 会自动恢复，不需要改代码。

## 安全

| 威胁 | 控制措施 |
|---|---|
| 记录文本携带的提示注入 | 服务端把 NCBI 记录文本夹在 `<<<EXTERNAL_NCBI_DATA` 标记之间，并标注为数据。它会从内容里剥掉标记本身，内容无法提前闭合围栏。服务端从不写入，因此无法被当作破坏性操作的代理人。 |
| 参数注入 | 服务端用字符集校验加 38 库白名单校验 `db`。UID、检索词、History 字段在使用前都会校验。所有值都用 `URLSearchParams` 编码，从不拼接 URL。 |
| API key 泄漏 | 服务端在每一行日志、每条错误消息、每个响应里都遮蔽 `api_key`。它从不把拼好的 URL 回显给模型。stdio 日志只写 stderr。 |
| SSRF | base URL 是常量，不通过环境变量配置。客户端手动跟随重定向，最多三跳，且每一跳的主机名必须以 `.ncbi.nlm.nih.gov` 结尾。 |
| 资源耗尽 | 令牌桶、每个接口的 `retmax` 上限、5 MB 响应体上限、请求超时，以及有上限的退避重试。 |
| 恶意 XML | 关闭实体处理。客户端在解析前剥掉 DOCTYPE 声明，并限制响应体大小。 |
| 供应链 | 只有三个运行时依赖。lockfile 已提交。 |

## 开发

```console
npm test           # 单元测试，不联网
npm run build      # strict TypeScript
npm run test:live  # 集成测试：每个工具都真实调用 NCBI
npm run verify     # stdio 协议冒烟测试，不真实调用
npm run verify:live
npm run doctor     # 探测全部九个接口，报告哪些可用
npm run verify:evals
npm run call eutils_esearch '{"db":"pubmed","term":"cancer","retmax":2}'
```

`npm run call` 直接调用单个工具。查看响应结构时它最快。

交互式检查：

```console
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

集成测试只断言稳定事实，例如某篇 1987 年论文的 PMID 或某个固定刊名。命中数和日期会随 PubMed 增长而变化，所以测试从不断言它们。

### 刷新数据库列表

NCBI 会新增和下线数据库。当合法库名被拒绝时，运行：

```console
npm run refresh:databases
```

该命令会从 EInfo 重新生成 `src/constants.ts` 里的 `ENTREZ_DATABASES`。

## 目录结构

```text
src/
  index.ts              服务入口，stdio 传输
  constants.ts          base URL、数据库白名单、各项上限
  types.ts              HistoryRef、分页、EutilsError
  services/
    eutilsClient.ts     唯一出口：拼 URL、重定向、重试、脱敏
    rateLimiter.ts      令牌桶
    xml.ts              加固的 XML 解析
    formatters.ts       markdown 与 JSON 渲染、不可信文本围栏、截断
    validate.ts         数据库、UID、retmax、History 校验
  tools/
    parse.ts            纯响应解析器，用真实抓包做单测
    common.ts           共享 schema 与数据源解析
    discovery.ts        EInfo、EGQuery、ESpell
    search.ts           ESearch、EPost
    records.ts          ESummary、EFetch
    links.ts            ELink、ECitMatch
    workflows.ts        search_then_fetch、link_then_fetch
    registry.ts         注册全部 11 个工具
```

所有对外请求都经过 `EutilsClient`。没有任何工具自己拼 URL。

## 许可证

MIT。见 [LICENSE](LICENSE)。

## 免责声明

数据由 NCBI 提供。若你再分发本软件或其输出，必须让用户看到 NCBI 的[免责声明与版权声明](https://www.ncbi.nlm.nih.gov/About/disclaimer.html)。PubMed 摘要可能受版权保护。超出合理使用的再分发需要版权所有者许可。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
