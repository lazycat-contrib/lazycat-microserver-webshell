# 移动端新增标签自动同步到 PC

## 场景元数据
- 状态：active
- 类型：multi-device / lifecycle
- 真实依赖：真实 Provider、persistent agent、PTY、既有终端 WebSocket、Chrome 桌面窗口和移动设备模拟窗口。
- 相关模块和源码入口：`runtime/static/workspace/README.md`、`activity_controller.js`、`refresh_controller.js`、`workspace_api.js`、`state_apply_controller.js`、`tab_view.js`；`runtime/static/global-runtime.js` 仅做依赖接线。
- 区别：06 验证单端新建/改名；18 验证另一端新建/关闭标签后，本端在不刷新页面的条件下发现并应用成员变化。

## 触发条件
PC 保持三个专用测试标签，在其中一个终端持续输出；移动端创建新标签。PC 不导航、不刷新、不主动调用刷新接口，等待现有 activity 请求发现新 pane 后更新标签列表，再验证移动端关闭该新标签也能同步。保留测试账号已有标签，只清理本场景创建的标签和输出进程。

## 用户可见问题
移动端创建成功，但 PC 标签列表不变，必须刷新页面或重新进入才看到新增标签。

## 预防的回归
- 前台下一轮 activity 发现 pane 集合变化后按需同步；没有新增 WebSocket 或额外轮询。
- PC 当前标签、输入焦点、现有 tab button、pane shell、Canvas DOM 和终端连接保持原实例。
- PC 持续输出和真实输入回显不中断，画布保持可见，不因远端新增标签重播已有终端。
- 未变化的 activity 响应不触发完整 workspace GET；并发提示合并，迟到响应不能覆盖新目标或本地操作。
- 关闭远端非活动标签同步删除，对本端活动终端无影响。
- 同步来的新标签可以在 PC 上激活并完成真实 PTY 输入回显；测试主动切换标签的 History API URL 变化不等于页面重载。

## 修复前基线
2026-09-07（本地时间），使用 `DISPLAY=:0` 和上述当前 Vite 静态映射命令，在真实容器测试环境运行失败；产物 `artifacts/2026-09-06T16-49-10-714Z/`。移动端创建 tab 成功，PC 在 12 秒上限内未出现该标签。4 次既有 activity 响应均包含新增 pane，全部 HTTP 200，但 PC 的完整 workspace GET 数量为 0、页面导航为 0；734 次 DOM 采样及截图记录 PC 保持旧标签列表。trace 确认没有服务端 API/网络错误导致遗漏。

补充边界后的运行 `artifacts/2026-09-06T16-56-02-309Z/` 卡在 `browserContext.newPage`，超过 120 秒仍无 login/open、HTTP 或场景事件；已检查 X display 可用并只终止该轮拥有的 Chrome 进程。`environment.txt`、`error.txt`、JSONL 留下启动失败信息，页面尚未建立所以无截图/trace；这属于浏览器启动前置故障，不是终端场景失败，原场景断言保持不变后重跑。

图形模式后续再次卡在首次建页；同一 Chrome 的无头建页/脚本执行检查立即成功，因此最终使用 `HEADLESS=1` 运行原有真实 Provider/PTY/WS 测试路径。没有通过放宽应用断言处理浏览器启动故障。

补充“点击同步来的新标签并真实输入，再返回原标签”的验收后，无头 Chrome 的 `artifacts/2026-09-06T17-00-07-482Z/` 已完成新增/输入/删除（2 次 workspace GET、8 次 activity，原 Canvas/焦点保持），但原 `framenavigated` 计数把两次主动 tab 切换的 History API URL 变化误算为页面重载。trace 只有准备阶段的两个 document GET/goto，截图可见新标签真实 marker；因此改用主 frame 的真实导航请求计数并额外断言 `performance.timeOrigin` 不变，继续严格验证“不重载页面”，没有放宽 tab/Canvas/焦点/WS 不变量。

## 已确认根因
activity 的 `updatePaneActivity()` 遇到本地没有的 pane ID 会直接跳过；`refreshActivity()` 仅更新已知 pane，没有比较成员集合或通知 workspace refresh，因此另一端新建的数据虽已到达 PC，标签结构仍不会更新。完整 state apply 又会重建已有按钮/布局并重新激活当前标签，直接复用会打断交互；需增加保留本端交互的成员同步模式。

## 实施方案
仅修改前端：复用 activity 响应检测完整 pane ID 集合变化；由 workspace refresh owner 合并按需状态请求；state apply 提供保留本端交互和未变化 DOM 的成员同步模式。新增请求不得新建 interval/WS，失败由后续既有 activity 再检测。后端协议不变，不能据此保证仅改名/排序的远端操作被独立发现。

已实施文件：`workspace/activity_controller.js`、`refresh_controller.js`、`workspace_api.js`、`state_apply_controller.js`、`tab_view.js` 和 global runtime 的依赖接线。activity 只检测有效完整集合；refresh 对观察变化合并请求，API 提供当前目标本地 action fence，state apply 提供已应用 revision，以拒绝迟到响应。成员模式保留当前 active tab/pane、历史访问列表、旧按钮/布局/Canvas，并仅在活动成员确实变化时进行必要布局和连接协调。对应 Node 测试、模块 README 与架构导航同步更新。

状态应用后的 fit/connect RAF 使用 target generation、活动 tab 和对象 identity 检查；后台成员同步不能使当前 tab 尚未执行的有效首次 fit/connect 失效。`pending-frame-baseline.txt` 记录用例在过严 revision fence 下的失败，修正后 `pending-frame-after.txt` 通过。HTTP 快照仍以 revision/mutation fence 拒绝旧响应，这与 DOM 回调 identity 的生命周期边界不同。

## 验证预期
移动端创建的新 tab 在 PC 前台 12 秒上限内出现（默认 activity 周期 4 秒，加网络预算），关闭也在同一上限内同步；网络证据必须显示 activity 已包含目标 pane。无页面 reload、无新增物理 WS、无现有 Canvas/按钮重建和焦点抢占；稳定后的两个 activity 响应期间不增加 workspace GET。

## 运行命令和环境变量
```sh
npm run build
WEBSHELL_LOCAL_STATIC_DIR="$PWD/build/runtime/static" \
node tests-auto/run-playwright.mjs tests-auto/18-cross-device-tab-sync/test.mjs
```
认证由 `tests-auto/.env` 或运行环境提供。默认真实 Chrome 前台方式需有效 DISPLAY；本机可用 `DISPLAY=:0`。通过 `WEBSHELL_TEST_URL` 选择获授权的目标。PC/移动表示浏览器设备，不代表目标一定是 `client:` 终端。

本次最终验证命令：
```sh
HEADLESS=1 WEBSHELL_LOCAL_STATIC_DIR="$PWD/build/runtime/static" \
node tests-auto/run-playwright.mjs tests-auto/18-cross-device-tab-sync/test.mjs
node --test tests/*_test.mjs
go test ./...
```

## 产物与失败诊断
`artifacts/<run-id>/` 保存截图、trace、JSONL、两端终端时间线、DOM 稳定性采样和 activity/workspace 请求摘要。只记录结构 ID 与请求数量，不记录账号、token、cookie 或真实 PTY 内容。失败必须结合服务端返回的新 pane ID、PC DOM、请求时序、Canvas 和连接状态调查。

## 已知限制
Chrome 移动设备模拟不等同于实体 Android/iOS 设备。默认测试环境提供普通容器 Unified 链路；若没有可用 `client:` 目标，不宣称这一兼容链路已验证。没有 WS 推送时，同步时效受既有 activity 周期与页面可见性影响；只重命名/排序且 pane 集合未变化，不在本次保证范围内。

## 验证结果

- 2026-09-07：用户确认本次跨端标签同步场景手动测试通过；设备型号和目标类型未单独记录。下述自动化验证范围保持原记录。
- 修复前真实场景失败见 `2026-09-06T16-49-10-714Z/`；首轮图形 Chrome 修复后在 `2026-09-06T16-51-46-924Z/` 通过新增/删除同步、持续输出、焦点/Canvas/连接保持。
- 最终源码及增强断言在 `artifacts/2026-09-06T17-05-52-320Z/` 通过。Chrome 桌面 1440x900、移动模拟 390x844，真实容器 Provider/agent/PTY/Unified WS，映射当前 Vite 产物。
- 7 次 activity 响应仅触发 2 次 workspace GET（新增、删除各一次）；稳定后的两个 activity 响应不新增 GET。主 document 导航 0，`performance.timeOrigin` 不变；新增阶段 1,076 次、删除阶段 31 次采样均保持本端 active tab、焦点、原按钮/shell/Canvas identity、画布可见和物理 socket 数量。同步来的新标签可真实输入回显，原终端持续输出完成。
- 目标场景 console/pageerror/API fatal 错误为 0；截图包括 `pc-synced-new-tab.png`、`pc-new-tab-usable.png`，详细证据在 `add-invariants.json`、`cross-tab-sync.json`、两端 trace 和 terminal timeline。
- 受影响真实场景 06、07、01 分别在 `2026-09-06T17-03-36-362Z/`、`2026-09-06T17-03-55-965Z/`、`2026-09-06T17-04-14-707Z/` 通过；07 按原用例主动注入一次 503 并验证恢复，其余无 fatal error。运行输出保存为 `artifacts/related-browser.txt`。
- `node --test tests/*_test.mjs`：459 通过，0 失败，见 `artifacts/node-all-final.txt`。覆盖成员比较、错误/旧 activity、请求合并、新观察补取、本地 action/目标切换/dispose、初次 bootstrap、保留 DOM/输入及有效 pending RAF。
- `go test ./...`：通过，见 `artifacts/go-all-final.txt`。Go 改动仅为静态模块 guard 跟随新增的 refresh fence 参数，并增加 revision/mutation/被动应用入口检查；后端运行代码和 API 没有修改。
- `npm run build` 与 `git diff --check` 通过；18 可由 test-all 自动发现。Agent 未运行完整 18 场景、实体手机或 `client:` PC 终端服务路径；本轮未打包或部署。
