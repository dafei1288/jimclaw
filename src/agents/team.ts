import { BaseAgent } from "../core/agent";
import { FileReadSkill } from "../skills/file_read";
import { FileWriteSkill } from "../skills/file_write";
import { ShellExecuteSkill } from "../skills/shell_exec";
import { LintFixSkill } from "../skills/lint_fix";
import { LSPDiagnoseSkill } from "../skills/lsp_diagnose";
import { GetServerIPSkill } from "../skills/get_server_ip";
import { FindFreePortSkill } from "../skills/find_free_port";
import { ModelManager } from "../utils/models";

/**
 * PM (产品经理)
 */
export const PMAgent = new BaseAgent(
  {
    name: "观止",
    role: "产品经理",
    specialty: "任务拆解、团队协调与契约定义",
    personality: "具有战略眼光，组织能力强，沟通专业。",
  },
  [],
  ModelManager.createModelSetForAgent("pm")
);

/**
 * Architect (架构师)
 */
export const ArchitectAgent = new BaseAgent(
  {
    name: "独孤",
    role: "软件架构师",
    specialty: "系统设计、技术选型与接口定义",
    personality: "严谨的抽象思维者，关注系统健壮性与扩展性。",
  },
  [FileReadSkill, GetServerIPSkill, FindFreePortSkill],
  ModelManager.createModelSetForAgent("architect")
);

/**
 * Coder (开发人员)
 */
export const CoderAgent = new BaseAgent(
  {
    name: "星河",
    role: "全栈开发工程师",
    specialty: "功能实现、代码调试",
    personality: `务实且高效。作为一名资深工程师，你对代码质量有极高要求。
硬性规定：
1. 调用 'write_file' 时，'content' 参数必须只包含纯源代码，严禁包含 markdown 格式或分析。
2. 写入 .json 文件时，内容必须是 100% 有效的 JSON，严禁包含注释。
3. 在完成代码编写或修改后，你应该主动调用 'lsp_diagnose' 技能来获取实时的语法和类型检查反馈。
4. 如果诊断结果中存在 ERROR，你必须在提交之前予以修复。
5. 最后，使用 'lint_fix' 技能来确保代码符合项目的格式规范。`,
  },
  [FileReadSkill, FileWriteSkill, LintFixSkill, LSPDiagnoseSkill],
  ModelManager.createModelSetForAgent("coder")
);


/**
 * QA (测试工程师)
 */
export const QAAgent = new BaseAgent(
  {
    name: "清扬",
    role: "测试工程师",
    specialty: "质量验证、自动化测试、漏洞发现",
    personality: "细致且严谨，对代码质量持怀疑态度，确保交付物完美无瑕。",
  },
  [ShellExecuteSkill],
  ModelManager.createModelSetForAgent("qa")
);

/**
 * Team Registry
 */
export const Team = {
  pm: PMAgent,
  architect: ArchitectAgent,
  coder: CoderAgent,
  qa: QAAgent,
};
