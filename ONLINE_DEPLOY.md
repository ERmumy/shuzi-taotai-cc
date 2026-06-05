# 把游戏上线到互联网

这个项目已经可以作为一个 Node.js 网站部署。上线后，玩家不需要在同一个 WiFi，直接打开网站、创建房间、扫码或复制链接即可加入。

## 推荐方式：Render

1. 把这个文件夹上传到 GitHub。
2. 打开 Render，选择 New > Blueprint。
3. 选择这个 GitHub 仓库，Render 会自动读取 `render.yaml`。
4. 创建服务后等待部署完成。
5. 部署成功后，打开 Render 给你的 `https://...onrender.com` 地址。

## 如果手动创建 Web Service

配置如下：

```txt
Environment: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /healthz
```

环境变量可选：

```txt
BASE_URL=https://你的域名
```

没有设置 `BASE_URL` 也可以运行，服务器会自动根据访问网站的域名生成房间邀请链接和二维码。绑定自定义域名后，建议设置 `BASE_URL`，这样二维码里永远是正式域名。

## 注意

- 免费服务休眠后，第一次打开可能需要等几十秒。
- 房间数据保存在服务器内存里，服务重启后房间会消失。
- 如果要长期稳定运营，后续可以加数据库或 Redis 来保存房间状态。
