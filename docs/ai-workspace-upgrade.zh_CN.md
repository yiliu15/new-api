# New API AI工作台功能升级说明

## 功能名称

新增功能名称固定为：`AI工作台`。

这是 New API 内置的网页端 AI 使用入口。用户登录 New API 后，可以在站内直接使用自己的 New API API Key 进行对话、生图、图片理解和图片编辑。

## 实现方案

AI工作台采用“前端内置客户端”方案，不改 New API 原有转发、计费、渠道、令牌、模型权限、日志等核心逻辑。

调用链路固定为：

```text
用户浏览器 -> AI工作台页面 -> 当前 New API /v1 接口 -> 原有 relay -> 上游模型
```

AI工作台不会绕过 New API。所有调用仍然走用户自己的 API Key，因此额度扣费、模型权限、分组限制、日志记录都继续使用 New API 原来的规则。

## 第一版已加入的能力

第一版实现以下能力：

- 文本对话：调用 `/v1/chat/completions`
- 图片理解：用户上传图片后调用 `/v1/chat/completions`
- 文生图：调用 `/v1/images/generations`
- 图片编辑：用户上传图片后调用 `/v1/images/edits`

页面是类似 ChatGPT 的单一对话窗口。用户可以直接输入文字，也可以上传图片；系统会按输入内容自动选择对话、图片理解、生图或图片编辑。用户也可以在页面顶部手动切换模式。

## 菜单入口

新增入口位置：

```text
左侧菜单 -> 聊天 -> AI工作台
```

只有登录用户才能访问。未开启功能或没有权限的普通用户不会看到入口，直接访问页面时会显示无权限提示。

## 后台新增配置

新增配置位置：

```text
系统设置 -> 站点与品牌 -> AI Workspace
```

新增可编辑内容：

- `启用 AI工作台`：全局开关，关闭后所有普通用户不可使用。
- `AI工作台 Base URL`：可留空，留空时默认使用当前 New API 网站地址；如果填写了末尾带 `/v1` 的地址，前端会自动兼容处理。
- `默认对话模型`：普通文字对话默认模型。
- `默认视觉模型`：上传图片并理解图片内容时默认模型。
- `默认生图模型`：文生图默认模型。
- `默认图片编辑模型`：上传图片并编辑图片时默认模型。

用户页面不会显示 Base URL 输入框。普通用户只需要填写自己的 API Key。

AI工作台页面新增图片尺寸选择，作用于生图和图片编辑：

```text
auto
1024x1024
1024x1536
1536x1024
```

默认值为 `auto`。图片编辑时使用 `auto`，由上游模型尽可能按上传图片的原始比例和尺寸策略返回结果；最终像素尺寸仍以模型和上游接口支持能力为准。

## 用户权限

新增用户字段：

```text
users.ai_workspace_enabled
```

新增用户管理开关位置：

```text
用户管理 -> 编辑用户 -> 允许使用 AI工作台
```

权限规则固定为：

- 超级管理员和管理员在全局开关开启后可以直接使用，不受单个用户权限限制。
- 普通用户必须同时满足“全局开关开启”和“该用户允许使用 AI工作台”。
- 新增数据库字段默认值为 `false`，不会自动给所有普通用户开放。

## API Key 保存方式

用户在 AI工作台中填写自己的 New API API Key。

API Key 只保存在用户浏览器本地：

```text
localStorage
```

服务端不保存用户在 AI工作台里填写的 API Key。
图片尺寸选择也保存在浏览器本地，键名为：

```text
ai_workspace_image_size
```

## 对原系统数据的影响

该功能不会覆盖原有用户数据、令牌数据、充值数据、日志数据或渠道配置。

上线后只会新增一个用户权限字段：

```text
ai_workspace_enabled
```

数据库自动迁移时会给已有用户补充该字段，默认值为 `false`。

## 相关文件

主要新增或修改文件：

```text
web/default/src/features/ai-workspace/
web/default/src/routes/_authenticated/ai-workspace/
web/default/src/features/system-settings/site/ai-workspace-section.tsx
web/default/src/features/users/components/users-mutate-drawer.tsx
web/default/src/hooks/use-sidebar-data.ts
web/default/src/hooks/use-sidebar-config.ts
controller/misc.go
controller/user.go
model/option.go
model/user.go
```

## 上线方式

代码合并到你的 GitHub fork 后，用你自己的镜像构建流程重新构建 Docker 镜像，再让服务器拉取新镜像并重启容器。

只要服务器继续挂载原来的数据库和数据卷，更新镜像不会覆盖用户数据。
