# WebShell 真机自动测试

## 测试机

- 地址示例：`https://lightos.debug123.heiyu.space/webshell/?name=devos-core%40cloud.lazycat.lightos.entry&tab=tab-4`
- 测试账号、密码和认证信息只通过 `tests-auto/.env` 或运行环境注入；脚本在页面出现登录页时自动填写并登录，已有登录态时不会重复登录。
- 示例 URL 中的实例名可能随测试机状态变化。运行器会先读取 `/webshell/api/instances`；指定实例对当前账号不可用时，自动选择第一个 `running` 实例，并把选择结果写入事件日志。
- 测试使用本机安装的 Google Chrome，并以有界面模式打开两个独立窗口。运行环境需要可用的 X11 `DISPLAY`。
- 运行器会在打开页面前只向目标测试 origin 授予 Chrome 的 `local-network-access` 权限，避免 Chrome 150+ 把测试站点的真实 Provider WebSocket 误拦截为未授权的本地网络访问；不会全局关闭浏览器安全特性。
- 默认使用 `lzc-os/onbox-tester/e2e/node_modules` 中已安装的 Playwright；也可通过 `PLAYWRIGHT_NODE_PATH` 指定包含 `@playwright/test` 的 Node 模块目录。
- 独立使用本项目时可先在 `tests-auto` 执行 `npm install`，运行器会优先使用本目录的依赖。

## 目录约定

运行器在认证完成后开始 trace，结束时通过 `artifact-redaction.mjs` 清理文本产物及 trace 中的账号、密码、Cookie、Authorization 和 token/ticket；保留截图、布局与终端事件证据。初始化失败也会关闭已创建的 browser/context 并留下失败产物。

每组用例一个独立目录，目录内至少包含一个 `test.mjs` 和一个 `README.md`。脚本产生的截图、JSONL 点击事件日志、trace、presentation probe/timeline 和错误摘要写入该组的 `artifacts/`，不会混入源码。

## 运行全部用例

```sh
cd lazycat-microserver-webshell
./tests-auto/test-all.sh
```

总入口会先构建当前 Vite 前端，并为每个 required 场景应用独立 profile：普通场景映射 `build/runtime/static`，`04-terminal-viewport` 在未显式覆盖时使用其要求的 iPhone User-Agent，`11-service-worker-retirement` 清空本地静态映射以启用 Service Worker。required 场景报告 skip 会使总入口失败，不能显示为 PASS。

只审计自动发现和最终 profile、但不构建或启动浏览器：

```sh
TESTS_AUTO_DRY_RUN=1 ./tests-auto/test-all.sh
```

仅在调用方已经完成构建时可设置 `TESTS_AUTO_SKIP_BUILD=1`；正式发布门禁默认不得跳过构建。

## 展示模式

需要向他人展示自动化过程时，使用显式的前台 Chrome 入口。它会强制关闭无头模式，先构建 Vite 前端，并默认把当前工作区的 `build/runtime/static` 映射到测试页面：

```sh
./tests-auto/run-visible.sh
```

不传参数时运行终端几何稳定性用例；也可以指定某个用例目录或 `test.mjs` 文件：

```sh
./tests-auto/run-visible.sh tests-auto/09-terminal-interaction-jitter
```

如需依次展示全部用例，使用 `--all`：

```sh
./tests-auto/run-visible.sh --all
```

运行环境需要可用的 X11 `DISPLAY`。测试结束后 Chrome 窗口会自动关闭；测试失败时可在对应用例的 `artifacts/` 目录查看截图、事件日志和 trace。

配置文件：

- `tests-auto/.env` 是所有真机用例的统一配置入口，可提供测试 URL、账号、密码和显示模式；认证内容不得写入 README、脚本、日志或提交，默认 `TEST_FOREGROUND=1`。
- `test-all.sh` 和 `run-playwright.mjs` 都会自动读取该文件，因此直接运行单个测试入口也遵循同一套配置。
- `TEST_FOREGROUND=1`（或 `true/on/yes`）会在桌面前台显示两个 Chrome 窗口；`TEST_FOREGROUND=0`（或 `false/off/no`）使用无头浏览器后台运行。
- 命令行中显式设置的同名变量优先于 `.env`；`HEADLESS=1` 仍可作为兼容方式强制无头运行。

可选环境变量：

- `WEBSHELL_TEST_URL`：覆盖默认 WebShell 地址。
- `WEBSHELL_CLIENT_TEST_URL`：场景 17 的真实 `client:` PC 终端地址。该场景只运行桌面窗口；可从实例列表选择获授权的 running 客户端，找不到时明确报 `CLIENT_TARGET_UNAVAILABLE`，绝不回退为普通容器。其他场景继续使用 `WEBSHELL_TEST_URL`。
- `HEADLESS=1`：兼容旧调用方式，强制无头模式；真机回归默认不要设置。
- `TEST_ROUNDS`：PC/移动端交替点击轮数，默认 `3`。
- `PW_CHANNEL`：Chrome channel，默认 `chrome`。
- `WEBSHELL_LOCAL_STATIC_DIR`：可选。设置为 `build/runtime/static` 的绝对路径后，测试仍使用测试机的真实 API/WebSocket/PTY，但把入口 HTML 和版本化静态资源映射到当前 Vite 产物，并阻止 Service Worker；用于验证尚未安装的前端改动。运行前先执行 `npm run build`。
- `WEBSHELL_MOBILE_USER_AGENT`：可选。仅覆盖移动测试窗口的 User-Agent，用于在桌面 Chrome 中进入 Android/iOS 平台专属 visualViewport、键盘或宿主分支。
- `WEBSHELL_MOBILE_DEVICE_SCALE_FACTOR`：可选。设置移动测试 context 的 device scale factor，用于高 DPR Canvas/hold 诊断；默认值为 `1`，不代表产品运行时 DPR 配置。
- `WEBSHELL_CAPTURE_TERMINAL_TIMELINE`：可选。设置为 `1` 时在页面初始化前打开 debug timeline，便于在 artifacts 中保存结构化终端事件；默认关闭。
- `WEBSHELL_ENABLE_INITIALIZATION_PERFORMANCE`：可选。仅用于真机回归，设置为 `1` 时在页面初始化前开启初始化性能指标并自动开启调试模式；默认关闭。

总入口按目录名排序后逐组串行执行；任何一组失败会立即停止并返回非零退出码。运行器把 pageerror、console error、WebShell API 请求失败和版本化 asset 请求失败统一纳入 fatal 门禁；只对 source URL 明确为 `/favicon.ico` 的浏览器自动装饰请求，以及登录门户等场景外非 API/asset 请求失败记录 info，避免日志显示与实际门禁语义不一致。

2026-09-04 最近一次发布前全量使用 `HEADLESS=1 ./tests-auto/test-all.sh`，16/16 required 场景通过；唯一 error 事件为 `07-workspace-retry` 主动注入且随后恢复的单次 503，其他场景无 fatal/cleanup error 或 skip。
