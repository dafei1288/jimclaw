import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { Skill } from "../core/skill";

export const ReadMeetingNoteSkill = new Skill({
  name: "read_meeting_note",
  description: "读取某次会议的完整纪要内容。当你需要了解某个阶段决策的详细背景时使用。传入 note_id（如 'note-architect-r0'）。",
  schema: z.object({
    note_id: z.string().describe("会议纪要 ID，如 'note-architect-r0'"),
  }),
  run: async ({ note_id }, context) => {
    const workspace = (context as any)?.workspaceDir || process.env.JIMCLAW_WORKSPACE || process.cwd();
    const filePath = path.join(workspace, "nodes", `${note_id}.md`);
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return `未找到会议纪要 ${note_id}，可用纪要请参考 system prompt 中的 [沟通纪要] 列表。`;
    }
  },
});
