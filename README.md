# DeepSeek Harness WebFetch fake-IP 与 PDF 文本插件

适配 **DeepSeek Harness 0.2.1-rc.2**。解决 OpenWrt / OpenClash / Mihomo 的
`198.18.0.0/15` 和 `fdfe:dcba:9876::/64` fake-IP 被内置 `web_fetch` 拒绝的问题，
并支持将网页返回的 PDF 在本地提取为正文，再交给原来的 `web_fetch` 工具。

插件禁用 `web-fetch-http` 组合项，并插入 `web-fetch-fakeip` 组合项，继续注册原来的 `http` 提供方；模型使用原来的
`web_fetch` 工具，不需要换工具名或调整提供方选择。抓取器基于固定版本的官方
`HttpFetchProvider`、URL 策略和地址固定传输代码，增加 PDF 解码分支，不修改 Harness 安装目录。

## 工作方式

1. 先读取系统 DNS；正常公网答案沿用官方地址策略。
2. 只有域名答案含已配置的 fake-IP 池，且没有混入其他非公网地址，才使用 DoH 查询 A 和 AAAA。
3. 对真实地址执行整组公网校验、IPv4-mapped IPv6 和本地 NAT64 检查。
4. 将通过校验的真实 IP 交给官方抓取器固定连接，保留原始 Host 和 TLS SNI。

真实内网域名、内网 IP 字面量和 fake-IP 字面量继续被拒绝。DoH 失败时明确报错，
不会退回未校验的 fake-IP。跨源重定向、抓取超时、响应字节上限和文本截断沿用官方行为。

默认 DoH 服务为阿里 DNS JSON API `https://dns.alidns.com/resolve`。
仅触发回退时，目标域名会发给所配置的 DoH 服务。支持 DNS JSON API，
不支持只提供二进制 `application/dns-message` 的端点。

## 安装

在 Harness 的插件页选择安装组合包，输入这个 GitHub 安装地址：

```text
git+https://github.com/charlesjson/dsh-web-fetch-fakeip.git#v0.2.0
```

安装并启用后重启 Harness。仓库包含 `dist/` 运行文件，安装时无需手动编译源码。
也可以直接安装 [GitHub Release 安装包](https://github.com/charlesjson/dsh-web-fetch-fakeip/releases/download/v0.2.0/dsh-web-fetch-fakeip-0.2.0.tgz)。

Web 版也可以用命令行安装到 `web` profile：

```sh
dsh plugin --profile web add "git+https://github.com/charlesjson/dsh-web-fetch-fakeip.git#v0.2.0"
```

自定义 profile 使用其实际名称。桌面版的 `desktop` profile 由桌面应用专有管理，
应使用桌面插件页或桌面应用自带的命令行入口；系统单独安装的 `dsh` 不能管理它。
会话可以由 Web 与桌面版共享，但插件应分别安装到实际使用的 profile。

从源码构建：

```sh
npm ci --ignore-scripts
npm test
npm pack
```

发布前执行测试和构建，并提交更新后的 `dist/`。CI 会检查运行文件与源码构建结果是否一致。

插件没有安装时执行的构建脚本，也不需要 API Key。PDF 提取需要本机安装 Poppler 的 `pdftotext`。
其官方 peer 依赖固定为 `0.2.1-rc.2`，便于复现验证；升级 Harness 后应重新检查兼容性。

## 配置

默认无需额外配置。可以在当前 profile 的 `cordis.patch.yml` 覆写：

```yaml
- id: web-fetch-fakeip
  name: dsh-web-fetch-fakeip/runtime
  config:
    dohUrl: https://dns.alidns.com/resolve
    dnsTimeoutMs: 8000
    fakeIpRanges:
      - 198.18.0.0/15
      - fdfe:dcba:9876::/64
    maxResponseBytes: 5000000
    maxBodyChars: 100000
    timeoutMs: 30000
    maxRedirects: 5
    userAgent: deepseek-harness/fakeip
    pdfCommand: pdftotext
    maxPdfBytes: 20000000
    maxPdfPages: 100
    pdfTimeoutMs: 15000
```

`dohUrl` 必须为 HTTPS，且不含用户名、密码或 URL 片段。
也可以使用支持 DNS JSON API 的 `https://cloudflare-dns.com/dns-query`，
前提是它在你的网络中可达。A/AAAA 两类查询都必须成功；没有某类记录是正常的空答案，
但该类查询超时或 SERVFAIL 会使本次抓取失败。

插件不会设置进程级代理或系统 DNS。如果你已经配置 `HTTP_PROXY` / `HTTPS_PROXY`，
官方抓取器仍按其代理策略工作，代理请求不会进入本插件的 DNS 回退。

## PDF 文字提取

直接让 Harness 对 PDF 的 HTTPS 地址调用 `web_fetch`，它会接收带 `[第 N 页]` 标记的普通正文。
PDF 在本机 `pdftotext` 子进程中解析，不上传到第三方解析服务，不保存临时 PDF 文件。
支持 `application/pdf`、`application/x-pdf`，以及 `.pdf` 地址返回的通用二进制下载类型。

默认 PDF 下载上限为 20 MB，最多提取前 100 页、100000 字符；超出页数或文字上限时，
返回结果带 `truncated: true`。PDF 必须完整下载，超过下载上限直接报错，不解析截断的字节。
单次提取最多 15 秒，且仍受整个 WebFetch 的 30 秒时限限制。HTML 和文本仍使用原有的 5 MB 上限。

无法提取文字的扫描件 / 图片 PDF 会明确提示需要 OCR；这个版本没有自动 OCR。
加密、需要密码、损坏的 PDF 会给出对应提示。多栏、表格等排版以 Poppler 提取结果为准，
不等同于视觉排版或表格结构识别。

如果找不到 `pdftotext`，安装系统的 Poppler 工具包，或将 `pdfCommand` 配为该可执行文件的完整路径。
该配置只接受程序路径，参数由插件固定，通过参数数组启动，不经过 shell。

## 验证与排障

重启后让 Harness 对之前报 `WEB_BLOCKED_URL` 的公网网址调用 `web_fetch`。
真实内网地址（例如 `http://127.0.0.1/`）应继续报 `WEB_BLOCKED_URL`。

开发者可运行实际联网验证：

```sh
npm run smoke
node scripts/smoke.mjs https://github.com/
node scripts/smoke.mjs https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf
```

该脚本强制目标域名的系统 DNS 返回 fake-IP，再使用真实 DoH 和官方抓取器完成请求，
不会改动系统 DNS。自动化测试使用隔离的 DNS/HTTP 传输及真实的本地 PDF 提取器，验证地址固定、每跳校验、
私网拦截、NAT64、超时、取消、PDF 页数与字符截断、扫描件提示和下载限制。

如果从 `WEB_BLOCKED_URL` 变成连接超时，说明还需要检查 OpenClash 对真实 IP 连接的分流。
依赖域名分流的部署可能需要启用 HTTP/TLS 域名嗅探；DoH 的可达性也需要保证。
本插件无法证明透明代理最终出口与本地校验地址一致；需要严格出口隔离时，
仍应在代理或防火墙限制内网和元数据地址访问。

默认识别 IPv4 池 `198.18.0.0/15` 和 IPv6 池 `fdfe:dcba:9876::/64`；其他 fake-IP 池可通过
`fakeIpRanges` 显式配置。该配置仅触发 DoH 回退，DoH 返回的地址仍必须通过完整公网校验。
不会自动修改 OpenClash 配置、停止现有 Harness 进程或替换用户已有的网络设置。

## 卸载

在插件页关闭或移除 `dsh-web-fetch-fakeip` 组合包并重启，内置提供方会恢复。
如果手工添加过上面的 profile 覆写，也应删除该覆写。

## 实现依据

- [官方解析器注入接口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/web/web-fetch-http/src/provider.ts)
- [官方地址校验策略](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/web/web-fetch-http/src/network.ts)
- [上游同类问题](https://github.com/deepseek-ai/deepseek-harness/discussions/5202)

地址校验策略来自上述固定版本，按 MIT 许可证保留于 `src/vendor/address-policy.ts`，
许可全文及来源见 `THIRD_PARTY_NOTICES.md`。
