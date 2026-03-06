import { z } from "zod";
import { Skill } from "../core/skill";
import { execSync } from "child_process";
import * as os from "os";

/**
 * 获取服务器真实可访问 IP 地址（非 localhost）
 */
export const GetServerIPSkill = new Skill({
  name: "get_server_ip",
  description: "获取服务器的真实可访问 IP 地址（非 localhost/127.0.0.1），用于生成对外可访问的服务 URL。",
  schema: z.object({}),
  run: async () => {
    // 方法 1：通过路由表获取出口 IP
    try {
      const ip = execSync("ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \\K[\\d.]+'")
        .toString().trim();
      if (ip && ip !== "127.0.0.1") return ip;
    } catch {}

    // 方法 2：通过网络接口获取第一个非回环 IPv4
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      if (name.startsWith("lo")) continue;
      for (const iface of interfaces[name] ?? []) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }

    return "127.0.0.1";
  },
});
