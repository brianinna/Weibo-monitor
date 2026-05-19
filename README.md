# Weibo Monitor

一个 Windows 优先的微博用户监控原型。程序通过用户本机 Edge/Chrome 的远程调试端口连接浏览器，尽量复用用户已有的微博登录态。

## 快速开始

```powershell
npm install
npm run ui
```

打开本地配置界面后可以完成：

- 选择 Edge/Chrome。
- 选择浏览器 Profile，例如 `Default`、`Profile 1`、`Profile 2`。
- 检测微博是否已登录。
- 打开微博登录页，引导用户登录。
- 添加需要监控的微博用户主页或 UID。
- 保存配置并手动检查一次。

## 命令

- `npm run ui`：打开本地配置界面。
- `npm run init`：生成 `config.json`。
- `npm run check`：只检查一次。
- `npm run monitor`：循环监控。

## 微信通知（WeClaw）

项目已支持通过 [fastclaw-ai/weclaw](https://github.com/fastclaw-ai/weclaw) 的本地 HTTP API 推送微信通知。WeClaw 启动后默认监听：

```text
http://127.0.0.1:18011/api/send
```

配置界面里的“微信通知”区域可以完成：

- 启动 `weclaw start -f`，首次启动时在日志里显示扫码登录信息。
- 配置 WeClaw API 地址。
- 配置一个或多个 WeClaw 绑定；每个绑定对应一个 WeClaw 实例、一个 API 地址和一个接收人 ID。
- 发送测试消息。
- 监控到新微博后先保存到本地库和截图，再发送文字和微博截图。

如果使用 `npm run monitor` 后台命令，程序会额外启动一个本机截图服务，默认地址为 `http://127.0.0.1:18789`，供 WeClaw 下载本地截图后转发到微信。使用 `npm run ui` 时会复用 UI 自带的截图接口。

## Linux/Docker 部署

推荐 Linux 服务器使用 Docker Compose 部署。Compose 会启动多个容器：

- `weibo-monitor`：内置 Chromium、Xvfb 和 noVNC，不依赖宿主机安装 Chrome。
- `weclaw` / `weclaw-2`：从 WeClaw 官方 GitHub release 构建本地镜像，每个实例独立扫码登录一套微信。

启动：

```bash
docker compose up -d --build
```

默认端口只绑定到服务器本机 `127.0.0.1`。在本地电脑通过 SSH 隧道访问：

```bash
ssh -L 18787:127.0.0.1:18787 -L 18790:127.0.0.1:18790 user@server
```

然后打开：

- 配置界面：`http://127.0.0.1:18787`
- 容器浏览器：`http://127.0.0.1:18790/vnc.html?autoconnect=true&resize=scale`

首次部署流程：

1. 查看 WeClaw 日志并用微信扫码：

   ```bash
   docker compose logs -f weclaw
   docker compose logs -f weclaw-2
   ```

配置页也可以直接点每个绑定里的“显示扫码日志”，扫码后让接收通知的微信给对应机器人发一条消息，再点这个绑定里的“识别最近发信人”。默认 `weclaw` 使用 `http://weclaw:18011/api/send`，`weclaw-2` 使用 `http://weclaw-2:18011/api/send`。

2. 打开配置界面，修改监控用户。
3. 每个 WeClaw 绑定扫码登录后，用接收通知的微信给对应机器人发一条消息，例如 `1`。
4. 在对应绑定上点击“识别最近发信人”，自动填入接收人 ID。
5. 在“异常告警管理员”里选择一个已填好接收人 ID 的 WeClaw 绑定，用来接收监控失败告警。
6. 启用 WeClaw 通知，发送测试消息。

持久化数据在：

```text
docker-data/weibo-monitor
docker-data/weclaw
docker-data/weclaw-2
docker-data/weclaw-logs
```

不要把 WeClaw API 直接暴露到公网；它可以主动发送微信消息。需要远程访问时优先使用 SSH 隧道或带认证的反向代理。

## 浏览器 Profile

大多数用户使用 `Default` 即可。Chrome 多账号用户通常会有 `Profile 1`、`Profile 2` 等目录，配置界面会自动枚举这些 Profile，并尽量读取浏览器里的显示名。

如果选择了错误的 Profile，程序会检测不到微博登录态。切换到你平时已经登录微博的 Profile 后，再点击“检测登录”。

## 重要限制

默认使用独立的受控浏览器数据目录：

`%LOCALAPPDATA%\WeiboMonitor\ChromeProfile`

这不会影响你日常 Chrome 的窗口、标签页和 Profile。首次使用需要在这个受控浏览器里登录一次微博。

Chrome/Edge 已经打开时，如果强行复用日常浏览器 Profile，Windows 下再次执行带 `--remote-debugging-port` 的启动命令通常只会复用已有进程，调试端口不会生效。

要复用当前登录态，最稳的流程是：

1. 使用默认受控目录，让工具自己启动 Chrome。
2. 在打开的 Chrome 里登录一次微博。
3. 回到配置界面点击“检测登录”。

如果你一定要复用日常 Chrome Profile，需要先关闭所有 Chrome 窗口，再让工具启动对应 Profile。

## 打包方向

后续建议用 `pkg` 或 `nexe` 打包 Node CLI，再用 Inno Setup/NSIS 做一键安装包。当前依赖是 `playwright-core`，不会下载 Chromium，安装包体积比完整 Playwright 小很多。

安装包建议创建两个快捷方式：

- “微博监控配置”：启动 `npm run ui` 对应的打包入口。
- “微博监控后台”：启动 `npm run monitor` 对应的打包入口。

默认 CDP 调试端口为 `18788`。程序会先检查 `http://127.0.0.1:18788/json/version`，确认这是 Chrome DevTools endpoint 后直接复用；如果端口不存在，就按当前配置的 `userDataDir` 和 `profileDirectory` 启动浏览器。

## Windows 便携包测试

先生成便携包：

```powershell
npm run build:portable
```

输出目录：

```text
dist\weibo-monitor-win
```

输出压缩包：

```text
dist\weibo-monitor-win.zip
```

在 Windows 上解压后双击：

- `start-ui.cmd`
- 或 `start-monitor.cmd`

便携包内带 `node.exe`、源码和依赖，不需要目标机器预装 Node.js，但仍需要机器上已安装 Chrome。
