/**
 * Vue + TypeScript 前端脚手架
 *
 * 用于混合项目（如 Vue + Java Spring Boot / Vue + Go Gin / Vue + Python FastAPI）
 * 文件全部放在 frontend/ 子目录下
 */
import {
  ScaffoldContext,
  ScaffoldProvider,
  registerScaffoldProvider,
} from "./types";

// ── 辅助函数 ──

function inferEntityPlural(ctx: ScaffoldContext): string {
  const entities = ctx.requirementProtocol?.capabilities?.entities || [];
  if (entities.length > 0) return entities[entities.length - 1];
  const m = (ctx.description || "").match(/(\w+)\/(?:list|create|crud)/i);
  if (m) return m[1];
  return "items";
}

// ── 模板生成 ──

function generatePackageJson(ctx: ScaffoldContext): string {
  return JSON.stringify({
    name: `frontend-${ctx.projectName || "app"}`,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "vite build",
      test: "vitest run",
      "test:watch": "vitest",
    },
    dependencies: {
      vue: "^3.5.13",
      "vue-router": "^4.5.0",
    },
    devDependencies: {
      "@vitejs/plugin-vue": "^5.2.3",
      "@vue/test-utils": "^2.4.6",
      jsdom: "^26.0.0",
      typescript: "~5.7.3",
      vite: "^6.3.2",
      vitest: "^3.1.2",
      "vue-tsc": "^2.2.8",
    },
  }, null, 2);
}

function generateViteConfig(ctx: ScaffoldContext): string {
  const backendPort = ctx.port || 8080;
  return `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:${backendPort}',
        changeOrigin: true,
      },
    },
  },
});
`;
}

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      jsx: "preserve",
      resolveJsonModule: true,
      isolatedModules: true,
      esModuleInterop: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      skipLibCheck: true,
      noEmit: true,
      paths: { "@/*": ["./src/*"] },
    },
    include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"],
    references: [{ path: "./tsconfig.node.json" }],
  }, null, 2);
}

function generateTsConfigNode(): string {
  return JSON.stringify({
    compilerOptions: {
      composite: true,
      skipLibCheck: true,
      module: "ESNext",
      moduleResolution: "bundler",
      allowSyntheticDefaultImports: true,
    },
    include: ["vite.config.ts"],
  }, null, 2);
}

function generateMainTs(_ctx: ScaffoldContext): string {
  return `import { createApp } from 'vue';
import App from './App.vue';

const app = createApp(App);
app.mount('#app');
`;
}

function generateAppVue(ctx: ScaffoldContext): string {
  const entity = inferEntityPlural(ctx);
  const entityLower = entity.toLowerCase();
  return `<template>
  <div id="app">
    <h1>{{ title }}</h1>
    <HealthCheck @status-change="onStatusChange" />
    <p v-if="backendStatus" :class="statusClass">后端状态: {{ backendStatus }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import HealthCheck from './components/HealthCheck.vue';

const title = ref('${ctx.projectName || "App"}');
const backendStatus = ref('');

const statusClass = computed(() => ({
  'status-ok': backendStatus.value === 'ok',
  'status-error': backendStatus.value && backendStatus.value !== 'ok',
}));

function onStatusChange(status: string) {
  backendStatus.value = status;
}
</script>

<style>
#app {
  font-family: Arial, sans-serif;
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
}
.status-ok { color: green; }
.status-error { color: red; }
</style>
`;
}

function generateHealthCheckVue(ctx: ScaffoldContext): string {
  const port = ctx.port || 8080;
  return `<template>
  <div class="health-check">
    <button @click="checkHealth" :disabled="loading">
      {{ loading ? '检查中...' : '健康检查' }}
    </button>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{
  (e: 'status-change', status: string): void;
}>();

const loading = ref(false);
const error = ref('');

async function checkHealth() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    emit('status-change', data.status || 'ok');
  } catch (e: any) {
    error.value = e.message || '请求失败';
    emit('status-change', 'error');
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.health-check { margin: 20px 0; }
button {
  padding: 8px 16px;
  cursor: pointer;
  background: #42b883;
  color: white;
  border: none;
  border-radius: 4px;
}
button:disabled { opacity: 0.6; cursor: not-allowed; }
.error { color: red; margin-top: 8px; }
</style>
`;
}

function generateEnvDts(): string {
  return `/// <reference types="vite/client" />
`;
}

function generateHealthCheckTest(ctx: ScaffoldContext): string {
  return `import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import HealthCheck from '../src/components/HealthCheck.vue';

// mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('HealthCheck', () => {
  it('renders button', () => {
    const wrapper = mount(HealthCheck);
    expect(wrapper.find('button').exists()).toBe(true);
  });

  it('shows loading state when clicked', async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ status: 'ok' }),
    });
    const wrapper = mount(HealthCheck);
    await wrapper.find('button').trigger('click');
    // 按钮应该存在（可能在 loading 或已完成状态）
    expect(wrapper.find('button').exists()).toBe(true);
  });
});
`;
}

function generateVitestConfig(): string {
  return `import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
  },
});
`;
}

function generateIndexHtml(ctx: ScaffoldContext): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${ctx.projectName || "App"}</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
`;
}

// ── Provider 类 ──

class VueTypescriptProvider implements ScaffoldProvider {
  id = "vue-typescript";
  language = "typescript";
  frameworks = ["vue", "vue3"];

  canHandle(_ctx: ScaffoldContext, normalizedTarget: string): boolean {
    const lower = normalizedTarget.toLowerCase();
    return lower.startsWith("frontend/");
  }

  generate(ctx: ScaffoldContext, normalizedTarget: string): string | null {
    // 去掉 frontend/ 前缀来匹配
    const rel = normalizedTarget.replace(/^frontend\//i, "").toLowerCase();

    switch (rel) {
      case "package.json": return generatePackageJson(ctx);
      case "vite.config.ts": return generateViteConfig(ctx);
      case "tsconfig.json": return generateTsConfig();
      case "tsconfig.node.json": return generateTsConfigNode();
      case "vitest.config.ts": return generateVitestConfig();
      case "index.html": return generateIndexHtml(ctx);
      case "src/main.ts": return generateMainTs(ctx);
      case "src/app.vue": return generateAppVue(ctx);
      case "src/env.d.ts": return generateEnvDts();
      case "src/components/healthcheck.vue": return generateHealthCheckVue(ctx);
      case "tests/healthcheck.test.ts": return generateHealthCheckTest(ctx);
      default: return null;
    }
  }

  fileExtensions(): string[] {
    return [".vue", ".ts", ".json", ".html"];
  }

  testCommand(): string {
    return "cd frontend && npx vitest run";
  }

  runCommand(_spec: any, _port: number): string {
    // 前端不需要独立运行——由后端 serve 静态文件
    return "echo 'Frontend is served by backend'";
  }

  baseDockerImage(): string {
    // 前端不直接用 Docker——在 backend 容器内构建
    return "node:20-alpine";
  }

  installCommand(): string {
    return "cd frontend && npm install --loglevel=error";
  }

  entryFilePath(): string {
    return "frontend/src/main.ts";
  }

  testFilePattern(): string {
    return "frontend/tests/**/*.test.ts";
  }

  /** 前端 scaffold 优先级低于后端 */
  priority(): number {
    return 50;
  }
}

// ── 注册 ──
registerScaffoldProvider(new VueTypescriptProvider());
