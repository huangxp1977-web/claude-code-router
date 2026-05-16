#!/bin/bash
set -e

# 发布脚本
# - Core 包作为 @thxp/llms npm 包发布
# - CLI 包作为 @thxp/claude-code-router npm 包发布
# - Server 包发布为 Docker 镜像

VERSION=$(node -p "require('../packages/cli/package.json').version")
IMAGE_NAME="ccr/router"
IMAGE_TAG="${VERSION}"
LATEST_TAG="latest"

echo "========================================="
echo "发布 Claude Code Router v${VERSION}"
echo "========================================="

# 获取发布类型参数
PUBLISH_TYPE="${1:-all}"

case "$PUBLISH_TYPE" in
  npm)
    echo "仅发布 npm 包..."
    ;;
  docker)
    echo "仅发布 Docker 镜像..."
    ;;
  all)
    echo "发布 npm 包和 Docker 镜像..."
    ;;
  *)
    echo "用法: $0 [npm|docker|all]"
    echo "  npm    - 仅发布到 npm"
    echo "  docker - 仅发布到 Docker Hub"
    echo "  all    - 发布到 npm 和 Docker Hub (默认)"
    exit 1
    ;;
esac

# ===========================
# 发布 Core npm 包 (@thxp/llms)
# ===========================
publish_core_npm() {
  echo ""
  echo "========================================="
  echo "发布 npm 包 @thxp/llms"
  echo "========================================="

  # 检查是否已登录 npm
  if ! npm whoami &>/dev/null; then
    echo "错误: 未登录 npm，请先运行: npm login"
    exit 1
  fi

  CORE_DIR="../packages/core"
  CORE_VERSION=$(node -p "require('../packages/core/package.json').version")

  # 复制 README 到 core 包
  cp ../README.md "$CORE_DIR/" 2>/dev/null || echo "README.md 不存在，跳过..."
  cp ../LICENSE "$CORE_DIR/" 2>/dev/null || echo "LICENSE 文件不存在，跳过..."

  # 使用子 Shell 发布，避免改变主脚本的路径
  (
    cd "$CORE_DIR"
    echo "执行 npm publish..."
    # 如果版本已存在，npm 会报错，我们加 || true 让脚本继续
    npm publish --access public || echo "提示: @thxp/llms 版本已存在，跳过发布。"
  )

  echo ""
  echo "✅ Core npm 包发布成功!"
  echo "   包名: @thxp/llms@${CORE_VERSION}"
}

# ===========================
# 发布 CLI npm 包
# ===========================
publish_npm() {
  echo ""
  echo "========================================="
  echo "发布 npm 包 @thxp/claude-code-router"
  echo "========================================="

  # 检查是否已登录 npm
  if ! npm whoami &>/dev/null; then
    echo "错误: 未登录 npm，请先运行: npm login"
    exit 1
  fi

  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  CLI_DIR="$ROOT_DIR/packages/cli"
  SERVER_DIR="$ROOT_DIR/packages/server"
  BACKUP_DIR="$CLI_DIR/.backup"

  mkdir -p "$BACKUP_DIR"
  cp "$CLI_DIR/package.json" "$BACKUP_DIR/package.json.bak"

  # 获取 @thxp/llms 的实际版本号（去掉 workspace: 前缀）
  LLMS_VERSION=$(node -p "require('$ROOT_DIR/packages/core/package.json').version")

  # 创建临时的发布用 package.json
  node -e "
    const pkg = require('$CLI_DIR/package.json');
    pkg.name = '@thxp/claude-code-router';
    delete pkg.scripts;
    delete pkg.devDependencies;
    pkg.files = ['dist/*', 'README.md', 'LICENSE'];
    pkg.dependencies = {
      '@thxp/llms': '^${LLMS_VERSION}'
    };
    pkg.peerDependencies = {
      'node': '>=18.0.0'
    };
    pkg.engines = {
      'node': '>=18.0.0'
    };
    require('fs').writeFileSync('$CLI_DIR/package.publish.json', JSON.stringify(pkg, null, 2));
  "

  # 使用发布版本的 package.json
  mv "$CLI_DIR/package.json" "$BACKUP_DIR/package.json.original"
  mv "$CLI_DIR/package.publish.json" "$CLI_DIR/package.json"

  # 复制 README 和 LICENSE
  cp "$ROOT_DIR/README.md" "$CLI_DIR/" 2>/dev/null || echo "README.md 不存在，跳过..."
  cp "$ROOT_DIR/LICENSE" "$CLI_DIR/" 2>/dev/null || echo "LICENSE 文件不存在，跳过..."

  # 使用子 Shell 发布，避免改变主脚本路径
  (
    cd "$CLI_DIR"
    echo "执行 npm publish..."
    npm publish --access public
  )

  # 恢复原始 package.json
  mv "$BACKUP_DIR/package.json.original" "$CLI_DIR/package.json"

  echo ""
  echo "✅ npm 包发布成功!"
  echo "   包名: @thxp/claude-code-router@${VERSION}"
}


# ===========================
# 发布 Docker 镜像
# ===========================
publish_docker() {
  echo ""
  echo "========================================="
  echo "发布 Docker 镜像"
  echo "========================================="

  # 检查是否已登录 Docker
  if ! docker info &>/dev/null; then
    echo "错误: Docker 未运行"
    exit 1
  fi

  # 构建 Docker 镜像
  echo "构建 Docker 镜像 ${IMAGE_NAME}:${IMAGE_TAG}..."
  docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" -f ../packages/server/Dockerfile ..

  # 标记为 latest
  echo "标记为 latest..."
  docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${IMAGE_NAME}:${LATEST_TAG}"

  # 推送到 Docker Hub
  echo "推送 ${IMAGE_NAME}:${IMAGE_TAG}..."
  docker push "${IMAGE_NAME}:${IMAGE_TAG}"

  echo "推送 ${IMAGE_NAME}:${LATEST_TAG}..."
  docker push "${IMAGE_NAME}:${LATEST_TAG}"

  echo ""
  echo "✅ Docker 镜像发布成功!"
  echo "   镜像: ${IMAGE_NAME}:${IMAGE_TAG}"
  echo "   镜像: ${IMAGE_NAME}:latest"
}

# ===========================
# 执行发布
# ===========================
if [ "$PUBLISH_TYPE" = "npm" ] || [ "$PUBLISH_TYPE" = "all" ]; then
  publish_core_npm
  publish_npm
fi

if [ "$PUBLISH_TYPE" = "docker" ] || [ "$PUBLISH_TYPE" = "all" ]; then
  publish_docker
fi

echo ""
echo "========================================="
echo "🎉 发布完成!"
echo "========================================="
