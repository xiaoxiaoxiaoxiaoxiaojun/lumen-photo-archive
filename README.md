# LUMEN 摄影档案

一个使用 Google 登录的私人摄影网站：

- 网站前端部署在 GitHub Pages。
- 原图存储在私有 Cloudflare R2 桶中。
- D1 保存作品名称、地点、分类等信息。
- 所有访客登录后都可以查看。
- 只有服务器配置的主人 Google 账号可以上传和删除。
- 每张照片最大 20MB，总存储达到 9GB 后停止上传，避免超过 R2 的 10GB 免费层。

## 权限设计

前端会为访客隐藏上传、删除入口，但真正的权限检查在 Cloudflare Worker：

- `GET /api/photos`：任意已登录 Google 用户。
- `POST /api/photos`：仅 `OWNER_GOOGLE_EMAIL` 对应的用户。
- `DELETE /api/photos/:id`：仅 `OWNER_GOOGLE_EMAIL` 对应的用户。
- R2 不公开；浏览器拿到的是 6 小时有效的签名图片地址。
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

## Cloudflare 后端部署

1. 创建 D1 数据库和 R2 桶：

```bash
npx wrangler login
npx wrangler d1 create lumen-photo-db
npx wrangler r2 bucket create lumen-photos
```

2. 把 D1 命令返回的 ID 填入 `cloudflare-api/wrangler.jsonc`。

3. 创建三个加密变量：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --config cloudflare-api/wrangler.jsonc
npx wrangler secret put SESSION_SECRET --config cloudflare-api/wrangler.jsonc
npx wrangler secret put OWNER_GOOGLE_EMAIL --config cloudflare-api/wrangler.jsonc
```

4. 将 GitHub Pages 的来源写入 Worker 普通变量 `ALLOWED_ORIGIN`，例如 `https://your-name.github.io`。来源只包含协议和域名，不包含仓库路径。

5. 初始化并部署：

```bash
npx wrangler d1 migrations apply lumen-photo-db --remote --config cloudflare-api/wrangler.jsonc
npm run deploy:api
```

## Google 登录配置

在 Google Cloud 创建 Web OAuth 客户端，并将 GitHub Pages 来源加入“已获授权的 JavaScript 来源”。把生成的客户端 ID 存入 Cloudflare 的 `GOOGLE_CLIENT_ID`。

Google 客户端密钥不需要放进网页，也不应提交到 GitHub。

## GitHub Pages 部署

1. 创建 GitHub 仓库并推送 `main` 分支。
2. 在仓库 `Settings → Pages` 中把 Source 设为 `GitHub Actions`。
3. 在 `Settings → Secrets and variables → Actions → Variables` 新增：
   - `API_BASE_URL`：已经部署的 Worker 地址，例如 `https://lumen-photo-api.example.workers.dev`
4. 重新运行 `Deploy LUMEN to GitHub Pages` 工作流。

工作流配置位于 `.github/workflows/pages.yml`。
