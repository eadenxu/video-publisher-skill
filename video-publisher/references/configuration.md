# 配置与首次使用

仅在首次配置、修复配置、修改默认平台或新增账号时读取。个人配置必须放在 Skill 目录之外。

## 配置检查

配置路径按以下顺序解析：

```text
VIDEO_PUBLISHER_CONFIG
$XDG_CONFIG_HOME/video-publisher/config.json
$HOME/.config/video-publisher/config.json
```

运行：

```bash
node scripts/config.mjs status
```

缺失、空文件、无效结构、旧版迁移失败或信息不完整时，输出 `onboardingRequired: true`。完成配置前不要打开创作者页面。

`warnings` 不会抹掉已经完成的配置，但发布前要修复或明确覆盖无效的源视频目录。

## 首次配置顺序

按顺序询问，避免让用户回答不使用平台的问题：

1. 用户实际拥有并可以登录哪些账号：小红书、抖音、B站、视频号、YouTube；至少选择一个。
2. 哪些已拥有平台作为默认发布平台；默认建议全部已拥有平台，也可选择非空子集。
3. 默认本地视频目录。
4. 常用文案风格和 recurring tags。
5. 仅在拥有对应账号时询问：
   - 抖音默认 topics；
   - B站允许保留的平台自动 tags；
   - YouTube 默认分类、语言和可见性。
6. 是否每个视频都能真实声明原创。没有明确确认时使用 `ask_each_run`。
7. 建议检查/上传并发为 `4/4`，默认使用平台封面；用户可以修改。

写入前用简短清单复述全部选择并取得确认。

## 写入配置

`--available-platform` 表示用户实际拥有的账号，`--platform` 表示默认发布子集，两个参数都可重复：

```bash
node scripts/config.mjs onboard \
  --source-dir "/absolute/video/directory" \
  --available-platform xiaohongshu \
  --available-platform douyin \
  --platform xiaohongshu \
  --platform douyin \
  --locale zh-CN \
  --copy-style "清楚、自然、具体、不夸张" \
  --recurring-tag "教程" \
  --douyin-topic "教程" \
  --originality-policy ask_each_run \
  --check-concurrency 4 \
  --upload-concurrency 4
```

未提供 `--platform` 时，全部 `--available-platform` 自动成为默认平台。

可选参数：

```text
--bilibili-auto-tag <精确标签>          可重复
--youtube-category <页面可见分类>
--youtube-language <页面可见语言>
--youtube-visibility <private|unlisted|public>
--upload-existing-cover-by-default
```

只传递已经向用户确认的值。随后运行：

```bash
node scripts/config.mjs validate
```

只有命令成功且 `onboardingRequired` 为 `false` 才继续发布。

## 小红书 Profile 与账号绑定

绑定写在 Skill 目录之外的私有配置里。它不修改 Ego 的全局默认 Profile，也不使用 `ego-browser import --profile`。`profileId` 必须来自只读 `profiles()` 的实际 id；`--profile-label` 只给人看，不会传给 `taskSpace`。

```bash
node scripts/config.mjs bind-account xiaohongshu \
  --profile-id "PASTE_PROFILE_ID_FROM_DIAGNOSE_BINDING" \
  --profile-label "PASTE_HUMAN_LABEL_NOT_USED_AS_ID" \
  --display-name "PASTE_ACCOUNT_DISPLAY_NAME" \
  --account-id "PASTE_ACCOUNT_ID"
```

先跑 `node scripts/v2/publisher.mjs --operation diagnose-binding`。它不需要视频、封面、内容包、已存在的 sourceDirectory，也不需要先完成绑定。`config validate` 仍会因不存在的 sourceDirectory 失败，那只挡住后续发布，不挡住这次只读发现。诊断输出里的 `profileId` 复制自 `profiles()` 的 `id`，`name` 只是显示标签。id 可以就是字面值 `Profile 2`，不能因为它像标签就丢掉。诊断结果不是账号已验证，也不是 READY。未配置绑定时，原有平台行为不变。配错或页面身份对不上时，创建、恢复和 inspect 都会在上传前停止。

## 无媒体维护配置

账号页观察使用单独的配置，不走 `onboard`，也不改生产配置。允许的键只有 `schemaVersion`、`purpose`、`locale`、`accounts`。`purpose` 必须是 `maintenance-account-observation`。文件里不能出现 `sourceDirectory`、`onboarding`、`declarations`、`availablePlatforms` 或 `defaultPlatforms`。因此它不需要素材目录、生产 onboarding 或原创政策。示例形状在 `examples/maintenance-config.example.json`，里面是占位身份，不是可执行账号。

用新的 `VIDEO_PUBLISHER_CONFIG` 指向 Skill 目录和生产配置之外的新文件。下面这条命令会创建该文件；目标已存在时拒绝覆盖。`Profile 2` 的 `labelLikeProfileId` 由命令写成 `true`。

```bash
export VIDEO_PUBLISHER_CONFIG="$HOME/.config/video-publisher-maintenance/config.json"
node scripts/config.mjs init-maintenance-account \
  --profile-id "Profile 2" \
  --profile-label "AI" \
  --display-name "GrokBot看AI" \
  --account-id "4221066816"
node scripts/config.mjs validate-maintenance
```

`validate-maintenance` 成功时退出码 0，输出 `maintenanceReady: true`、`productionReady: false`、`onboardingRequired: true`、`errors: []`、`warnings: []`。它不创建维护状态目录，不拿 publisher 锁，不调用 Ego。同一文件再跑 `node scripts/config.mjs validate` 必须退出码 1。create、resume、inspect 以及其他生产命令读到这份配置时，在读取内容包和媒体之前拒绝。`maintenance-diagnose` 读到生产配置时，在 Ego 之前拒绝。身份缺字段，或命令行的 `--profile-id`、`--display-name`、`--account-id`、非空 `--profile-label` 与文件不一致，也在 Ego 之前拒绝。

检查通过后才按 `references/scripts.md` 运行 `maintenance-diagnose`。截图没有可选旗标，页面打开后自动写入 `--maintenance-root`：`<空间名>-home.png`，以及首页匹配后的 `<空间名>-notes.png`。记录文件是 `<空间名>.json`。`--close-maintenance-space` 是不带值的布尔旗标，只关闭同一次命令创建且名称相符的句柄。

## 新增平台

不要为了新增账号重新运行 `onboard`，因为它会重建完整配置。用户确认账号后使用非破坏命令：

```bash
node scripts/config.mjs add-platform douyin \
  --default \
  --douyin-topic "教程"
```

YouTube 示例：

```bash
node scripts/config.mjs add-platform youtube \
  --default \
  --youtube-category "科学与技术" \
  --youtube-language "中文（简体）" \
  --youtube-visibility private
```

省略 `--default` 时，该平台只在显式选择时使用。B站可以重复传入 `--bilibili-auto-tag`。

## 优先级和隐私

```text
当前用户指令（限 availablePlatforms）
> 内容包显式字段
> 个人配置
> Skill 通用默认值
```

- 当前请求不能静默加入 `availablePlatforms` 之外的平台。
- `all_videos_original` 只表示长期内容事实，不代表允许最终发布。
- `ask_each_run` 要求每次 mutation 前获得当前视频确认并添加 `--confirm-original-rights`。
- 配置可以保存平台可用性、文案偏好、默认 tags、原创政策、并发和封面偏好。
- 不保存 cookies、token、密码、单次视频路径或最终发布指令。
- 不手工编辑 schema；使用 CLI 写入，程序负责校验、权限和旧版本迁移。
