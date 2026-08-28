# LUMEN 摄影档案

一个公开只读、主人专属管理的摄影网站：

- 网站前端部署在 GitHub Pages。
- 原图存储在私有 Backblaze B2 桶中。
- D1 保存作品名称、地点、分类等信息。
- 任何获得网站链接的访客都可以直接查看，无需登录。
- 只有服务器配置的主人 Google 账号通过专用管理入口登录后可以上传和删除。
- 每张照片最大 20MB，总存储达到 9GB 后停止上传，避免超过 B2 的 10GB 免费额度。

## 权限设计

公开页面不显示登录、上传或删除入口，真正的写入权限检查在 Cloudflare Worker：

- `GET /api/photos`：公开只读。
- `POST /api/photos`：仅 `OWNER_GOOGLE_EMAIL` 对应的用户。
- `PATCH /api/photos/:id`：仅主人可编辑作品信息。
- `DELETE /api/photos/:id`：仅 `OWNER_GOOGLE_EMAIL` 对应的用户。
- `POST /api/photos/batch-delete`：仅主人可批量删除，单次最多 100 张。
- B2 存储桶不公开；浏览器拿到的是 6 小时有效的签名图片地址。
- 跨站写操作只接受 `ALLOWED_ORIGIN` 指定的 GitHub Pages 来源。

因此，访客即使修改网页或手动调用接口，也不能获得上传、删除权限。

## 本地检查

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run build:github
npm run test:security
npx tsc --noEmit
```

## 免费服务组合

- GitHub Pages：托管网站页面。
- Cloudflare Workers + D1：验证主人 Google 登录、保存作品信息并执行写入权限。
- Backblaze B2：10GB 免费文件存储；注册不要求银行卡。

## Backblaze B2 配置

1. 在 Backblaze 注册 B2 账号并验证邮箱。
2. 创建一个私有存储桶，记下存储桶名称和 S3 Endpoint，例如 `s3.us-west-004.backblazeb2.com`。
3. 为这个存储桶创建专用 Application Key，授予读取、写入和删除文件权限。记下 Key ID 与只显示一次的 Application Key。

不要把 Application Key 写入网页代码、GitHub 仓库或聊天消息。

## Cloudflare 后端部署

1. 创建 D1 数据库：

```bash
npx wrangler login
npx wrangler d1 create lumen-photo-db
```

2. 把 D1 命令返回的 ID 填入 `cloudflare-api/wrangler.jsonc`。

3. 创建七个加密变量：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --config cloudflare-api/wrangler.jsonc
npx wrangler secret put SESSION_SECRET --config cloudflare-api/wrangler.jsonc
npx wrangler secret put OWNER_GOOGLE_EMAIL --config cloudflare-api/wrangler.jsonc
npx wrangler secret put B2_KEY_ID --config cloudflare-api/wrangler.jsonc
npx wrangler secret put B2_APPLICATION_KEY --config cloudflare-api/wrangler.jsonc
npx wrangler secret put B2_ENDPOINT --config cloudflare-api/wrangler.jsonc
npx wrangler secret put B2_BUCKET_NAME --config cloudflare-api/wrangler.jsonc
```

4. 将 GitHub Pages 的来源写入 Worker 普通变量 `ALLOWED_ORIGIN`，例如 `https://your-name.github.io`。来源只包含协议和域名，不包含仓库路径。

5. 初始化并部署：

```bash
npx wrangler d1 migrations apply lumen-photo-db --remote --config cloudflare-api/wrangler.jsonc
npm run deploy:api
```

## Google 登录配置

在 Google Cloud 创建 Web OAuth 客户端，并将 GitHub Pages 来源加入“已获授权的 JavaScript 来源”。把生成的客户端 ID 存入 Cloudflare 的 `GOOGLE_CLIENT_ID`。Google 登录只用于主人管理入口，普通访客无需登录。

Google 客户端密钥不需要放进网页，也不应提交到 GitHub。

## GitHub Pages 部署

1. 创建 GitHub 仓库并推送 `main` 分支。
2. 在仓库 `Settings → Pages` 中把 Source 设为 `GitHub Actions`。
3. 在 `.github/workflows/pages.yml` 中确认 `VITE_API_BASE_URL` 是已部署的 Worker 地址。
4. 重新运行 `Deploy LUMEN to GitHub Pages` 工作流。

工作流配置位于 `.github/workflows/pages.yml`。
