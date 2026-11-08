# Production And Diagnostic Commands

All paths below are relative to the Skill directory. Resolve the directory containing `SKILL.md` and use it as the working directory before running any command.

## Contents

- Configuration and package validation
- Production orchestrator and recovery
- One-platform diagnosis
- Result contract and local tests

## Configuration

Inspect onboarding state before any other command:

```bash
node scripts/config.mjs status
node scripts/config.mjs validate
```

Run onboarding as documented in `references/configuration.md`. Set `VIDEO_PUBLISHER_CONFIG` to test or use an alternate per-user configuration file.

## Package Validation

生产入口会在浏览器工作前统一校验全部所选平台。只有排查某个平台的内容包时，才单独运行：

```bash
node scripts/check-package.mjs <platform> /absolute/path/to/package.json
```

Supported platform keys:

```text
xiaohongshu
douyin
bilibili
wechat_channels
youtube
```

Validation checks the local video path, platform-specific title limits, required platform fields, package-supplied topic/tag data, YouTube audience/visibility/license, and requested cover paths and ratios. Xiaohongshu uses a weighted 20-character limit: every ASCII code point, including English letters, digits, spaces, and half-width punctuation, counts as 0.5, while every non-ASCII Unicode code point counts as 1. Preserve the original title whenever this weighted length is within the limit. Douyin requires a valid MP4/M4V/MOV duration readable from ISO BMFF metadata; unknown duration fails closed with `DOUYIN_DURATION_UNVERIFIED`. No local duration ceiling is imposed; an explicit creator-page rejection is recorded as `PLATFORM_REJECTED_ASSET`.

## Production Orchestrator

Windows PowerShell / cmd: use `scripts\run-safe-platforms.cmd` with the same arguments. The portable equivalent is `node scripts/v2/publisher.mjs`. The `.sh` wrapper requires Bash. Production sends UTF-8 scripts through Node stdin, avoiding PowerShell quoting and text-pipeline encoding issues.

Ego output is buffered before decoding so multibyte characters may span stream chunks. UTF-8 is preferred; Windows falls back to GB18030 for the current Chinese Ego Lite CLI. Set `VIDEO_PUBLISHER_EGO_OUTPUT_ENCODING` to a supported TextDecoder encoding for another system code page or to force a known encoding.

```bash
scripts/run-safe-platforms.sh \
  --package /absolute/path/to/package.json \
  --task-suffix task-suffix \
  --platforms xiaohongshu,douyin,bilibili,wechat_channels,youtube
```

位置参数仍然可用：`scripts/run-safe-platforms.sh package.json task-suffix xiaohongshu douyin`。

When onboarding has `declarations.originalityPolicy: all_videos_original`, the runner applies truthful original/self-made declarations without another flag. With the generic `ask_each_run` policy, add `--confirm-original-rights` only after the user confirms the current video; this one-run override is not persisted. Read-only `--inspect-only` never needs either signal.

The platform list is optional; omit it to use configured `defaultPlatforms`. Explicit platform arguments may select any configured `availablePlatforms`. If the second positional argument is a platform key, the task suffix defaults to `manual`.

Read-only inspection:

```bash
scripts/run-safe-platforms.sh \
  /absolute/path/to/package.json \
  task-suffix \
  xiaohongshu bilibili \
  --inspect-only
```

Options:

```text
--package <path>
--platform <name>          (repeatable)
--platforms a,b,c
--task-suffix <name>
--operation <auto|create|resume|inspect|replace-cover|repost|diagnose-binding|diagnose-dedup>
--inspect-only
--replace-cover            replace covers on an existing READY draft; requires --job-id
--confirm-new-copy         required with --operation repost
--confirm-original-rights
--state-root <dir>
--job-id <id>
--check-concurrency <positive integer>
--upload-concurrency <positive integer>
--fresh-space              (default) new Ego space for a new job
--reuse-space              keep the recorded space name; also --no-fresh-space
--force-fresh-space        new space even when resuming an in-progress job
--keep-space               (default) leave this job's draft pages open after READY
--close-on-complete        close this job's spaces after READY; also --close-space / --no-keep-space
--cleanup-stale-spaces     (default) close other ready/inspected job spaces and oil-collect-publish
--no-cleanup-stale-spaces
--cleanup-only             close leftover spaces and exit; package is optional
--cleanup-name <name>      extra exact leftover names, repeatable or comma-separated
--cleanup-prefix <text>    extra leftover name prefixes; never the default publisher prefix
--space-prefix <name>
--space-name <name>        exact space name; single-platform only
--space-suffix <text>      replace the generated unique suffix
```

Space policy: a new job gets a unique space. `running`, `inspecting`, `paused_user`, and `blocked` jobs reuse the recorded space so drafts and receipts stay attached. An implicit rerun of a `READY` job exits with usage error and performs no browser work. After READY, this job's draft pages stay open so the user can click publish. That keep-flag is written to `state.json`. Stale cleanup only closes retired spaces, leftover `oil-collect-publish`, and other `ready`/`inspected` jobs that were explicitly closed with `--close-on-complete`. `--inspect-only` does not close an in-progress or kept job. `--cleanup-only --package` takes the job lock and can close a finished job's current spaces; it never closes an in-progress job. It does not prefix-sweep `video publisher v2 *`. `USER_CONTROL` never closes spaces.

To resume an interrupted generation, repeat the same command with the same `--job-id`, or add `--operation resume`. To inspect a READY draft use `--operation inspect`. To create an intentional second copy use `--operation repost --confirm-new-copy`; omit `--job-id` for a generated new identity, or provide a new unused id. To close leftover spaces without generating: `scripts/run-safe-platforms.sh --cleanup-only`.

## Xiaohongshu account binding, schedule readback, and history dedup

These commands are the only maintained entry. They do not change Ego's global default profile, do not call `import --profile`, and do not pass `--profile` / `--profileId` to `ego-browser nodejs`. Ego scripts do not inherit shell environment variables; the runner writes the binding into the script.

`profileId` must be the `id` returned by `profiles()`. On the observed runtime that field is the profile id and `name` is only the display label, so an id can literally be `Profile 2` while the label is different. Do not swap those fields, and do not reject a listed id because it looks like a label. `taskSpace(name, { profileId })` applies the id only when creating a space. Resume calls `taskSpace(id)` without `profileId` and refuses to open the page unless `listTaskSpaces()` shows that same id on the existing space. A matching space name is not proof of the profile. Create, resume, and inspect each read the live account again; a mismatch or an unproven identity stops before upload.

Discover profile ids before any package, video, cover, source directory, or account binding exists. This command does not read those files and does not write a job, config, or media path. Exit 0 means the two read-only calls returned; `ready`, `accepted`, and `accountVerified` stay false. Copy `profileId` from the record's `id`. `name` is the display label. An empty `listTaskSpaces()` array is only this inventory: it does not prove a matching space is absent, and it does not verify resume. The global default profile is not changed.

```bash
node scripts/v2/publisher.mjs --operation diagnose-binding
```

`scripts/run-safe-platforms.sh --operation diagnose-binding` is the same entry. Do not pass a placeholder package. `--package`, `--job-id`, and `--state-root` are ignored and not written. The command only calls `profiles()` and `listTaskSpaces()`. It does not create, open, switch, or close a space, and it does not open a page or upload. It does receive and print the whole profile list and the whole space list, and it holds the publisher lock while that runs. Copy the returned `profileId`, not the label, into the private config.

`maintenance-diagnose` is not a pure read. It creates one new Ego space named `vp-maint-...` when that exact name is absent, navigates that space only to `https://creator.xiaohongshu.com/new/home` and, after the fresh home text matches the display name and account id, to `https://creator.xiaohongshu.com/new/note-manager`. It writes a record and screenshots under `--maintenance-root` and holds the account-wide publisher lock. It does not open the video publish URL, click, hover, upload, fill a form, claim an existing space, write a production job, or call `releaseForConfirmedPublish`. A name conflict, unknown list shape, or missing profile id stops before `taskSpace`. A home mismatch, login wall, or captcha stops before note-manager and does not create a second space. Controls that are not visible as text are `not-observed`, which is not production acceptance. `ready`, `accepted`, `accountVerified`, and `publishable` stay false. Exit 0 means the new space was created and the home identity text matched, not that a draft is publishable. Public `lite.ego.app` pages describe `useOrCreateTaskSpace` and are a different generation; this command follows the saved 0.6.2.7 `taskSpace` / `newPage` / `goto` / `evaluate` model instead. Navigation is not a claim of zero server-side writes.

The command accepts only a config whose `purpose` is `maintenance-account-observation`. That file has exactly `schemaVersion`, `purpose`, `locale`, and `accounts.xiaohongshu`. It has no `sourceDirectory`, `onboarding`, `declarations`, or platform lists. `node scripts/config.mjs validate-maintenance` must exit 0 with `maintenanceReady: true` and `productionReady: false` before the diagnose command. `node scripts/config.mjs validate` on the same file exits 1. Create, resume, inspect, and the other production commands refuse this file before reading a package or media. A production config is refused by `maintenance-diagnose` before Ego. Write it with `init-maintenance-account` to a new `VIDEO_PUBLISHER_CONFIG` path outside the skill and outside the production config. The shape without a real account is `examples/maintenance-config.example.json`. For profile id `Profile 2`, the stored `labelLikeProfileId` is `true`; the CLI sets that. Do not hand-edit it to `false`.

`validate-maintenance` does not create the maintenance state directory, take the publisher lock, or call Ego. The diagnose command creates `--maintenance-root` only after that check passes. Screenshots are automatic. There is no screenshot flag. After home opens, the file is `<maintenance-root>/<maintenance-space-name>-home.png`. After the home identity matches and note-manager opens, the file is `<maintenance-root>/<maintenance-space-name>-notes.png`. The record is `<maintenance-root>/<maintenance-space-name>.json`. A screenshot error is stored as `screenshotError` and does not click the page. `--close-maintenance-space` is a boolean flag and takes no value. The three CLI identity fields must match `accounts.xiaohongshu`. A mismatch exits before Ego.

```bash
export VIDEO_PUBLISHER_CONFIG="$HOME/.config/video-publisher-maintenance/config.json"
node scripts/config.mjs init-maintenance-account \
  --profile-id "PROFILE_ID_FROM_PROFILES" \
  --profile-label "PROFILE_LABEL_NOT_THE_ID" \
  --display-name "ACCOUNT_DISPLAY_NAME" \
  --account-id "ACCOUNT_ID"
node scripts/config.mjs validate-maintenance
node scripts/v2/publisher.mjs \
  --operation maintenance-diagnose \
  --profile-id "PROFILE_ID_FROM_PROFILES" \
  --profile-label "PROFILE_LABEL_NOT_THE_ID" \
  --display-name "ACCOUNT_DISPLAY_NAME" \
  --account-id "ACCOUNT_ID" \
  --maintenance-space-name "vp-maint-account-check" \
  --maintenance-root "$HOME/.local/state/video-publisher-maintenance"
```

`--close-maintenance-space` finishes only the handle created in that same process, and only when its name matches. It does not scan or close other spaces. Omit it to keep the new space. Do not point `--maintenance-root` at the production job directory. The CLI identity must match the maintenance file; this command does not fill a missing account from the shell.

The script logs `VIDEO_PUBLISHER_MAINTENANCE:` and writes `<maintenance-root>/<maintenance-space-name>.checkpoint.json` before `finish`. `closeResult.closed` is true only when `finish` returns. If that return is lost, close stays `unknown`; it is not reported as success. A missing marker leaves `sideEffects`, space id, home identity, and note-manager as `unknown`, even when the screenshot files exist. Those files are recorded under `screenshotFilesPresent` and do not set `homeIdentityMatched`. The raw child stdout and stderr are saved only by this version, at `<maintenance-root>/<maintenance-space-name>.ego.log`, with `exitCode`, `----- stdout -----`, and `----- stderr -----`. The 585fe53 run did not write that log or a checkpoint; its retained output is the publisher JSON and the two screenshots.

`maintenance-space-status` uses the same `maintenance-account-observation` config as `maintenance-diagnose`. It does not require `productionReady`. It calls `profiles()` and `listTaskSpaces()` and prints only the exact `--maintenance-space-name`. It does not call `taskSpace`, open a page, or finish. `found: false` means that snapshot did not contain the name. It does not prove the earlier finish succeeded. `found: true` returns `spaceId` when the list has it and does not claim or close the space.

`maintenance-close-space` is the supported way to finish one own maintenance space. It is not a pure read. It first requires one fresh inventory row whose id, exact `vp-maint-` name, `profileId`, and `ownership: "agent"` all match the command. Only then does it call `taskSpace(id)` with no `profileId` and no `claimTaskSpace`. The returned handle must have the same id, the same name, and `ownership: "agent"` before `finish({ keep: [] })`. Installed Ego 0.6.2.7 rejects a boolean `keep`. Its error says `keep` must be `"all"` or an array of unique non-empty page labels. `"all"` retains every page. `[]` names no page to retain. `returnedHandle` records the handle fields actually returned; it is null only when no handle was returned. A missing, ambiguous, mismatched, or unknown inventory row never calls `taskSpace`. A thrown `USER_CONTROL`, a mismatched handle, or a failed finish does not retry and does not call `taskSpace` again. `taskSpace(id)` is still reuse-or-create: if the id disappears between the list and the call, the call can attach or create something else. That handle is not finished. The command does not guarantee the call created nothing. `closeResult` is only the finish receipt. `inventoryCleared` is a separate later `listTaskSpaces` snapshot. Guide v2.2.0 says task spaces persist after the script ends. A later row with the same id, name, `ownership: "agent"`, and profile id is that persisted record, not a failed finish and not proof that pages are open. `pagesClosed` stays `not-observed` because this command does not call `task.pages()`. Exit 0 requires the finish receipt plus either that same persisted row or an absent row. A changed or unreadable later row stays exit 10. `ready`, `accepted`, `accountVerified`, and `publishable` stay false. No page is opened. Do not run this command again merely to chase a missing inventory row.

```bash
export VIDEO_PUBLISHER_CONFIG="$HOME/.config/video-publisher-maintenance/config.json"
node scripts/v2/publisher.mjs \
  --operation maintenance-close-space \
  --profile-id "Profile 2" \
  --profile-label "AI" \
  --display-name "GrokBot看AI" \
  --account-id "4221066816" \
  --maintenance-space-name "vp-maint-account-check-585fe53-20261108-1201" \
  --maintenance-space-id 107 \
  --maintenance-root "$HOME/.local/state/video-publisher-maintenance"
```

```bash
node scripts/config.mjs bind-account xiaohongshu \
  --profile-id "PASTE_PROFILE_ID_FROM_DIAGNOSE_BINDING" \
  --profile-label "PASTE_HUMAN_LABEL_NOT_USED_AS_ID" \
  --display-name "PASTE_ACCOUNT_DISPLAY_NAME" \
  --account-id "PASTE_ACCOUNT_ID"
```

Create, resume, and inspect still require a real package, existing media, and a validated config. Then prepare:

```bash
scripts/run-safe-platforms.sh \
  --package /absolute/package.json \
  --platforms xiaohongshu \
  --job-id SAME-JOB \
  --state-root /absolute/state-root \
  --operation create \
  --no-cleanup-stale-spaces
```

After a crash, keep the same package, `--job-id`, and `--state-root`, and use `--operation resume --reuse-space --no-cleanup-stale-spaces`. Do not mint a new job when the result is unknown. `--operation inspect` reads the same job again. `--operation diagnose-dedup` records that job-level dedup is not platform history dedup; it does not open note management and cannot return READY. The publisher lock stays under the fixed lock root and still blocks a second job that uses another `--state-root`.

`xhsSchedule` is validated as an Asia/Shanghai civil time. It does not authorize `releaseForConfirmedPublish` or a click on `发布` or `定时发布`. A missing or unproven schedule control is `SCHEDULE_CONTROL_UNVERIFIED`, which does not mean the platform lacks scheduling. AI declaration, collection, prose, and the 3:4 cover require a fresh readback; a click receipt is not field success. Platform history dedup stays `PLATFORM_HISTORY_UNVERIFIED` until a later live note-management read exists. Do not treat that pending state as acceptance.

Final publish, only after a separate explicit authorization for this job and these platforms:

1. `--operation inspect` on the same job still reports that platform `READY`, with the same draft identity and a fresh account match.
2. The page guard is armed, `blockedAttempts` is 0, and `finalPublishClicked` is false.
3. Call `releaseForConfirmedPublish()` once and require `ok: true`.
4. Click one final control that matches the authorized action. A configured schedule time does not select or authorize that control.
5. If the platform result cannot be read back, report it as unconfirmed. Do not click again and do not create another draft.

Replace covers on an existing READY draft without uploading the video again:

```bash
scripts/run-safe-platforms.sh \
  --package /absolute/path/to/package-with-new-cover.json \
  --job-id existing-ready-job-id \
  --platforms xiaohongshu \
  --operation replace-cover
```

The replacement package must keep the exact video, title, descriptions, tags, and settings. It must set `cover.uploadCustomCover=true` and change only mapped cover files. The orchestrator reuses the recorded task space, invalidates only affected cover receipts, then runs `inspect -> mutate -> verify`. If another existing platform's mapped cover also changed, include that platform in the same command. Published-content editing is outside this draft orchestrator and must never be represented as a successful replacement without a separate live-page workflow and explicit authorization to save the online change.

只恢复或重开同一多平台 Job 的部分平台时，保留原 Job 的其他待发布页面：

```bash
scripts/run-safe-platforms.sh \
  --package /absolute/path/to/package.json \
  --job-id existing-job-id \
  --platforms xiaohongshu,douyin,bilibili \
  --force-fresh-space \
  --no-cleanup-stale-spaces
```

清理计划会保护当前 Job 中全部现用空间，即使历史 `retiredSpaces` 记录与现用空间重复也不能关闭它们。子集恢复仍必须显式关闭 stale cleanup，避免清理其他已完成 Job；任务完成后另行运行受控清理。

子集命令成功只说明本次所选平台完成；整个 Job 必须全部平台就绪才能标为 `READY`，未完成平台仍可沿用原 Job 恢复。清理旧空间必须核对记录名称，不能仅凭可能被 Ego 复用的数字 ID 关闭页面。

`INPUT_CHANNEL_BROKEN` 与 `USER_CONTROL` 都会停止后续空间清理；关闭页面也属于浏览器修改，不能绕过全局停止条件。

UI concurrency is fixed at `1` and has no public override.

State defaults to `~/.video-publisher/v2-jobs/<job-id>/`. The job stores the package fingerprint, numeric task-space ids, exact stable task-space names, task-space-bound receipts, observations, compact verdicts, an atomic one-generation `state.backup.json`, and schema-`2` receipt checkpoints under `checkpoints/`. An invalid primary state may recover only from a fingerprint-matching backup; the corrupt file is preserved as `state.corrupt-<timestamp>.json`, after which all platform gates are read again.

上传并行执行，不设跨平台完成屏障。五个平台都先执行 `upload_start`；页面证明视频仍在上传且对应安全字段已就绪时，立即通过单宽 UI 队列执行 `prefill`，再继续等待上传完成。视频号只提前填写描述并保持短标题为空；YouTube 提前填写详情和可编辑高级设置。封面、原创声明、B 站简介与创作声明、YouTube 可见性与最终步骤、最终修复和验证不会提前。平台一旦完成上传，就进入滚动串行收尾；普通阻塞只冻结该平台。

Before state or browser work, production acquires the account-wide publisher lock under `${VIDEO_PUBLISHER_V2_LOCK_ROOT:-$HOME/.video-publisher/v2-locks}/publisher/`, then `<job-dir>/orchestrator.lock/`. The first is independent of `--state-root`; the second protects persisted state. Direct diagnosis proves parent-lock ownership or acquires the same lock, and each spawned Ego controller registers a token-bound member PID. Normal completion removes locks; crash recovery removes the publisher lock only after its owner and all registered members are dead.

Job directories use mode `0700`. State, evidence, receipt checkpoints, and lock-owner JSON use mode `0600`; opening an existing job also repairs older broader permissions.

These POSIX permission bits apply on POSIX filesystems. On Windows, Node chmod does not configure NTFS ACLs; files inherit the destination's existing ACLs. Choose a private user directory for configuration and state. Windows tests validate persistence, recovery and lock behavior without asserting POSIX mode bits.

To resume an interrupted run, repeat the same command with the same `--job-id`. The package fingerprint must match. The orchestrator reuses a persisted task space only when both its numeric id and exact stable name identify the same live space; this prevents Ego's post-crash numeric-id recycling from entering another job. It restores only checkpoints whose platform, package fingerprint, and task-space id all match, then inspects page truth again before acting. If the recorded id is missing or has another live name, the runner selects or recreates only the recorded exact platform-space name and writes its current id back. An explicit recreation invalidates receipts even when Ego assigns the replacement the same numeric id. Ownership or user-control errors never use this fallback.

`INPUT_CHANNEL_BROKEN` is invocation-wide. Once any runner records it, the orchestrator lets already-started work settle, starts no new UI mutation, preserves platforms that already completed rolling verification, and performs only still-missing final read-only verification. `USER_CONTROL` also stops the whole browser job. Other typed blockers, including `AUTH_REQUIRED`, are platform-local. The next ordinary same-job invocation resumes after Ego restarts; do not manually clean state or re-run a one-platform mutator inside the broken invocation.

Exit codes:

```text
0: every selected platform is ready, or read-only inspection completed without a hard blocker
10: at least one platform has a hard blocker, including unavailable browser input or user control
1: fatal runner/parse/environment error
2: command usage error
```

## One-Platform Adapter Runner

Use only for adapter diagnosis and targeted repair:

```bash
node scripts/v2/run-platform.mjs \
  <platform> \
  /absolute/path/to/package.json \
  <inspect|upload_start|prefill|upload|mutate|verify|quarantine> \
  [task-suffix] \
  [numeric-task-space-id]
```

`upload_start` 和 `prefill` 支持五个平台。`upload_start` 不是上传完成回执；`prefill` 只处理已实测稳定字段且不上传封面或原创声明，运行后仍必须执行正式 `upload`、`mutate` 和 `verify`。

Direct `mutate` diagnosis for Xiaohongshu, Bilibili, or WeChat Channels requires either onboarded `all_videos_original` or the one-run `--confirm-original-rights` override. `inspect`, `upload`, `verify`, and Bilibili `quarantine` remain available without either signal.

`quarantine` is valid only for Bilibili. Always reuse the numeric task-space id recorded in job state; do not invent a second task space for an active draft.

For a verify call that must check a custom-cover receipt, pass the persisted receipt JSON:

```bash
VIDEO_PUBLISHER_V2_RECEIPTS='{"cover":{...}}' \
  node scripts/v2/run-platform.mjs bilibili package.json verify suffix 12
```

## Result Contract

The adapter runner prints one line prefixed with:

```text
VIDEO_PUBLISHER_V2_RESULT:
```

Parsers accept the prefix only at the start of a trimmed output line. An exception message that merely mentions the prefix is not a result and must preserve the underlying runner error.

The payload includes:

```text
platform and phase
taskSpaceId
fresh gate evidence
typed blocker, when present
cover receipts, when produced
finalPublishClicked: false
```

Do not parse unstructured page logs as success.

## Tests

Run local validation without opening creator pages:

```bash
node --check scripts/v2/publisher.mjs
node --check scripts/v2/run-platform.mjs
for file in scripts/v2/platforms/*.mjs scripts/v2/ego/*.mjs scripts/v2/lib/*.mjs; do node --check "$file"; done
node --test scripts/tests/*.test.mjs scripts/v2/tests/*.test.mjs
```

These tests do not replace real platform acceptance.
