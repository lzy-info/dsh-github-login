# dsh-github-login

GitHub OAuth Device Flow 登录插件，供 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 使用。它提供登录、状态检查、退出和已认证 GitHub REST API 工具。

## 功能

- `github_login_start`：启动 GitHub Device Flow，返回验证网址和一次性用户码。
- `github_login_poll`：在网页授权后轮询一次并完成登录。
- `github_auth_status`：检查当前登录账号；不会返回令牌。
- `github_logout`：删除本机保存的 GitHub 令牌。
- `github_api`：使用当前账号调用 `api.github.com` 的 REST API。

访问令牌只保存到本机用户目录下的 `~/.config/dsh-github-login/credentials.json`（可通过 `DSH_GITHUB_TOKEN_PATH` 覆盖），不会进入工具返回值、日志或浏览器页面。

## 创建 GitHub OAuth App

1. 打开 GitHub 的 **Settings → Developer settings → OAuth Apps → New OAuth App**。
2. 填写任意应用名和主页，例如 `http://127.0.0.1`。
3. 创建后复制 **Client ID**。
4. 在 OAuth App 设置中勾选 **Enable Device Flow**。

Device Flow 不需要在插件中保存 Client Secret。Client ID 是公开标识符，不是密码。

## 安装

```bash
dsh plugin --profile web add github:lzy-info/dsh-github-login#main
```

重启 Harness。然后设置 Client ID（二选一）：

```powershell
$env:DSH_GITHUB_CLIENT_ID = '你的 Client ID'
```

也可以在 Harness profile 的 `cordis.patch.yml` 里写入：

```yaml
- insert:
    - id: dsh-github-login
      name: dsh-github-login
      config:
        clientId: '你的 Client ID'
        scopes: 'read:user user:email'
```

## 登录流程

在 Harness 中让 Agent 依次调用 `github_login_start`，打开返回的 `verification_uri` 并输入 `user_code`，再调用 `github_login_poll`。如果返回 `authorization_pending`，等待 `interval` 秒后再次调用 `github_login_poll`。

首次登录后可以使用：

```json
{"path":"/user/repos?per_page=10","method":"GET","body":null}
```

`github_api` 只接受相对路径，并强制请求发送到 `api.github.com`。请只授予 OAuth App 实际需要的 scopes；默认是 `read:user user:email`。

## 本地检查

```bash
npm run check
npm test
```

## 兼容性

插件面向 DeepSeek Harness `>=0.1.5 <0.3.0`。Harness 仍处于 developer preview，接口可能随版本变化。

## 许可

MIT
