# eutils-mcp-server

中文 · [English](README.md)

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

把 NCBI 的九个 Entrez E-utilities 包装成 11 个只读工具的 MCP server。

它把 E-utilities 直接交给大模型，让模型能检索生物医学文献、取序列、在 Entrez 各库之间
跳转，不用浏览器，也不用爬网页。仓库目录名 `E-utilities` 来自它所包装的 API。包名、
server 注册名、GitHub 仓库名都是 `eutils-mcp-server`。

适用场景是"要答案，不要数据集"。例如"找 2024 年 CRISPR 递送的文章，给我摘要"。不适合
批量下载：NCBI 要求批量数据挖掘改用本地 PubMed 副本，而本服务遵守 NCBI 限流，大任务要跑
几天。也不适合改数据，因为它只读，而且 NCBI 没有通过这些接口开放写路径。

## Table of Contents

- [背景](#背景)
- [安装](#安装)
- [用法](#用法)
- [配置](#配置)
- [限流](#限流)
- [限制](#限制)
- [已知上游故障：EGQuery](#已知上游故障egquery)
- [安全](#安全)
- [API](#api)
- [维护者](#维护者)
- [贡献](#贡献)
- [许可证](#许可证)

## 背景

Entrez Programming Utilities 是 NCBI 的九个服务端程序。它们共用一套 URL 语法，覆盖 38 个
数据库，包括 PubMed、PMC、Protein、Nucleotide、Gene、SNP、Structure 和 Taxonomy。NCBI 在
[E-utilities 手册](https://www.ncbi.nlm.nih.gov/books/NBK25501/)里记录它们。

这套接口稳定，但让模型直接驱动很别扭。每个请求都要带同样的凭据、做同样的编码，还要知道
哪些接口接受哪种输出格式。批量取记录要用 History 服务器，它跨调用保存状态。超过限流会被
NCBI 封 IP。

本服务把这些细节写进代码。由一个 client 负责拼每个 URL、给每个请求限速、在允许列表内跟随
重定向、限制响应体积、遮蔽 API key。每个工具只做一件事：把一次操作映射成一次 E-utilities
调用，返回模型能读的结果。

两条上游事实决定了设计。EGQuery 从公网不可达，ESummary 的 JSON 上限是 500 条而不是手册
写的 10,000 条。两条都带证据记在 [docs/upstream-issues.md](docs/upstream-issues.md)。

## 安装

```console
git clone https://github.com/iwinoid/eutils-mcp-server.git
cd eutils-mcp-server
npm install
npm run build
```

### 依赖

需要 Node.js 22 或更高版本，版本锁在 `.nvmrc`。

运行时依赖三个：`@modelcontextprotocol/server`、`fast-xml-parser`、`zod`。lockfile 已提交。
没有安装脚本，也没有原生构建步骤。

## 用法

把本服务注册到你的 MCP 宿主。将下面内容加入宿主配置，例如 `claude_desktop_config.json`：

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
    "eutils": {
      "command": "node",
      "args": [
        "--env-file-if-exists=/absolute/path/to/E-utilities/.env",
        "/absolute/path/to/E-utilities/dist/index.js"
      ]
    }
  }
}
```

然后让模型去检索。也可以直接调单个工具：

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

命中数会随 PubMed 增长而变。确认你看到命中数和三个 UID 即可。

## 配置

三个环境变量都可选。NCBI 要求自动化客户端表明身份，API key 能提高限流上限。

| 变量           | 默认值              | 作用                                                                                                 |
| -------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `NCBI_API_KEY` | 未设置              | 把上限从每秒 3 次提到每秒 10 次。在 [NCBI 账户](https://www.ncbi.nlm.nih.gov/account/)的设置页申请。 |
| `NCBI_EMAIL`   | 未设置              | 随每个请求发送的联系邮箱。NCBI 封 IP 前会先通知你。                                                  |
| `NCBI_TOOL`    | `eutils-mcp-server` | 在 NCBI 日志里标识本软件的名字。                                                                     |

把值写进宿主配置的 `env` 块，或者放在项目根目录的 `.env` 文件里、用
`--env-file-if-exists` 启动。`npm start` 和 `npm run dev` 会自动带上该 flag。文件不存在时
Node 打印 `not found. Continuing without it.`，然后继续启动，所以缺少 `.env` 不会导致启动
失败。路径按工作目录解析。如果宿主在别处启动服务，请改用绝对路径。

`.gitignore` 排除了 `.env`，但没有排除宿主配置文件。提交前请检查该文件。

设置 `NCBI_EMAIL` 和 `NCBI_TOOL` 后，发邮件到 <eutilities@ncbi.nlm.nih.gov> 注册这两个值。
只带参数不注册，不算符合 NCBI 使用政策。

同时向该地址申请订阅 Entrez Utilities 公告邮件列表。这是 NCBI 唯一会通报已知缺陷的渠道。
[NCBI Insights 博客](https://ncbiinsights.ncbi.nlm.nih.gov/tag/e-utilities/)只发计划变更。
[E-utilities 手册](https://www.ncbi.nlm.nih.gov/books/NBK25501/)里的变更记录停在 2015 年。

## 限流

超限会被 NCBI 封 IP。所有请求（含分批请求）共用一个令牌桶。

- 无 API key：每秒 3 次
- 有 API key：每秒 10 次

NCBI 要求大任务放在周末。工作日请放在美东时间 21:00 到次日 05:00。

## 限制

- **只覆盖 Entrez。** 服务端读的是 Entrez 已索引的数据。Entrez 之外的数据取不到。
- **`retmax` 上限。** `eutils_esearch` 最多 10,000 条。`eutils_esummary` 和 `eutils_efetch`
  每次最多 500 条。更大的 UID 列表会自动切成每批 500 条，响应里用 `batches` 标明批数。
- **PubMed 和 PMC 上限。** ESearch 只能取到结果集的前 10,000 条。更大的集合请加日期条件分段。
- **截断。** 响应超过 25,000 字符会被截断。截断消息会说明如何翻页或收窄查询。
- **响应体积上限。** 响应体超过 5 MB 时客户端会放弃读取。
- **仅支持 stdio。** 没有 HTTP 传输。若要增加，请绑定 `127.0.0.1` 并校验 `Origin` 和
  `Host` 请求头。
- **EGQuery 覆盖范围。** EGQuery 本身不可达，所以 `eutils_egquery` 只覆盖 12 个库，不是
  38 个。详见下节。

## 已知上游故障：EGQuery

NCBI 的 `egquery.fcgi` 返回 HTTP 301，跳转到
`ext-http-eutils.linkerd.ncbi.nlm.nih.gov`。该主机没有发布到公网 DNS。

两个独立的 DNSSEC 验证解析器（Cloudflare 和 Google）都对该域名返回 NXDOMAIN。对照查询
`eutils.ncbi.nlm.nih.gov` 则正常解析。

试过的所有参数组合都会跳转：GET 和 POST，带或不带 `retmode`、`retmax`、`tool`、`email`、
浏览器 User-Agent，以及 HTTP/1.0。

带 API key 也没用。同一次会话里，带有效 key 的 `esearch` 返回 200，而 `egquery` 仍返回
301。带语法无效的 key 时，`egquery` 返回 `400 API key invalid`。这个结果说明 NCBI 在路由
之前先校验密钥。所以该跳转不是凭据或限流决策。

运行 `npm run doctor` 可以在你自己的网络上复现这个结论。完整证据链，以及构建本服务期间
发现的其他上游缺陷，见 [docs/upstream-issues.md](docs/upstream-issues.md)。

`eutils_egquery` 先试真正的 EGQuery。只有网络故障才触发降级，降级后用 ESearch 统计 12 个
常用库的命中数。结果里带 `degraded: true`、原因和一条说明。看到这个标记，就要理解为
"这是子集，不是全部 38 个库"。校验错误不会触发降级，所以一次错误查询不会白白多打 12 个
请求。

降级是惰性的。NCBI 修好该接口后，真正的 EGQuery 会自动恢复，不需要改代码。

## 安全

本服务只读，不监听端口，从不写磁盘。攻击者没有可连接的端口：唯一的网络流量
是从本服务到 NCBI 的出站 HTTPS。

| 威胁                   | 控制措施                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 记录文本携带的提示注入 | 服务端把 NCBI 记录文本夹在 `<<<EXTERNAL_NCBI_DATA` 标记之间，并标注为数据。它会从内容里剥掉标记本身，内容无法提前闭合围栏。服务端从不写入，因此无法被当作破坏性操作的代理人。 |
| 参数注入               | 服务端用字符集校验加 38 库白名单校验 `db`。UID、检索词、History 字段在使用前都会校验。所有值都用 `URLSearchParams` 编码，从不拼接 URL。                                       |
| API key 泄漏           | 服务端在每一行日志、每条错误消息、每个响应里都遮蔽 `api_key`。它从不把拼好的 URL 回显给模型。stdio 日志只写 stderr。                                                          |
| SSRF                   | base URL 是常量，不通过环境变量配置。客户端手动跟随重定向，最多三跳，且每一跳的主机名必须以 `.ncbi.nlm.nih.gov` 结尾。                                                        |
| 资源耗尽               | 令牌桶、每个接口的 `retmax` 上限、5 MB 响应体上限、请求超时，以及有上限的退避重试。                                                                                           |
| 恶意 XML               | 关闭实体处理。客户端在解析前剥掉 DOCTYPE 声明，并限制响应体大小。                                                                                                             |
| 供应链                 | 只有三个运行时依赖。lockfile 已提交。                                                                                                                                         |

安全漏洞请通过 [issue tracker](https://github.com/iwinoid/eutils-mcp-server/issues) 报告。

## API

共 11 个工具。每个都接受 `response_format`，取值为 `"markdown"` 或 `"json"`，默认 markdown。
每个都声明 `readOnlyHint: true` 和 `destructiveHint: false`，并且声明一个它自己的返回值
必定满足的 `outputSchema`。

| 工具                       | 用途                                             |
| -------------------------- | ------------------------------------------------ |
| `eutils_einfo`             | 列出数据库，或描述单个库的可搜字段、链接、记录数 |
| `eutils_esearch`           | 检索数据库，返回 UID 和 History 句柄             |
| `eutils_epost`             | 把 UID 列表上传到 NCBI History 服务器            |
| `eutils_esummary`          | 取一批 UID 的摘要：标题、作者、期刊、日期        |
| `eutils_efetch`            | 取完整记录：PubMed 摘要、FASTA 序列及其他格式    |
| `eutils_elink`             | 跨库跳转，例如 pubmed 到 pmc，或 gene 到 protein |
| `eutils_egquery`           | 一次统计多个库的命中数                           |
| `eutils_espell`            | 给出拼写建议                                     |
| `eutils_ecitmatch`         | 把格式化引文解析成 PMID                          |
| `eutils_search_then_fetch` | 一次调用完成检索加下载                           |
| `eutils_link_then_fetch`   | 一次调用完成跳转加下载目标记录                   |

每个工具对应九个 E-utilities 中的一个。工具名在 `eutils_` 前缀后带上 E-utilities 的名字，
所以 `eutils_esearch` 调的是 `esearch.fcgi`。参数名沿用 API 的写法，手册可以直接对照。

### 处理大数据集

服务端不保存状态。History 句柄作为普通值传递，原样回传即可。

```text
eutils_esearch(db="pubmed", term="...", retmax=0, usehistory=true)
  -> { total: 16896, history: { db, web_env, query_key } }

eutils_efetch(history={...}, retstart=0,   retmax=500)
eutils_efetch(history={...}, retstart=500, retmax=500)
```

用 inspector 查看每个工具完整的输入与输出 schema：

```console
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

## 维护者

[@iwinoid](https://github.com/iwinoid)

## 贡献

有问题请在 [issue tracker](https://github.com/iwinoid/eutils-mcp-server/issues) 提出。接受
pull request。

提交前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。里面写了开发命令、pull request 必须满足
的要求，以及怎么看覆盖率数字。

本项目遵循 [Contributor Covenant](CODE_OF_CONDUCT.md) 2.1 版。

## 许可证

[MIT](LICENSE) © iwinoid

数据由 NCBI 提供。若你再分发本软件或其输出，必须让用户看到 NCBI 的
[免责声明与版权声明](https://www.ncbi.nlm.nih.gov/About/disclaimer.html)。PubMed 摘要可能
受版权保护。超出合理使用的再分发需要版权所有者许可。
