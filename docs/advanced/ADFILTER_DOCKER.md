# 去广告版：镜像怎么给别人 & 怎么安全同步上游

面向不太熟 Docker 的场景说明，照抄命令即可。

## 零、一句话版：别人怎么拉（已发布到 GitHub 官方镜像仓库）

镜像已经推到 **GHCR（GitHub Container Registry）并设为公开**，任何人不需要账号、
不需要登录，直接一条命令就能拉：

```bash
docker pull ghcr.io/qq169876/lunatv:latest
```

拉下来直接跑：

```bash
docker run -d --name moontv --restart always -p 3000:3000 \
  -e USERNAME=admin -e PASSWORD=改成自己的密码 \
  ghcr.io/qq169876/lunatv:latest
```

浏览器打开 `http://他的机器IP:3000` 即可。

**可用的标签**（都是同一个镜像，只是名字不同）：

| 标签 | 用途 |
| --- | --- |
| `ghcr.io/qq169876/lunatv:latest` | 最新去广告版，最省事就用这个 |
| `ghcr.io/qq169876/lunatv:adfilter-latest` | 同上，名字里带 adfilter 好辨认 |
| `ghcr.io/qq169876/lunatv:6.6.4-adfilter-2c07712` | 锁死版本（对应源码提交 `2c07712`），想固定不变用这个 |

包页面：<https://github.com/users/QQ169876/packages/container/package/lunatv>

发布页（Release，含更新说明与离线镜像包）：
<https://github.com/QQ169876/LunaTV/releases/tag/v6.6.4-adfilter>

> 注意：镜像是**按当前源码编译好的成品**，不含任何配置。
> 拉完还要在后台「去广告」里打开开关（见 SERVER_AD_FILTER.md）；
> 想让 TV / 第三方播放器也走服务端过滤，再打开「对外播放地址改写为本站代理」。

## 一、还有另外两种办法（离线 / 自己编译）

### 办法 1：打包成文件给他（断网/内网也能装）

在你的服务器上导出（约 1-3 分钟，文件 100MB 出头）：

```bash
docker save lunatv:adfilter-latest | gzip -1 > lunatv-adfilter.tar.gz
```

把文件传给他（U 盘、网盘、scp 都行），他在自己机器上：

```bash
docker load -i lunatv-adfilter.tar.gz      # 导入，导入后镜像名仍是 lunatv:adfilter-latest
docker run -d --name moontv --restart always -p 3000:3000 \
  -e USERNAME=admin -e PASSWORD=改成自己的密码 \
  lunatv:adfilter-latest
```

然后浏览器打开 `http://他的机器IP:3000`。

### 办法 2（已完成）：推到 GHCR，别人一条命令就能拉

上面第零节就是这个办法，已经做好了。以后代码更新、重新构建出新镜像之后，
在服务器上执行这几条就能把最新版本推上去（需要一个有 `write:packages`
权限的 GitHub 个人令牌，令牌只在自己机器上用，不要给别人）：

```bash
echo "<你的GitHub令牌>" | docker login ghcr.io -u qq169876 --password-stdin

docker tag lunatv:adfilter-latest ghcr.io/qq169876/lunatv:adfilter-latest
docker tag lunatv:adfilter-latest ghcr.io/qq169876/lunatv:6.6.4-adfilter-<新提交号>
docker tag lunatv:adfilter-latest ghcr.io/qq169876/lunatv:latest

docker push ghcr.io/qq169876/lunatv:adfilter-latest
docker push ghcr.io/qq169876/lunatv:6.6.4-adfilter-<新提交号>
docker push ghcr.io/qq169876/lunatv:latest
docker logout ghcr.io
```

仓库名必须**全小写**（`qq169876` 不能写成 `QQ169876`），否则 docker 会报
`repository name must be lowercase`。

令牌在 GitHub → Settings → Developer settings → Personal access tokens 里生成，
勾选 `write:packages` 和 `delete:packages` 即可。

### 办法 3：把源码给他，让他自己构建

```bash
git clone -b adfilter https://github.com/QQ169876/LunaTV.git
cd LunaTV
docker build -f Dockerfile.adfilter -t lunatv:adfilter .
```

`Dockerfile.adfilter` 和仓库自带的 `Dockerfile` 唯一区别是给构建阶段加了
`ENV NODE_OPTIONS=--max-old-space-size=1536`，避免 2GB 内存的小机器构建时把内存吃满。
内存 ≥4GB 的机器用哪个都行。

> 构建完记得在后台「去广告」里打开开关（见 SERVER_AD_FILTER.md）；
> 想让 TV / 第三方播放器也走服务端过滤，再打开「对外播放地址改写为本站代理」。

## 二、同步上游会不会覆盖我的改动

> 🌿 本仓库的分支约定：**默认分支 = `adfilter`（去广告版，对外展示）**，
> **`main` 保持与上游完全一致**（干净的上游代码，专门用来跟上游同步）。
> 所以平时改动都提交在去广告分支上，不要往 main 上合，这样上游发新版时 main 可以直接快进同步，不会打架。

**不会自动覆盖。** 我们的改动已经用 `git commit` 提交进分支了，合并上游更新是
"把两边各自的改动叠在一起"，只有同一个文件的同一段都被改了才会冲突；冲突时 git 会
**停下来等你处理**，不会静默把你的代码冲掉。

### 我们改了哪些文件（冲突只可能出现在这些文件附近）

| 文件 | 作用 |
| --- | --- |
| `src/lib/m3u8-ad-filter.ts` | 服务端过滤引擎（新增文件） |
| `src/lib/server-play-url.ts` | 播放地址改写成本站代理（新增文件） |
| `src/app/api/proxy/m3u8/route.ts` | 代理接口里加过滤、allowCORS 分流 |
| `src/app/api/detail/route.ts` | 详情接口按客户端改写剧集地址 |
| `src/app/api/shortdrama/parse/route.ts` | 短剧解析地址改写 |
| `src/components/CustomAdFilterConfig.tsx` | 后台开关界面 |
| `src/lib/admin.types.ts` | 新增配置项类型 |
| `src/lib/__tests__/m3u8-ad-filter.test.ts` | 单元测试（新增文件） |
| `docs/advanced/SERVER_AD_FILTER.md`、`CUSTOM_AD_FILTER.md`、本文件 | 文档 |

`README.md` 我们只加了一行文档链接。上游如果大改 README，合并时这一行可能冲突，
手选一下即可（几秒钟的事）。**建议：我们自己的说明都写在 `docs/advanced/` 下的独立文件里，
不要在上游 README 里大段写东西**，这样以后同步基本不会打架。

### 安全同步流程（推荐）

第一次先加一次上游地址（以后不用重复）：

```bash
git remote add upstream https://github.com/SzeMeng76/LunaTV.git
git fetch upstream
```

以后每次想跟上游更新：

```bash
git fetch upstream                 # 只下载，不改你的代码
git merge upstream/main            # 把上游改动合进当前分支
```

- 没冲突：自动合并完成；
- 有冲突：`git status` 会列出冲突文件，打开后看到 `<<<<<<<` / `=======` / `>>>>>>>`
  标记，保留你要的那一段（一般是两边都留：上游的新代码 + 我们的过滤逻辑），
  然后 `git add <文件>`，再 `git commit` 完成合并。

合并完记得重新构建镜像并换容器：

```bash
docker build -f Dockerfile.adfilter -t lunatv:adfilter-latest .
docker stop moontv-2 && docker rename moontv-2 moontv-2-old
docker run -d --name moontv-2 --restart always -p 3010:3000 <原来的 -e 参数> lunatv:adfilter-latest
# 确认新容器正常后再 docker rm moontv-2-old
```

### 千万别做的操作（会真的丢改动）

- `git reset --hard` / `git checkout -- .`：丢弃本地未提交的修改；
- `git checkout upstream/main -- .` 或 `git checkout upstream/main -- src`：用上游文件覆盖自己的；
- `git pull --force`、`git push --force`：强制覆盖远端；
- 删掉仓库重新 fork：本地分支没了，改动也就没了（除非推到远端过）。

**保险做法：改动随时 commit，并且 push 到自己的远端仓库（origin）。**
只要推上去过，本地玩坏了也能 `git clone` 回来。

## 三、常用检查命令

```bash
docker images | grep lunatv          # 看本地有哪些镜像
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'   # 看容器跑的是哪个镜像
docker logs --tail 50 moontv-2       # 看容器日志
docker stats --no-stream moontv-2    # 看占用
```

## 四、发一个新的 Release（每次更新镜像后）

GitHub 仓库右侧的 Releases 就是"版本发布页"，别人在这里能一眼看到镜像地址、
启动命令和这次改了什么。当前版本：**[v6.6.4-adfilter](https://github.com/QQ169876/LunaTV/releases/tag/v6.6.4-adfilter)**。

发新版的流程（在服务器上做，PAT 需要有 `repo` 权限）：

```bash
# 1. 构建并推镜像
docker build -f Dockerfile.adfilter -t lunatv:adfilter-latest .
docker tag lunatv:adfilter-latest ghcr.io/qq169876/lunatv:latest
docker tag lunatv:adfilter-latest ghcr.io/qq169876/lunatv:adfilter-latest
docker tag lunatv:adfilter-latest ghcr.io/qq169876/lunatv:6.6.4-adfilter-<新提交号>
echo $TOKEN | docker login ghcr.io -u qq169876 --password-stdin
docker push ghcr.io/qq169876/lunatv --all-tags

# 2. 导出离线包（可选，作为 Release 附件）
docker save lunatv:adfilter-latest | gzip -1 > /root/docker-images/lunatv-adfilter-<新提交号>.tar.gz

# 3. 创建 Release（body 里写镜像地址、启动命令、改动说明）
curl -X POST https://api.github.com/repos/QQ169876/LunaTV/releases \
  -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d '{"tag_name":"v6.6.4-adfilter-<新提交号>","name":"v6.6.4-adfilter 去广告版",
       "target_commitish":"main","draft":false,"prerelease":false,"body":"见上一版格式"}'

# 4. 上传附件（用第 3 步返回的 upload_url）
curl -X POST "<upload_url>?name=lunatv-adfilter-<新提交号>.tar.gz" \
  -H "Authorization: token $TOKEN" -H "Content-Type: application/gzip" \
  --data-binary @/root/docker-images/lunatv-adfilter-<新提交号>.tar.gz
```

> Release 的正文格式参考现在的 v6.6.4-adfilter：先写"这个版本是什么"，
> 再给 `docker pull` / `docker run` / compose 片段，然后是"拉完还要做一步"（后台开关），
> 最后是本次改动清单和文档链接。
