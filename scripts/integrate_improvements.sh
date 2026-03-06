#!/bin/bash
# JimClaw 改进集成脚本
# 将模板引擎和分阶段生成集成到 graph.ts

set -e

GRAPH_FILE="src/core/graph.ts"
BACKUP_FILE="src/core/graph.ts.backup"

echo "=== JimClaw 改进集成脚本 ==="
echo ""

# 1. 备份原始文件
echo "[1/4] 备份原始文件..."
cp "$GRAPH_FILE" "$BACKUP_FILE"
echo "✓ 已备份到 $BACKUP_FILE"
echo ""

# 2. 添加导入语句
echo "[2/4] 添加导入语句..."
if ! grep -q "from \"./template_engine\"" "$GRAPH_FILE"; then
  # 在 LintFixSkill 导入后添加
  sed -i '/from "\.\.\/skills\/lint_fix";/a\
\
// ========== 改进 1: 模板引擎导入 ==========\
import { getTemplateEngine, type TemplateContext } from "./template_engine";\
import {\
  getScaffoldingCommand,\
  generateMiddlewareConfig,\
  REQUIRED_MIDDLEWARE,\
  type MiddlewareSpec\
} from "./middleware_standards";\
// ========== 改进 2: 分阶段生成导入 ==========\
import {\
  GenerationStage,\
  getScaffoldPrompt,\
  getImplementationPrompt,\
  getTestAlignmentPrompt,\
  validateScaffoldCode,\
  validateImplementationCode,\
  extractCodeBlock,\
  generateStageSummary,\
  type FileGenerationState,\
  type PhasedGenerationConfig,\
  DEFAULT_PHASED_CONFIG\
} from "./phased_generation";' "$GRAPH_FILE"
  echo "✓ 已添加导入语句"
else
  echo "⊙ 导入语句已存在，跳过"
fi
echo ""

# 3. 在 JimClawState 中添加新状态
echo "[3/4] 添加状态定义..."
if ! grep -q "templateId: Annotation" "$GRAPH_FILE"; then
  # 在 containerId 状态后添加
  sed -i '/containerId: Annotation<string>/a\
  // 改进 1: 模板相关状态\
  templateId: Annotation<string>({\
    reducer: (x, y) => y ?? x,\
  }),\
  templateMetadata: Annotation<any>({\
    reducer: (x, y) => y ?? x,\
  }),\
  // 改进 2: 分阶段生成状态\
  generationStage: Annotation<GenerationStage | null>({\
    reducer: (x, y) => y ?? x,\
  }),\
  fileGenerationStates: Annotation<Record<string, FileGenerationState>>({\
    reducer: (x, y) => ({ ...(x || {}), ...(y || {}) }),\
  }),\
  phasedConfig: Annotation<PhasedGenerationConfig>({\
    reducer: (x, y) => y ?? x,\
  }),' "$GRAPH_FILE"
  echo "✓ 已添加状态定义"
else
  echo "⊙ 状态定义已存在，跳过"
fi
echo ""

# 4. 在 createJimClawGraph 开始时初始化模板引擎
echo "[4/4] 添加模板引擎初始化..."
if ! grep -q "initializeTemplateEngine" "$GRAPH_FILE"; then
  # 在函数开始处添加初始化
  sed -i '/const maxRetries = ModelManager.getGlobalConfig/a\
\
  // ========== 改进: 初始化模板引擎 ==========\
  const templateEngine = getTemplateEngine();\
  await templateEngine.loadTemplates();\
  console.log(\`[Graph] 模板引擎已就绪，加载了 \${templateEngine.getTemplateCount()} 个模板\`);' "$GRAPH_FILE"
  echo "✓ 已添加模板引擎初始化"
else
  echo "⊙ 模板引擎初始化已存在，跳过"
fi
echo ""

echo "=== 集成完成 ==="
echo ""
echo "下一步："
echo "1. 编译检查: npx tsc --noEmit"
echo "2. 如果有错误，恢复备份: cp $BACKUP_FILE $GRAPH_FILE"
echo ""
