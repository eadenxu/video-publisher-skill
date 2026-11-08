# 给 redbooker 的最小真稿接入交接

这是文档，不是执行许可。本助手不读取、不接管、不上传摄影 V2.1 原片或 3:4 封面。内容权利和最终发布授权由执行者当次亲核。2026-11-08 的维护验收不能当成生产安全。

## 已安装的入口

mini 上独立安装、未激活共享技能的目录是：

```text
/Users/eadenxu/.local/share/video-publisher/releases/7e7eccc/video-publisher
```

commit `7e7eccc72a5d3d127893b2a370f02c9ab069dcd5`。工作目录就是这个目录，里面有 `SKILL.md`。后续只含文档的 commit 没有装到这台机器；下面的命令以这份已安装源码为准。不要改 PATH，不要切到共享正式版，不要用维护空间或旧的 bonus 配置。

```bash
cd /Users/eadenxu/.local/share/video-publisher/releases/7e7eccc/video-publisher
```

## 生产配置必须新建

不要设置 `VIDEO_PUBLISHER_CONFIG` 为：

```text
$HOME/.config/video-publisher-maintenance/config.json
```

那份文件的 `purpose` 是 `maintenance-account-observation`。生产 `validate` 对它退出码 1，create、resume、inspect 在读内容包和媒体之前拒绝它。也不要使用任何旧 bonus 占位配置，不要写假素材路径。

生产配置放在 Skill 目录之外。未设置 `VIDEO_PUBLISHER_CONFIG` 时，路径是 `$HOME/.config/video-publisher/config.json`。该文件若已存在，停下来，不要用 `onboard` 覆盖。要新建时，把变量指到一个还不存在的生产配置路径，再执行。

字段只填执行者已经向用户确认的值：

- `--source-dir`：用户确认存在的视频目录，绝对路径。本交接不代填目录。
- `--available-platform`：用户确认拥有的平台。只做小红书时只传 `xiaohongshu`。
- `--platform`：默认发布子集；省略时，全部 `--available-platform` 成为默认平台。
- `--originality-policy`：用户没有明确确认每条视频都可声明原创时，不要传 `all_videos_original`。省略该旗标时，已安装 CLI 写入 `ask_each_run`。
- 抖音话题、B站自动标签、YouTube 分类只在确认拥有对应账号后才传。

```bash
export VIDEO_PUBLISHER_CONFIG="$HOME/.config/video-publisher/config.json"
node scripts/config.mjs onboard \
  --source-dir "/ABSOLUTE/DIR/CONFIRMED/BY/USER" \
  --available-platform xiaohongshu \
  --platform xiaohongshu \
  --locale zh-CN \
  --originality-policy ask_each_run
node scripts/config.mjs validate
```

`validate` 必须退出码 0，且 `onboardingRequired` 为 false、`productionReady` 为 true，才可以进入发布准备。`warnings` 非空时退出码也是 1。

## 账号绑定的来源

先在同一工作目录跑：

```bash
node scripts/v2/publisher.mjs --operation diagnose-binding
```

它调用 `profiles()` 和 `listTaskSpaces()`，不读视频、封面或内容包，不写 job。退出码 0 不是账号已验证，也不是 READY。`profileId` 复制输出里的 `id`。已观察过的 id 可以字面就是 `Profile 2`；`name` 为 `AI` 时，`AI` 只是标签，不能填进 `--profile-id`。

显示名和账号 ID 由执行者从当前登录的创作者首页读取，并经用户确认后再写入。2026-11-08 12:36 的维护首页读到过 GrokBot看AI 与 4221066816；那是当时的页面证据，不是已经填好的生产配置。

```bash
node scripts/config.mjs bind-account xiaohongshu \
  --profile-id "ID_FROM_PROFILES" \
  --profile-label "LABEL_NOT_THE_ID" \
  --display-name "NAME_CONFIRMED_BY_USER" \
  --account-id "ID_CONFIRMED_BY_USER"
node scripts/config.mjs validate
```

`bind-account` 要求已经完成生产 onboarding，且 `xiaohongshu` 已在 `availablePlatforms`。它不改 Ego 全局默认 Profile。

## 同一内容包、同一个 Job

内容包放在 Skill 目录之外。`videoPath` 是本地绝对路径。小红书至少要有真实话题 `xhsTopics`。要用已有 3:4 封面时，包里写 `cover.uploadCustomCover: true` 和 `cover.vertical3x4Path`。文件必须是执行者已经能正常读取的材料。本助手不读取这些文件。

状态目录用新的生产目录，不要指向 `$HOME/.local/state/video-publisher-maintenance`。未传 `--state-root` 时，已安装代码使用 `$HOME/.video-publisher/v2-jobs`。

`ask_each_run` 时，只有用户确认当前这一条视频的原创权利之后，才加上 `--confirm-original-rights`。该旗标不写入配置。

首次创建，Job id 只选定一次：

```bash
node scripts/v2/publisher.mjs \
  --package /ABSOLUTE/package.json \
  --platforms xiaohongshu \
  --job-id SAME-JOB \
  --state-root /ABSOLUTE/production-state \
  --operation create \
  --no-cleanup-stale-spaces \
  --confirm-original-rights
```

中断后沿用同一内容包、同一 `--job-id`、同一 `--state-root`。结果不明时不新建 Job，不换 id：

```bash
node scripts/v2/publisher.mjs \
  --package /ABSOLUTE/package.json \
  --platforms xiaohongshu \
  --job-id SAME-JOB \
  --state-root /ABSOLUTE/production-state \
  --operation resume \
  --reuse-space \
  --no-cleanup-stale-spaces \
  --confirm-original-rights
```

已是 READY 时，resume 拒绝并且不创建另一份草稿。同一 Job 的只读复查是 `--operation inspect`。故意再做一版才使用 `--operation repost --confirm-new-copy`，并使用新的未占用 id。

## READY 之后只换封面

现有草稿必须已经 READY。新包保持同一视频、标题、简介、标签和其他设置，只改封面文件，并保持 `cover.uploadCustomCover: true`。

```bash
node scripts/v2/publisher.mjs \
  --package /ABSOLUTE/package-with-new-cover.json \
  --platforms xiaohongshu \
  --job-id SAME-JOB \
  --state-root /ABSOLUTE/production-state \
  --operation replace-cover
```

它复用该 Job 已记录的任务空间，不重新上传视频。已发布内容的在线修改不在这条命令里。

## 当前守卫和未验边界

这些门在源码里存在。2026-11-08 的维护实跑没有验收它们，不能写成生产通过：

- 账号：创建、恢复、inspect 都会再读页面。显示名和账号 ID 对不上，或身份未证明，就在上传前停止。
- 原创：`ask_each_run` 且没有当次 `--confirm-original-rights` 时，变更页面的命令停止。
- 封面：只有 `cover.uploadCustomCover` 为 true 才上传已有封面。小红书要 3:4 路径。新鲜读回成功才算封面通过；点击回执不算。
- AI 声明、合集、正文：内容包请求后必须新鲜读回。12:36 管理页正文里这三项是 `not-observed`。
- 定时：`xhsSchedule` 只校验 Asia/Shanghai 时间。它不授权点击 `发布` 或 `定时发布`。12:36 只看到定时文字，功能未验。
- 查重：任务级去重不是平台历史去重。`diagnose-dedup` 不打开笔记管理，也不能返回 READY。平台历史在实页读回之前保持未验证。
- 最终发布：inspect 仍为 READY、页面守卫已武装、`blockedAttempts` 为 0、`finalPublishClicked` 为 false 之后，才可以单独授权 `releaseForConfirmedPublish()`。维护命令不会调用它。

`ready`、`accepted`、`accountVerified`、`publishable` 在维护结果里保持 false。页面是否关闭仍是 `not-observed`。
