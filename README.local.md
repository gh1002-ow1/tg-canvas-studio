# TG Canvas 本地配置说明

## 当前配置状态

**域名**: `https://canvas.dgl.us.ci`
**Bot**: `@userver002_bot`
**工作区**: `/home/joker/.openclaw`

## 启动步骤（systemd 常驻）

### 1. 运行时配置文件

```bash
sudo mkdir -p /etc/tg-canvas
sudo cp /home/joker/.openclaw/workspace/skills/openclaw-tg-canvas/.env /etc/tg-canvas/.env
sudo chown root:root /etc/tg-canvas/.env
sudo chmod 600 /etc/tg-canvas/.env
```

### 2. 启动服务

```bash
sudo systemctl enable --now tg-canvas.service
sudo systemctl enable --now cloudflared-canvas.service
sudo systemctl enable --now ttyd-canvas.service
```

### 3. 验证服务

```bash
# 检查本地服务
curl http://localhost:3721/health

# 检查域名访问
curl https://canvas.dgl.us.ci/health
```

## 搜索功能

### API 端点

```
GET /fs/search?q=关键词&type=name|content|all&ext=md,json&limit=50&token=JWT
```

**参数说明**:
- `q`: 搜索关键词（必需）
- `type`: 搜索类型
  - `name`: 仅文件名
  - `content`: 仅文件内容
  - `all`: 两者都搜索
- `ext`: 文件扩展名过滤（可选），如 `md,json`
- `limit`: 最大结果数（可选，默认 50）
- `token`: JWT 认证令牌（必需）

**响应示例**:
```json
{
  "query": "telegram",
  "type": "name",
  "count": 5,
  "results": [
    {
      "name": "telegram-id-index.md",
      "path": "docs/telegram-id-index.md",
      "type": "file",
      "matchType": "name",
      "matchLines": null
    }
  ]
}
```

### 文件内搜索 API

在编辑器中使用 CodeMirror 的 `getSearchCursor` API：

```javascript
const cursor = editorInstance.getSearchCursor(query);
while (cursor.findNext()) {
  // 找到匹配项
}
```

## 快捷命令功能

### 配置文件

`miniapp/commands.json` - 定义 Quick Commands 按钮

**命令格式**:
```json
{
  "commands": [
    {
      "id": "unique-id",
      "type": "navigate",  // 或 "terminal"
      "label": "显示名称",
      "icon": "📁",
      "description": "简短描述",
      "path": "workspace/docs",  // navigate 类型需要
      "command": "git status"    // terminal 类型需要
    }
  ]
}
```

**命令类型**:
- **navigate**: 跳转到 Files 页面并打开指定路径
- **terminal**: 打开终端并执行预设命令

### 可视化编辑器

在首页 Quick Commands 区域点击 **✏️ Edit** 按钮打开编辑器。

**功能**:
1. **添加命令**: 点击 ➕ Add Command，填写表单
2. **编辑命令**: 点击命令右侧的 Edit 按钮
3. **删除命令**: 点击 Delete 按钮
4. **调整顺序**: 使用 ↑ ↓ 按钮上下移动
5. **保存**: 点击 💾 Save Changes 保存到配置文件
6. **重置**: 点击 🔄 Reset 恢复默认命令

**API**:
```
GET /api/commands?token=JWT      # 获取命令列表
POST /api/commands?token=JWT     # 保存命令列表
```

### 默认命令

| 图标 | 名称 | 类型 | 说明 |
|------|------|------|------|
| 🏠 | OpenClaw | navigate | 打开 OpenClaw 目录 |
| 💼 | Workspace | navigate | 打开工作区 |
| 📚 | 文档 | navigate | 打开文档目录 |
| 🔍 | Git 状态 | terminal | `git status` |
| 📝 | Git 日志 | terminal | `git log --oneline -10` |

## 配置文件

### /etc/tg-canvas/.env

```env
BOT_TOKEN=<telegram_bot_token>
ALLOWED_USER_IDS=<telegram_user_id1,telegram_user_id2>
JWT_SECRET=<32+_bytes_random_secret>
PUSH_TOKEN=<32+_bytes_random_secret>
PORT=3721
TG_CANVAS_URL=https://canvas.example.com
WORKSPACE_ROOT=/home/joker/.openclaw
ENABLE_OPENCLAW_PROXY=true
OPENCLAW_GATEWAY_TOKEN=<openclaw_gateway_token>
OPENCLAW_PROXY_HOST=127.0.0.1
OPENCLAW_PROXY_PORT=18889
JWT_TTL_SECONDS=900
INIT_DATA_MAX_AGE_SECONDS=300
```

### Cloudflare config.yml

```yaml
tunnel: canvas-tunnel
credentials-file: /home/joker/.cloudflared/b21ee3c8-b436-46d0-8d54-cd9cdc0124b2.json

ingress:
  - hostname: canvas.dgl.us.ci
    service: http://localhost:3721
  - service: http_status:404
```

## 常用命令

### 生成 JWT Token

```bash
set -a && source /etc/tg-canvas/.env && set +a

node -e "
const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET;
function signJwt(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 900;
  const tokenPayload = { ...payload, iat: now, exp, jti: crypto.randomUUID() };
  const base64url = (input) => Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const head = base64url(JSON.stringify(header));
  const body = base64url(JSON.stringify(tokenPayload));
  const sig = base64url(crypto.createHmac('sha256', JWT_SECRET).update(head + '.' + body).digest());
  console.log(head + '.' + body + '.' + sig);
}
signJwt({ userId: '6269883894' });
"
```

### 测试搜索 API

```bash
TOKEN=$(<上面生成的 token>)
curl "https://canvas.dgl.us.ci/fs/search?q=telegram&type=name&limit=5&token=$TOKEN" | jq '.'
```

### 推送内容到 Canvas

```bash
set -a && source /etc/tg-canvas/.env && set +a

# 推送 HTML
tg-canvas push --html "<h1>Hello Canvas</h1>"

# 推送 Markdown
tg-canvas push --markdown "# Hello\n\nThis is a test"

# 推送 A2UI
tg-canvas push --a2ui @./a2ui.json
```

### 清理缓存

```bash
# 清除浏览器缓存
# 在 Telegram 中：设置 → Data and Storage → Clear Cache

# 重启服务
sudo systemctl restart tg-canvas.service
sudo systemctl restart cloudflared-canvas.service
sudo systemctl restart ttyd-canvas.service
```

## 故障排查

### Canvas 按钮不显示

1. 完全关闭 Telegram
2. 清除缓存
3. 重新打开 Telegram
4. 发送 `/start` 到 Bot
5. 或使用直接链接：`https://t.me/userver002_bot/Canvas`

### 域名无法访问

```bash
# 检查 DNS
dig canvas.dgl.us.ci

# 检查 Tunnel 状态
cloudflared tunnel info canvas-tunnel

# 检查服务
systemctl status tg-canvas.service
systemctl status cloudflared-canvas.service
systemctl status ttyd-canvas.service
```

## 多 Bot / 多实例

可以启动多个实例。每个实例至少要拆分这些配置：
- `BOT_TOKEN`
- `ALLOWED_USER_IDS`
- `PORT`（canvas 端口）
- ttyd 端口（例如 7681/7682/...）
- `PUSH_TOKEN`、`JWT_SECRET`
- 独立域名与 cloudflared ingress

推荐做法：
- 运行时配置：`/etc/tg-canvas/inst-a.env`, `/etc/tg-canvas/inst-b.env`
- systemd 实例化服务：`tg-canvas@inst-a.service`, `ttyd-canvas@inst-a.service`, `cloudflared-canvas@inst-a.service`
- 每个 Bot 用对应域名执行一次 `setChatMenuButton`

### 搜索返回 0 结果

1. 确认 `WORKSPACE_ROOT` 配置正确
2. 确认文件不是隐藏文件（以 `.` 开头）
3. 内容搜索只支持文本文件
4. 检查 JWT token 是否有效

### 文件内搜索无法使用

1. 确保加载了 `searchcursor.js` 插件
2. 检查浏览器控制台是否有错误
3. 刷新页面清除缓存
4. 检查 CodeMirror 版本是否兼容

## Git 提交

```bash
cd /home/joker/.openclaw
git add workspace/skills/openclaw-tg-canvas/
git add workspace/docs/tg-canvas/
git commit -m "feat(canvas): 添加搜索功能"
```

## 相关文档

- [开发记录](../../docs/tg-canvas/tg-canvas-development.md)
- [Skill 文档](./SKILL.md)
- [服务器日志](../../logs/tg-canvas.log)
