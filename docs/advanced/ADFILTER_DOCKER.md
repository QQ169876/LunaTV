# 去广告版：镜像怎么给别人 & 怎么安全同步上游

面向不太熟 Docker 的场景说明，照抄命令即可。所有命令中的 `lunatv:adfilter-latest`
是本机构建出来的去广告镜像标签（对应源码提交 `6cd5e04`）。

## 一、镜像现在在哪里

**只在你的服务器本地**，没有上传到任何公开仓库，所以别人直接 `docker pull` 是拉不到的。
在服务器上 `docker images` 能看到：

```
lunatv    6.6.4-adfilter-6cd5e04   308MB
lunatv    adfilter-latest          308MB   # 同一个镜像的通用标签
```

想让别人用上，有三种办法，按省事程度排序。

### 办法 1：打包成文件给他（不需要任何账号）

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

### 办法 2：推到 Docker Hub / GHCR（别人一条命令就能拉）

需要一个 Docker Hub 账号（或 GitHub 账号用 GHCR）：

```bash
docker tag lunatv:adfilter-latest 你的用户名/lunatv:adfilter-6.6.4
docker login                                        # 输入账号密码
docker push 你的用户名/lunatv:adfilter-6.6.4
```

对方只需要：

```bash
docker pull 你的用户名/lunatv:adfilter-6.6.4
docker run -d --name moontv --restart always -p 3000:3000 \
  -e USERNAME=admin -e PASSWORD=改成自己的密码 \
  你的用户名/lunatv:adfilter-6.6.4
```

### 办法 3：把源码给他，让他自己构建

```bash
git clone -b feat/server-side-ad-filter https://github.com/QQ169876/LunaTV.git
cd LunaTV
docker build -f Dockerfile.adfilter -t lunatv:adfilter .
```

`Dockerfile.adfilter` 和仓库自带的 `Dockerfile` 唯一区别是给构建阶段加了
`ENV NODE_OPTIONS=--max-old-space-size=1536`，避免 2GB 内存的小机器构建时把内存吃满。
内存 ≥4GB 的机器用哪个都行。

> 构建完记得在后台「去广告」里打开开关（见 SERVER_AD_FILTER.md）；
> 想让 TV / 第三方播放器也走服务端过滤，再打开「对外播放地址改写为本站代理」。

## 二、同步上游会不会覆盖我的改动

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
